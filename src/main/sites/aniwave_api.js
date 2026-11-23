'use strict';

// Aniwave (aniwaves.ru) catalog over plain HTTP - no browser needed:
//   search     GET /filter?keyword=<q>            -> <a class="name d-title" href="/watch/<slug>-<id>" data-jp="...">Title</a>
//   episodes   GET /ajax/episode/list/<id>         -> { result: "<a ... data-num="N" data-sub="1" data-dub="0|1" ...>" }
// Verified live (Oct 2026): Solo Leveling (76040) flags all 12 episodes
// data-dub="1" and every one has a DUB server row (its stream URL is the
// "<slug>-dub" one); Smoking Behind the Supermarket (82730) flags 0 of 12 and
// has no DUB row. So data-dub is the per-episode "is the English dub out"
// answer used by the dub badge, intake and the daily waiting-list pass.
//
// Each Aniwave entry is ONE season (a sequel is its own entry: "Solo
// Leveling Season 2: Arise from the Shadow"), numbered from episode 1.

const https = require('https');

const BASE = 'https://aniwaves.ru';
// The address in use: the one set in the engine settings (aniwaveBase), else
// the one the site last redirected to, else BASE. Aniwave moves address now
// and then; a redirect to the new one is followed and remembered.
function base() {
  try {
    const c = require('../engineconfig').get() || {};
    if (c.aniwaveBase && /^https?:\/\/[^/]+$/.test(String(c.aniwaveBase).replace(/\/$/, ''))) return String(c.aniwaveBase).replace(/\/$/, '');
  } catch (e) {
    /* plain Node / no config */
  }
  return BASE;
}
// What the site answered last (for dub-check / the Sources row).
let lastResponse = null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const CACHE_MS = 6 * 3600 * 1000;
const cache = new Map(); // key -> { at, value }

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  return fn().then((value) => {
    if (value != null) cache.set(key, { at: Date.now(), value });
    return value;
  });
}

// Injectable for tests: (path, { ajax }) -> body string (null on failure).
// A hard deadline on the whole request (the socket timeout only fires on
// silence: a trickling or never-ending response held the watch pass forever).
const REQUEST_DEADLINE_MS = 40000;
let get = (pathAndQuery, { ajax = false } = {}) =>
  new Promise((resolveRaw) => {
    let done = false;
    const resolve = (v) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolveRaw(v);
    };
    const deadline = setTimeout(() => {
      try { if (req) req.destroy(); } catch (e) { /* ignore */ }
      resolve(null);
    }, REQUEST_DEADLINE_MS);
    let req = null;
    const headers = { 'User-Agent': UA, Accept: ajax ? 'application/json, text/javascript, */*' : 'text/html' };
    if (ajax) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers.Referer = base() + '/';
    }
    const fetchUrl = (url, hops) => {
    const lib = url.startsWith('http:') ? require('http') : https;
    req = lib.get(url, { headers, timeout: 15000 }, (res) => {
      const loc = res.headers && res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && hops < 3) {
        res.resume();
        let next = '';
        try { next = new URL(loc, url).href; } catch (e) { next = ''; }
        if (!next) return resolve(null);
        // Moved to another address for the same page: use that address from
        // now on (kept in the engine settings).
        try {
          const from = new URL(url);
          const to = new URL(next);
          if (to.host !== from.host && to.pathname === from.pathname) {
            const origin = to.origin;
            require('../engineconfig').set({ aniwaveBase: origin });
            console.log(`[aniwave] the site moved to ${origin} - using it from now on`);
          }
        } catch (e) { /* keep the old address */ }
        return fetchUrl(next, hops + 1);
      }
      if (res.statusCode !== 200) {
        let peek = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (peek.length < 300) peek += d; });
        res.on('end', () => {
          lastResponse = {
            at: Date.now(), url, status: res.statusCode, server: String(res.headers.server || ''),
            cloudflare: /cloudflare/i.test(String(res.headers.server || '')) || !!res.headers['cf-ray'] || /just a moment|cf-chl/i.test(peek),
            body: peek.replace(/\s+/g, ' ').slice(0, 160)
          };
          resolve(null);
        });
        res.on('error', () => resolve(null));
        return undefined;
      }
      lastResponse = { at: Date.now(), url, status: 200 };
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (body.length < 2000000) body += d;
      });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(null));
      res.on('close', () => resolve(null)); // closed without 'end': no answer
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => {
      lastResponse = { at: Date.now(), url, status: 0, error: (e && (e.code || e.message)) || 'network error' };
      resolve(null);
    });
    };
    fetchUrl(base() + pathAndQuery, 0);
  });

// Injectable for tests: (title, season) -> [other names of the work]
let getNames = (title, season) => require('../animenames').namesFor(title, season);

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();

// -> [{ title, jp, slug, id }]
function search(q) {
  const query = String(q || '').trim();
  if (query.length < 2) return Promise.resolve([]);
  return cached('s:' + query.toLowerCase(), async () => {
    const html = await get('/filter?keyword=' + encodeURIComponent(query).replace(/%20/g, '+'));
    if (!html) return null;
    const out = [];
    const re = /<a class="name d-title" href="\/watch\/([^"]+?)-(\d+)"([^>]*)>([^<]*)</g;
    let m;
    while ((m = re.exec(html))) {
      const jp = (m[3].match(/data-jp="([^"]*)"/) || [])[1] || '';
      out.push({ slug: `${m[1]}-${m[2]}`, id: m[2], title: decode(m[4]), jp: decode(jp) });
    }
    return out;
  });
}

// -> [{ episode, sub, dub }] (null when the list could not be read)
function episodes(id) {
  return cached('e:' + id, async () => {
    const body = await get('/ajax/episode/list/' + encodeURIComponent(id), { ajax: true });
    if (!body) return null;
    let html = '';
    try {
      html = String(JSON.parse(body).result || '');
    } catch (e) {
      return null;
    }
    const out = [];
    // Whole episodes only: recap / bonus entries are numbered between two
    // episodes ("10.5", "11.5" - The Girl Downstairs) and are never the
    // episode a job asks for.
    const re = /<a\b[^>]*\bdata-num="([\d.]+)"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[0];
      if (!/^\d+$/.test(m[1])) continue;
      out.push({
        episode: Number(m[1]),
        sub: /\bdata-sub="1"/.test(tag),
        dub: /\bdata-dub="1"/.test(tag)
      });
    }
    return out;
  });
}

const norm = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019'`]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// Plainer search queries for a title the site's search may not take as-is
// (accents, quotes, guillemets, "!!"): the folded words, then the part
// before a colon. The pick stays strict (pickShow), so these only widen
// what is searched, never what is accepted.
function searchQueries(title) {
  const t = String(title || '').trim();
  const folded = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019'`]/g, '')
    .replace(/[^A-Za-z0-9 :\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const head = folded.split(':')[0].trim();
  // The site's own spelling is often another one: the apostrophe moved
  // ("Devils' Crest" -> "Devil's Crest"), or the first word alone finds it
  // (the match below still needs the same name). Searched last.
  const moved = t.replace(/([A-Za-z])s['\u2019](?=\s|$)/g, "$1's");
  const words = head.split(' ').filter(Boolean);
  const first = words.length > 1 && words[0].length >= 4 ? words[0] : '';
  return [...new Set([t, folded, head, moved, first, first && first.replace(/s$/i, '')].filter((q) => q && q.length >= 3))];
}

// The season number a title names ("Season 2", "2nd Season", a trailing
// "III"; "Part 2" is NOT a season), or 1 when it names none - and the title
// with its season markers removed. Shared with Anime Village.
const { seasonOfTitle, baseName } = require('./animevillage_api');

// The entry for (title, season): the base title must match exactly (after
// removing a season suffix and anything after a colon), and the season
// number named in the title must be the one asked for. Movies, specials and
// spin-offs whose base title differs are never picked.
// The same name, whatever its spacing / apostrophes: "Ao Ashi" = "Aoashi",
// "Devil's Crest" = "Devils' Crest" (the watch list's spelling). Only for
// names long enough not to collide.
const squash = (x) => String(x || '').replace(/\s+/g, '');
function sameName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = squash(a);
  return sa.length >= 5 && sa === squash(b);
}

function pickShow(results, title, season = 1) {
  const want = baseName(title);
  const wantSeason = Number(season) > 0 ? Number(season) : 1;
  const base = baseName;
  const candidates = (results || []).filter((r) => {
    const names = [r.title, r.jp].filter(Boolean);
    const sameWork = names.some((n) => sameName(base(n), want) || sameName(norm(n), want));
    return sameWork && seasonOfTitle(r.title) === wantSeason;
  });
  // Prefer the plainest name (no ": subtitle" spin-off text).
  candidates.sort((a, b) => a.title.length - b.title.length);
  return candidates[0] || null;
}

// The Aniwave entry + its episode flags for one season of a title.
// -> { show, episodes } or null
async function seasonInfo(title, season = 1) {
  let show = null;
  for (const q of searchQueries(title)) {
    show = pickShow(await search(q), title, season);
    if (show) break;
  }
  if (!show) {
    // Not under the English title: try the work's other names from AniList
    // (romaji / Chinese romanization), each matched the same strict way.
    let names = [];
    try {
      names = await getNames(title, season);
    } catch (e) {
      names = [];
    }
    for (const n of names.filter((x) => /[a-z]/i.test(x)).slice(0, 4)) {
      const q = String(n).split(':')[0].trim();
      const res = await search(q);
      show = pickShow(res, n, season) || pickShow(res, q, season);
      if (show) break;
    }
  }
  if (!show) return null;
  const eps = await episodes(show.id);
  if (!eps) return null;
  return { show, episodes: eps };
}

// Entries of the SAME work whose title names no season number - arcs and
// parts ("Link Click: Bridon Arc"), never the plain season-1 entry (pass its
// id in excludeIds). -> [{ show, episodes }] (episode lists read). These are
// how a TMDB season that Aniwave lists under a name is found.
async function unnumberedEntries(title, excludeIds = []) {
  const want = baseName(title);
  if (!want) return [];
  const skip = new Set((excludeIds || []).map(String));
  const results = (await search(title)) || [];
  const picked = results.filter((r) => {
    if (skip.has(String(r.id))) return false;
    const names = [r.title, r.jp].filter(Boolean);
    if (!names.some((n) => sameName(baseName(n), want))) return false;
    // Named season ("Season 2", "2nd Season", "III") -> a numbered entry.
    if (seasonOfTitle(r.title) !== 1) return false;
    // The plain title is season 1 itself; an arc/part has more after it.
    return norm(r.title) !== want;
  });
  const out = [];
  for (const show of picked.slice(0, 6)) {
    const eps = await episodes(show.id);
    if (eps && eps.length) out.push({ show, episodes: eps });
  }
  return out;
}

function episodeUrl(show, episode) {
  return `${base()}/watch/${show.slug}/ep-${Number(episode)}`;
}

module.exports = {
  get BASE() { return base(); },
  base,
  lastResponse: () => lastResponse,
  search,
  episodes,
  pickShow,
  seasonOfTitle,
  seasonInfo,
  unnumberedEntries,
  searchQueries,
  sameName,
  episodeUrl,
  _setGetForTests(fn, names = async () => []) {
    get = fn;
    getNames = names;
    cache.clear();
  },
  _clearCache() {
    cache.clear();
  }
};
