#!/usr/bin/env node
'use strict';
/**
 * Anime library audit (READ-ONLY): would the engine / watch list download
 * anything you already have?
 *
 * For every series (folders of the same show on several drives are merged):
 *   1. the TMDB id - taken from the folder name when it carries one
 *      ("Haikyu!! (2014) [tmdb-60863]"), else a name + year search (animation
 *      only, the plugin's rule);
 *   2. the season list exactly as the plugin shows it, in the library's
 *      numbering (AniDB-style "anime", or TMDB's);
 *   3. for EVERY episode of that list, whether the engine's own "already in
 *      the library?" check (organizer.existingEpisodeFile - the one the queue
 *      and the watch list run) finds it on any of the drives. Loose files in
 *      the series folder count exactly as the engine counts them;
 *   4. what could cause a duplicate:
 *        MISMATCH  a "Season N" folder (or episode numbers) the layout does
 *                  not have, or the engine would not find your folder at all
 *                  under the TMDB name (it would start a second folder);
 *        WARN      video files the engine cannot attribute to any episode
 *                  (it would download those episodes again), or the anime
 *                  numbering could not be built (TMDB's seasons were used).
 *
 * Nothing is downloaded, renamed or written - it only reads folders and asks
 * TMDB / AniList / Aniwave.
 *
 * Usage (on the engine PC, from the repo folder):
 *   node scripts/audit-anime-library.js "A:\Anime" "S:\Anime" "T:\Anime"
 *   node scripts/audit-anime-library.js "\\192.168.0.74\Selfhost1\Anime" --limit 30
 *   node scripts/audit-anime-library.js "A:\Anime" --only "Link Click,Ranma"
 * Options:
 *   --limit N          series to check (default 0 = all)
 *   --numbering X      anime (AniDB/AniList library, default) or tmdb
 *   --only a,b         only series whose folder name contains one of these
 *   --json file        also write the full report as JSON
 *   --add-watch a,b    put these titles on the engine's watch list (engine
 *                      must be running); it downloads the missing aired
 *                      episodes at engine start and daily after
 *   --library X        library for --add-watch (default "Anime")
 *   --mode dub|sub     default dub (anime: English dub only; others wait)
 *   --min-height N     default 1080
 *   --watch-live       also switch the watcher out of report-only mode
 *
 * Needs the engine's TMDB key (engine.json "tmdbApiKey", or TMDB_API_KEY).
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'main');
const tmdb = require(path.join(SRC, 'tmdb.js'));
const animelayout = require(path.join(SRC, 'anime-layout.js'));
const organizer = require(path.join(SRC, 'organizer.js'));

const OPTS_WITH_VALUE = new Set(['--limit', '--numbering', '--only', '--json', '--add-watch', '--library', '--mode', '--min-height']);
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}
function roots() {
  const out = [];
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (OPTS_WITH_VALUE.has(a[i])) { i += 1; continue; }
    if (a[i].startsWith('--')) continue;
    out.push(a[i]);
  }
  return out;
}

const VIDEO = new Set((organizer.VIDEO_EXTS || ['.mp4', '.mkv', '.avi', '.m4v', '.ts']).map((x) => x.toLowerCase()));

// "Haikyu!! (2014) [tmdb-60863]" -> { name: "Haikyu!!", year: 2014, tmdb: "60863" }
// Windows folder names replace ":" and "?" with "_": "Hakkenden_ Eight Dogs".
function folderTitle(base) {
  let s = String(base || '');
  let id = '';
  const m = s.match(/[[{(]\s*tmdb(?:id)?[-=\s]*(\d+)\s*[\]})]/i);
  if (m) id = m[1];
  s = s.replace(/\s*[[{(]\s*(?:tmdb|tvdb|imdb|anidb|anilist)(?:id)?[-=\s]*[A-Za-z0-9]+\s*[\]})]/gi, ' ');
  let year = 0;
  const y = s.match(/\s*\((\d{4})\)\s*$/);
  if (y) { year = Number(y[1]); s = s.slice(0, y.index); }
  const name = s.replace(/_(\s)/g, ':$1').replace(/_$/, '?').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return { name, year, tmdb: id };
}

// Every video file under a series folder (3 levels), with the "Season N"
// folder it sits in (null = loose / non-season folder).
function listVideos(dir) {
  const out = [];
  const walk = (d, depth, season) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3 && !e.name.startsWith('.')) {
          const n = organizer.seasonFromName(e.name);
          walk(full, depth + 1, n != null ? n : season);
        }
      } else if (VIDEO.has(path.extname(e.name).toLowerCase())) {
        out.push({ path: full, season, name: e.name });
      }
    }
  };
  walk(dir, 0, null);
  return out;
}

function tmdbKey() {
  let k = process.env.TMDB_API_KEY || '';
  try { k = k || require(path.join(SRC, 'engineconfig.js')).get().tmdbApiKey || ''; } catch (e) { /* none */ }
  return String(k).trim();
}

async function searchTmdb(name, year) {
  const key = tmdbKey();
  if (!key) throw new Error('no TMDB key (engine.json "tmdbApiKey" or TMDB_API_KEY)');
  const queries = [...new Set([name, animelayout.cleanAnimeTitle(name), name.split(':')[0].trim()])].filter((q) => q && q.length > 1);
  let best = null;
  for (const q of queries) {
    const body = await tmdb.tmdbFetch(`/search/tv?query=${encodeURIComponent(q)}&include_adult=false&language=en-US`, key);
    const pick = animelayout.pickTmdbAnime((body && body.results) || [], [name], year);
    if (pick && (!best || pick.score > best.score)) best = pick;
  }
  return best;
}

const range = (nums) => {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  if (!a.length) return '-';
  const out = [];
  let s = a[0];
  let p = a[0];
  for (const n of a.slice(1).concat([null])) {
    if (n === p + 1) { p = n; continue; }
    out.push(s === p ? `E${s}` : `E${s}-E${p}`);
    if (n != null) { s = n; p = n; }
  }
  return out.join(',');
};

// Series folders across all roots, grouped by show: same TMDB id in the
// folder name, or the engine's own folder match (exact key / fuzzy).
function collectSeries(rootList) {
  const groups = [];
  for (const root of rootList) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
      console.error(`Cannot read ${root}: ${e.message}`);
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || /^\$|^System Volume/i.test(e.name)) continue;
      const t = folderTitle(e.name);
      const entry = { root, dir: path.join(root, e.name), folder: e.name, ...t };
      // Same id, or the engine's name match - never two different ids.
      const g = groups.find((x) => (t.tmdb && x.tmdb === t.tmdb) ||
        (!(t.tmdb && x.tmdb && x.tmdb !== t.tmdb) && x.entries.some((y) => organizer.fuzzySeriesMatch(y.name, t.name))));
      if (g) {
        g.entries.push(entry);
        if (!g.tmdb && t.tmdb) g.tmdb = t.tmdb;
        if (!g.year && t.year) g.year = t.year;
      } else {
        groups.push({ name: t.name, year: t.year, tmdb: t.tmdb, entries: [entry] });
      }
    }
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

async function auditOne(g, rootList, numbering) {
  const row = { series: g.name, folders: g.entries.map((e) => e.dir), status: 'OK', problems: [], warnings: [], notes: [], seasons: [] };
  const sameRoot = new Map();
  for (const e of g.entries) sameRoot.set(e.root, (sameRoot.get(e.root) || 0) + 1);
  if ([...sameRoot.values()].some((n) => n > 1)) {
    row.warnings.push(`Several folders for this show on one drive: ${g.entries.map((e) => `"${e.folder}"`).join(', ')} - merge them into one.`);
  }

  let id = g.tmdb;
  let how = 'folder id';
  if (!id) {
    const hit = await searchTmdb(g.name, g.year);
    if (!hit) {
      row.status = 'NO_TMDB';
      row.problems.push(`No TMDB animation series named "${g.name}"${g.year ? ` (${g.year})` : ''} - add the id to the folder name, e.g. "${g.name} [tmdbid-12345]".`);
      return row;
    }
    id = String(hit.id);
    how = 'name search';
  }
  const info = await tmdb.tmdbInfo(id, 'tv', { anime: true, numbering });
  if (!info) {
    row.status = 'ERROR';
    row.problems.push(`TMDB id ${id} could not be read as a TV series${how === 'folder id' ? ' - the folder\'s [tmdb-' + id + '] may be a movie id or wrong' : ''}.`);
    return row;
  }
  row.tmdb = id;
  row.tmdbName = info.title;
  row.tmdbYear = info.year;
  row.idFrom = how;
  row.numbering = info.numbering || 'tmdb';
  if (numbering === 'anime' && info.numbering !== 'anime') {
    row.warnings.push('Anime (AniDB) numbering could not be built - TMDB\'s seasons were used: ' + (info.numberingNote || 'anime sites unreachable'));
  }

  // The name the plugin / watch list files this show under (TMDB's), and
  // whether the engine finds YOUR folder from it.
  const series = info.title || g.name;
  const found = rootList.map((r) => organizer.existingSeriesFolder(r, { series, tmdb: id })).filter(Boolean);
  if (!found.length) {
    row.problems.push(`The engine would not find your folder under TMDB's name "${series}" - it would start a new folder and download everything again. Add the id to your folder name: "${g.entries[0].folder} [tmdbid-${id}]".`);
  }
  // A folder id whose TMDB title shares no word with the folder name is
  // probably the wrong id (Galaxy Angel A [tmdb-96860] is "A3!").
  if (how === 'folder id') {
    const words = (x) => new Set(organizer.normSeries(x).split(' ').filter((w) => w.length > 2));
    const a = words(g.name);
    const b = words(series);
    if (a.size && b.size && ![...a].some((w) => b.has(w))) {
      row.warnings.push(`The folder's [tmdb-${id}] is TMDB's "${series}" - check it is the right show (episode counts and new episodes come from it).`);
    }
  }

  // Every layout episode -> the file the engine's check finds (any drive).
  const attributed = new Set();
  const layout = (info.seasons || []).filter((s) => s.season > 0);
  organizer.withScanCache(() => {
    for (const s of layout) {
      const have = [];
      const miss = [];
      for (let ep = 1; ep <= (Number(s.episodes) || 0); ep++) {
        let file = null;
        // Exactly what the queue / watch list check: folder by id, plus the
        // episode's other identities (TMDB pair, absolute number).
        const alt = tmdb.episodeAlternatesFromInfo(info, numbering, s.season, ep);
        for (const r of rootList) {
          file = organizer.existingEpisodeFile(r, { series, tmdb: id, season: s.season, episode: ep, alt });
          if (!file && series !== g.name) file = organizer.existingEpisodeFile(r, { series: g.name, tmdb: id, season: s.season, episode: ep, alt });
          if (file) break;
        }
        if (file) { have.push(ep); attributed.add(path.resolve(file)); } else miss.push(ep);
      }
      row.seasons.push({ season: s.season, layoutEpisodes: Number(s.episodes) || 0, have: range(have), haveCount: have.length, missing: range(miss), missingCount: miss.length });
    }
  });

  // What is on disk that the layout cannot place.
  const videos = g.entries.flatMap((e) => listVideos(e.dir));
  const layoutSeasons = new Map(layout.map((s) => [s.season, Number(s.episodes) || 0]));
  const diskSeasons = new Map();
  for (const v of videos) {
    if (v.season == null || v.season === 0) continue;
    if (!diskSeasons.has(v.season)) diskSeasons.set(v.season, []);
    diskSeasons.get(v.season).push(v);
  }
  let stray = videos.filter((v) => !attributed.has(path.resolve(v.path)) && v.season !== 0 && !/\b(?:specials?|extras?|ova|ovas|movies?|featurettes?)\b/i.test(path.relative(path.dirname(v.path), v.path) + ' ' + path.basename(path.dirname(v.path))));
  // Leftover temp files from an interrupted download ("..._temp_5572_1769819228608.mp4").
  const temps = stray.filter((v) => /_temp_\d+_\d+/i.test(v.name));
  stray = stray.filter((v) => !temps.includes(v));
  if (temps.length) row.notes.push(`${temps.length} leftover temp file(s) from an interrupted download (e.g. "${temps[0].name}") - safe to delete once the real episode plays.`);
  // A second copy of an episode the engine already finds (same S/E marker as
  // a recognized file - backup folders like "_Fix_Backup").
  const markerOf = (name) => { const m = String(name).match(/s0*(\d{1,3})e0*(\d{1,4})(?!\d)/i); return m ? m[1] + 'x' + m[2] : null; };
  const foundMarkers = new Set(videos.filter((v) => attributed.has(path.resolve(v.path))).map((v) => markerOf(v.name)).filter(Boolean));
  const copies = stray.filter((v) => markerOf(v.name) && foundMarkers.has(markerOf(v.name)));
  stray = stray.filter((v) => !copies.includes(v));
  if (copies.length) row.notes.push(`${copies.length} extra copy/copies of episodes already found (e.g. "${path.relative(g.entries[0].root, copies[0].path)}") - not downloaded again; delete if unwanted.`);
  // Season folders whose files the engine cannot place in the layout under
  // ANY identity: those episodes would be downloaded again.
  const maxLayout = Math.max(0, ...layoutSeasons.keys());
  for (const [n, files] of [...diskSeasons.entries()].sort((a, b) => a[0] - b[0])) {
    const lost = files.filter((f) => stray.includes(f));
    if (!lost.length) continue;
    // OVA/special groupings are numbered far above any real season
    // ("S44", "S45"); a lumped TMDB layout (One Piece: 1 season) still has
    // real season folders 2..20 on disk, so only very high numbers count.
    if (n >= 40 && n > maxLayout + 5) {
      row.notes.push(`"Season ${n}" (${files.length} files) looks like specials/OVAs - the engine never downloads into it.`);
      continue;
    }
    const count = layoutSeasons.get(n);
    if (count == null) {
      row.problems.push(`"Season ${n}" is on disk (${lost.length} unrecognized files) but the layout has no Season ${n} - those episodes would be offered again under other numbers.`);
      continue;
    }
    const over = lost.map((f) => organizer.episodeNumberFromName(f.name)).filter((e) => e > count);
    if (over.length) row.problems.push(`Season ${n}: disk has ${range(over)} but the layout's Season ${n} has only ${count} episodes, and they match no other numbering.`);
  }
  row.files = videos.length;
  row.unattributed = stray.length;
  if (stray.length) {
    row.warnings.push(`${stray.length} of ${videos.length} video file(s) are not recognized as any episode of the layout (e.g. "${path.relative(g.entries[0].root, stray[0].path)}") - if they are episodes, they would be downloaded again.`);
  }
  const loose = videos.filter((v) => v.season == null).length;
  if (loose) row.notes.push(`${loose} file(s) outside "Season N" folders (counted when the engine can read their episode number).`);
  if (g.entries.length > 1) row.notes.push(`Merged ${g.entries.length} folders: ${g.entries.map((e) => e.dir).join(' | ')}`);

  // What the watch list would do with this title (same guards as the daily
  // check): frozen by the risk list, or held by the layout-safety check.
  row.seasonsMissing = row.seasons.filter((x) => x.missingCount > 0).map((x) => x.season);
  try {
    const risk = ((require(path.join(SRC, 'engineconfig.js')).get() || {}).riskSeries || []).map(String);
    if (risk.includes(String(id))) row.notes.push('Watch list: FROZEN (its TMDB id is in the engine\'s risk list) - it would download nothing until cleared.');
  } catch (e) { /* no engine config */ }
  try {
    const sourceTotal = layout.reduce((a, x) => a + (Number(x.episodes) || 0), 0);
    const lr = organizer.seriesLayoutRiskFor(rootList, series, sourceTotal);
    row.watchHold = lr && lr.mode === 'hold' ? lr.reason : null;
    if (row.watchHold) row.warnings.push(`Watch list would HOLD this title (downloads nothing): ${lr.reason}.`);
  } catch (e) { /* best effort */ }

  if (row.problems.length) row.status = 'MISMATCH';
  else if (row.warnings.length) row.status = 'WARN';
  return row;
}

// ---- --add-watch: put titles with missing episodes on the engine's watch list
// (POST /api/schedules on the running engine). The daily check - and the one
// at engine start - then downloads every AIRED episode it does not find on any
// drive (English dub only for anime in dub mode: the rest wait for their dub),
// starting at the first season with a gap and moving on season by season.
function engineRequest(method, p, body) {
  const ec = require(path.join(SRC, 'engineconfig.js')).get() || {};
  const port = Number(ec.port) || 7878;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign(
      { Authorization: 'Bearer ' + ec.apiKey },
      payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) { j = null; }
        if (res.statusCode >= 400) reject(new Error(`engine answered ${res.statusCode}: ${d.slice(0, 200)}`));
        else resolve(j);
      });
    });
    req.on('error', (e) => reject(new Error(`engine not reachable on 127.0.0.1:${port} (${e.message}) - start the engine and run this again`)));
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function addToWatch(rows, rootList, numbering) {
  const terms = String(arg('add-watch', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return;
  const libName = arg('library', 'Anime');
  const mode = arg('mode', 'dub') === 'sub' ? 'sub' : 'dub';
  const minHeight = Number(arg('min-height', '1080')) || 0;
  console.log(`\nAdding to the watch list (library "${libName}", ${mode.toUpperCase()}, ${minHeight || 'any'}p):`);
  for (const r of rows) {
    const name = String(r.series || '').toLowerCase();
    const tname = String(r.tmdbName || '').toLowerCase();
    if (!terms.some((t) => name.includes(t) || tname.includes(t))) continue;
    if (!r.tmdb) { console.log(`  skip  ${r.series}: no TMDB id`); continue; }
    if (!r.seasonsMissing || !r.seasonsMissing.length) { console.log(`  skip  ${r.series}: nothing missing`); continue; }
    if (r.watchHold) { console.log(`  skip  ${r.series}: the watch list would hold it (${r.watchHold})`); continue; }
    const season = Math.min(...r.seasonsMissing);
    const spec = {
      series: r.tmdbName || r.series,
      season,
      mode,
      baseUrl: `https://vidsrc.sh/embed/tv/${r.tmdb}-${season}-1`,
      library: { id: libName, name: libName, locations: rootList },
      minHeight,
      tmdb: String(r.tmdb),
      anime: true,
      movie: false,
      numbering
    };
    try {
      const res = await engineRequest('POST', '/api/schedules', spec);
      const miss = r.seasons.filter((x) => x.missingCount > 0).map((x) => `S${x.season} ${x.missing}`).join('; ');
      console.log(`  ${res && res.added ? 'added' : 'kept '} ${spec.series} from season ${season} - missing: ${miss}`);
    } catch (e) {
      console.log(`  FAIL  ${spec.series}: ${e.message}`);
      if (/not reachable/.test(e.message)) return;
    }
  }
  try {
    if (process.argv.includes('--watch-live')) {
      await engineRequest('POST', '/api/schedules/mode', { dryRun: false });
      console.log('Watcher switched to LIVE: the next check downloads (for every watched title).');
    } else {
      const st = await engineRequest('GET', '/api/schedules');
      if (st && st.dryRun !== false) {
        console.log('NOTE: the watcher is in REPORT-ONLY mode - it lists these episodes but downloads nothing.');
        console.log('      Re-run with --watch-live (or switch it off in the engine) to let it download.');
      } else {
        console.log('Watcher is LIVE: the missing episodes download on the next check (engine start, then daily).');
      }
    }
  } catch (e) {
    console.log('Could not read the watcher mode: ' + e.message);
  }
}

async function main() {
  const rootList = roots();
  if (!rootList.length) {
    console.error('Usage: node scripts/audit-anime-library.js "<anime folder>" ["<another drive\'s anime folder>" ...] [--limit N] [--numbering anime|tmdb] [--only "a,b"] [--json out.json]');
    process.exit(2);
  }
  const limit = Number(arg('limit', '0'));
  const numbering = arg('numbering', 'anime') === 'tmdb' ? 'tmdb' : 'anime';
  const only = String(arg('only', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  let groups = collectSeries(rootList);
  if (only.length) groups = groups.filter((g) => g.entries.some((e) => only.some((o) => e.folder.toLowerCase().includes(o))));
  if (limit > 0) groups = groups.slice(0, limit);
  console.log(`Auditing ${groups.length} series in ${rootList.join(', ')} (numbering: ${numbering === 'anime' ? 'AniDB-style' : 'TMDB'})...\n`);
  const rows = [];
  for (const g of groups) {
    let row;
    try { row = await auditOne(g, rootList, numbering); } catch (e) { row = { series: g.name, status: 'ERROR', problems: [e.message], warnings: [], notes: [], seasons: [] }; }
    rows.push(row);
    console.log(`${row.status.padEnd(8)} ${row.series}${row.tmdb ? `  [TMDB ${row.tmdb} "${row.tmdbName}" ${row.tmdbYear || ''}, id from ${row.idFrom}]` : ''}`);
    for (const s of row.seasons) {
      console.log(`           Season ${s.season}: ${s.layoutEpisodes} eps | engine finds ${s.haveCount} (${s.have})${s.missingCount ? ` | would download ${s.missingCount} (${s.missing})` : ''}`);
    }
    for (const p of row.problems) console.log('           !! ' + p);
    for (const w of row.warnings) console.log('           ?? ' + w);
    for (const n of row.notes) console.log('           -- ' + n);
  }
  const by = (st) => rows.filter((r) => r.status === st).length;
  console.log(`\nSummary: ${by('OK')} OK, ${by('WARN')} warning, ${by('MISMATCH')} numbering mismatch, ${by('NO_TMDB')} no TMDB match, ${by('ERROR')} error.`);
  console.log('!! MISMATCH: the engine would number or file some episodes differently from your folders - keep those titles off the watch list until fixed.');
  console.log('?? WARN: check the named files; everything else lines up.');
  console.log('"would download" = episodes the engine does not find on any drive (missing, or named in a way it cannot read).');
  await addToWatch(rows, rootList, numbering);
  const out = arg('json', '');
  if (out) {
    fs.writeFileSync(out, JSON.stringify(rows, null, 2));
    console.log('Full report: ' + out);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Audit failed:', (e && e.stack) || e);
    process.exit(1);
  });
}

module.exports = { folderTitle, collectSeries, listVideos, auditOne, addToWatch };
