'use strict';

// Anime Village (animevillage.org) - a JSON API over plain HTTP, no browser:
//   search    GET /api/search?search=<q>&page=1&perPage=15
//             -> { data: { Page: { media: [{ id, title:{english,romaji,native}, synonyms, format }] } }, _fallback? }
//   episodes  GET /api/episodes/<id>?dub=true
//             -> { episodes: [{ id: "<slug>?ep=<epId>", number }] }
//   stream    GET /api/stream/<id>?category=dub|sub&server=hd-1|hd-2&ep=<epId>
//             -> { headers: { Referer, Origin }, sources: [{ url: ".../master.m3u8" }], subtitles: [{ url, lang, label }] }
//
// Verified live (Oct 2026):
//   - Smoking Behind the Supermarket with You E1: the DUB stream is its own
//     file, audio tagged "eng", 1080p, with "English (Forced)" subtitles; the
//     SUB stream is a different file tagged "jpn" (Aniwave and Vidsrc have
//     no English dub of it at all).
//   - Link Click S3 ("Shiguang Dailiren III"): E1-E10 have a DUB file; for
//     E11/E12 (not dubbed yet) the "dub" request returns the SAME file as the
//     sub. So "dubbed" = the dub stream is a different file from the sub.
//   - The CDN (and the subtitle host) answer 403 without the player's
//     Referer/Origin, which the stream response names.
//   - Search is backed by AniList and falls back to the site's own catalog
//     ("_fallback": "hianime-search") when AniList is busy; it sometimes
//     returns nothing at all. Only the catalog's slug ids
//     ("shiguang-dailiren-iii-8854") have reliable episode lists, so the
//     search is retried until it yields them.

const https = require('https');

const BASE = 'https://www.animevillage.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const CACHE_MS = 6 * 3600 * 1000;
const DUB_TTL = { yes: 7 * 24 * 3600 * 1000, no: 6 * 3600 * 1000 };
const cache = new Map(); // key -> { at, value }
const dubCache = new Map(); // "slug|episode" -> { at, dubbed }

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let pauseMs = (ms) => delay(ms);

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  return fn().then((value) => {
    if (value != null) cache.set(key, { at: Date.now(), value });
    return value;
  });
}

// Injectable for tests: (pathAndQuery) -> parsed JSON (null on failure).
let get = (pathAndQuery) =>
  new Promise((resolve) => {
    const req = https.get(BASE + pathAndQuery, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 30000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (body.length < 4000000) body += d;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });

// The API's answer, retried while it is missing or an { error } (the site's
// backend is often briefly "down").
async function getJson(pathAndQuery, { tries = 3, ok = (o) => o && !o.error } = {}) {
  for (let i = 0; i < tries; i++) {
    const o = await get(pathAndQuery);
    if (ok(o)) return o;
    if (i < tries - 1) await pauseMs(1500 * (i + 1));
  }
  return null;
}

// Accents folded ("Fiancé" = "Fiance") and apostrophes dropped ("God's" =
// "Gods"), so a site spelling either way is the same work.
const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019'`]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

// A trailing roman numeral ("Shiguang Dailiren III") - but not the romaji
// word "ii" ("good") after a particle: "Raise wa Tanin ga Ii" (Yakuza
// Fiance) is season 1, not II. -> 'iii' etc., or null.
function romanTail(s) {
  const m = String(s || '').match(/ (ii|iii|iv|v|vi|vii|viii|ix|x)$/);
  if (!m) return null;
  if (m[1] === 'ii' && /(?:^| )(?:ga|wa|ha|de|mo|ni|to|no|ya|yo|ne|ka|demo|hou ga) ii$/.test(s)) return null;
  return m[1];
}

// Season named by a title: "Season 2", "2nd Season", or a trailing roman
// numeral ("Shiguang Dailiren III"); 1 when it names none. "Part 2" is not a
// season (a split cour of the same season).
function seasonOfTitle(t) {
  const s = norm(String(t || '').split(':')[0]);
  const m = s.match(/\bseason (\d+)\b/) || s.match(/\b(\d+)(?:st|nd|rd|th) season\b/);
  if (m) return Number(m[1]);
  const r = romanTail(s.replace(/\bpart \d+$/, '').trim());
  return r ? ROMAN[r] : 1;
}

// A title with its season / part markers removed: the "same work" key.
// Anything after a season marker is that season's subtitle (slugs have no
// colon: "solo leveling season 2 arise from the shadow").
function baseName(t) {
  let s = norm(String(t || '').split(':')[0]);
  const m = s.match(/^(.*?)\b(?:season \d+|\d+(?:st|nd|rd|th) season)\b/);
  if (m && m[1].trim()) s = m[1];
  s = s.replace(/\bpart \d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  return romanTail(s) ? s.replace(/ (ii|iii|iv|v|vi|vii|viii|ix|x)$/, '').trim() : s.trim();
}

// The site's own catalog ids are slugs ("<english-ish-name>[-<5-char tag>]-<n>").
const isSlug = (id) => typeof id === 'string' && /[a-z]/i.test(id) && /-\d+$/.test(id);
function slugNames(id) {
  if (!isSlug(id)) return [];
  const noNum = id.replace(/-\d+$/, '');
  const noTag = noNum.replace(/-[a-z0-9]{5}$/, '');
  return [...new Set([noNum, noTag])].map((x) => x.replace(/-/g, ' '));
}

function namesOf(m) {
  const t = m.title || {};
  return [t.english, t.romaji, t.native, ...(Array.isArray(m.synonyms) ? m.synonyms : []), ...slugNames(String(m.id))].filter(Boolean);
}

// -> [{ id, names, format, slug }] for one query. The search answers from
// AniList (numeric ids, whose episode lists do not load) or from the site's
// own catalog (slug ids); it is retried until the catalog answers, keeping
// AniList's answer (its names help the next query) when it never does.
function search(q) {
  const query = String(q || '').trim();
  if (query.length < 2) return Promise.resolve([]);
  return cached('s:' + query.toLowerCase(), async () => {
    let best = null;
    for (let i = 0; i < 4; i++) {
      const o = await get(`/api/search?search=${encodeURIComponent(query)}&page=1&perPage=15`);
      const media = o && o.data && o.data.Page && Array.isArray(o.data.Page.media) ? o.data.Page.media : [];
      const rows = media.map((m) => ({ id: String(m.id), names: namesOf(m), format: String(m.format || ''), slug: isSlug(String(m.id)) }));
      // The catalog's answer (marked "_fallback", slug ids) is definitive,
      // also when it lists nothing.
      if ((o && o._fallback) || rows.some((x) => x.slug)) {
        rows.catalog = true;
        return rows;
      }
      if (rows.length && !best) best = rows;
      if (i < 3) await pauseMs(1500 * (i + 1));
    }
    return best;
  });
}

const NOT_SERIES = /^(MOVIE|SPECIAL|OVA|MUSIC|TV_SHORT)$/i;

// The entry for (one of the names, season): same work (base name equal) and
// the season the title names; series formats only; catalog slugs preferred
// (their episode lists load), then the plainest name.
function pickShow(results, names, season = 1) {
  const want = new Set((Array.isArray(names) ? names : [names]).map(baseName).filter(Boolean));
  const wantSeason = Number(season) > 0 ? Number(season) : 1;
  const cands = (results || []).filter((r) => {
    if (NOT_SERIES.test(r.format)) return false;
    return r.names.some((n) => want.has(baseName(n)) && seasonOfTitle(n) === wantSeason);
  });
  cands.sort((a, b) => (b.slug - a.slug) || (Math.min(...a.names.map((n) => n.length)) - Math.min(...b.names.map((n) => n.length))));
  return cands[0] || null;
}

// -> [{ number, epId }] (null when the list could not be read)
function episodes(id) {
  return cached('e:' + id, async () => {
    const o = await getJson(`/api/episodes/${encodeURIComponent(id)}?dub=true`, {
      ok: (x) => x && Array.isArray(x.episodes) && x.episodes.length > 0
    });
    if (!o) return null;
    // Whole episodes only (a "10.5" recap is never the episode asked for).
    return o.episodes
      .map((e) => ({ number: Number(e.number), epId: String(e.id || '').split('?ep=')[1] || '' }))
      .filter((e) => Number.isInteger(e.number) && e.number > 0 && e.epId);
  });
}

// The show's own summary: { hasDub, hasSub, totalEpisodes } (null when
// unreadable). "hasDub: false" is a definite "no English dub of this show",
// also when its episode list does not load (The Girl Downstairs: the list
// answers "Anime not found", the summary says 22 episodes, no dub).
function info(id) {
  return cached('i:' + id, () => getJson(`/api/episodes/${encodeURIComponent(id)}/info`, { ok: (x) => x && typeof x.hasDub === 'boolean' }));
}

// The show for (title, season). names: other titles of the work to try
// (Aniwave's romaji name, ...). A season-numbered query goes first for later
// seasons so the right entry is in the results. ctx.catalog is set when the
// site's own catalog answered a search - a miss is then a real "not here",
// not a search that never got a usable answer.
async function findShow(title, season = 1, names = [], { anilist = true, ctx = {} } = {}) {
  const found = await findShowBy(title, season, names, ctx);
  if (found || !anilist) return found;
  // Not under the names we have: ask AniList for every name of the work
  // (romaji / native / synonyms - Link Click S3 is "Shiguang Dailiren III").
  let more = [];
  try {
    more = await require('../animenames').namesFor(title, season);
  } catch (e) {
    more = [];
  }
  more = more.filter((n) => /[a-z]/i.test(n) && !names.includes(n)).slice(0, 4);
  return more.length ? findShowBy(title, season, [...names, ...more], ctx) : null;
}

async function findShowBy(title, season = 1, names = [], ctx = {}) {
  const all = [title, ...names].filter(Boolean);
  const queries = [];
  for (const n of all) {
    const b = String(n).split(':')[0].trim();
    if (Number(season) > 1) queries.push(`${b} season ${season}`);
    queries.push(b);
  }
  for (const q of [...new Set(queries)]) {
    const res = await search(q);
    if (res && res.catalog) ctx.catalog = true;
    const show = pickShow(res || [], all, season);
    if (show && show.slug) return show;
    // An AniList id: its names are good, but only a catalog slug lists
    // episodes reliably - search again by its romaji/English names.
    if (show) {
      for (const n of [...new Set(show.names.slice(0, 2).map((x) => String(x).replace(/\s*\bpart \d+\s*$/i, '')))]) {
        const again = pickShow((await search(n)) || [], [...all, ...show.names], season);
        if (again && again.slug) return again;
      }
      const eps = await episodes(show.id);
      if (eps && eps.length) return show;
    }
  }
  return null;
}

// One category's stream for an episode: hd-1, then hd-2 (what the site's
// player does). -> { url, headers, subtitles } or null
async function stream(showId, epId, category) {
  for (const server of ['hd-1', 'hd-2']) {
    const o = await getJson(
      `/api/stream/${encodeURIComponent(showId)}?category=${category}&server=${server}&ep=${encodeURIComponent(epId)}`,
      { tries: 2, ok: (x) => x && Array.isArray(x.sources) && x.sources.length && x.sources[0].url }
    );
    if (o) {
      return {
        url: String(o.sources[0].url),
        headers: o.headers && typeof o.headers === 'object' ? o.headers : {},
        subtitles: Array.isArray(o.subtitles) ? o.subtitles : [],
        server
      };
    }
  }
  return null;
}

// The file a stream URL points at (".../anime/<show>/<file>/master.m3u8").
function fileKey(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : url;
  } catch (e) {
    return String(url || '');
  }
}

// Is this episode English-dubbed here? true / false / null (unreachable).
// The dub must be its own file: when there is no dub yet the site hands back
// the sub file for a "dub" request.
async function episodeDub(show, ep) {
  const k = `${show.id}|${ep.number}`;
  const hit = dubCache.get(k);
  if (hit && Date.now() - hit.at < (hit.dubbed ? DUB_TTL.yes : DUB_TTL.no)) return { dubbed: hit.dubbed, cached: true };
  const dub = await stream(show.id, ep.epId, 'dub');
  if (!dub) return { dubbed: null };
  const sub = await stream(show.id, ep.epId, 'sub');
  if (!sub) return { dubbed: null, dub };
  const dubbed = fileKey(dub.url) !== fileKey(sub.url);
  dubCache.set(k, { at: Date.now(), dubbed });
  return { dubbed, dub, sub };
}

// Episode -> dubbed (true/false) for one season; episodes it could not check
// are left out. A show (or an asked-for episode) the catalog does not list
// has no dub here: false. null when the site gave no usable answer.
async function dubMap(title, season = 1, { names = [], only = null } = {}) {
  const ctx = {};
  const show = await findShow(title, season, names, { ctx });
  const want = only ? only.map(Number) : null;
  const none = () => new Map((want || []).map((e) => [e, false]));
  if (!show) return ctx.catalog ? none() : null;
  const eps = await episodes(show.id);
  if (!eps) {
    const sum = await info(show.id);
    return sum && sum.hasDub === false ? none() : null;
  }
  const out = new Map();
  for (const ep of eps) {
    if (want && !want.includes(ep.number)) continue;
    const r = await episodeDub(show, ep);
    if (r.dubbed != null) out.set(ep.number, r.dubbed);
    if (!r.cached) await pauseMs(300); // gentle on the site's API
  }
  for (const e of want || []) if (!eps.some((x) => x.number === e)) out.set(e, false);
  return out;
}

// Dub results already known (no network): episode -> true/false.
function cachedDubMap(showId) {
  const out = new Map();
  for (const [k, v] of dubCache) {
    const [id, n] = k.split('|');
    if (id === showId && Date.now() - v.at < (v.dubbed ? DUB_TTL.yes : DUB_TTL.no)) out.set(Number(n), v.dubbed);
  }
  return out;
}

// The stream to download for one episode.
//   -> { status: 'resolved', show, episode, stream, category }
//    | { status: 'no_show' | 'no_episode' | 'no_dub' | 'no_sub' | 'unreachable', reason }
async function resolveEpisode({ title, season = 1, episode, mode = 'dub', names = [] }) {
  const show = await findShow(title, season, names);
  if (!show) return { status: 'no_show', reason: `"${title}" season ${season} is not on Anime Village` };
  const eps = await episodes(show.id);
  if (!eps) {
    const sum = mode === 'dub' ? await info(show.id) : null;
    if (sum && sum.hasDub === false) return { status: 'no_dub', reason: `Anime Village has no English dub of "${show.names[0]}"`, show };
    return { status: 'unreachable', reason: 'Anime Village episode list did not load' };
  }
  const ep = eps.find((e) => e.number === Number(episode));
  if (!ep) return { status: 'no_episode', reason: `Anime Village has no episode ${episode} of "${show.names[0]}" yet`, show };
  if (mode === 'sub') {
    const sub = await stream(show.id, ep.epId, 'sub');
    if (!sub) return { status: 'unreachable', reason: 'Anime Village stream did not load', show };
    return { status: 'resolved', show, episode: ep, stream: sub, category: 'sub' };
  }
  const r = await episodeDub(show, ep);
  if (r.dubbed === null) return { status: 'unreachable', reason: 'Anime Village stream did not load', show };
  if (!r.dubbed) return { status: 'no_dub', reason: `Anime Village has no English dub of "${show.names[0]}" E${ep.number} yet`, show };
  // A cached "dubbed" answer carries no stream: fetch the dub one now.
  const dub = r.dub || (await stream(show.id, ep.epId, 'dub'));
  if (!dub) return { status: 'unreachable', reason: 'Anime Village stream did not load', show };
  return { status: 'resolved', show, episode: ep, stream: dub, category: 'dub' };
}

module.exports = {
  BASE,
  UA,
  search,
  episodes,
  info,
  pickShow,
  findShow,
  seasonOfTitle,
  baseName,
  stream,
  fileKey,
  episodeDub,
  dubMap,
  cachedDubMap,
  resolveEpisode,
  _setGetForTests(fn, { noPause = true } = {}) {
    get = fn;
    if (noPause) pauseMs = () => Promise.resolve();
    cache.clear();
    dubCache.clear();
  },
  _clearCache() {
    cache.clear();
    dubCache.clear();
  }
};
