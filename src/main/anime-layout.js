'use strict';

// Anime season-layout resolution.
//
// The user's anime library is organized the way ANIWAVE splits a series into
// seasons (cours), with each season's episodes numbered from 1. So for anime
// the authoritative "which seasons/episodes exist" is resolved in this order:
//
//   1. Aniwave (mirror API, keyed by TMDB id) - the layout itself, when a
//      reachable mirror answers. Official domain is parked as of this writing;
//      mirrors come and go, so every call is best-effort with negative cache.
//   2. AniList - the official per-season (cour) split, the same structure
//      Aniwave presents. Used when the caller confirms the title is anime.
//   3. TMDB - the caller's fallback (this module returns null then).
//
// Add-only discipline: NOTHING here touches the disk, moves a file, renames a
// folder, or queues a download. It only decides which (season, episode) pairs
// exist, what their names are, and how an authoritative pair maps onto TMDB's
// numbers (which TMDB-keyed sources like Vidsrc use for their streams).
//
// Every network function accepts an injectable fetcher for tests.

const https = require('https');
const http = require('http');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SEASONS = 12;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) webvideodownloader';

// Mirrors, best-effort. The official build's API shape is tried first, then
// the older mirror's ajax shape. A parked/dead mirror fails fast (non-JSON).
const ANIWAVE_MIRRORS = [
  'https://aniwaves.ru',
  'https://aniwave.com'
];

const cache = new Map(); // key -> { at, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  cache.delete(key);
  return undefined;
}
function cacheSet(key, value) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
}
function _resetCache() {
  cache.clear();
}

// GET a URL, parse JSON. Any failure (DNS, 4xx/5xx, non-JSON, timeout)
// resolves to null - callers treat null as "this source doesn't know".
// timeoutMs is a HARD TOTAL timeout: the socket is destroyed when it fires,
// so a server that accepts the connection and then hangs (or drips bytes)
// cannot exceed the budget. (The socket 'timeout' option is an IDLE timer
// and does not bound a slow drip.)
function httpJson(url, timeoutMs) {
  const budget = timeoutMs || 2500;
  return new Promise((resolve) => {
    let u;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      resolve(v);
    };
    let hard;
    try { u = new URL(url); } catch (e) { return finish(null); }
    const mod = u.protocol === 'https:' ? https : http;
    let req;
    try {
      req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': UA },
          timeout: budget
        },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return finish(null);
            try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { finish(null); }
          });
          res.on('error', () => finish(null));
        }
      );
    } catch (e) {
      return finish(null);
    }
    hard = setTimeout(() => { try { req.destroy(new Error('total-timeout')); } catch (e) { /* already gone */ } }, budget);
    req.on('error', () => finish(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tier 1: Aniwave
// ---------------------------------------------------------------------------

// Normalize one Aniwave season payload to our shape. Both API shapes use a
// top-level `result` array of episodes; accept the common key variants.
function normAniwaveSeason(payload, seasonNo) {
  if (!payload || !Array.isArray(payload.result) || !payload.result.length) return null;
  const episodes = [];
  for (const it of payload.result) {
    if (!it) continue;
    const ep = Number(it.ep != null ? it.ep : it.episode);
    if (!ep || ep <= 0) continue;
    episodes.push({ episode: ep, name: String(it.name || it.title || '') });
  }
  if (!episodes.length) return null;
  episodes.sort((a, b) => a.episode - b.episode);
  return { season: Number(seasonNo), episodes, dub: !!payload.dub, sub: !!payload.sub, year: '' };
}

function sameEpisodeSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Aniwave's season list for a TMDB id, or null when no mirror knows it.
// Season 1 is probed IN PARALLEL across every mirror x API shape with a hard
// total timeout, so a dead/hanging mirror costs at most one budget tick
// (2.5 s) instead of stacking timeouts - this is the tier that used to make
// every anime title take 30+ s to open. The first working mirror then serves
// seasons 2..N. Stops when the API stops returning data (or starts repeating
// itself, which means the season parameter is being ignored by that build).
async function aniwaveSeasons(tmdbId, opts = {}) {
  const id = String(tmdbId || '').trim();
  if (!/^\d{2,}$/.test(id)) return null;
  const key = 'aniwave:' + id;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const get = opts.fetcher || ((u) => httpJson(u, 2500));
  const SHAPES = [
    (base, n) => base + '/api/episode/' + id + '?season=' + n,
    (base, n) => base + '/ajax/endpoint?ajax=episode/list/' + id + '&season=' + n
  ];

  // Season 1: all candidates in parallel; first valid answer wins.
  const combos = [];
  for (const base of ANIWAVE_MIRRORS) for (const shape of SHAPES) combos.push({ base, url: shape(base, 1) });
  const results = await Promise.all(combos.map(async (c) => {
    try { return { base: c.base, payload: await get(c.url) };
    } catch (e) { return { base: c.base, payload: null }; }
  }));
  const winner = results.find((r) => r.payload && Array.isArray(r.payload.result) && r.payload.result.length) || null;
  if (!winner) {
    cacheSet(key, null); // negative cache: don't re-probe every title open
    return null;
  }
  const out = [normAniwaveSeason(winner.payload, 1)];
  let prevEps = out[0].episodes.map((e) => e.episode);
  for (let n = 2; n <= MAX_SEASONS; n++) {
    let payload = null;
    for (const shape of SHAPES) {
      try { payload = await get(shape(winner.base, n)); } catch (e) { payload = null; }
      if (payload && Array.isArray(payload.result) && payload.result.length) break;
      payload = null;
    }
    const s = normAniwaveSeason(payload, n);
    if (!s) break;
    const nums = s.episodes.map((e) => e.episode);
    if (sameEpisodeSet(nums, prevEps)) break; // season param ignored
    prevEps = nums;
    out.push(s);
  }
  cacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tier 2: AniList
// ---------------------------------------------------------------------------

function anilistGql(query, variables) {
  const payload = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers: {
        'Content-Type': 'application/json',
        'Length-Content': Buffer.byteLength(payload),
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': UA
      } },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { resolve(null); }
        });
      }
    );
    req.on('error', () => reject(new Error('anilist unreachable')));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// Strict guard against an AniList search returning a DIFFERENT work with a
// similar name ("Succession" vs "B: The Beginning: Succession", "Jujutsu
// Kaisen" vs "Jujutsu Kaisen: Shimetsu Kaiyuu"). Only accept: exact
// normalized equality, near-containment (the shorter title is most of the
// longer one - covers "<Title> Season 2" style additions), or a long shared
// prefix (12+ chars is distinctive).
function titlesMatch(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = n(a);
  const y = n(b);
  if (!x || !y) return false; // no basis to judge -> don't accept
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short) && short.length / long.length >= 0.7) return true;
  let prefix = 0;
  const lim = Math.min(x.length, y.length);
  while (prefix < lim && x[prefix] === y[prefix]) prefix++;
  return prefix >= 12;
}

// TMDB -> AniList id (deterministic; no title guessing). Cached.
async function anilistIdFor(tmdbId, opts = {}) {
  const key = 'anilistid:' + String(tmdbId || '');
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const id = String(tmdbId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const c = (opts.engineconfig && opts.engineconfig.get && opts.engineconfig.get()) || {};
  const apiKey = String(process.env.TMDB_API_KEY || c.tmdbApiKey || '').trim();
  if (!apiKey) return null;
  const get = opts.fetcher || ((u) => httpJson(u, 10000));
  const body = await get('https://api.themoviedb.org/3/tv/' + id + '/external_ids');
  const aid = body && body.anilist_id ? String(body.anilist_id) : '';
  cacheSet(key, aid);
  return aid || null;
}

// AniList's per-season (cour) split for a title: [{season, episodes:[...], year}].
// `episodes` is a synthesized 1..count list (AniList gives counts, not names).
//
// When opts.anilistId is available it is used DIRECTLY (Media by id) - exact,
// no title guessing. The search path is the fallback (AniList-only browse
// results) and applies the strict title guard, because a single search hit
// can be a spinoff of the real work.
async function anilistSeasons(title, opts = {}) {
  const t = String(title || '').trim();
  const alId = opts && opts.anilistId ? String(opts.anilistId) : '';
  const key = alId ? 'anilistid:' + alId : 'anilist:' + t.toLowerCase();
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const gql = opts.fetcher || anilistGql;

  let media = null;
  if (alId) {
    try {
      const r = await gql(
        'query($id: Int) { Media(id: $id, type: ANIME) { id title { english romaji } episodes seasonYear } }',
        { id: Number(alId) }
      );
      media = r && r.data && r.data.Media;
    } catch (e) {
      media = null;
    }
  } else {
    if (t.length < 3) return null;
    let raw = null;
    try {
      const search = await gql(
        'query($title: String) { Media(search: $title, type: ANIME, sort: START_DATE) { id title { english romaji } episodes seasonYear } }',
        { title: t }
      );
      raw = search && search.data && search.data.Media;
    } catch (e) {
      return null;
    }
    // Some API builds return one hit, some a list - accept both shapes.
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const scored = list
      .filter((m) => m && m.episodes != null && m.episodes > 0)
      .map((m) => {
        const official = (m.title && (m.title.english || m.title.romaji)) || '';
        if (!titlesMatch(official, t)) return null;
        const a = official.toLowerCase().replace(/[^a-z0-9]/g, '');
        const b = t.toLowerCase().replace(/[^a-z0-9]/g, '');
        return { media: m, dist: Math.abs(a.length - b.length) };
      })
      .filter(Boolean);
    if (!scored.length) {
      cacheSet(key, null);
      return null;
    }
    scored.sort((x, y) => x.dist - y.dist);
    media = scored[0].media;
  }
  if (!media || media.episodes == null || media.episodes <= 0) {
    cacheSet(key, null);
    return null;
  }
  const mk = (count, year) => {
    const eps = [];
    for (let e = 1; e <= Math.max(0, Number(count) || 0); e++) eps.push({ episode: e, name: '' });
    return eps;
  };
  let seasons = [{ season: 1, episodes: mk(media.episodes, media.seasonYear), year: media.seasonYear || '' }];
  try {
    const rel = await gql(
      'query($id: Int) { Media(id: $id) { relations { edges { relationType node { id episodes seasonYear title { english romaji } } } } } }',
      { id: media.id }
    );
    const edges = (rel && rel.data && rel.data.Media && rel.data.Media.relations && rel.data.Media.relations.edges) || [];
    let n = 1;
    for (const edge of edges) {
      if (!edge.node || !edge.relationType) continue;
      if (!/SEQUEL|NEXT_SEASON/i.test(edge.relationType)) continue;
      n++;
      seasons.push({
        season: n,
        episodes: mk(edge.node.episodes, edge.node.seasonYear),
        year: edge.node.seasonYear || ''
      });
    }
  } catch (e) { /* relations optional */ }
  if (!seasons[0].episodes.length && !seasons.some((s) => s.episodes.length)) {
    cacheSet(key, null);
    return null;
  }
  cacheSet(key, seasons);
  return seasons;
}

// ---------------------------------------------------------------------------
// Combined resolution + TMDB mapping
// ---------------------------------------------------------------------------

// TMDB's own per-season counts for a series id (used to MAP, not as layout).
async function tmdbSeasonCounts(tmdbId, opts = {}) {
  const key = 'tmdb:' + String(tmdbId || '');
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const id = String(tmdbId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const c = (opts.engineconfig && opts.engineconfig.get && opts.engineconfig.get()) || {};
  const apiKey = String(process.env.TMDB_API_KEY || c.tmdbApiKey || '').trim();
  if (!apiKey) return null;
  const get = opts.fetcher || ((u) => httpJson(u, 10000));
  const body = await get('https://api.themoviedb.org/3/tv/' + id + '?language=en-US');
  if (!body || !Array.isArray(body.seasons)) {
    cacheSet(key, null);
    return null;
  }
  const seasons = body.seasons
    .filter((s) => s.season_number > 0)
    .map((s) => ({ season: s.season_number, episodes: s.episode_count || 0, year: String(s.air_date || '').slice(0, 4) }));
  cacheSet(key, seasons);
  return seasons;
}

// Resolve the authoritative layout for an anime title.
// Returns { source: 'aniwave'|'anilist', seasons: [{season, episodes:[...], year}] }
// or null when no non-TMDB source knows it (caller keeps TMDB).
async function resolveLayout(tmdbId, title, opts = {}) {
  if (tmdbId) {
    try {
      const aw = await aniwaveSeasons(tmdbId, opts);
      if (aw) return { source: 'aniwave', seasons: aw };
    } catch (e) { /* tier is best-effort */ }
  }
  if (title && (opts.anime || opts.allowAnilist)) {
    try {
      let alId = opts.anilistId ? String(opts.anilistId) : '';
      if (!alId && tmdbId) {
        try { alId = String((await anilistIdFor(tmdbId, opts)) || ''); } catch (e) { alId = ''; }
      }
      const al = await anilistSeasons(title, { ...opts, anilistId: alId });
      if (al) return { source: 'anilist', seasons: al };
    } catch (e) { /* tier is best-effort */ }
  }
  return null;
}

const countOf = (s) => (Array.isArray(s.episodes) ? s.episodes.length : Number(s.episodes) || 0);

// Additive merge: keep every base (TMDB) season with its count, and only ADD
// season numbers the base lacks. NEVER overrides an existing count.
//
// Why: AniList's episode counts have proven unreliable in the wild (it
// reported 24 episodes for "The Apothecary Diaries Season 2", which has 12),
// and overriding TMDB's correct 12 with that 24 is exactly the "our logic is
// wrong about the seasons" failure. AniList still earns its place by adding
// the missing sequel TMDB hasn't listed yet - the original bug it fixed.
function addMissingSeasons(baseSeasons, extraSeasons) {
  const out = (baseSeasons || []).filter((s) => s && s.season > 0)
    .map((s) => ({ season: s.season, episodes: countOf(s), year: s.year || '' }));
  const have = new Set(out.map((s) => s.season));
  for (const s of extraSeasons || []) {
    if (!s || s.season <= 0 || have.has(s.season)) continue;
    have.add(s.season);
    out.push({ season: s.season, episodes: countOf(s), year: s.year || '' });
  }
  out.sort((a, b) => a.season - b.season);
  return out;
}

// PURE: map a (season, episode) pair expressed in the authoritative layout
// onto TMDB's numbering, so a TMDB-keyed source fetches the right content.
//
// Conservative on purpose - the only safe answers:
//   - same season shape            -> identity (they already agree);
//   - different shape, SAME total  -> exact cumulative-offset mapping;
//   - totals differ (e.g. TMDB is behind) or anything odd -> identity
//     (assume they agree; never invent a cross-season guess).
function mapEpisode(authoritative, tmdbSeasons, season, episode) {
  const identity = { season, episode, mapped: false };
  const A = (authoritative || []).filter((s) => s && s.season > 0).sort((x, y) => x.season - y.season);
  const T = (tmdbSeasons || []).filter((s) => s && s.season > 0).sort((x, y) => x.season - y.season);
  if (!A.length || !T.length) return identity;
  const aTotal = A.reduce((x, s) => x + countOf(s), 0);
  const tTotal = T.reduce((x, s) => x + countOf(s), 0);
  if (!aTotal || !tTotal) return identity;
  const shape = (L) => L.map((s) => s.season + ':' + countOf(s)).join('|');
  if (shape(A) === shape(T)) return identity;
  if (aTotal !== tTotal) return identity;
  const target = A.reduce((x, s) => x + (s.season < season ? countOf(s) : 0), 0) + Number(episode);
  if (!(target >= 1 && target <= aTotal)) return identity;
  let off = 0;
  for (const s of T) {
    const c = countOf(s);
    if (target > off && target <= off + c) {
      return { season: s.season, episode: target - off, mapped: true };
    }
    off += c;
  }
  return identity;
}

// Build a URL-number mapper for one title: (season, episode) -> TMDB pair.
// Returns null when no mapping is needed/possible (identity everywhere).
async function urlMapFor(tmdbId, title, opts = {}) {
  const resolved = await resolveLayout(tmdbId, title, opts);
  if (!resolved) return null;
  let tmdbSeasons = null;
  try { tmdbSeasons = await tmdbSeasonCounts(tmdbId, opts); } catch (e) { /* ignore */ }
  if (!tmdbSeasons) return null;
  // No-op check: if the first real pair is already identity and shapes
  // match, skip the per-episode work entirely.
  const a = resolved.seasons.find((s) => s.season > 0) || resolved.seasons[0];
  if (a) {
    const m = mapEpisode(resolved.seasons, tmdbSeasons, a.season, 1);
    if (!m.mapped) {
      // Identity for ep 1 does not prove identity for all - but if the total
      // episode sets differ or shapes match, mapEpisode always returns
      // identity. Re-check with a mid/last pair to be sure.
      const last = resolved.seasons[resolved.seasons.length - 1];
      const lastEp = countOf(last) || 1;
      const m2 = mapEpisode(resolved.seasons, tmdbSeasons, last.season, lastEp);
      if (!m2.mapped) return null;
    }
  }
  return (season, episode) => mapEpisode(resolved.seasons, tmdbSeasons, season, episode);
}

module.exports = {
  aniwaveSeasons,
  anilistSeasons,
  anilistIdFor,
  resolveLayout,
  mapEpisode,
  addMissingSeasons,
  urlMapFor,
  tmdbSeasonCounts,
  normAniwaveSeason,
  titlesMatch,
  _resetCache,
  _internals: { httpJson, anilistGql, cacheGet, cacheSet, ANIWAVE_MIRRORS }
};
