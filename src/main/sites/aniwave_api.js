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
let get = (pathAndQuery, { ajax = false } = {}) =>
  new Promise((resolve) => {
    const headers = { 'User-Agent': UA, Accept: ajax ? 'application/json, text/javascript, */*' : 'text/html' };
    if (ajax) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers.Referer = BASE + '/';
    }
    const req = https.get(BASE + pathAndQuery, { headers, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (body.length < 2000000) body += d;
      });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });

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
    const re = /<a\b[^>]*\bdata-num="(\d+)"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[0];
      out.push({
        episode: Number(m[1]),
        sub: /\bdata-sub="1"/.test(tag),
        dub: /\bdata-dub="1"/.test(tag)
      });
    }
    return out;
  });
}

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// The season number an Aniwave title names ("Season 2", "2nd Season",
// "Part 2" is NOT a season), or 1 when it names none.
function seasonOfTitle(t) {
  const s = norm(t);
  const m = s.match(/\bseason (\d+)\b/) || s.match(/\b(\d+)(?:st|nd|rd|th) season\b/);
  return m ? Number(m[1]) : 1;
}

// The entry for (title, season): the base title must match exactly (after
// removing a season suffix and anything after a colon), and the season
// number named in the title must be the one asked for. Movies, specials and
// spin-offs whose base title differs are never picked.
function pickShow(results, title, season = 1) {
  const want = norm(title);
  const wantSeason = Number(season) > 0 ? Number(season) : 1;
  const base = (t) =>
    norm(String(t || '').split(':')[0])
      .replace(/\b(season \d+|\d+(?:st|nd|rd|th) season)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const candidates = (results || []).filter((r) => {
    const names = [r.title, r.jp].filter(Boolean);
    const sameWork = names.some((n) => base(n) === want || norm(n) === want);
    return sameWork && seasonOfTitle(r.title) === wantSeason;
  });
  // Prefer the plainest name (no ": subtitle" spin-off text).
  candidates.sort((a, b) => a.title.length - b.title.length);
  return candidates[0] || null;
}

// The Aniwave entry + its episode flags for one season of a title.
// -> { show, episodes } or null
async function seasonInfo(title, season = 1) {
  const results = await search(title);
  const show = pickShow(results, title, season);
  if (!show) return null;
  const eps = await episodes(show.id);
  if (!eps) return null;
  return { show, episodes: eps };
}

function episodeUrl(show, episode) {
  return `${BASE}/watch/${show.slug}/ep-${Number(episode)}`;
}

module.exports = {
  BASE,
  search,
  episodes,
  pickShow,
  seasonOfTitle,
  seasonInfo,
  episodeUrl,
  _setGetForTests(fn) {
    get = fn;
    cache.clear();
  },
  _clearCache() {
    cache.clear();
  }
};
