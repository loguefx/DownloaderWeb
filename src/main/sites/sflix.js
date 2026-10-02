'use strict';

const { rememberMediaId: sharedRememberMediaId } = require('./findtitle');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function playerUrlNeedsId(url) {
  const s = String(url || '');
  if (!s) return false;
  if (/[?&](?:id|imdb|video_id)=(?:&|$)/i.test(s)) return true;
  try {
    const p = new URL(s).pathname.replace(/\/+/g, '/').replace(/\/$/, '');
    const parts = p.split('/').filter(Boolean);
    const kind = parts[0] === 'embed' ? parts[1] : parts[0];
    const rest = parts[0] === 'embed' ? parts.slice(2) : parts.slice(1);
    if (kind !== 'tv' && kind !== 'movie') return false;
    // moviesapi.to/tv/1739-1-7 already names the episode. Treating that slug
    // as a missing id prepended the TMDB number on every pass
    // (/tv/1739/1739/1739-1-7).
    if (rest.some((seg) => /^\d+-\d+-\d+$/.test(seg))) return false;
    if (rest.length < 3) return true;
    const id = rest[0] || '';
    if (!id || id === 'tt') return true;
    if (/^\d{1,3}$/.test(id) && !/^tt/i.test(id)) return true;
    return false;
  } catch (e) {
    return /\/(?:tv|movie)\/+\d+\//i.test(s);
  }
}

// Idempotent on purpose: beforeResolve rewrites every [data-player-url] and
// dubselect rewrites the tab URL again. Without the needs-id gate a numeric
// TMDB id got prepended each pass (/tv/210704/210704/210704/1/1 -> 404).
function injectPlayerUrl(url, mediaId) {
  const id = String(mediaId || '').trim();
  if (!url || !id) return url;
  if (!playerUrlNeedsId(url)) return url;
  try {
    const u = new URL(url, 'https://vidfast.pro');
    let path = u.pathname.replace(/\/+/g, '/');
    path = path.replace(/\/(tv|movie)\/(?:tt\d+\/)?/i, `/$1/${id}/`);
    const segs = path.split('/').filter(Boolean);
    const embed = segs[0] === 'embed';
    const kindAt = embed ? 1 : 0;
    const kind = segs[kindAt];
    if (kind === 'tv' || kind === 'movie') {
      const rest = segs.slice(kindAt + 1);
      if (rest.length === 2 && /^\d{1,3}$/.test(rest[0])) {
        const prefix = embed ? '/embed' : '';
        path = `${prefix}/${kind}/${id}/${rest[0]}/${rest[1]}`;
      }
    }
    u.pathname = path;
    if (u.searchParams.has('id') && !u.searchParams.get('id')) u.searchParams.set('id', id);
    if (u.searchParams.has('imdb') && !/^tt\d+/i.test(u.searchParams.get('imdb') || '')) {
      u.searchParams.set('imdb', id);
    }
    if (u.searchParams.has('video_id') && !u.searchParams.get('video_id')) {
      u.searchParams.set('video_id', id.replace(/^tt/i, ''));
    }
    return u.toString();
  } catch (e) {
    return url;
  }
}

function httpsJson(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let b = '';
      res.on('data', (c) => {
        b += c;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      try {
        req.destroy();
      } catch (e) {
        // ignore
      }
      reject(new Error('imdb lookup timeout'));
    });
  });
}

// SFlix carries two page families for the same show
// (…-season-1-episode-2 and …-s01e10-episode-1-10-2) and they advertise
// different player ids. Vidfast is TMDB-keyed, so the numeric id loads a player
// while the IMDB one returns about:blank for the same episode. Remember what a
// series has used and prefer the numeric id once we have seen one.
const seriesMediaIds = new Map();

function seriesKeyFromUrl(url) {
  try {
    const m = new URL(String(url || '')).pathname.match(/\/episodes\/([^/]+)/i);
    if (!m) return '';
    return m[1]
      .toLowerCase()
      .replace(/-s\d{1,2}e\d{1,3}\b.*$/i, '')
      .replace(/-season-\d+-episode-\d+.*$/i, '')
      .replace(/-+$/, '');
  } catch (e) {
    return '';
  }
}

const isNumericId = (id) => /^\d+$/.test(String(id || ''));

function rememberMediaId(key, id) {
  if (!key || !id) return;
  const prev = seriesMediaIds.get(key);
  if (!prev || (isNumericId(id) && !isNumericId(prev))) seriesMediaIds.set(key, id);
}

function preferredMediaId(key, id) {
  const cached = key ? seriesMediaIds.get(key) : '';
  if (!cached) return id;
  if (!id) return cached;
  return isNumericId(cached) && !isNumericId(id) ? cached : id;
}

async function lookupImdbFromTitle(title) {
  const cleaned = String(title || '')
    .replace(/\s*[-–|].*sflix.*$/i, '')
    .replace(/\s*[-–:]\s*season\s+\d+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const q = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  if (q.length < 3) return '';
  const url = `https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(q[0])}/${encodeURIComponent(q)}.json`;
  try {
    const data = await httpsJson(url);
    const want = cleaned.toLowerCase();
    const hits = (data && data.d) || [];
    const tv = hits.filter((x) => x && /^tt\d+/i.test(x.id) && /tv/i.test(String(x.q || x.qid || 'tv')));
    const pool = tv.length ? tv : hits.filter((x) => x && /^tt\d+/i.test(x.id));
    const exact = pool.find((x) => String(x.l || '').toLowerCase() === want);
    if (exact) return exact.id;
    const close = pool.find((x) => {
      const l = String(x.l || '').toLowerCase();
      return l.includes(want) || want.includes(l);
    });
    return (close && close.id) || (pool[0] && pool[0].id) || '';
  } catch (e) {
    return '';
  }
}

const FIND_MEDIA_ID = `(() => {
  const ranked = [];
  const add = (v, score) => {
    const id = String(v || '').trim();
    if (!id) return;
    if (!/^tt\\d{5,}$/i.test(id) && !/^\\d{4,8}$/.test(id)) return;
    ranked.push({ id, score: score + (/^tt/i.test(id) ? 20 : 0) });
  };
  document.querySelectorAll('[data-player-url], iframe').forEach((el) => {
    const u = el.getAttribute('data-player-url') || el.src || el.getAttribute('src') || '';
    const m = String(u).match(/\\/(?:tv|movie)\\/(tt\\d{5,}|\\d{4,8})\\//i);
    if (m) add(m[1], 50);
  });
  document.querySelectorAll('a[href*="imdb.com/title/"]').forEach((a) => {
    const m = String(a.href || a.getAttribute('href') || '').match(/tt\\d{5,}/i);
    if (m) add(m[0], 40);
  });
  document.querySelectorAll('[data-imdb], [data-imdb-id], [data-ids], [data-tmdb], [data-tmdb-id]').forEach((el) => {
    add(el.getAttribute('data-imdb') || el.getAttribute('data-imdb-id') || '', 35);
    add(el.getAttribute('data-ids') || '', 30);
    add(el.getAttribute('data-tmdb') || el.getAttribute('data-tmdb-id') || '', 25);
  });
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    const t = s.textContent || '';
    const imdb = t.match(/tt\\d{5,}/);
    if (imdb) add(imdb[0], 30);
    const tmdb = t.match(/themoviedb\\.org\\/(?:tv|movie)\\/(\\d{3,8})/);
    if (tmdb) add(tmdb[1], 20);
  });
  const html = (document.documentElement && document.documentElement.innerHTML) || '';
  let m;
  const reTt = /tt\\d{6,}/g;
  while ((m = reTt.exec(html))) add(m[0], 10);
  const tmdb = html.match(/themoviedb\\.org\\/(?:tv|movie)\\/(\\d{4,8})/);
  if (tmdb) add(tmdb[1], 8);
  ranked.sort((a, b) => b.score - a.score);
  return (ranked[0] && ranked[0].id) || '';
})()`;

// Watch-site catalogs. Same-family hosts share episode paths. The other family
// is searched by title when this one has no 1080p copy. sflix.ch and sflix.vg
// redirect to sflix.bz, so they are not a third catalog.
const SFLIX_FAMILIES = {
  dooplay: ['https://sflix.soap2day.day', 'https://sflixz.day'],
  // Episode pages are /episode/{show}-season-1-episode-2/ and use a different
  // set of players than sflix.soap2day.day.
  psyplay: ['https://ww25.soap2day.day'],
  fmovie: ['https://sflix.bz']
};

function sflixFamily(pageUrl) {
  try {
    const host = new URL(String(pageUrl || '')).host;
    if (/sflix\.(bz|ch|vg)$/i.test(host)) return 'fmovie';
    if (/^sflix\.soap2day\.day$/i.test(host) || /sflixz\.day$/i.test(host)) return 'dooplay';
    if (/soap2day\.day$/i.test(host)) return 'psyplay';
  } catch (e) {
    // ignore
  }
  return '';
}

function seriesSlug(pageUrl) {
  try {
    const parts = new URL(String(pageUrl || '')).pathname.split('/').filter(Boolean);
    let slug = parts[parts.length - 1] || '';
    slug = slug.replace(/-s\d{1,2}e\d{1,3}(?:-.*)?$/i, '');
    slug = slug.replace(/-season-\d+-episode-\d+$/i, '');
    return slug;
  } catch (e) {
    return '';
  }
}

function episodeLabel(title, where) {
  const name = title || 'this title';
  if (!where || !where.episode) return name;
  return `${name} S${where.season || 1}E${where.episode}`;
}

function normTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function seasonEpisodeFromUrl(pageUrl) {
  const s = String(pageUrl || '');
  let season = null;
  let episode = null;
  const se = s.match(/season[-_](\d+)[-_]episode[-_](\d+)/i);
  const sxe = s.match(/[sS](\d{1,2})[eE](\d{1,3})/);
  const hash = s.match(/#ep-(\d+)/i);
  const q = s.match(/[?&]season=(\d+)/i);
  if (se) {
    season = parseInt(se[1], 10);
    episode = parseInt(se[2], 10);
  } else if (sxe) {
    season = parseInt(sxe[1], 10);
    episode = parseInt(sxe[2], 10);
  } else if (hash) {
    episode = parseInt(hash[1], 10);
  }
  if (season == null && q) season = parseInt(q[1], 10);
  return { season, episode };
}

function titleFromSlug(pageUrl) {
  try {
    const parts = new URL(String(pageUrl || '')).pathname.split('/').filter(Boolean);
    let slug = parts[parts.length - 1] || '';
    slug = slug.replace(/-season-\d+-episode-\d+$/i, '');
    slug = slug.replace(/-s\d{1,2}e\d{1,3}(?:-.*)?$/i, '');
    slug = slug.replace(/-(?:19|20)\d{2}$/i, '');
    return slug.replace(/-/g, ' ').trim();
  } catch (e) {
    return '';
  }
}

// Site adapter for the SFlix watch sites: soap2day.day / sflixz.day (DooPlay)
// and sflix.bz (the fmovie catalog; sflix.ch and sflix.vg land there too).
//
// This is a WordPress/DooPlay catalog, NOT the old PHP sflix.to clone:
//   series  https://sflix.soap2day.day/series/{slug}/
//   episode https://sflix.soap2day.day/episodes/{slug}-season-{season}-episode-{episode}/
//   movie   https://sflix.soap2day.day/{slug}/
//
// There are no SUB/DUB rows. Servers are ".player-tab-btn" buttons labelled
// Server 1..N, each carrying data-player-url to a third-party embed
// (vidapi / vidfast / embedmaster / multiembed / nontongo). Clicking the
// play poster (or a server tab) points #main-player at that URL.
//
// Existing Aniwave/Enma/FilmeHD profiles are untouched; this file is picked
// up automatically by sites/index.js.

module.exports = {
  id: 'sflix',
  name: 'SFlix',
  match: [/sflix\.soap2day\.day/i, /soap2day\.day/i, /\bsflixz\.day\b/i, /sflix\.(?:bz|ch|vg)\b/i],
  // Anything under 1080p is rejected. The queue then tries the other SFlix site.
  minHeight: 1080,
  mirrorUrls(pageUrl) {
    const family = sflixFamily(pageUrl);
    const origins = (SFLIX_FAMILIES[family] || []).slice();
    let path = '/';
    let current = '';
    try {
      const u = new URL(String(pageUrl || ''));
      path = `${u.pathname || '/'}${u.search || ''}${u.hash || ''}`;
      current = u.origin;
    } catch (e) {
      return [String(pageUrl || '')];
    }
    const out = [];
    const seen = new Set();
    const add = (origin) => {
      const abs = `${String(origin).replace(/\/$/, '')}${path}`;
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    };
    if (current) add(current);
    for (const origin of origins) add(origin);
    return out;
  },

  // Another SFlix catalog, found by title. Same-path mirrors are handled by
  // mirrorUrls; this is how soap2day and sflix.bz stand in for each other.
  async openAlternate(wc, pageUrl, onLog, triedHosts, hooks) {
    const here = sflixFamily(pageUrl) || sflixFamily(wc && wc.getURL && wc.getURL());
    const families = Object.keys(SFLIX_FAMILIES).filter((name) => name !== here);
    if (!families.length || !hooks || typeof hooks.load !== 'function') return null;
    let title = '';
    try {
      title = await wc.executeJavaScript(
        `(() => {
          const series = document.querySelector('a[href*="/series/"]');
          const h1 = document.querySelector('h1');
          const og = document.querySelector('meta[property="og:title"]');
          const raw = (
            (series && series.textContent) ||
            (h1 && h1.textContent) ||
            (og && og.getAttribute('content')) ||
            document.title ||
            ''
          );
          return raw
            .replace(/\\s+/g, ' ')
            .replace(/\\s*[-–|]\\s*Sflix.*$/i, '')
            .replace(/\\s*[-–:]\\s*Season\\s+\\d+.*$/i, '')
            .replace(/\\s+S\\d+E\\d+.*$/i, '')
            .trim();
        })()`,
        true
      );
    } catch (e) {
      title = '';
    }
    const episodePage = /s\d{1,2}e\d{1,3}|season[-_]\d+[-_]episode[-_]\d+/i.test(String(pageUrl || ''));
    const slugTitle = titleFromSlug(pageUrl);
    // Episode pages title the installment ("Cheryl's Old Flame"). The series
    // name is in the slug, and that is what the other sites can be searched for.
    title = (episodePage && slugTitle) || String(title || '').trim() || slugTitle;
    if (normTitle(title).length < 3) return null;
    const where = seasonEpisodeFromUrl(pageUrl);
    const wanted = episodeLabel(title, where);
    const load = async (target) => {
      await hooks.load(target);
      if (typeof hooks.cloudflare === 'function') return hooks.cloudflare(target);
      return true;
    };
    for (const family of families) {
      const origin = SFLIX_FAMILIES[family][0];
      let host = '';
      try {
        host = new URL(origin).host;
      } catch (e) {
        continue;
      }
      if (triedHosts && triedHosts.has(host)) continue;
      if (triedHosts) triedHosts.add(host);
      if (family === 'psyplay' && where.episode && seriesSlug(pageUrl)) {
        const direct = `${origin}/episode/${seriesSlug(pageUrl)}-season-${where.season || 1}-episode-${where.episode}/`;
        onLog(`No 1080p yet; opening ${wanted} on ${host}.`);
        return direct;
      }
      const search = `${origin}/?s=${encodeURIComponent(title)}`;
      onLog(`No 1080p yet; searching ${host} for ${wanted}.`);
      let cleared = false;
      try {
        cleared = await load(search);
      } catch (e) {
        onLog(`${host} search did not load.`);
        continue;
      }
      if (!cleared) continue;
      let hit = '';
      try {
        hit = await wc.executeJavaScript(
          `(() => {
            const want = ${JSON.stringify(normTitle(title))};
            const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
            let best = '';
            let bestScore = 0;
            document.querySelectorAll('a[href]').forEach((a) => {
              let u;
              try { u = new URL(a.href, location.href); } catch (e) { return; }
              if (u.host !== location.host) return;
              const path = u.pathname || '';
              if (/\\/(?:category|country|language|quality|years|wp-|search|home|top-imdb|genres?)(?:\\/|$)/i.test(path)) return;
              const segs = path.split('/').filter(Boolean);
              if (!segs.length) return;
              const text = norm(a.textContent);
              const slug = norm(segs[segs.length - 1].replace(/-(?:19|20)\\d{2}$/i, ''));
              let score = 0;
              if (text === want || slug === want) score = 100;
              else if (text.indexOf(want) === 0 || slug.indexOf(want) === 0) score = 80;
              else if (text.indexOf(want) !== -1 || slug.indexOf(want) !== -1) score = 60;
              else return;
              if (segs[0] === 'series' || segs[0] === 'episodes') score += 5;
              if (score > bestScore) { bestScore = score; best = u.href; }
            });
            return bestScore >= 60 ? best : '';
          })()`,
          true
        );
      } catch (e) {
        hit = '';
      }
      if (!hit) {
        onLog(`${host} has no page for "${title}".`);
        continue;
      }
      if (family === 'fmovie') {
        try {
          const u = new URL(hit);
          if (where.season) u.searchParams.set('season', String(where.season));
          if (where.episode) u.hash = `ep-${where.episode}`;
          return u.toString();
        } catch (e) {
          return hit;
        }
      }
      if (!where.episode) return hit;
      try {
        if (!(await load(hit))) continue;
      } catch (e) {
        continue;
      }
      const season = where.season || 1;
      const episode = where.episode;
      let epUrl = '';
      for (let i = 0; i < 6 && !epUrl; i++) {
        try {
          epUrl = await wc.executeJavaScript(
            `(() => {
              const want = ${JSON.stringify(String(season))};
              const ep = ${JSON.stringify(String(episode))};
              const pad = want.length < 2 ? ('0' + want) : want;
              const reSeason = new RegExp('season[-_]' + want + '[-_]episode[-_]' + ep + '(?:\\\\D|$)', 'i');
              const reSxe = new RegExp('[sS](?:' + want + '|' + pad + ')[eE]' + String(ep).padStart(2, '0') + '(?:\\\\D|$)');
              const reSxeShort = new RegExp('[sS](?:' + want + '|' + pad + ')[eE]' + ep + '(?:\\\\D|$)');
              const tab = document.querySelector('.season-tab-btn[data-season="' + want + '"]');
              if (tab && !/\\bactive\\b/.test(tab.className || '')) { try { tab.click(); } catch (e) {} }
              let found = '';
              document.querySelectorAll('a[href*="/episodes/"]').forEach((a) => {
                if (found) return;
                const h = a.href || '';
                if (reSeason.test(h) || reSxe.test(h) || reSxeShort.test(h)) found = h;
              });
              return found;
            })()`,
            true
          );
        } catch (e) {
          epUrl = '';
        }
        if (!epUrl) await delay(700);
      }
      if (epUrl) return epUrl;
      onLog(`${host} has "${title}" but not S${season}E${episode}.`);
    }
    return null;
  },

  dub: {
    // No audio-row toggles — empty so the scanner does not invent SUB/DUB.
    dubLabelText: [],
    subLabelText: [],
    knownSourceLabels: [
      'server 1',
      'server 2',
      'server 3',
      'server 4',
      'server 5',
      'server 6',
      'server 7',
      'server 8',
      'vidapi',
      'vidfast',
      'embedmaster',
      'multiembed',
      'nontongo',
      'filemoon',
      'streamtape',
      'doodstream'
    ],
    sourceSelector: '.player-tab-btn',
    sourceWaitMs: 14000,
    pageSettleMs: 3000,
    // embedmaster is blob/Turnstile offscreen; multiembed is Cloudflare (both
    // re-probed on Linux: their frame chains dead-end at challenges.cloudflare
    // .com). Windows skips vidfast (segments are not fetchable from Node) and
    // uses NontonGo progressive MP4 at 5-wide. Linux NontonGo/EmbedFlix never
    // requests /_stream (nested Cloudflare iframe), so skip it and capture
    // Vidfast. Each episode gets its own Chromium partition so five live
    // players can run without sharing tokens.
    //
    // vidapi is no longer skipped on Linux: it now serves playable HLS through
    // videm.xyz, and it is the only fallback for episodes Vidfast has no source
    // for (it 500s on those). It is deferred, not preferred, so Vidfast stays
    // the first choice and the working path is unchanged.
    maxSources: 5,
    skipEmbedHosts: [
      ...(process.platform === 'win32' ? [/vidapi\./i, /vidfast\./i] : [/nontongo/i]),
      /embedmaster\.|embdmstrplayer/i,
      /multiembed\.|streamingnow\.mov/i
    ],
    preferEmbedHosts: process.platform === 'win32' ? [/nontongo/i] : [],
    deferEmbedHosts: process.platform === 'win32' ? [] : [/vidapi\./i]
  },

  // NontonGo MP4 downloads like Windows: 5 files at once, prefetch the next
  // episode. Vidfast token-CDN capture is serialized in the queue so overlapping
  // live players cannot spend one-shot /s/ tokens.
  download: {
    concurrency: 5,
    prefetchDiscover: 1
  },

  urlTemplates: [
    'https://sflix.soap2day.day/series/{slug}/#ep-{episode}',
    'https://sflix.soap2day.day/episodes/{slug}-season-{season}-episode-{episode}/',
    'https://sflix.soap2day.day/episodes/{slug}-s{season2}e{episode2}/',
    'https://sflix.soap2day.day/{slug}/#ep-{episode}'
  ],

  // Never invent /episodes/{slug}-s01e02-{other-episode-title}/ URLs. Those
  // pages have no player. Bulk must use the real Watch hrefs from this scan.
  inventEpisodeUrls: false,
  playerUrlNeedsId,
  injectPlayerUrl,

  // A movie / one-off special lives at /{slug}/ or /movie/{id}/{slug}: one
  // player, no episode list. Series pages also sit at /{slug}/ on this theme,
  // so this only says "could be a single title" - bulk still scans for an
  // episode list first and consults this when the scan comes back empty.
  singleTitle(pageUrl) {
    let u;
    try {
      u = new URL(String(pageUrl || ''));
    } catch (e) {
      return false;
    }
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length) return false;
    if (/^movies?$/i.test(segs[0])) return true;
    if (segs.length !== 1) return false;
    // Catalog sections and the series/episode prefixes are never a title.
    return !/^(series|seriale|episodes|tv|genre|country|language|quality|home|top-imdb|years|release-year|search|page|watch|category)$/i.test(
      segs[0]
    );
  },

  // Keep a real /series/{slug}/ URL. Do not invent one from an episode slug:
  // Watch paths omit the random series suffix (…-8knav), and
  // /series/the-epic-tales-of-captain-underpants/ is the wrong page (Cloudflare).
  // detectEpisodes follows the on-page series breadcrumb instead.
  catalogUrl(pageUrl) {
    try {
      const u = new URL(String(pageUrl || ''));
      if (/\/series\//i.test(u.pathname) && !/\/series\/?$/i.test(u.pathname)) {
        return `${u.origin}${u.pathname.replace(/\/?$/, '/')}`;
      }
    } catch (e) {
      // ignore
    }
    return pageUrl;
  },

  // Collects the real Watch hrefs. SFlix uses two path shapes on the same site
  // (`season-1-episode-12` AND `s01e01-title-slug`). Season tabs are clicked
  // first; detectEpisodes retries while the list hydrates.
  episodeScan({ season } = {}) {
    const prefer = season != null && season !== '' && !isNaN(parseInt(season, 10))
      ? String(parseInt(season, 10))
      : '';
    return `(() => {
    const add = (set, v) => { const n = parseInt(v, 10); if (n > 0 && n < 100000) set.add(n); };
    const seasonOf = (v) => { const n = parseInt(v, 10); return n > 0 ? String(n) : ''; };
    const href = location.href || '';
    const fromSeasonPath = href.match(/season[-_](\\d+)/i);
    const fromSxe = href.match(/[sS](\\d{1,2})[eE]\\d{1,3}/);
    const activeTab = document.querySelector('.season-tab-btn.active, [data-season].active');
    // Never use the hero player poster season. On this show the poster stays
    // on Season 3 even while the Season 1 tab is selected, which made Season 1
    // batches scan (or skip) Season 3 instead.
    const want = ${JSON.stringify(prefer)} ||
      seasonOf(fromSeasonPath && fromSeasonPath[1]) ||
      seasonOf(fromSxe && fromSxe[1]) ||
      seasonOf(activeTab && activeTab.getAttribute('data-season')) ||
      '1';
    const tab = document.querySelector(
      '.season-tab-btn[data-season="' + want + '"], a.season-tab-btn[data-season="' + want + '"]'
    );
    if (tab && !/\\bactive\\b/.test(tab.className || '')) {
      try { tab.click(); } catch (e) {}
    } else if (!tab) {
      const reTab = new RegExp('^(season|sezonul)?\\\\s*' + want + '$', 'i');
      const nodes = document.querySelectorAll('.season-tab-btn, [data-season], .se-q, #seasons a, button');
      for (const el of nodes) {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!reTab.test(t)) continue;
        try { el.click(); } catch (e) {}
        break;
      }
    }
    const nums = new Set();
    const urls = {};
    const wantPad = want.length < 2 ? ('0' + want) : want;
    const reSeason = new RegExp('season[-_]' + want + '[-_]episode[-_](\\\\d+)', 'i');
    const reSxe = new RegExp('[sS](?:' + want + '|' + wantPad + ')[eE](\\\\d{1,3})');
    const consider = (h) => {
      if (!h || /\\/episodes\\/?$/i.test(h)) return;
      let abs = h;
      try { abs = new URL(h, location.href).href; } catch (e) {}
      const m = abs.match(reSeason) || abs.match(reSxe);
      if (!m) return;
      const ep = parseInt(m[1], 10);
      if (!ep) return;
      add(nums, ep);
      if (!urls[ep]) urls[ep] = abs;
    };
    document.querySelectorAll(
      'a[href*="/episodes/"], .episodios a, [class*="episodi"] a, #seasons a, .se-c a, [data-link*="/episodes/"]'
    ).forEach((a) => {
      consider(a.href || a.getAttribute('href') || a.getAttribute('data-link') || '');
    });
    const html = (document.documentElement && document.documentElement.innerHTML) || '';
    const hrefRe = /(?:https?:\\/\\/[^"'\\s]+)?\\/episodes\\/[^"'\\s<>]+/gi;
    let hm;
    while ((hm = hrefRe.exec(html))) consider(hm[0]);
    document.querySelectorAll('[data-episode], [data-nume]').forEach((el) => {
      const s = seasonOf(el.getAttribute('data-season'));
      if (s && s !== want) return;
      const ep = parseInt(el.getAttribute('data-episode') || el.getAttribute('data-nume'), 10);
      if (!ep) return;
      const a = el.closest('a') || el.querySelector('a');
      const h = (a && (a.href || a.getAttribute('href'))) || '';
      add(nums, ep);
      if (h) consider(h);
    });
    if (!nums.size || document.querySelector('#episodes a[data-episode_id]')) {
      const wantN = String(parseInt(want, 10));
      const view = document.querySelector('.season-view');
      const shown = view && (view.textContent || '').match(/(\\d+)/);
      const shownN = shown ? String(parseInt(shown[1], 10)) : '';
      const seasonLink = document.querySelector(
        '#seasons .dropdown-menu a[data-tab="season' + wantN + '"]'
      );
      if (shownN && shownN !== wantN && seasonLink) {
        try { seasonLink.click(); } catch (e) {}
      } else if (!shownN || shownN === wantN) {
        document.querySelectorAll('#episodes a[data-episode_id]').forEach((a) => {
          const ep = parseInt(a.getAttribute('data-episode_id'), 10);
          if (!ep) return;
          add(nums, ep);
          if (!urls[ep]) {
            const u = new URL(location.href);
            u.searchParams.set('season', wantN);
            u.hash = 'ep-' + ep;
            urls[ep] = u.toString();
          }
        });
      }
    }
    // Do not add the current Watch URL until the series list is empty. A single
    // s01e01 match used to set aired=1 and stop bulk after episode 1.
    const currentOnly = !nums.size;
    if (currentOnly) {
      const curSxe = href.match(/[sS](\\d{1,2})[eE](\\d{1,3})/);
      const curSe = href.match(/season[-_](\\d+)[-_]episode[-_](\\d+)/i);
      if (curSxe && seasonOf(curSxe[1]) === want) {
        add(nums, curSxe[2]);
        urls[parseInt(curSxe[2], 10)] = href;
      } else if (curSe && seasonOf(curSe[1]) === want) {
        add(nums, curSe[2]);
        urls[parseInt(curSe[2], 10)] = href;
      }
    }
    let catalog = '';
    if (/\\/series\\/[^/]+/i.test(href) && !/\\/series\\/?$/i.test(href)) {
      catalog = href;
    } else {
      const canon = document.querySelector('link[rel="canonical"], meta[property="og:url"]');
      const extra = canon && (canon.href || canon.getAttribute('href') || canon.getAttribute('content'));
      const seriesLinks = document.querySelectorAll(
        'a[href*="/series/"], .breadcrumb a, #single .data a, h1 a, .sbox a, .poster a, .film-poster a'
      );
      const candidates = extra ? [extra] : [];
      seriesLinks.forEach((a) => candidates.push(a.href || a.getAttribute('href') || ''));
      for (const h of candidates) {
        if (!/\\/series\\/[^/?#]+/i.test(h) || /\\/series\\/?(?:[?#]|$)/i.test(h)) continue;
        try { catalog = new URL(h, location.href).href; } catch (e) { catalog = h; }
        break;
      }
    }
    const list = Array.from(nums).sort((a, b) => a - b);
    return {
      list,
      max: list.length ? list[list.length - 1] : 0,
      aired: list.length > 1 ? list.length : 0,
      total: list.length > 1 ? list.length : 0,
      urls,
      season: parseInt(want, 10),
      catalog,
      currentOnly
    };
  })()`;
  },

  async beforeResolve(wc, { onLog }) {
    const prepared = await wc
      .executeJavaScript(
        `(() => {
          if (document.querySelector('.player-tab-btn[data-player-url]')) {
            return { kind: 'dooplay', n: document.querySelectorAll('.player-tab-btn').length };
          }
          const page = new URL(location.href);
          const season = page.searchParams.get('season') || '1';
          const epMatch = (page.hash || '').match(/ep-(\\d+)/i);
          const episode = (epMatch && epMatch[1]) || '1';
          const bar = document.getElementById('wvd-sflix-servers') || document.createElement('div');
          bar.id = 'wvd-sflix-servers';
          bar.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483646;display:flex;gap:6px;';
          bar.textContent = '';
          const add = (label, url) => {
            if (!url) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'player-tab-btn';
            btn.textContent = label;
            btn.setAttribute('data-player-url', url);
            bar.appendChild(btn);
          };
          const frames = Array.from(document.querySelectorAll('#content-embed iframe, #player2 iframe'));
          if (frames.length) {
            const urls = [];
            frames.forEach((frame) => {
              const url = frame.getAttribute('data-src') || frame.getAttribute('src') || '';
              if (!/^https?:/i.test(url)) return;
              if (/nontongo|embedmaster|embdmstrplayer|multiembed|streamingnow\\.mov/i.test(url)) return;
              urls.push(url);
            });
            urls.sort((a, b) => {
              const rank = (u) => /moviesapi\\.|peachify\\.|111movies\\.|vixsrc\\./i.test(u) ? 0 : 1;
              return rank(a) - rank(b);
            });
            urls.forEach((url, idx) => add('Server ' + (idx + 1), url));
          }
          if (!bar.childElementCount && window.Episodes && Episodes.tvplayer && Episodes.post_id) {
            const hosts = Array.from(document.querySelectorAll('[data-load-embed-host]'))
              .map((el) => el.getAttribute('data-load-embed-host'))
              .filter(Boolean);
            const list = hosts.length ? hosts : ['embedru', 'vidsrc'];
            list.forEach((host, idx) => {
              add(
                'Server ' + (idx + 1),
                String(Episodes.tvplayer) + Episodes.post_id + '&s=' + season + '&e=' + episode + '&sv=' + host + '&tv=true'
              );
            });
          } else if (!bar.childElementCount && window.Servers) {
            let n = 0;
            Object.keys(Servers).forEach((key) => {
              const url = Servers[key];
              if (typeof url !== 'string' || !/^https?:/i.test(url)) return;
              if (/tmdb\\.org|wp-content|wp-includes|youtube/i.test(url)) return;
              if (!/embed|player|vid|movie\\.php/i.test(url + key)) return;
              n += 1;
              add('Server ' + n, url);
            });
          }
          if (bar.childElementCount) document.documentElement.appendChild(bar);
          return { kind: 'fmovie', n: bar.childElementCount };
        })()`,
        true
      )
      .catch(() => null);
    if (prepared && prepared.kind === 'fmovie' && prepared.n) {
      onLog(`SFlix: ${prepared.n} server(s) on this site.`);
    }

    const info = await wc
      .executeJavaScript(
        `(() => {
          const poster = document.querySelector('#player-poster, .player-poster');
          const tabs = Array.from(document.querySelectorAll('.player-tab-btn'));
          const iframe = document.querySelector('#main-player, .player-frame__iframe, iframe');
          const src = (iframe && (iframe.src || iframe.getAttribute('src'))) || '';
          const firstUrl = (tabs[0] && tabs[0].getAttribute('data-player-url')) ||
            (poster && poster.getAttribute('data-player-url')) || '';
          if (poster) {
            try { poster.click(); } catch (e) {}
          }
          if (iframe && firstUrl && (!src || src.indexOf(location.hostname) !== -1)) {
            iframe.src = firstUrl;
          }
          return {
            servers: tabs.length,
            poster: !!poster,
            embed: firstUrl
          };
        })()`,
        true
      )
      .catch(() => null);

    if (info && info.servers) {
      onLog(
        `SFlix: ${info.servers} server tab(s)` +
          (info.embed ? `; primed player ${info.embed}` : '') +
          '.'
      );
      await delay(800);
    } else {
      onLog('SFlix: no server tabs yet; scanner will retry.');
    }

    let mediaId = '';
    try {
      mediaId = (await wc.executeJavaScript(FIND_MEDIA_ID, true)) || '';
    } catch (e) {
      mediaId = '';
    }
    if (!mediaId) {
      await delay(1200);
      try {
        mediaId = (await wc.executeJavaScript(FIND_MEDIA_ID, true)) || '';
      } catch (e) {
        mediaId = '';
      }
    }
    const seriesKey = seriesKeyFromUrl(wc.getURL());
    if (!mediaId && seriesKey && seriesMediaIds.has(seriesKey)) {
      mediaId = seriesMediaIds.get(seriesKey);
      onLog(`SFlix: reusing media id ${mediaId} remembered for this series.`);
    }
    let idFromTitleLookup = false;
    if (!mediaId) {
      try {
        const title = await wc.executeJavaScript(
          `(() => {
            const h1 = (document.querySelector('h1') && document.querySelector('h1').textContent) || '';
            const og = document.querySelector('meta[property="og:title"]');
            const t = (h1 || (og && og.getAttribute('content')) || document.title || '').replace(/\\s+/g, ' ').trim();
            return t.replace(/\\s*[-–|]\\s*Sflix.*$/i, '').replace(/\\s*[-–:]\\s*Season\\s+\\d+.*$/i, '').trim();
          })()`,
          true
        );
        // A half-loaded page can report a garbage title ("404"); a lookup from
        // that returns a wrong id and poisons both caches for this series.
        const usable =
          title && title.length >= 3 && /[a-z]/i.test(title) && !/^(404|not found|error|page not)/i.test(title.trim());
        if (usable) {
          mediaId = await lookupImdbFromTitle(title);
          if (mediaId) {
            onLog(`SFlix: looked up IMDB ${mediaId} for "${title}".`);
            idFromTitleLookup = true;
          }
        }
      } catch (e) {
        mediaId = '';
      }
    }
    rememberMediaId(seriesKey, mediaId);
    const preferred = preferredMediaId(seriesKey, mediaId);
    if (preferred !== mediaId) {
      onLog(`SFlix: preferring media id ${preferred} over ${mediaId} for this series.`);
      mediaId = preferred;
    }
    // Share ids that came from real player markup (never title-lookup ids) so
    // the cross-site walker's id-keyed adapters (Vidsrc primary, NontonGo)
    // can target this episode after this window has navigated away.
    if (mediaId && !idFromTitleLookup) sharedRememberMediaId(seriesKey, mediaId);

    if (mediaId) {
      try {
        wc._wvdMediaId = mediaId;
      } catch (e) {
        // ignore
      }
      const patched = await wc
        .executeJavaScript(
          `(() => {
            const id = ${JSON.stringify(mediaId)};
            const needsId = (url) => {
              try {
                if (/[?&](?:id|imdb|video_id)=(?:&|$)/i.test(url)) return true;
                const p = new URL(url, location.href).pathname.replace(/\\/+/g, '/').replace(/\\/$/, '');
                const parts = p.split('/').filter(Boolean);
                const kind = parts[0] === 'embed' ? parts[1] : parts[0];
                const rest = parts[0] === 'embed' ? parts.slice(2) : parts.slice(1);
                if (kind !== 'tv' && kind !== 'movie') return false;
                if (rest.some((seg) => /^\\d+-\\d+-\\d+$/.test(seg))) return false;
                if (rest.length < 3) return true;
                const cur = rest[0] || '';
                if (!cur || cur === 'tt') return true;
                return /^\\d{1,3}$/.test(cur) && !/^tt/i.test(cur);
              } catch (e) {
                return false;
              }
            };
            const fix = (url) => {
              if (!url || !id) return url;
              if (!needsId(url)) return url;
              try {
                const u = new URL(url, location.href);
                let path = u.pathname.replace(/\\/+/g, '/');
                path = path.replace(/\\/(tv|movie)\\/(?:tt\\d+\\/)?/i, '/$1/' + id + '/');
                const segs = path.split('/').filter(Boolean);
                const embed = segs[0] === 'embed';
                const kindAt = embed ? 1 : 0;
                const kind = segs[kindAt];
                if (kind === 'tv' || kind === 'movie') {
                  const rest = segs.slice(kindAt + 1);
                  if (rest.length === 2 && /^\\d{1,3}$/.test(rest[0])) {
                    path = (embed ? '/embed' : '') + '/' + kind + '/' + id + '/' + rest[0] + '/' + rest[1];
                  }
                }
                u.pathname = path;
                if (u.searchParams.has('id') && !u.searchParams.get('id')) u.searchParams.set('id', id);
                if (u.searchParams.has('imdb') && !/^tt\\d+/i.test(u.searchParams.get('imdb') || '')) {
                  u.searchParams.set('imdb', id);
                }
                if (u.searchParams.has('video_id') && !u.searchParams.get('video_id')) {
                  u.searchParams.set('video_id', id.replace(/^tt/i, ''));
                }
                return u.toString();
              } catch (e) {
                return url;
              }
            };
            const out = [];
            document.querySelectorAll('.player-tab-btn, #player-poster, .player-poster, [data-player-url]').forEach((el) => {
              const u = el.getAttribute('data-player-url') || '';
              if (!u) return;
              const n = fix(u);
              if (n !== u) el.setAttribute('data-player-url', n);
              out.push(el.getAttribute('data-player-url') || n);
            });
            return out;
          })()`,
          true
        )
        .catch(() => []);
      const sample = (patched && patched.find((u) => /vidfast|vidapi|nontongo|multiembed/i.test(u))) || '';
      onLog(`SFlix: filled player media id ${mediaId}` + (sample ? `; e.g. ${sample}` : '.'));
    } else if (info && playerUrlNeedsId(info.embed)) {
      onLog('SFlix: player URLs have no IMDB/TMDB id; embeds will 404 until the page provides one.');
    }
  }
};
