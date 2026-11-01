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
 *
 * Needs the engine's TMDB key (engine.json "tmdbApiKey", or TMDB_API_KEY).
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'main');
const tmdb = require(path.join(SRC, 'tmdb.js'));
const animelayout = require(path.join(SRC, 'anime-layout.js'));
const organizer = require(path.join(SRC, 'organizer.js'));

const OPTS_WITH_VALUE = new Set(['--limit', '--numbering', '--only', '--json']);
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
      const g = groups.find((x) => (t.tmdb && x.tmdb === t.tmdb) ||
        x.entries.some((y) => organizer.fuzzySeriesMatch(y.name, t.name)));
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
  if (!info) { row.status = 'ERROR'; row.problems.push(`TMDB id ${id} could not be read`); return row; }
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
  const found = rootList.map((r) => organizer.existingSeriesFolder(r, { series })).filter(Boolean);
  if (!found.length) {
    row.problems.push(`The engine would not find your folder under TMDB's name "${series}" - it would start a new "${organizer.sanitize(series)}" folder and download everything again. Rename the folder to "${organizer.sanitize(series)}"${info.year ? ` (${info.year})` : ''}.`);
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
        for (const r of rootList) {
          file = organizer.existingEpisodeFile(r, { series, season: s.season, episode: ep });
          if (!file && series !== g.name) file = organizer.existingEpisodeFile(r, { series: g.name, season: s.season, episode: ep });
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
  for (const [n, files] of [...diskSeasons.entries()].sort((a, b) => a[0] - b[0])) {
    const count = layoutSeasons.get(n);
    if (count == null) {
      row.problems.push(`"Season ${n}" is on disk (${files.length} files) but the layout has no Season ${n} - those episodes would be offered again under other numbers.`);
      continue;
    }
    const over = files.map((f) => organizer.episodeNumberFromName(f.name)).filter((e) => e > count);
    if (over.length) row.problems.push(`Season ${n}: disk has ${range(over)} but the layout's Season ${n} has only ${count} episodes.`);
  }
  const stray = videos.filter((v) => !attributed.has(path.resolve(v.path)) && v.season !== 0 && !/\b(?:specials?|extras?|ova|ovas|movies?|featurettes?)\b/i.test(path.relative(path.dirname(v.path), v.path) + ' ' + path.basename(path.dirname(v.path))));
  row.files = videos.length;
  row.unattributed = stray.length;
  if (stray.length) {
    row.warnings.push(`${stray.length} of ${videos.length} video file(s) are not recognized as any episode of the layout (e.g. "${path.relative(g.entries[0].root, stray[0].path)}") - if they are episodes, they would be downloaded again.`);
  }
  const loose = videos.filter((v) => v.season == null).length;
  if (loose) row.notes.push(`${loose} file(s) outside "Season N" folders (counted when the engine can read their episode number).`);
  if (g.entries.length > 1) row.notes.push(`Merged ${g.entries.length} folders: ${g.entries.map((e) => e.dir).join(' | ')}`);

  if (row.problems.length) row.status = 'MISMATCH';
  else if (row.warnings.length) row.status = 'WARN';
  return row;
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

module.exports = { folderTitle, collectSeries, listVideos, auditOne };
