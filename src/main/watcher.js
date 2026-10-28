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
const engineconfig = require('./engineconfig');
const placer = require('./placer');

const DAY_MS = 24 * 60 * 60 * 1000;

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
    this.tick();
    this.timer = setInterval(() => this.tick(), DAY_MS);
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
    this.checkNow();
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
  async checkSchedules() {
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
    if (!info || !(info.seasons || []).length) {
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

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const aired = eps.filter((e) => !e.airDate || String(e.airDate).slice(0, 10) <= today);
    const notAired = eps.length - aired.length;
    if (!aired.length) {
      this.onLog(`"${s.series}" season ${season}: no episodes have aired yet.`);
      return 0;
    }

    const { queued, present, missing } = await this.queueMissingEps(s, season, aired, urlMap, template, roots, dryRun);
    const fresh = aired.length - present;
    this.onLog(
      `"${s.series}" season ${season}: ${aired.length} aired, ${present} already on disk, ${queued} new queued` +
        (dryRun && missing.length ? `, ${missing.length} missing (${missing.map((n) => `E${n}`).join(', ')}) - report only, nothing queued` : '') +
        (notAired ? `, ${notAired} not out yet (skipped until they air)` : '') + '.'
    );

    // Caught up on this season? Check the next one (anime layout included -
    // info.seasons is authoritative for anime). In report-only mode the next
    // season is still REPORTED (aired/on disk/missing) but nothing is queued
    // and the watch season is NOT advanced.
    if (present >= aired.length && fresh === 0) {
      const next = seasonNums.find((x) => x === season + 1);
      if (next) {
        const nextData = await tmdb.tmdbSeason(s.tmdb, next, { anime });
        const nextEps = (nextData && nextData.episodes) || [];
        const nextAired = nextEps.filter((e) => !e.airDate || String(e.airDate).slice(0, 10) <= today);
        if (nextAired.length) {
          if (dryRun) {
            const r = await this.queueMissingEps(s, next, nextAired, urlMap, template, roots, true);
            this.onLog(
              `"${s.series}" season ${next} (new): ${nextAired.length} aired, ${r.present} on disk, ${r.missing.length} missing` +
                (r.missing.length ? ` (${r.missing.map((n) => `E${n}`).join(', ')})` : '') +
                ` - report only, watch stays on season ${season}.`
            );
          } else {
            this.onLog(`New season detected: "${s.series}" season ${next} - queueing its new episodes.`);
            await this.queueMissingEps(s, next, nextAired, urlMap, template, roots, dryRun);
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
  async queueMissingEps(s, season, eps, urlMap, template, roots, dryRun) {
    let queued = 0;
    let present = 0;
    const missing = [];
    for (const e of eps) {
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
          anime: !!s.anime
        },
        this.onLog
      );
      queued += r.queued || 0;
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
      s.season &&
      typeof s.template === 'string' &&
      urltemplate.hasSeasonToken(s.template)
    ) {
      const next = s.season + 1;
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

  checkNow() {
    const items = pending.list();
    if (!items.length) return { checked: 0 };
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
          if (root && organizer.existingEpisodeFile(root, meta, '.mp4')) {
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

      if (dryRun) {
        this.onLog(`Pending dub "${spec.label}" still missing - report only, not re-queued.`);
        pending.markChecked(spec.key);
        continue;
      }

      pending.markChecked(spec.key);
      manager.add({
        label: spec.label,
        series: spec.series,
        season: spec.season,
        episode: spec.episode,
        outputRoot: spec.outputRoot,
        stopRunOnFail: false, // watcher must never nuke the queue
        library: spec.library || null,
        minHeight: spec.minHeight || 0,
        key: spec.key,
        discover: bulk.makeDiscover(url, this.onLog, spec.mode || 'dub'),
        onUnavailable: () => pending.markChecked(spec.key),
        onDone: () => pending.remove(spec.key)
      });
    }
    return { checked: items.length };
  }
}

module.exports = new Watcher();
module.exports.withManagerLog = withManagerLog; // exposed for tests
