'use strict';

// AniDB: "does an English-dubbed release of this anime exist?"
//
// The user's watch list mixes shows with official English dubs (Crunchyroll,
// Hulu...) and shows that will never get one. Vidsrc (and friends) serve ONE
// fixed file per episode with no dub/sub toggle, so the only way to know what
// to expect is to ask AniDB - the authoritative release database - whether any
// release carries English audio.
//
// Two upstreams:
//   1. TMDB -> AniDB id: the Anime-Lists project mapping (anime-lists.json).
//      Community-maintained, used by Kometa/Shoko; covers essentially every
//      anime that also exists on TMDB. Fetched once and cached on disk.
//   2. Releases: the AniDB API itself (api.anidb.net), public key "0".
//      Port 564 (HTTPS) first, port 7 (HTTP) as fallback - residential
//      networks block one or the other.
//
// Everything here is BEST-EFFORT: any network failure returns
// { available: null, reason: 'network' } instead of throwing, because this
// feeds a daily schedule check and a dashboard badge - never the download
// path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const MAPPING_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/main/anidb-anime-lists.json';
// The repo publishes both a full and a reduced file; try the reduced one first
// (same anidb_id/themoviedb_id pairs, far smaller).
const MAPPING_URLS = [
  'https://raw.githubusercontent.com/Fribb/anime-lists/main/anidb-anime-lists-reduced.json',
  MAPPING_URL
];
const ANIDB_BASES = [
  { lib: https, host: 'api.anidb.net', port: 564, scheme: 'https:' },
  { lib: http, host: 'api.anidb.net', port: 7, scheme: 'http:' }
];
const KEY = '0'; // public, rate-limited - fine for a daily per-series check

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

async function anidbApi(query, timeoutMs = 15000) {
  // Try each base; the first that answers wins. Throws only if ALL fail.
  let lastErr = null;
  for (const b of ANIDB_BASES) {
    try {
      const u = `${b.scheme}//${b.host}:${b.port}/3/?${query}`;
      const r = await rawGet(u, timeoutMs);
      if (r.status === 200) return r.body.toString('utf8');
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('AniDB unreachable');
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

// Parse AniDB release XML -> [{ name, audio, date }] (best-effort, no deps).
function parseReleases(xml) {
  const out = [];
  const blocks = String(xml || '').match(/<release\b[^>]*>[\s\S]*?<\/release>/g) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };
    out.push({ name: pick('name'), audio: pick('audio'), date: pick('date') });
  }
  return out;
}

function cached(tmdbId) {
  const r = _results.get(String(tmdbId));
  if (!r) return null;
  const ttl = r.available === null ? FAILURE_TTL_MS : RESULT_TTL_MS;
  return Date.now() - r.at < ttl ? r : null;
}

function remember(tmdbId, r) {
  _results.set(String(tmdbId), r);
  return r;
}

const _inflight = new Map(); // tmdbId -> promise (dedupe concurrent fetches)

/** Non-mutating read: the cached result if fresh, else null. Never touches the network. */
function peek(tmdbId) {
  return cached(String(tmdbId || '').trim());
}

/** Kicks off a fetch if none is cached; safe to call repeatedly (deduped). */
function ensure(tmdbId) {
  const id = String(tmdbId || '').trim();
  if (!id) return Promise.resolve({ tmdbId: null, available: null, reason: 'no-tmdb-id', at: Date.now() });
  if (peek(id)) return Promise.resolve(peek(id));
  if (!_inflight.has(id)) {
    const p = englishDubForTmdb(id)
      .catch((e) => ({
        tmdbId: id,
        anidbId: null,
        available: null,
        reason: 'network',
        error: String((e && e.message) || e),
        at: Date.now()
      }))
      .finally(() => _inflight.delete(id));
    _inflight.set(id, p);
  }
  return _inflight.get(id);
}

/**
 * English-dub availability for a TMDB id.
 *   available: true  - at least one AniDB release carries English audio
 *   available: false - on AniDB, but no release has English audio
 *   available: null  - unknown (not in the mapping, or network failure)
 */
async function englishDubForTmdb(tmdbId, { force = false } = {}) {
  const id = String(tmdbId || '').trim();
  if (!id) return { tmdbId: null, available: null, reason: 'no-tmdb-id', at: Date.now() };
  const hit = cached(id);
  if (hit && !force) return hit;

  let anidbId = null;
  try {
    anidbId = await tmdbToAnidb(id);
  } catch (e) {
    // Mapping fetch failed: if we have a STALE mapping, use it; otherwise
    // report unknown (network), not "no dub".
    if (!_mapping) {
      return remember(id, {
        tmdbId: id,
        anidbId: null,
        available: null,
        englishDubReleases: 0,
        totalReleases: 0,
        sample: '',
        reason: 'network',
        error: String((e && e.message) || e),
        at: Date.now()
      });
    }
  }
  if (!anidbId) {
    return remember(id, {
      tmdbId: id,
      anidbId: null,
      available: null,
      englishDubReleases: 0,
      totalReleases: 0,
      sample: '',
      reason: 'not-on-anidb',
      at: Date.now()
    });
  }
  let xml = '';
  try {
    xml = await anidbApi(
      `req=getanime&sub=release&file=anidb.all&anime=${anidbId}&key=${KEY}`
    );
  } catch (e) {
    return remember(id, {
      tmdbId: id,
      anidbId,
      available: null,
      englishDubReleases: 0,
      totalReleases: 0,
      sample: '',
      reason: 'network',
      error: String((e && e.message) || e),
      at: Date.now()
    });
  }
  const releases = parseReleases(xml);
  const english = releases.filter((r) => /\benglish\b/i.test(r.audio || ''));
  return remember(id, {
    tmdbId: id,
    anidbId,
    available: english.length > 0,
    englishDubReleases: english.length,
    totalReleases: releases.length,
    sample: english[0] ? english[0].name : '',
    reason: 'ok',
    at: Date.now()
  });
}

module.exports = {
  englishDubForTmdb,
  peek,
  ensure,
  // Exported for tests:
  parseReleases,
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
  },
  _setAnidbBasesForTests(bases) {
    ANIDB_BASES.length = 0;
    (bases || []).forEach((b) => ANIDB_BASES.push(b));
  }
};
