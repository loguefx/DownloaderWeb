'use strict';
// AniList id -> TMDB id, deterministically, from the Anime-Lists mapping
// (Fribb/anime-lists - the same file the dub badge reads AniDB ids from).
//
// Why: an Anime-tab card is an AniList entry with no TMDB id. Finding the TMDB
// series used to mean asking AniList for the entry, walking its PREQUEL links
// back to season 1 (one AniList request per season) and searching TMDB by
// name + year. AniList answers HTTP 429 when a client asks too often (its
// limit is ~30 requests a minute, shared with the Anime tab's own browsing,
// the season layouts and the dub names), and every 429 turned a perfectly
// normal show into "This title has no TMDB id". This map answers without
// asking AniList at all, for every show the list knows.
//
//   tmdbFor(anilistId) -> { tmdb, type: 'tv'|'movie', season|null } | null
//
// The list is fetched at most weekly and kept on disk; a failed fetch keeps
// the copy already on disk (or answers null - callers fall back).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// The full list carries per-entry season numbers where known; the mini list
// is the fallback (ids only).
const URLS = [
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json'
];
const TTL_MS = 7 * 24 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000; // after a failed fetch, try again later

let state = null; // { at, map: Map<anilistId, entry> }
let loading = null;
let lastFailAt = 0;

let dirOverride = null;
function dataDir() {
  if (dirOverride) return dirOverride;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) {
    /* plain Node */
  }
  return path.join(os.tmpdir(), 'wvd-animeids');
}
function file() {
  return path.join(dataDir(), 'anime-ids.json');
}

// Injectable for tests: url -> parsed JSON array (throws on failure).
let fetchList = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'webvideodownloader-animeids/1.0' }, timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(c).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });

// One list row -> { tmdb, type, season } (null when it has no TMDB id).
// themoviedb_id is a number in older files and { tv, movie } in newer ones.
function rowEntry(row) {
  const t = row && row.themoviedb_id;
  let tmdb = null;
  let type = 'tv';
  if (t && typeof t === 'object') {
    if (t.tv) tmdb = t.tv;
    else if (t.movie) {
      tmdb = t.movie;
      type = 'movie';
    }
  } else if (t) {
    tmdb = t;
    type = String(row.type || '').toUpperCase() === 'MOVIE' ? 'movie' : 'tv';
  }
  if (!tmdb) return null;
  const s = row.season && typeof row.season === 'object' ? Number(row.season.tmdb) : NaN;
  return { tmdb: String(tmdb), type, season: s > 0 ? s : null };
}

function build(arr) {
  const map = {};
  for (const row of arr || []) {
    const id = row && row.anilist_id;
    if (!id) continue;
    const e = rowEntry(row);
    if (e) map[String(id)] = e;
  }
  return map;
}

function loadDisk(allowStale) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!raw || !raw.map) return false;
    if (!allowStale && Date.now() - (raw.at || 0) >= TTL_MS) return false;
    state = { at: raw.at || 0, map: new Map(Object.entries(raw.map)) };
    return true;
  } catch (e) {
    return false;
  }
}

async function refresh() {
  for (const url of URLS) {
    try {
      const map = build(await fetchList(url));
      if (!Object.keys(map).length) continue;
      try {
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify({ at: Date.now(), map }));
      } catch (e) {
        /* the in-memory copy still answers */
      }
      state = { at: Date.now(), map: new Map(Object.entries(map)) };
      return true;
    } catch (e) {
      /* next URL */
    }
  }
  lastFailAt = Date.now();
  return false;
}

// The map, fetched when missing or older than a week. Never throws.
async function ensure() {
  if (state && Date.now() - state.at < TTL_MS) return state;
  if (!state && loadDisk(false)) return state;
  if (Date.now() - lastFailAt < RETRY_MS) {
    if (!state) loadDisk(true); // a stale copy beats none
    return state;
  }
  if (!loading) {
    loading = refresh().finally(() => {
      loading = null;
    });
  }
  await loading;
  if (!state) loadDisk(true);
  return state;
}

async function tmdbFor(anilistId) {
  const id = String(anilistId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const s = await ensure();
  return (s && s.map.get(id)) || null;
}

// Without network: the answer if the map is already loaded (for listing many
// cards at once).
function peek(anilistId) {
  if (!state) loadDisk(true);
  return (state && state.map.get(String(anilistId))) || null;
}

module.exports = {
  tmdbFor,
  peek,
  ensure,
  _rowEntry: rowEntry,
  _setFetchForTests(fn, dir = null) {
    dirOverride = dir;
    fetchList = fn;
    state = null;
    loading = null;
    lastFailAt = 0;
  }
};
