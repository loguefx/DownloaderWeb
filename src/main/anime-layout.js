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

// Everything AniList relates to one work, split the way TMDB and Jellyfin
// split it:
//   seasons - the main SEQUEL chain S1 -> S2 -> S3 ... (TV / TV_SHORT / ONA).
//             Each entry's relations list only its DIRECT sequel, so the chain
//             is walked hop by hop; reading S1's relations alone stops at S2.
//   extras  - movies, OVAs, specials and side stories hanging off any main
//             season (or sitting between two of them in the chain). These
//             are Season 0 ("Specials"), never a numbered season, so a recap
//             movie between two TV seasons cannot shift S2 to S3.
// Spin-offs / alternatives / characters are different works and are ignored.
// Both lists hold { id, format, episodes, seasonYear, startDate, title }; the
// start entry itself is not in `seasons`. Network errors end the walk early
// with whatever was found.
const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const EXTRA_FORMATS = new Set(['MOVIE', 'OVA', 'SPECIAL', 'ONA', 'TV_SHORT']);
const EXTRA_RELATIONS = /^(SEQUEL|PREQUEL|SIDE_STORY|SUMMARY)$/i;
const RELATIONS_QUERY =
  'query($id: Int) { Media(id: $id) { relations { edges { relationType node { ' +
  'id type format episodes seasonYear startDate { year month day } title { english romaji } } } } } }';

async function anilistRelations(startId, gql = anilistGql, maxHops = 30) {
  const seasons = [];
  const extras = [];
  const mainIds = new Set([Number(startId)]);
  const extraIds = new Set();
  const pick = (n) => ({
    id: n.id,
    format: n.format || '',
    episodes: n.episodes,
    seasonYear: n.seasonYear,
    startDate: n.startDate || null,
    title: n.title
  });
  const addExtra = (n) => {
    if (mainIds.has(n.id) || extraIds.has(n.id)) return;
    extraIds.add(n.id);
    extras.push(pick(n));
  };
  let id = Number(startId);
  for (let hop = 0; hop < maxHops; hop++) {
    let rel;
    try {
      rel = await gql(RELATIONS_QUERY, { id });
    } catch (e) {
      break;
    }
    const edges = ((rel && rel.data && rel.data.Media && rel.data.Media.relations && rel.data.Media.relations.edges) || [])
      .filter((e) => e && e.node && (!e.node.type || e.node.type === 'ANIME'));
    const sequels = edges.filter((e) => /^(SEQUEL|NEXT_SEASON)$/i.test(e.relationType || '') && !mainIds.has(e.node.id));
    // When a season has both a sequel season and a sequel movie, the season
    // continues the chain and the movie is an extra.
    const next = sequels.find((e) => SEASON_FORMATS.has(e.node.format)) || sequels[0] || null;
    for (const e of edges) {
      if (next && e.node.id === next.node.id) continue;
      if (!EXTRA_RELATIONS.test(e.relationType || '')) continue;
      if (!EXTRA_FORMATS.has(e.node.format)) continue;
      addExtra(e.node);
    }
    if (!next) break;
    if (!next.node.format || SEASON_FORMATS.has(next.node.format)) {
      // A node first seen as an extra (e.g. an ONA side story) that turns out
      // to be the next main season is promoted.
      const was = extras.findIndex((x) => x.id === next.node.id);
      if (was >= 0) extras.splice(was, 1);
      extraIds.delete(next.node.id);
      seasons.push(pick(next.node));
    } else {
      // A movie / OVA sitting in the sequel chain: keep walking through it.
      addExtra(next.node);
    }
    mainIds.add(next.node.id);
    id = next.node.id;
  }
  const when = (x) => {
    const d = x.startDate || {};
    return (d.year || x.seasonYear || 9999) * 10000 + (d.month || 12) * 100 + (d.day || 31);
  };
  extras.sort((a, b) => when(a) - when(b));
  return { seasons, extras };
}

async function anilistSequelChain(startId, gql = anilistGql, maxHops = 30) {
  return (await anilistRelations(startId, gql, maxHops)).seasons;
}

// Season 0 ("Specials") episodes from AniList extras, in release order: a
// movie is one episode, a multi-episode OVA is one episode per part. Names
// carry the extra's title so a hand-named file ("Show - Mugen Train.mkv") is
// still recognized as present.
function specialsFromExtras(extras) {
  const eps = [];
  for (const x of extras || []) {
    const name = (x.title && (x.title.english || x.title.romaji)) || '';
    const count = x.format === 'MOVIE' ? 1 : Math.max(1, Number(x.episodes) || 1);
    for (let i = 1; i <= count; i++) {
      eps.push({
        episode: eps.length + 1,
        name: count > 1 ? `${name} - ${i}` : name,
        anilist: String(x.id),
        format: x.format
      });
    }
  }
  return eps;
}

// Strict guard against an AniList search returning a DIFFERENT work with a
// similar name ("Succession" vs "B: The Beginning: Succession", "Jujutsu
// Kaisen" vs "Jujutsu Kaisen: Shimetsu Kaiyuu"). Only accept: exact
// normalized equality, near-containment (the shorter title is most of the
// longer one - covers "<Title> Season 2" style additions), or a long shared
// prefix (12+ chars is distinctive).
function titlesMatch(a, b) {
  // "Ranma ½ (2024)" and "Ranma1/2" are the same work: ½ spelled out, and a
  // trailing "(year)" disambiguation tag dropped before comparing.
  const n = (s) => String(s || '').replace(/½/g, '1/2').replace(/\s*\((?:19|20)\d{2}\)\s*$/, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
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
  const key = alId ? 'anilistid:' + alId : 'anilist:' + t.toLowerCase() + (opts && opts.year ? '|' + opts.year : '');
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
      // A LIST of candidates (a remake shares its title with the original:
      // "Ranma ½" 1989 vs 2024), narrowed below by the TMDB start year.
      const search = await gql(
        'query($title: String) { Page(perPage: 15) { media(search: $title, type: ANIME, sort: SEARCH_MATCH) { ' +
          'id format title { english romaji } episodes seasonYear startDate { year } } } }',
        { title: t }
      );
      raw = search && search.data && ((search.data.Page && search.data.Page.media) || search.data.Media);
    } catch (e) {
      return null;
    }
    // Some API builds return one hit, some a list - accept both shapes.
    let list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    // When the caller knows the first-air year, a candidate from that year
    // wins over a same-titled older/newer work.
    const wantYear = Number(opts && opts.year) || 0;
    if (wantYear) {
      const yearOf = (m) => Number((m && m.startDate && m.startDate.year) || (m && m.seasonYear) || 0);
      const sameYear = list.filter((m) => yearOf(m) === wantYear);
      if (sameYear.length) list = sameYear;
    }
    const scored = list
      .filter((m) => m && (m.episodes == null || m.episodes > 0))
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
  if (!media) {
    cacheSet(key, null);
    return null;
  }
  const mk = (count, year) => {
    const eps = [];
    for (let e = 1; e <= Math.max(0, Number(count) || 0); e++) eps.push({ episode: e, name: '' });
    return eps;
  };
  let seasons = [{ season: 1, episodes: mk(media.episodes, media.seasonYear), year: media.seasonYear || '' }];
  const { seasons: chain, extras } = await anilistRelations(media.id, gql);
  chain.forEach((node, i) => {
    seasons.push({
      season: i + 2,
      episodes: mk(node.episodes, node.seasonYear),
      year: node.seasonYear || ''
    });
  });
  // Season 0 (Specials) goes FIRST so callers that read "the last season"
  // still get the newest numbered one.
  const specials = specialsFromExtras(extras);
  if (specials.length) seasons.unshift({ season: 0, episodes: specials, year: '' });
  if (!seasons.some((s) => s.season > 0 && s.episodes.length)) {
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
  // First-air year: narrows the AniList title search (a remake shares its
  // title with the original).
  cacheSet('tmdbyear:' + id, Number(String(body.first_air_date || '').slice(0, 4)) || 0);
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
    const al = await anilistLayout(tmdbId, title, opts);
    if (al) return { source: 'anilist', seasons: al };
  }
  return null;
}

// The AniList tier on its own (TMDB->AniList id when known, else the guarded
// title search, narrowed by opts.year). null when AniList does not know it.
async function anilistLayout(tmdbId, title, opts = {}) {
  if (!title) return null;
  try {
    let alId = opts.anilistId ? String(opts.anilistId) : '';
    if (!alId && tmdbId) {
      try { alId = String((await anilistIdFor(tmdbId, opts)) || ''); } catch (e) { alId = ''; }
    }
    return (await anilistSeasons(title, { ...opts, anilistId: alId })) || null;
  } catch (e) {
    return null; // tier is best-effort
  }
}

// PURE: TMDB (or a single-season Aniwave answer) often lumps several cours
// into ONE season with continuous numbering - Ranma ½ (2024) is TMDB
// "Season 1, 36 episodes" for three 12-episode seasons. AniList lists each
// cour as its own season. When AniList's seasons PARTITION the base seasons
// exactly (consecutive AniList counts add up to each base count), the base
// season is split along those lines:
//   base [S1:36] + AniList [12, 12, 12] -> S1:12, S2:12, S3:12
// Each split season records where its episodes live in the base layout
// (tmdbSeason + tmdbOffset), so names, air dates and source URLs map back
// exactly. The airing season may have an unknown AniList count (null / 0):
// it takes whatever the base season still has. A base season that lists
// fewer episodes of the airing cour than AniList announces keeps the base's
// count (only episodes the base knows are offered).
//
// Only the LAST base season is ever split (see below), and anything that
// does not partition (AniList's counts are sometimes wrong: 24 where the
// season has 12) returns null and the caller keeps its layout.
// AniList seasons past the end of the base are appended like
// addMissingSeasons would (no tmdbSeason: TMDB does not list them yet).
function splitLumpedSeasons(baseSeasons, anilistSeasons) {
  const B = (baseSeasons || []).filter((s) => s && s.season > 0).sort((x, y) => x.season - y.season);
  const A = (anilistSeasons || []).filter((s) => s && s.season > 0).sort((x, y) => x.season - y.season);
  if (!B.length || A.length <= B.length) return null;
  const out = [];
  let ai = 0;
  let lumped = false;
  for (let bi = 0; bi < B.length; bi++) {
    const b = B[bi];
    const bCount = countOf(b);
    if (!(bCount > 0)) return null;
    let used = 0;
    let parts = 0;
    while (used < bCount) {
      const a = A[ai];
      if (!a) return null;
      let c = countOf(a);
      const isLastA = ai === A.length - 1;
      const isLastB = bi === B.length - 1;
      const left = bCount - used;
      if (!(c > 0)) {
        // Unknown count (airing cour): only the very last season may absorb
        // the remainder.
        if (!isLastA || !isLastB) return null;
        c = left;
      } else if (c > left) {
        // The base lists fewer episodes of the newest cour than AniList
        // announces (TMDB adds them as they air): last season only.
        if (!(isLastA && isLastB) || parts === 0) return null;
        c = left;
      }
      out.push({ season: a.season, episodes: c, year: a.year || '', tmdbSeason: b.season, tmdbOffset: used });
      used += c;
      parts++;
      ai++;
    }
    if (parts > 1) {
      // Only the LAST base season may be split. TMDB grouping parts mid-run
      // (Attack on Titan S3 = AniList "S3" + "S3 Part 2"; Spy x Family S1 =
      // two cours) is the numbering Jellyfin and existing libraries use:
      // splitting there would renumber every later season and orphan
      // Season N folders already on disk. A show that keeps appending new
      // cours to its last season (Ranma ½ 2024) is the case this is for.
      if (bi !== B.length - 1) return null;
      lumped = true;
    }
  }
  if (!lumped) return null; // nothing was lumped: the layouts already agree
  for (; ai < A.length; ai++) {
    const a = A[ai];
    if (countOf(a) > 0) out.push({ season: a.season, episodes: countOf(a), year: a.year || '' });
  }
  return out;
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
  const out = (baseSeasons || []).filter((s) => s && s.season >= 0)
    .map((s) => ({ season: s.season, episodes: countOf(s), year: s.year || '' }));
  const have = new Set(out.map((s) => s.season));
  // AniList splits finer than TMDB when its seasons up to TMDB's last one
  // hold FEWER episodes than TMDB lists: TMDB's seasons already contain the
  // "extra" AniList seasons (Attack on Titan: TMDB S3 = AniList S3 + S3
  // Part 2, so AniList has 6 seasons for TMDB's 4). Appending them would
  // list episodes twice and point downloads at TMDB seasons that do not
  // exist. Only a genuinely missing sequel (AniList's matching seasons cover
  // TMDB's count) is added. Specials are judged on their own.
  const numbered = out.filter((s) => s.season > 0);
  const maxBase = numbered.reduce((m, s) => Math.max(m, s.season), 0);
  const baseTotal = numbered.reduce((t, s) => t + countOf(s), 0);
  const extraCovered = (extraSeasons || []).filter((s) => s && s.season > 0 && s.season <= maxBase)
    .reduce((t, s) => t + countOf(s), 0);
  const extraIsFiner = maxBase > 0 && extraCovered > 0 && extraCovered < baseTotal;
  for (const s of extraSeasons || []) {
    if (!s || !(s.season >= 0) || have.has(s.season)) continue;
    if (s.season > 0 && extraIsFiner) continue;
    if (s.season === 0 && !countOf(s)) continue; // no known specials: nothing to add
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
  // Specials (Season 0) are numbered per source and are never part of the
  // main-season episode run, so they are never offset into a real season.
  if (!(Number(season) > 0)) return identity;
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
  let tmdbSeasons = null;
  try { tmdbSeasons = await tmdbSeasonCounts(tmdbId, opts); } catch (e) { /* ignore */ }
  // Cour split (TMDB lumps several AniList seasons into one): the plugin
  // shows - and the files use - the split numbering; the source URL needs
  // TMDB's lumped numbers. S3E1 of Ranma ½ (2024) -> TMDB S1E25.
  if (tmdbSeasons && opts.anime) {
    const year = opts.year || cacheGet('tmdbyear:' + String(tmdbId || '').trim()) || 0;
    const al = await anilistLayout(tmdbId, title, { ...opts, year });
    const split = al ? splitLumpedSeasons(tmdbSeasons, al) : null;
    if (split) {
      return (season, episode) => {
        const s = split.find((x) => x.season === Number(season));
        if (!s || s.tmdbSeason == null || !(Number(episode) >= 1)) return { season, episode, mapped: false };
        return { season: s.tmdbSeason, episode: s.tmdbOffset + Number(episode), mapped: true };
      };
    }
  }
  const resolved = await resolveLayout(tmdbId, title, opts);
  if (!resolved) return null;
  if (!tmdbSeasons) return null;
  // Translate ONLY when the plugin shows the resolved layout - the numbers
  // it sends are in that layout. tmdbInfo shows AniList's layout only when
  // TMDB lists no numbered season; otherwise it shows TMDB's own seasons
  // (plus genuinely missing sequels), so the numbers already ARE TMDB's.
  // Mapping them anyway sent Attack on Titan "S4E1" to TMDB S3E13.
  if (resolved.source === 'anilist' && tmdbSeasons.some((s) => s.season > 0 && countOf(s) > 0)) return null;
  // No-op check: if the first real pair is already identity and shapes
  // match, skip the per-episode work entirely.
  const a = resolved.seasons.find((s) => s.season > 0) || resolved.seasons[0];
  if (a) {
    const m = mapEpisode(resolved.seasons, tmdbSeasons, a.season, 1);
    if (!m.mapped) {
      // Identity for ep 1 does not prove identity for all - but if the total
      // episode sets differ or shapes match, mapEpisode always returns
      // identity. Re-check with a mid/last pair to be sure.
      const numbered = resolved.seasons.filter((s) => s.season > 0);
      const last = numbered[numbered.length - 1] || a;
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
  anilistSequelChain,
  anilistRelations,
  specialsFromExtras,
  anilistGql,
  anilistIdFor,
  resolveLayout,
  anilistLayout,
  splitLumpedSeasons,
  mapEpisode,
  addMissingSeasons,
  urlMapFor,
  tmdbSeasonCounts,
  normAniwaveSeason,
  titlesMatch,
  _resetCache,
  _internals: { httpJson, anilistGql, cacheGet, cacheSet, ANIWAVE_MIRRORS }
};
