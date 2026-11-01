'use strict';

// "Does this anime season have an English dub, and how much of it?" - the
// watch list's "eng dub" pill and the daily log line.
//
// Answered from the anime sources the downloads use (Aniwave's per-episode dub
// flags, Anime Village's separate dub files): the number of English-dubbed
// episodes of the season. The AniDB id is still looked up (Anime-Lists'
// TMDB -> AniDB mapping) and shown, but AniDB itself is NOT asked: it has no
// public API for release audio (the HTTP API needs a registered client and
// lists no releases), so the old release query never once answered.
//
// Everything here is BEST-EFFORT: a failure returns { available: null }
// instead of throwing - this feeds a log line and a badge, never downloads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

// Anime-Lists moved its files (the old main/anidb-anime-lists*.json paths
// are 404 since 2026): the mini file has the same anidb_id/themoviedb_id pairs.
const MAPPING_URLS = [
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json',
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json'
];

const MAPPING_TTL_MS = 7 * 24 * 3600 * 1000; // refresh the id map weekly
const RESULT_TTL_MS = 24 * 3600 * 1000; // a show's dub status is stable
const NEGATIVE_TTL_MS = 24 * 3600 * 1000;
const FAILURE_TTL_MS = 6 * 3600 * 1000; // don't hammer a dead network

let _mapping = null; // { at, map: Map<tmdbId, anidbId> }
const _results = new Map(); // tmdbId -> result object (with .at)

function dataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) {
    /* plain Node (tests/engine) */
  }
  return path.join(os.tmpdir(), 'wvd-anidb');
}

function rawGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'webvideodownloader-anidb/1.0' }, timeout: timeoutMs },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(c) })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function mappingFile() {
  return path.join(dataDir(), 'anidb-mapping.json');
}

// TMDB id -> AniDB id via the Anime-Lists mapping (disk-cached).
async function tmdbToAnidb(tmdbId) {
  if (_mapping && Date.now() - _mapping.at < MAPPING_TTL_MS) {
    return _mapping.map.get(String(tmdbId)) || null;
  }
  const file = mappingFile();
  const tryLoad = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - (raw.at || 0) >= MAPPING_TTL_MS) return false;
      _mapping = { at: raw.at, map: new Map(Object.entries(raw.map || {})) };
      return true;
    } catch (e) {
      return false;
    }
  };
  if (!tryLoad()) {
    let ok = false;
    let lastErr = null;
    for (const url of MAPPING_URLS) {
      try {
        const r = await rawGet(url, 30000);
        if (r.status !== 200) {
          lastErr = new Error(`mapping HTTP ${r.status}`);
          continue;
        }
        const arr = JSON.parse(r.body.toString('utf8'));
        const map = {};
        for (const row of arr || []) {
          const a = row && row.anidb_id;
          const tm = row && row.themoviedb_id;
          if (!a) continue;
          if (tm) {
            if (tm.tv) map[String(tm.tv)] = a;
            if (tm.movie) map[String(tm.movie)] = a;
          }
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ at: Date.now(), map }));
        _mapping = { at: Date.now(), map: new Map(Object.entries(map)) };
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!ok && _mapping) {
      /* stale is better than nothing */
    } else if (!ok) {
      throw lastErr || new Error('AniDB mapping unavailable');
    }
  }
  return _mapping.map.get(String(tmdbId)) || null;
}

const rkey = (tmdbId, season) => `${String(tmdbId || '').trim()}|${Number(season) > 0 ? Number(season) : 1}`;

function cached(key) {
  const r = _results.get(key);
  if (!r) return null;
  const ttl = r.available === null ? FAILURE_TTL_MS : RESULT_TTL_MS;
  return Date.now() - r.at < ttl ? r : null;
}

function remember(key, r) {
  _results.set(key, r);
  return r;
}

const _inflight = new Map(); // tmdbId -> promise (dedupe concurrent fetches)

/** Non-mutating read: the cached result if fresh, else null. Never touches the network. */
function peek(tmdbId, season = 1) {
  return cached(rkey(tmdbId, season));
}

/** Kicks off a fetch if none is cached; safe to call repeatedly (deduped). */
function ensure(tmdbId, { title = '', season = 1 } = {}) {
  const id = String(tmdbId || '').trim();
  if (!id) return Promise.resolve({ tmdbId: null, available: null, reason: 'no-tmdb-id', at: Date.now() });
  const k = rkey(id, season);
  if (peek(id, season)) return Promise.resolve(peek(id, season));
  if (!_inflight.has(k)) {
    const p = englishDubForTmdb(id, { title, season })
      .catch((e) => ({
        tmdbId: id,
        anidbId: null,
        available: null,
        reason: 'network',
        error: String((e && e.message) || e),
        at: Date.now()
      }))
      .finally(() => _inflight.delete(k));
    _inflight.set(k, p);
  }
  return _inflight.get(k);
}

// Injectable for tests: (title, season) -> { aniwave: Map|null, animevillage: Map|null }
// Aniwave first (one request for the whole season); Anime Village is asked
// only about the episodes Aniwave does not show dubbed, through the engine's
// saved per-episode answers (dubstatus, kept for days) - so the daily
// summary line no longer re-asks Anime Village about every episode (two
// stream requests each: LINK CLICK took 80 s and the burst set off the
// site's timeouts for the downloads running at the same time).
let sources = async (title, season) => {
  const dubstatus = require('./dubstatus');
  const aniwave = await dubstatus.aniwaveDubMap(title, season).catch(() => null);
  let animevillage = null;
  if (aniwave && aniwave.size) {
    const need = [...aniwave.keys()].filter((ep) => aniwave.get(ep) !== true);
    if (need.length) animevillage = await dubstatus.animevillageDubMap(title, season, need).catch(() => null);
  } else {
    animevillage = await require('./sites/animevillage_api').dubMap(title, season).catch(() => null);
  }
  return { aniwave, animevillage };
};

/**
 * English-dub status of one anime season, from the anime sources.
 *   available: true  - at least one episode is English-dubbed
 *                      (englishDubReleases = dubbed episodes, totalReleases = episodes)
 *   available: false - Anime Village answered and no episode is dubbed on either source
 *   available: null  - unknown (no title, or Anime Village unreachable)
 */
async function englishDubForTmdb(tmdbId, { title = '', season = 1, force = false } = {}) {
  const id = String(tmdbId || '').trim();
  const k = rkey(id, season);
  const hit = cached(k);
  if (hit && !force) return hit;
  // The AniDB id is informational only: looked up alongside, never waited
  // on alone, and a failure leaves it null.
  const idP = id ? tmdbToAnidb(id).catch(() => null) : Promise.resolve(null);
  if (!String(title || '').trim()) {
    return { tmdbId: id || null, anidbId: await idP, englishDubReleases: 0, totalReleases: 0, sample: '', at: Date.now(), available: null, reason: 'no-title' };
  }
  let src = { aniwave: null, animevillage: null };
  try {
    src = await sources(String(title).trim(), Number(season) > 0 ? Number(season) : 1);
  } catch (e) {
    src = { aniwave: null, animevillage: null };
  }
  const base = { tmdbId: id || null, anidbId: await idP, englishDubReleases: 0, totalReleases: 0, sample: '', at: Date.now() };
  // An EMPTY Anime Village answer (catalog loaded, show or episodes not
  // found - the site flaking) is no answer: never "no dub" from it.
  if (src.animevillage && src.animevillage.size === 0) src.animevillage = null;
  const eps = new Map();
  for (const m of [src.aniwave, src.animevillage]) {
    if (!m) continue;
    for (const [ep, d] of m) eps.set(ep, eps.get(ep) === true || d === true);
  }
  const dubbed = [...eps.values()].filter(Boolean).length;
  const via = [src.aniwave && [...src.aniwave.values()].some(Boolean) ? 'Aniwave' : '', src.animevillage && [...src.animevillage.values()].some(Boolean) ? 'Anime Village' : ''].filter(Boolean).join(' + ');
  let available = null;
  if (dubbed > 0) available = true;
  else if (src.animevillage) available = false;
  // Dubs do not disappear: a check that sees FEWER dubbed episodes than the
  // last one (a source flaking mid-check - Smoking Behind the Supermarket
  // went from "9 of 12" to "none" within the hour) keeps the earlier answer.
  const prev = _results.get(k);
  if (prev && prev.available === true && dubbed < prev.englishDubReleases) {
    return remember(k, Object.assign({}, prev, { at: Date.now() }));
  }
  return remember(k, Object.assign(base, {
    available,
    englishDubReleases: dubbed,
    totalReleases: eps.size,
    sample: via,
    reason: available === null ? 'unreachable' : 'ok'
  }));
}

module.exports = {
  englishDubForTmdb,
  peek,
  ensure,
  // Exported for tests:
  _setSourcesForTests(fn) {
    sources = fn;
  },
  _setMappingForTests(m) {
    _mapping = { at: Date.now(), map: m };
  },
  _clearCaches() {
    _mapping = null;
    _results.clear();
  },
  _setMappingUrlsForTests(urls) {
    MAPPING_URLS.length = 0;
    (urls || []).forEach((u) => MAPPING_URLS.push(u));
  }
};
