'use strict';

const organizer = require('./organizer');
const urltemplate = require('./urltemplate');
const manager = require('./queue');
const vpn = require('./vpn');
const pending = require('./pending');
const schedule = require('./schedule');
const bulk = require('./bulk');
const tmdb = require('./tmdb');
const animelayout = require('./anime-layout');
const anidb = require('./anidb');
const engineconfig = require('./engineconfig');
const placer = require('./placer');

const DAY_MS = 24 * 60 * 60 * 1000;

// The episodes of a season that have aired by `today` (YYYY-MM-DD). An
// episode with no air date is TMDB's "announced, not scheduled yet" (the TBA
// tail of a running season) - it counts as aired only when a LATER episode of
// the same season has already aired. A season with no dates at all (old
// shows with sparse data) is taken as fully aired, as before.
function airedEpisodes(eps, today) {
  const list = eps || [];
  const dated = list.filter((e) => e && e.airDate);
  if (!dated.length) return list.slice();
  const airedDated = dated.filter((e) => String(e.airDate).slice(0, 10) <= today);
  const lastAired = airedDated.reduce((m, e) => Math.max(m, Number(e.episode) || 0), 0);
  return list.filter((e) => {
    if (!e) return false;
    if (e.airDate) return String(e.airDate).slice(0, 10) <= today;
    return Number(e.episode) < lastAired;
  });
}

// Wraps an injected log sink so every line is ALSO emitted on the queue
// manager's 'log' event. In engine mode there is no Electron window to push
// to, and the /api/log activity buffer listens to exactly that event (it is
// what the queue's own _log feeds) - so without this the watcher's pass
// ("Checking N scheduled series...", per-title results, "Schedule check
// complete.") ran fine but was INVISIBLE through the API and the plugin.
// Additive: the desktop UI reads main.js's own logLines buffer, so no line is
// duplicated for it.
function withManagerLog(onLog = () => {}) {
  return (msg) => {
    try { onLog(msg); } catch (e) { /* the primary sink is best-effort */ }
    try { manager.emit('log', msg); } catch (e) { /* no listener / not an emitter */ }
  };
}

// Re-checks the "waiting for dub" list. New episodes release weekly, so a daily
// pass is plenty. Each pending episode is (re)queued as a non-fatal item: if the
// dub is now available it downloads and leaves the list; otherwise it stays.
class Watcher {
  constructor() {
    this.timer = null;
    this.onLog = () => {};
  }

  start(onLog = () => {}) {
    this.onLog = withManagerLog(onLog);
    if (this.timer) return;
    // Nothing awaits these passes: a failure outside the per-series guards
    // must be logged, not left as an unhandled rejection.
    const run = () => this.tick().catch((e) => this.onLog(`Watcher pass failed: ${(e && e.message) || e}`));
    run();
    this.timer = setInterval(run, DAY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One scheduled pass: retry pending dubs, then pull new episodes for any
  // scheduled series. Both go online (episode detection, discovery), so the
  // whole pass holds until Mullvad is confirmed up (Part 3).
  async tick() {
    await vpn.waitUntilConnected();
    await this.checkNow();
    await this.checkSchedules();
  }

  // Every root a watched title's files may live in: staging plus each library
  // location (engine-path mapped). "Already on disk" must be true across ALL
  // of them - checking staging alone re-downloads the whole library daily.
  rootsFor(s) {
    const roots = [];
    const add = (p) => { if (p && !roots.includes(p)) roots.push(p); };
    add(s.outputRoot);
    if (s.library && Array.isArray(s.library.locations)) {
      let mappings = null;
      try { mappings = engineconfig.get().pathMappings; } catch (e) { /* defaults */ }
      for (const l of s.library.locations) {
        try { add(placer.toEnginePath(l, mappings)); } catch (e) { /* unreadable location */ }
      }
    }
    return roots;
  }

  // ---- scheduled series -----------------------------------------------------

  // One scheduled pass. TMDB-aware first (accurate "what has aired" + new
  // season detection, even for sources that list no episodes like Vidsrc);
  // the old source-detection path remains as the fallback when a title has no
  // TMDB id or TMDB has no data for it. One bad series never stops the rest.
  // A pass already running (daily tick vs. "Check now") is joined, not run
  // twice side by side.
  checkSchedules() {
    if (this._schedulesRun) return this._schedulesRun;
    this._schedulesRun = this._checkSchedules().finally(() => {
      this._schedulesRun = null;
    });
    return this._schedulesRun;
  }

  async _checkSchedules() {
    // On-disk facts are re-read every pass: an episode deleted since the last
    // pass must count as missing again (the flat-library floor was cached for
    // the engine's whole lifetime).
    this.__flatFloorCache = null;
    const items = schedule.list();
    if (!items.length) return { checked: 0, newSeasons: 0 };
    const dryRun = this.watcherMode().dryRun;
    this.onLog(
      `Checking ${items.length} scheduled series for new episodes...` +
        (dryRun ? ' (report only - nothing will be queued)' : '')
    );
    let newSeasons = 0;
    for (const s of items) {
      schedule.markChecked(s.key);
      // Opt-out: a frozen series is never auto-downloaded (in either mode).
      // It is reported and skipped - the layout for these titles is being
      // aligned before it is allowed to grab new episodes/seasons.
      if (this.isFrozen(s)) {
        this.onLog(`"${s.series}" is frozen (opt-out) - skipped, no downloads.`);
        continue;
      }
      // Backfill: entries created before TMDB-id storage. Vidsrc-style source
      // URLs carry the id in the path - recover it once so the TMDB-aware
      // check runs instead of the guess-the-range legacy path.
      if (!s.movie && !s.tmdb && (s.baseUrl || s.template)) {
        try {
          const ids = require('./sites/findtitle').idFromPlayerUrl(s.baseUrl || s.template) || {};
          if (ids.tmdb) {
            schedule.setIds(s.key, ids.tmdb, ids.imdb);
            s.tmdb = ids.tmdb;
            if (ids.imdb) s.imdb = ids.imdb;
            this.onLog(`Recovered TMDB id ${ids.tmdb} for "${s.series}" from its source URL.`);
          }
        } catch (e) {
          // best effort - the legacy path still works without it
        }
      }
      try {
        if (s.movie) {
          await this.checkMovie(s, dryRun);
        } else if (s.tmdb) {
          newSeasons += await this.checkSeriesTmdb(s, dryRun);
        } else if (dryRun) {
          // The legacy path downloads (startBatch); in report-only mode it
          // must not run at all - the title is reported as unchecked instead.
          this.onLog(`"${s.series}" has no TMDB data - report mode skips it (nothing downloaded).`);
        } else {
          newSeasons += await this.checkSeriesLegacy(s);
        }
      } catch (e) {
        this.onLog(`Schedule check failed for "${s.series}": ${e.message}`);
      }
    }
    this.onLog('Schedule check complete.');
    return { checked: items.length, newSeasons };
  }

  // Watcher mode: report-only is the DEFAULT (engineconfig.watchDryRun).
  // The user verifies what the scanner sees before it may queue anything.
  watcherMode() {
    try {
      const c = engineconfig.get() || {};
      return { dryRun: c.watchDryRun !== false };
    } catch (e) {
      return { dryRun: true };
    }
  }

  // Opt-out ("frozen") decision for one scheduled entry. Precedence:
  //   1. explicit per-entry flag  (frozen true -> frozen; frozen false -> cleared)
  //   2. engine risk-series policy (the title's TMDB id is in riskSeries)
  // A cleared entry (frozen:false) always wins over the policy, so once a
  // series' layout is aligned and the user unfreezes it, it watches again even
  // though its id is still in the risk list.
  isFrozen(s) {
    try {
      if (!s) return false;
      if (s.frozen === true) return true;
      if (s.frozen === false) return false;
      const risk = (engineconfig.get() || {}).riskSeries || [];
      return risk.map((x) => String(x)).includes(String(s.tmdb));
    } catch (e) {
      return false;
    }
  }

  // Flat-library floor. For a series whose files form a single continuous 1..N
  // axis ("Kingdom: S01E01..S01E142"), the highest episode number on disk is a
  // safe "you have up to here" floor - and it is ONLY trusted when the on-disk
  // library is a SUPERSET of everything the source claims (flatFloor >=
  // sourceTotal). Then every source episode is already owned, so we never
  // re-queue one and never miss a new one (there is none beyond the floor).
  // Non-flat (arc-based) series return null and keep their existing behavior.
  _flatFloorCache() {
    if (!this.__flatFloorCache) this.__flatFloorCache = new Map();
    return this.__flatFloorCache;
  }
  flatFloor(seriesDir) {
    if (!seriesDir) return null;
    const cache = this._flatFloorCache();
    if (cache.has(seriesDir)) return cache.get(seriesDir);
    let floor = null;
    try {
      const ext = organizer.seriesExtent(seriesDir);
      if (ext.flat && ext.maxEpisode) floor = ext.maxEpisode;
    } catch (e) { floor = null; }
    cache.set(seriesDir, floor);
    return floor;
  }
  seriesFlatFloor(roots, series) {
    let floor = null;
    for (const root of roots || []) {
      if (!root) continue;
      let dir = null;
      try { dir = organizer.seriesRoot(root, { series }); } catch (e) { dir = null; }
      if (!dir) continue;
      const f = this.flatFloor(dir);
      if (f != null) floor = (floor == null || f > floor) ? f : floor;
    }
    return floor;
  }

  // Movie watch: the daily check is "is the file still there?". Present in
  // staging or any library drive -> done (silent, nothing to do). Missing ->
  // re-queue the ONE movie (queueOne dedupes if it is already in the queue),
  // unless report-only mode is on, in which case it is only reported.
  // The old batch path had no movie awareness and would have queued the movie
  // up to 12 times as "S1E1..S1E12".
  async checkMovie(s, dryRun) {
    for (const root of this.rootsFor(s)) {
      try {
        if (root && organizer.titleOnDisk(root, s.series)) {
          this.onLog(`"${s.series}" (movie): on disk.`);
          return { action: 'on-disk' };
        }
      } catch (e) {
        // unreadable root
      }
    }
    if (dryRun) {
      this.onLog(`"${s.series}" (movie): MISSING from disk - report only, NOT re-queued.`);
      return { action: 'missing-reported' };
    }
    this.onLog(`"${s.series}" (movie) is not on disk - re-queuing it.`);
    await bulk.queueOne(
      {
        url: s.baseUrl,
        series: s.series,
        season: null,
        episode: null,
        mode: s.mode || 'dub',
        outputRoot: s.outputRoot,
        library: s.library || null,
        minHeight: s.minHeight || 0,
        anime: !!s.anime
      },
      this.onLog
    );
    return { action: 're-queued' };
  }

  // TMDB-aware series check (the default path now):
  //   1. seasons  - TMDB, or the Aniwave/AniList layout for anime (cached);
  //   2. target   - the watched season if it still exists, else the latest;
  //   3. episodes - only the ones that have AIRED (air date <= today; a null
  //                 date means "long since aired") and are not already on disk
  //                 in staging or any library drive;
  //   4. caught up - every aired episode present -> check season+1 and, if it
  //                 has aired episodes, queue them and advance the watch.
  // Future episodes are NEVER queued (the old source-detection path guessed a
  // 1-12 range and re-queued every not-yet-out episode daily).
  async checkSeriesTmdb(s, dryRun) {
    const anime = !!s.anime;
    const info = await tmdb.tmdbInfo(s.tmdb, 'tv', { anime });
    if (!info || !(info.seasons || []).some((x) => x && x.season > 0)) {
      if (dryRun) {
        // The fallback downloads (startBatch) - report-only mode must not run it.
        this.onLog(`TMDB has no seasons for "${s.series}" yet - report mode skips the source page check (nothing downloaded).`);
        return 0;
      }
      this.onLog(`TMDB has no seasons for "${s.series}" yet - falling back to the source page check.`);
      return this.checkSeriesLegacy(s);
    }
    const seasonNums = info.seasons
      .filter((x) => x && x.season > 0)
      .map((x) => x.season)
      .sort((a, b) => a - b);
    // Total episode count the source claims across all seasons - used by the
    // flat-library floor guard (only active when the disk holds at least this).
    // Specials (Season 0) are not part of the numbered run the guard compares.
    const sourceTotal = info.seasons.reduce((a, x) => a + ((x && x.season > 0 && x.episodes) || 0), 0);
    let season = s.season != null && String(s.season).trim() !== '' ? Number(s.season) : null;
    if (!season || !seasonNums.includes(season)) {
      const fallback = seasonNums[seasonNums.length - 1];
      if (season && season !== fallback) {
        this.onLog(`Season ${season} of "${s.series}" is no longer listed - checking season ${fallback} instead.`);
      }
      season = fallback || season;
    }

    const seasonData = await tmdb.tmdbSeason(s.tmdb, season, { anime });
    const eps = (seasonData && seasonData.episodes) || [];
    if (!eps.length) {
      this.onLog(`TMDB lists no episodes for "${s.series}" season ${season} - nothing to check.`);
      return 0;
    }

    // Anime: the file keeps the authoritative (Aniwave/AniList) numbers; the
    // SOURCE URL may need TMDB numbers. urlMapFor answers that (identity when
    // they already line up). TV: identity.
    let urlMap = null;
    if (anime) {
      try { urlMap = await animelayout.urlMapFor(s.tmdb, s.series, { anime: true }); } catch (e) { urlMap = null; }
    }
    const template = s.template || (s.baseUrl ? urltemplate.toTemplate(s.baseUrl).template : null);
    const roots = this.rootsFor(s);

    // GLOBAL no-duplicate guard (runs in BOTH dry-run and live): if the on-disk
    // layout is ambiguous (the same S#E# names different episodes), mislabeled,
    // or overflows the source model, we CANNOT tell episodes apart by label - so
    // we HOLD (queue nothing) instead of risking a re-download of something we
    // already have under another label. Clean layouts proceed exactly as before.
    const layoutRisk = organizer.seriesLayoutRiskFor(roots, s.series, sourceTotal);
    if (layoutRisk.mode === 'hold') {
      this.onLog(
        `"${s.series}" layout is unsafe to auto-download (${layoutRisk.reason}) - HELD, nothing queued to avoid duplicates. Add a per-title baseline to watch it.`
      );
      return 0;
    }
    // Non-blocking note: an arc or dub/sub duplicate. The recognizer still
    // dedupes by label (so nothing already on disk is ever re-downloaded); a
    // brand-new arc episode is the only thing that could be missed. Proceed.
    if (layoutRisk.warning) {
      this.onLog(`"${s.series}" note: ${layoutRisk.warning}`);
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const aired = airedEpisodes(eps, today);
    const notAired = eps.length - aired.length;
    if (!aired.length) {
      this.onLog(`"${s.series}" season ${season}: no episodes have aired yet.`);
      return 0;
    }

    const { queued, present, missing } = await this.queueMissingEps(s, season, aired, urlMap, template, roots, dryRun, sourceTotal);
    const fresh = aired.length - present;
    this.onLog(
      `"${s.series}" season ${season}: ${aired.length} aired, ${present} already on disk, ${queued} new queued` +
        (dryRun && missing.length ? `, ${missing.length} missing (${missing.map((n) => `E${n}`).join(', ')}) - report only, nothing queued` : '') +
        (notAired ? `, ${notAired} not out yet (skipped until they air)` : '') + '.'
    );

    // Dub availability (AniDB) - the user chose a dub/sub mode when queueing,
    // but source sites like Vidsrc have NO dub toggle: one fixed file per
    // episode. So the daily check states plainly whether an English-dubbed
    // release of this series even EXISTS, so a "dub" download that turns out
    // to be Japanese audio is never a surprise. Best-effort: a network
    // failure must never break the schedule check.
    if (anime && s.tmdb) {
      let d = null;
      try {
        d = await anidb.englishDubForTmdb(s.tmdb);
      } catch (e) {
        d = { available: null, reason: 'network' };
      }
      if (d && d.available === true) {
        this.onLog(
          `"${s.series}" AniDB: English dub EXISTS - ${d.englishDubReleases} release(s)` +
            (d.sample ? ` (e.g. ${String(d.sample).slice(0, 90)})` : '') + '.'
        );
      } else if (d && d.available === false) {
        this.onLog(
          `"${s.series}" AniDB: no English-dub release found (${d.totalReleases} release(s) total) - expect Japanese/sub audio from source sites.`
        );
      } else {
        this.onLog(`"${s.series}" AniDB: English-dub status unknown (${(d && d.reason) || 'lookup failed'}) - not counted against the show.`);
      }
    }

    // Caught up on this season? Check the next one (anime layout included -
    // info.seasons is authoritative for anime). In report-only mode the next
    // season is still REPORTED (aired/on disk/missing) but nothing is queued
    // and the watch season is NOT advanced.
    if (present >= aired.length && fresh === 0) {
      const next = seasonNums.find((x) => x === season + 1);
      if (next) {
        const nextData = await tmdb.tmdbSeason(s.tmdb, next, { anime });
        const nextEps = (nextData && nextData.episodes) || [];
        const nextAired = airedEpisodes(nextEps, today);
        if (nextAired.length) {
          if (dryRun) {
            const r = await this.queueMissingEps(s, next, nextAired, urlMap, template, roots, true, sourceTotal);
            this.onLog(
              `"${s.series}" season ${next} (new): ${nextAired.length} aired, ${r.present} on disk, ${r.missing.length} missing` +
                (r.missing.length ? ` (${r.missing.map((n) => `E${n}`).join(', ')})` : '') +
                ` - report only, watch stays on season ${season}.`
            );
          } else {
            this.onLog(`New season detected: "${s.series}" season ${next} - queueing its new episodes.`);
            await this.queueMissingEps(s, next, nextAired, urlMap, template, roots, dryRun, sourceTotal);
            schedule.bumpSeason(s.key, next);
            return 1;
          }
        }
      }
    }
    return 0;
  }

  // Queues the aired episodes of a season that are not already on disk
  // (staging or any library drive) and not already in the queue. Additive
  // only: nothing existing is touched, replaced, or re-downloaded.
  // dryRun: missing episodes are collected and reported, never queued.
  async queueMissingEps(s, season, eps, urlMap, template, roots, dryRun, sourceTotal) {
    let queued = 0;
    let present = 0;
    const missing = [];
    // Flat 1..N library floor: active ONLY when the on-disk library is a
    // superset of the source (flatFloor >= sourceTotal). Then every source
    // episode is already owned, so none may be re-queued and none is missed.
    const floor = this.seriesFlatFloor(roots, s.series);
    const floorActive = floor != null && sourceTotal != null && floor >= sourceTotal;
    // Anime DUB: which aired episodes are English-dubbed on the source (one
    // batched, cached check per season, TMDB numbering like the source URL).
    const pairOf = (ep) => {
      if (!urlMap) return { season, episode: ep };
      try {
        const m = urlMap(season, ep);
        if (m && m.season != null && m.episode != null) return { season: m.season, episode: m.episode };
      } catch (err) {
        // identity
      }
      return { season, episode: ep };
    };
    const dubGate = !!(s.anime && (s.mode || 'dub') === 'dub' && /^\d+$/.test(String(s.tmdb || '')));
    // Episodes of this season already waiting for their dub = the user asked
    // for this season in DUB: any other missing, undubbed episode waits too
    // (e.g. one deleted because it was not the dub).
    const seasonWaiting = dubGate && pending.list().some((w) => w.series === s.series && Number(w.season) === Number(season) && (w.mode || 'dub') === 'dub');
    const dubbedOf = new Map(); // episode -> true/false/null
    let dubStarted = false;
    let notDubbed = 0;
    let parked = 0;
    if (dubGate && eps.length) {
      const dubstatus = require('./dubstatus');
      const bySeason = new Map();
      for (const e of eps) {
        const p = pairOf(e.episode);
        if (!bySeason.has(p.season)) bySeason.set(p.season, []);
        bySeason.get(p.season).push({ ep: e.episode, urlEp: p.episode });
      }
      for (const [urlSeason, list] of bySeason) {
        let res = null;
        try {
          res = await dubstatus.checkSeason(s.tmdb, urlSeason, list.map((x) => x.urlEp), { onLog: this.onLog });
        } catch (err) {
          res = null;
        }
        for (const x of list) {
          const row = res && res.episodes.find((r) => r.episode === x.urlEp);
          const d = row ? row.dubbed : null;
          dubbedOf.set(x.ep, d);
          if (d === true) dubStarted = true;
        }
      }
    }
    for (const e of eps) {
      if (floorActive && e.episode != null && Number(e.episode) <= floor) {
        present++;
        continue;
      }
      const meta = { series: s.series, season, episode: e.episode };
      let onDisk = false;
      for (const root of roots) {
        try {
          if (root && organizer.existingEpisodeFile(root, meta, null, e.name || '')) {
            onDisk = true;
            break;
          }
        } catch (err) {
          // unreadable root
        }
      }
      if (onDisk) {
        present += 1;
        continue;
      }
      // Source URL: authoritative numbers for the FILE, TMDB numbers in the
      // URL when the layout differs (anime cour splits and friends).
      let pair = { season, episode: e.episode };
      if (urlMap) {
        try {
          const m = urlMap(season, e.episode);
          if (m && m.season != null && m.episode != null) pair = { season: m.season, episode: m.episode };
        } catch (err) {
          // identity
        }
      }
      const url = template
        ? urltemplate.buildEpisodeUrl({ template, baseUrl: s.baseUrl, season: pair.season, series: s.series }, pair.episode)
        : s.baseUrl || '';
      if (!url) {
        this.onLog(`No source URL for "${s.series}" S${season}E${e.episode} - skipping it.`);
        continue;
      }
      if (dubGate && dubbedOf.get(e.episode) !== true) {
        // Not dubbed (or unknown) yet. Once the season's dub has started, the
        // episode waits on the waiting-for-dub list (re-checked every 24 h).
        // Before the first dub of the season appears, the series just stays
        // on the watch list - nothing is queued or parked.
        notDubbed += 1;
        // Parking only adds to the waiting list (nothing is downloaded until
        // the dub is confirmed), so it also runs in report-only mode.
        if ((dubStarted || seasonWaiting) && dubbedOf.get(e.episode) === false) {
          const isNew = pending.add({
            label: organizer.buildBaseName({ series: s.series, season, episode: e.episode }),
            series: s.series,
            season,
            episode: e.episode,
            outputRoot: s.outputRoot,
            baseUrl: url,
            mode: 'dub',
            library: s.library || null,
            minHeight: s.minHeight || 0,
            anime: true,
            tmdb: s.tmdb,
            urlSeason: pair.season,
            urlEpisode: pair.episode,
            episodeName: e.name || ''
          });
          if (isNew) parked += 1;
        }
        continue;
      }
      if (dryRun) {
        // Report-only: record the gap, spend no bandwidth on it.
        missing.push(e.episode);
        continue;
      }
      const r = await bulk.queueOne(
        {
          url,
          series: s.series,
          season,
          episode: e.episode,
          mode: s.mode || 'dub',
          outputRoot: s.outputRoot,
          episodeName: e.name || '',
          library: s.library || null,
          minHeight: s.minHeight || 0,
          anime: !!s.anime,
          tmdb: s.tmdb || null
        },
        this.onLog
      );
      queued += r.queued || 0;
    }
    if (dubGate && notDubbed) {
      this.onLog(
        `"${s.series}" season ${season}: ${notDubbed} aired episode(s) not dubbed yet - ` +
          (dubStarted || seasonWaiting
            ? `${parked} newly added to the waiting-for-dub list.`
            : 'the English dub has not started for this season; watching until it does.')
      );
    }
    return { queued, present, missing };
  }

  // Fallback: the source page itself lists the episode count (catalog sites).
  // Kept for titles without a TMDB id; same add-only guarantees because
  // startBatch -> queueOne -> existingKeepsEpisode refuse to touch files that
  // are already on disk.
  async checkSeriesLegacy(s) {
    const runOpts = {
      stopRunOnFail: false,
      library: s.library || null,
      minHeight: s.minHeight || 0,
      anime: !!s.anime
    };
    const entry = {
      series: s.series,
      season: s.season,
      baseUrl: s.baseUrl,
      template: s.template,
      startEp: '1',
      endEp: '',
      mode: s.mode || 'dub'
    };
    let r = null;
    try {
      r = await bulk.startBatch([entry], s.outputRoot, this.onLog, runOpts);
    } catch (e) {
      this.onLog(`Schedule check failed for "${s.series}": ${e.message}`);
    }
    // New-season probe (only templates that can be filled for any season).
    if (
      r &&
      r.queued === 0 &&
      Number(s.season) > 0 &&
      typeof s.template === 'string' &&
      urltemplate.hasSeasonToken(s.template)
    ) {
      const next = Number(s.season) + 1;
      try {
        const probeUrl = urltemplate.fill(s.template, { season: next, episode: 1 });
        if (probeUrl) {
          const det = await bulk.detectEpisodes(probeUrl, this.onLog, { season: next });
          const found = (det && det.list && det.list.length > 0) || (det && det.max > 0);
          if (found) {
            this.onLog(`New season detected: "${s.series}" season ${next} - queuing its new episodes.`);
            await bulk.startBatch(
              [
                {
                  series: s.series,
                  season: next,
                  baseUrl: s.baseUrl,
                  template: s.template,
                  startEp: '1',
                  endEp: 'auto',
                  mode: s.mode || 'dub'
                }
              ],
              s.outputRoot,
              this.onLog,
              runOpts
            );
            schedule.bumpSeason(s.key, next);
            return 1;
          }
        }
      } catch (e) {
        // Next season is not out yet (or the probe failed) - stay on this one.
      }
    }
    return 0;
  }

  // ---- waiting-for-dub list -------------------------------------------------

  async checkNow() {
    const items = pending.list();
    if (!items.length) return { checked: 0 };
    const dubstatus = require('./dubstatus');
    const dubTally = new Map(); // series|season -> { released, waiting }
    const dryRun = this.watcherMode().dryRun;
    this.onLog(
      `Checking ${items.length} pending dub(s) for new releases...` +
        (dryRun ? ' (report only - nothing will be re-queued)' : '')
    );

    for (const spec of items) {
      const url = urltemplate.buildEpisodeUrl(
        { template: spec.template, baseUrl: spec.baseUrl, season: spec.season, series: spec.series },
        spec.episode
      );
      if (!url) {
        this.onLog(`Pending "${spec.label}" has no usable URL/template; skipping.`);
        continue;
      }

      // Already downloaded out-of-band? Clear it. Staging OR any library drive
      // counts - checking staging alone re-downloads episodes that are already
      // in the library.
      let onDisk = false;
      const meta = { series: spec.series, season: spec.season, episode: spec.episode };
      for (const root of this.rootsFor(spec)) {
        try {
          // Any video container (.mkv etc.), like every other presence check.
          if (root && organizer.existingEpisodeFile(root, meta)) {
            onDisk = true;
            break;
          }
        } catch (e) {
          // unreadable root
        }
      }
      if (onDisk) {
        // Clearing an entry that is on disk is safe in every mode.
        pending.remove(spec.key);
        continue;
      }

      // Anime DUB entries: ask the source whether the dub is out before
      // spending anything on it. Not out -> stays on the list (checked again
      // in 24 h). Out -> queued even in report-only mode: these are episodes
      // the user already asked for, not the scanner's guesses.
      const dubEntry = spec.anime && (spec.mode || 'dub') === 'dub' && spec.tmdb;
      if (dubEntry) {
        let dubbed = null;
        try {
          dubbed = await dubstatus.isDubbed(
            spec.tmdb,
            spec.urlSeason != null ? spec.urlSeason : spec.season,
            spec.urlEpisode != null ? spec.urlEpisode : spec.episode,
            { maxAgeMs: 60 * 60 * 1000 }
          );
        } catch (e) {
          dubbed = null;
        }
        const tk = `${spec.series}|${spec.season}`;
        const t = dubTally.get(tk) || { series: spec.series, season: spec.season, released: [], waiting: 0 };
        dubTally.set(tk, t);
        pending.markChecked(spec.key);
        if (dubbed !== true) {
          t.waiting += 1;
          continue;
        }
        t.released.push(spec.episode);
      } else if (dryRun) {
        this.onLog(`Pending dub "${spec.label}" still missing - report only, not re-queued.`);
        pending.markChecked(spec.key);
        continue;
      }

      pending.markChecked(spec.key);
      // Same fields bulk.queueOne gives an item: the URL picks the site (and
      // the headless Vidsrc path + per-site limits), and lets the item be
      // restored after a restart.
      const rec = {
        label: spec.label,
        series: spec.series,
        season: spec.season,
        episode: spec.episode,
        mode: spec.mode || 'dub',
        outputRoot: spec.outputRoot,
        stopRunOnFail: false, // watcher must never nuke the queue
        library: spec.library || null,
        minHeight: spec.minHeight || 0,
        anime: !!spec.anime,
        tmdb: spec.tmdb || null,
        url,
        baseUrl: url,
        template: spec.template || null,
        key: spec.key,
        skipSources: [],
        onUnavailable: () => pending.markChecked(spec.key),
        onDone: () => pending.remove(spec.key)
      };
      rec.discover = bulk.makeDiscover(url, this.onLog, rec.mode, () => ({
        skipSources: rec.skipSources,
        anime: rec.anime,
        minHeight: rec.minHeight,
        series: rec.series,
        season: rec.season,
        skipSourceSite: !!rec._wrongAudio
      }));
      manager.add(rec);
    }
    for (const t of dubTally.values()) {
      const out = t.released.length
        ? `English dub out for E${t.released.join(', E')} - queued`
        : 'no new English-dubbed episodes';
      this.onLog(`"${t.series}" season ${t.season}: ${out}; ${t.waiting} episode(s) still waiting for their dub.`);
    }
    return { checked: items.length };
  }
}

module.exports = new Watcher();
module.exports.airedEpisodes = airedEpisodes;
module.exports.withManagerLog = withManagerLog; // exposed for tests
