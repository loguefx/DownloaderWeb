#!/usr/bin/env node
'use strict';
/**
 * Anime library audit (READ-ONLY): does the engine's season logic line up
 * with what is on disk?
 *
 * For each series folder in an anime library it:
 *   1. resolves the TMDB series id from the folder name (name + year match,
 *      animation only - the same rule the plugin uses),
 *   2. builds the season list exactly like the plugin shows it, in the
 *      library's numbering (AniDB-style "anime" or TMDB's),
 *   3. counts the episode files in each "Season N" folder,
 *   4. flags anything that could make the engine (or the watch list)
 *      download an episode you already have under another number.
 *
 * Nothing is downloaded, renamed or written - it only reads folders and asks
 * TMDB / AniList / Aniwave.
 *
 * Usage (on the engine PC, from the repo folder):
 *   node scripts/audit-anime-library.js "\\192.168.0.74\Selfhost1\Anime"
 *   node scripts/audit-anime-library.js "<folder>" --limit 30 --numbering anime
 *   node scripts/audit-anime-library.js "<folder>" --only "Link Click,Ranma"
 * Options:
 *   --limit N          series to check (default 30; 0 = all)
 *   --numbering X      anime (AniDB/AniList library, default) or tmdb
 *   --only a,b         only folders whose name contains one of these
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

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const VIDEO = new Set((organizer.VIDEO_EXTS || ['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.ts', '.webm']).map((x) => x.toLowerCase()));

// "Ranma 1/2 (2024)" -> { name: "Ranma 1/2", year: 2024 }
function folderTitle(dir) {
  const base = path.basename(dir);
  const m = base.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  return m ? { name: m[1].trim(), year: Number(m[2]) } : { name: base.trim(), year: 0 };
}

// Season folders and the episode numbers in each (files directly in the
// series folder are reported as "loose").
function scanSeries(dir) {
  const seasons = new Map();
  const loose = [];
  const add = (season, file) => {
    const ep = organizer.episodeNumberFromName(path.basename(file));
    if (!seasons.has(season)) seasons.set(season, { episodes: new Set(), files: 0, unnumbered: [] });
    const s = seasons.get(season);
    s.files += 1;
    if (ep > 0) s.episodes.add(ep);
    else s.unnumbered.push(path.basename(file));
  };
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { seasons, loose, error: e.message }; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const n = organizer.seasonFromName(e.name);
      if (n == null) continue;
      let files = [];
      try { files = fs.readdirSync(full); } catch (err) { continue; }
      for (const f of files) if (VIDEO.has(path.extname(f).toLowerCase())) add(n, path.join(full, f));
    } else if (VIDEO.has(path.extname(e.name).toLowerCase())) {
      loose.push(e.name);
    }
  }
  return { seasons, loose };
}

async function resolveTmdb(name, year) {
  const key = String(process.env.TMDB_API_KEY || (require(path.join(SRC, 'engineconfig.js')).get().tmdbApiKey) || '').trim();
  if (!key) throw new Error('no TMDB key (engine.json "tmdbApiKey" or TMDB_API_KEY)');
  const queries = [...new Set([name, animelayout.cleanAnimeTitle(name)])].filter(Boolean);
  let best = null;
  for (const q of queries) {
    const body = await tmdb.tmdbFetch(`/search/tv?query=${encodeURIComponent(q)}&include_adult=false&language=en-US`, key);
    const pick = animelayout.pickTmdbAnime((body && body.results) || [], [name], year);
    if (pick && (!best || pick.score > best.score)) best = pick;
  }
  return best;
}

const range = (set) => {
  const a = [...set].sort((x, y) => x - y);
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

async function auditOne(dir, numbering) {
  const { name, year } = folderTitle(dir);
  const disk = scanSeries(dir);
  const row = { folder: path.basename(dir), status: 'OK', problems: [], notes: [], seasons: [] };
  let hit = null;
  try { hit = await resolveTmdb(name, year); } catch (e) { row.status = 'ERROR'; row.problems.push(e.message); return row; }
  if (!hit) {
    row.status = 'NO_TMDB';
    row.problems.push(`No TMDB animation series named "${name}"${year ? ` (${year})` : ''} - add the year to the folder name, e.g. "${name} (2024)".`);
    return row;
  }
  row.tmdb = hit.id;
  row.tmdbName = hit.name;
  row.tmdbYear = hit.year;
  const info = await tmdb.tmdbInfo(hit.id, 'tv', { anime: true, numbering });
  if (!info) { row.status = 'ERROR'; row.problems.push('TMDB info unavailable'); return row; }
  row.numbering = info.numbering || 'tmdb';
  if (numbering === 'anime' && info.numbering !== 'anime') {
    row.problems.push('Could not build the anime (AniDB) numbering - TMDB\'s seasons were used: ' + (info.numberingNote || 'anime sites unreachable'));
  }
  const layout = new Map((info.seasons || []).map((s) => [s.season, s.episodes]));
  for (const [n, s] of [...disk.seasons.entries()].sort((a, b) => a[0] - b[0])) {
    const count = layout.get(n);
    const max = s.episodes.size ? Math.max(...s.episodes) : 0;
    const have = [...s.episodes].filter((e) => count != null && e <= count).length;
    const line = { season: n, files: s.files, onDisk: range(s.episodes), layoutEpisodes: count == null ? null : count };
    row.seasons.push(line);
    if (count == null) {
      row.problems.push(`Season ${n} is on disk (${s.files} files) but the layout has no Season ${n} - numbering mismatch: these episodes would be offered again under other numbers.`);
    } else if (max > count) {
      row.problems.push(`Season ${n}: disk has ${range([...s.episodes].filter((e) => e > count))} but the layout's Season ${n} has only ${count} episodes - numbering mismatch.`);
    } else if (have < count) {
      line.missing = count - have;
    }
    if (s.unnumbered.length) row.notes.push(`Season ${n}: ${s.unnumbered.length} file(s) with no episode number (e.g. "${s.unnumbered[0]}").`);
  }
  for (const [n, count] of layout) {
    if (n > 0 && !disk.seasons.has(n)) row.seasons.push({ season: n, files: 0, onDisk: '-', layoutEpisodes: count, missing: count });
  }
  row.seasons.sort((a, b) => a.season - b.season);
  if (disk.loose.length) row.notes.push(`${disk.loose.length} video file(s) directly in the series folder (no Season folder).`);
  if (row.problems.length) row.status = 'MISMATCH';
  return row;
}

async function main() {
  const root = process.argv[2];
  if (!root || root.startsWith('--')) {
    console.error('Usage: node scripts/audit-anime-library.js "<anime library folder>" [--limit 30] [--numbering anime|tmdb] [--only "a,b"] [--json out.json]');
    process.exit(2);
  }
  const limit = Number(arg('limit', '30'));
  const numbering = arg('numbering', 'anime') === 'tmdb' ? 'tmdb' : 'anime';
  const only = String(arg('only', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  let dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).sort();
  if (only.length) dirs = dirs.filter((d) => only.some((o) => path.basename(d).toLowerCase().includes(o)));
  if (limit > 0) dirs = dirs.slice(0, limit);
  console.log(`Auditing ${dirs.length} series in ${root} (numbering: ${numbering === 'anime' ? 'AniDB-style' : 'TMDB'})...\n`);
  const rows = [];
  for (const d of dirs) {
    let row;
    try { row = await auditOne(d, numbering); } catch (e) { row = { folder: path.basename(d), status: 'ERROR', problems: [e.message], notes: [], seasons: [] }; }
    rows.push(row);
    const mark = row.status === 'OK' ? 'OK      ' : row.status.padEnd(8);
    console.log(`${mark} ${row.folder}${row.tmdb ? `  [TMDB ${row.tmdb} "${row.tmdbName}" ${row.tmdbYear || ''}]` : ''}`);
    for (const s of row.seasons) {
      const lay = s.layoutEpisodes == null ? 'not in layout' : `${s.layoutEpisodes} eps`;
      console.log(`           Season ${s.season}: disk ${s.files} file(s) ${s.onDisk}  |  layout ${lay}${s.missing ? `  (${s.missing} to get)` : ''}`);
    }
    for (const p of row.problems) console.log('           !! ' + p);
    for (const n of row.notes) console.log('           -- ' + n);
  }
  const by = (st) => rows.filter((r) => r.status === st).length;
  console.log(`\nSummary: ${by('OK')} OK, ${by('MISMATCH')} numbering mismatch, ${by('NO_TMDB')} no TMDB match, ${by('ERROR')} error.`);
  console.log('A MISMATCH means the engine would number some episodes differently from your folders - keep those titles off the watch list until fixed.');
  const out = arg('json', '');
  if (out) {
    fs.writeFileSync(out, JSON.stringify(rows, null, 2));
    console.log('Full report: ' + out);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Audit failed:', e && e.stack || e);
  process.exit(1);
});
