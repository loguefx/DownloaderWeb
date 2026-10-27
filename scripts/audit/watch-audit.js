'use strict';

// Watch audit — READ-ONLY.
//
// Reports what the watcher's logic SEES for every title in the inventory:
//   - the authoritative season/episode layout for the title
//     (anime: Aniwave -> AniList, the same tiers the watcher uses;
//      tv: TMDB; movie: presence only - the watcher only checks "is it on disk");
//   - which of those episodes the RECOGNITION LOGIC (organizer.existingEpisodeFile,
//     the exact function the watcher calls) finds on disk, across ALL drives;
//   - the gap: aired/available episodes missing, whole seasons missing,
//     next-season status, and disk-vs-truth anomalies (disk has MORE than the
//     source lists - flagged, never "fixed").
//
// It writes NOTHING: no queue, no pending list, no downloads, no NAS writes,
// no file moves. Network calls are GET-only (Aniwave/AniList/TMDB).
//
// Usage:
//   node scripts/audit/watch-audit.js <inventoryJson> [options]
//     --types anime,tv,movie   default: all auditable types
//     --limit N                audit only the first N titles (smoke test)
//     --match NAME             only titles whose name contains NAME
//     --json OUT               also write the full report to OUT
//
// TMDB_API_KEY env enables the TV truth tier (and TMDB-backed anime tiers);
// without it, anime still resolves via Aniwave/AniList and TV is reported
// as "needs TMDB key".

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const organizer = require(path.join(REPO, 'src/main/organizer.js'));
const animelayout = require(path.join(REPO, 'src/main/anime-layout.js'));
const tmdb = require(path.join(REPO, 'src/main/tmdb.js'));

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
const INVENTORY = argv[0];
const TYPES = new Set((opt('--types') || 'anime,tv,movie').split(',').map((s) => s.trim()).filter(Boolean));
const LIMIT = opt('--limit') ? parseInt(opt('--limit'), 10) : Infinity;
const MATCH = opt('--match') ? opt('--match').toLowerCase() : null;
const JSON_OUT = opt('--json');
if (!INVENTORY) {
  console.error('usage: node watch-audit.js <inventoryJson> [--types anime,tv,movie] [--limit N] [--match NAME] [--json OUT]');
  process.exit(1);
}

const inv = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
const MIRROR = inv.mirrorRoot;
const tmdbKey = tmdb.getTmdbKey();
const today = new Date().toISOString().slice(0, 10);

// cleanTitle: strip the "(year)" / "[tmdb-…]" tokens the library bakes in.
function cleanTitle(name) {
  return String(name || '')
    .replace(/\s*\(\s*\[?\s*(?:tmdb|tvdb|imdb)[-\s]*[A-Za-z0-9]+\s*\]?\s*\)/gi, ' ')
    .replace(/\s*\[\s*(?:tmdb|tvdb|imdb)[-\s]*[A-Za-z0-9]+\s*\]/gi, ' ')
    .replace(/\s*\(\d{4}\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tmdbIdFromName(name) {
  const m = String(name || '').match(/\[\s*tmdb[-\s]*(\d+)\s*\]/i);
  return m ? m[1] : '';
}

// Is this (season, episode) recognized on disk for this title, across all its
// locations (every drive/category the title lives in)? Uses the SAME
// organizer.existingEpisodeFile the watcher calls.
function onDiskAnywhere(title, season, episode, epName) {
  // One inventory record = one category (all its locations share it).
  const root = path.join(MIRROR, title.category);
  for (const loc of title.locations) {
    try {
      if (organizer.existingEpisodeFile(root, { series: locTitleOf(loc, title), season, episode }, null, epName || '')) {
        return true;
      }
    } catch (e) {
      // unreadable mirror dir - keep checking other locations
    }
  }
  return false;
}
// The location's own folder name is the exact series name for recognition.
function locTitleOf(loc, title) {
  return (loc.path && loc.path.split(path.sep).pop()) || title.title;
}

// ---- truth tiers -----------------------------------------------------------

// Anime: Aniwave (TMDB-id keyed, keyless) -> AniList (search, keyless).
async function animeTruth(title) {
  const tmdbId = tmdbIdFromName(title.title) || title.locations.map((l) => tmdbIdFromName(l.path)).find(Boolean) || '';
  const clean = cleanTitle(title.title) || title.title;
  const resolved = await animelayout.resolveLayout(tmdbId, clean, { anime: true });
  if (resolved) {
    return {
      source: resolved.source,
      tmdbId,
      seasons: resolved.seasons
        .filter((s) => s && s.season > 0)
        .map((s) => ({
          season: s.season,
          episodes: (s.episodes || []).map((e) => ({ episode: e.episode, name: e.name || '' })),
          year: s.year || ''
        }))
    };
  }
  return null;
}

// TV: TMDB search (guarded match) -> info. Needs a key.
async function tvTruth(title) {
  if (!tmdbKey) return null;
  const clean = cleanTitle(title.title) || title.title;
  const body = await tmdb.tmdbFetch(`/search/tv?query=${encodeURIComponent(clean)}&language=en-US`, tmdbKey);
  const results = (body && body.results) || [];
  const hit = results
    .map((r) => ({ r, ok: animelayout.titlesMatch((r.name || ''), clean) }))
    .find((x) => x.ok);
  if (!hit) return null;
  const info = await tmdb.tmdbInfo(String(hit.r.id), 'tv', { anime: false });
  if (!info) return null;
  return { source: 'tmdb', tmdbId: String(hit.r.id), info, seasons: info.seasons };
}

// One season's episodes with air dates (TV "what has aired" decision).
async function tvSeasonEpisodes(tmdbId, season) {
  const data = await tmdb.tmdbSeason(tmdbId, season, { anime: false });
  if (!data) return null;
  return data.episodes.map((e) => ({
    episode: e.episode,
    name: e.name || '',
    aired: !e.airDate || String(e.airDate).slice(0, 10) <= today
  }));
}

// ---- audit -----------------------------------------------------------------

function seasonNumsOnDisk(title) {
  const out = new Set();
  for (const loc of title.locations) {
    for (const folderName of Object.keys(loc.seasons || {})) {
      if (folderName === (loc.path || '').split('/').pop()) { out.add(1); continue; } // files in the series root = flat layout
      const n = organizer.seasonFromName(folderName);
      if (n != null) out.add(n);
    }
    if (loc.flatFiles && loc.flatFiles.length) out.add(1); // flat layout = season 1
  }
  return [...out].sort((a, b) => a - b);
}

function auditAnime(title) {
  return (async () => {
    const truth = await animeTruth(title);
    if (!truth) {
      return { type: 'anime', title: title.title, status: 'no-truth', note: 'Aniwave/AniList have no layout for this title' };
    }
    const diskSeasons = seasonNumsOnDisk(title);
    const seasons = [];
    let missingEps = 0;
    for (const s of truth.seasons) {
      const present = [];
      const missing = [];
      for (const e of s.episodes) {
        if (onDiskAnywhere(title, s.season, e.episode, e.name)) present.push(e.episode);
        else missing.push(e.episode);
      }
      missingEps += missing.length;
      seasons.push({
        season: s.season,
        truthCount: s.episodes.length,
        presentCount: present.length,
        missing: missing.slice(0, 40),
        onDisk: diskSeasons.includes(s.season)
      });
    }
    const truthSeasons = new Set(truth.seasons.map((s) => s.season));
    const diskOnlySeasons = diskSeasons.filter((n) => !truthSeasons.has(n));
    const latestNum = truth.seasons[truth.seasons.length - 1].season;
    const latestRow = seasons.find((s) => s.season === latestNum);
    const latestComplete = latestRow && latestRow.truthCount > 0 && latestRow.presentCount >= latestRow.truthCount;
    return {
      type: 'anime',
      title: title.title,
      status: latestComplete ? (diskOnlySeasons.length ? 'up-to-date-extra-disk' : 'up-to-date') : 'missing-episodes',
      source: truth.source,
      tmdbId: truth.tmdbId,
      latestSeason: latestNum,
      latestProgress: latestRow ? `${latestRow.presentCount}/${latestRow.truthCount}` : 'n/a',
      missingTotal: missingEps,
      diskSeasons,
      diskOnlySeasons,
      seasons
    };
  })();
}

function auditTv(title) {
  return (async () => {
    if (!tmdbKey) {
      const diskSeasons = seasonNumsOnDisk(title);
      return {
        type: 'tv',
        title: title.title,
        status: 'needs-tmdb-key',
        diskSeasons,
        note: 'TMDB truth tier unavailable (no key) - on-disk seasons only'
      };
    }
    const truth = await tvTruth(title);
    if (!truth) {
      return { type: 'tv', title: title.title, status: 'no-truth', note: 'TMDB search found no matching series' };
    }
    const diskSeasons = seasonNumsOnDisk(title);
    const truthNums = truth.seasons.map((s) => s.season);
    const missingSeasons = truthNums.filter((n) => !diskSeasons.includes(n));
    // Audit the latest two truth seasons (where "new episodes" land) plus any
    // disk season whose episodes we should verify.
    const toAudit = [...new Set([...truthNums.slice(-2), ...diskSeasons])].sort((a, b) => b - a).slice(0, 4);
    const seasons = [];
    let missingAired = 0;
    for (const n of toAudit) {
      const eps = await tvSeasonEpisodes(truth.tmdbId, n);
      if (!eps) { seasons.push({ season: n, truthCount: 0, presentCount: 0, note: 'no TMDB episode data' }); continue; }
      const aired = eps.filter((e) => e.aired);
      const notAired = eps.length - aired.length;
      const missing = [];
      let presentCount = 0;
      for (const e of aired) {
        if (onDiskAnywhere(title, n, e.episode, e.name)) presentCount++;
        else missing.push(e.episode);
      }
      missingAired += missing.length;
      seasons.push({
        season: n,
        truthCount: eps.length,
        airedCount: aired.length,
        notAired,
        presentCount,
        missing: missing.slice(0, 40),
        onDisk: diskSeasons.includes(n)
      });
    }
    const latest = truthNums[truthNums.length - 1];
    const latestRow = seasons.find((s) => s.season === latest);
    const latestComplete = latestRow && latestCompleteRow(latestRow);
    return {
      type: 'tv',
      title: title.title,
      status: latestComplete && missingAired === 0 ? 'up-to-date' : 'missing-episodes',
      source: truth.source,
      tmdbId: truth.tmdbId,
      latestSeason: latest,
      latestProgress: latestRow ? `${latestRow.presentCount}/${latestRow.airedCount || latestRow.truthCount} aired` : 'n/a',
      missingTotal: missingAired,
      missingWholeSeasons: missingSeasons,
      diskSeasons,
      seasons
    };
  })();
}
function latestCompleteRow(row) {
  const target = row.airedCount != null ? row.airedCount : row.truthCount;
  return target > 0 && row.presentCount >= target;
}

function auditMovie(title) {
  // The watcher's movie rule: "is the file still there?" across all roots.
  const present = title.locations.some((loc) => {
    const root = path.join(MIRROR, title.category);
    try {
      return organizer.titleOnDisk(root, locTitleOf(loc, title));
    } catch (e) {
      return false;
    }
  });
  return {
    type: 'movie',
    title: title.title,
    status: present ? 'on-disk' : 'MISSING-from-disk',
    locations: title.locations.map((l) => l.path)
  };
}

// ---- run -------------------------------------------------------------------

(async () => {
  const titles = inv.titles.filter((t) =>
    TYPES.has(t.type) && (!MATCH || t.title.toLowerCase().includes(MATCH))
  );
  const take = titles.slice(0, LIMIT);
  const AUDIT = { anime: auditAnime, tv: auditTv, movie: auditMovie };

  // Concurrency pool with progress. Deliberately gentle: AniList rate-limits
  // bursts (a full parallel pass once lost 823/878 anime to 429s), so the
  // main pass runs at 3-wide, and any 'no-truth' anime get a SEQUENTIAL retry
  // pass below (the module's negative cache is per-process, so a retry that
  // succeeds replaces nothing - only the audit result is re-derived).
  const results = new Array(take.length);
  let done = 0;
  const t0 = Date.now();
  const progress = (extra) => {
    done++;
    if (done % 50 === 0 || done === take.length) {
      console.error(`  ...${done}/${take.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)${extra || ''}`);
    }
  };
  let i = 0;
  const workers = Array.from({ length: 3 }, async () => {
    while (i < take.length) {
      const idx = i++;
      try {
        results[idx] = await AUDIT[take[idx].type](take[idx]);
      } catch (e) {
        results[idx] = { type: take[idx].type, title: take[idx].title, status: 'error', note: e.message };
      }
      progress();
    }
  });
  await Promise.all(workers);

  // Retry pass: anime the tiers did not answer (rate limit or a search miss)
  // get one quiet sequential second look before being reported as 'no-truth'.
  const retryIdx = [];
  for (let k = 0; k < results.length; k++) {
    if (results[k] && results[k].type === 'anime' && results[k].status === 'no-truth') retryIdx.push(k);
  }
  if (retryIdx.length) {
    console.error(`  ...retrying ${retryIdx.length} no-truth anime sequentially`);
    animelayout._resetCache(); // drop the (possibly rate-limit-poisoned) negative cache
    let saved = 0;
    for (const k of retryIdx) {
      await new Promise((r) => setTimeout(r, 250)); // stay under the rate limit
      try {
        const again = await auditAnime(take[k]);
        if (again.status !== 'no-truth') {
          results[k] = again;
          saved++;
        }
      } catch (e) {
        // keep the original no-truth result
      }
    }
    console.error(`  ...retry recovered ${saved}/${retryIdx.length} anime truth layouts`);
  }

  // ---- report ----------------------------------------------------------------
  const groups = { anime: [], tv: [], movie: [] };
  for (const r of results) (groups[r.type] || (groups[r.type] = [])).push(r);

  const fmtTitle = (r) => {
    const pad = (s, n) => String(s).padEnd(n);
    const flag = r.status === 'up-to-date' || r.status === 'on-disk' ? '  OK ' :
      r.status === 'up-to-date-extra-disk' ? '  OK* ' :
      r.status === 'missing-episodes' ? ' MISS' :
      r.status === 'MISSING-from-disk' ? 'MISS!' : '  ??  ';
    return `${flag} ${r.title}`;
  };

  console.log('\n================ WATCH AUDIT (read-only) ================');
  console.log(`TMDB key: ${tmdbKey ? 'yes' : 'NO (TV truth tier disabled)'}   Anime tiers: Aniwave/AniList`);
  console.log(`Generated ${inv.generated} from ${inv.nas}\n`);

  for (const type of ['tv', 'anime', 'movie']) {
    const rows = groups[type] || [];
    if (!rows.length) continue;
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    console.log(`---- ${type.toUpperCase()} (${rows.length}) ----  ` + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  '));
    const interesting = rows.filter((r) => !String(r.status).startsWith('up-to-date') && r.status !== 'on-disk');
    for (const r of interesting.slice(0, 400)) {
      let detail = fmtTitle(r);
      if (r.type === 'movie' && r.status === 'MISSING-from-disk') detail += `   (${r.locations.join(' ; ')})`;
      if (r.missingTotal) detail += `   missing ${r.missingTotal}`;
      if (r.latestProgress) detail += `   latest S${r.latestSeason}: ${r.latestProgress}`;
      if (r.missingWholeSeasons && r.missingWholeSeasons.length) detail += `   whole seasons missing: ${r.missingWholeSeasons.join(',')}`;
      if (r.diskOnlySeasons && r.diskOnlySeasons.length) detail += `   [disk has extra seasons: ${r.diskOnlySeasons.join(',')} - verify]`;
      if (r.note) detail += `   (${r.note})`;
      console.log(detail);
      if (r.status === 'missing-episodes' && r.seasons) {
        for (const s of r.seasons) {
          if (s.missing && s.missing.length) {
            console.log(`        S${s.season}: ${s.presentCount}/${s.truthCount || s.airedCount} present; missing ${s.missing.slice(0, 12).join(', ')}${s.missing.length > 12 ? '…' : ''}`);
          }
        }
      }
    }
    const okCount = rows.length - Math.min(interesting.length, 400);
    if (okCount > 0) console.log(`        + ${okCount} more title(s) fully caught up / on disk (see JSON)`);
  }

  const summary = {
    generated: new Date().toISOString(),
    tmdbKeyPresent: !!tmdbKey,
    totals: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    statusCounts: {}
  };
  for (const [type, rows] of Object.entries(groups)) {
    summary.statusCounts[type] = {};
    for (const r of rows) summary.statusCounts[type][r.status] = (summary.statusCounts[type][r.status] || 0) + 1;
  }
  console.log('\n================ SUMMARY ================');
  console.log(JSON.stringify(summary, null, 1));
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));
    console.log(`Full report -> ${JSON_OUT}`);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
