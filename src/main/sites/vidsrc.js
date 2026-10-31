'use strict';

// Vidsrc family — embed player, NO catalog search page.
//
// The page takes an id instead of a slug:
//   tv     /embed/tv/{tmdb}-{season}-{episode}     (e.g. /embed/tv/1739-1-5)
//   tv     /embed/imdb/{imdb}-{season}-{episode}   (e.g. /embed/imdb/tt0285351-1-5)
//   movie  /embed/movie/{tmdb}
//   movie  /embed/imdb/{imdb}
// The player page is plain HTML + JS (verified 2026: no Cloudflare on either
// host), and the stream arrives in the page's own webContents, where the
// sniffer already captures it — the same path that handles vidfast/videm/
// vidlove. So no server tabs, no DUB/SUB toggles: dubselect's page-stream
// fallback does the job.
//
// Verified live (curl):
//   https://vidsrc.sh/embed/tv/1739-1-5        -> 200 player page
//   https://vidsrc.sh/embed/movie/550          -> 200 player page
//   https://vidsrcme.ru/embed/tv/1739-1-5      -> 200 player page
//   https://vidsrcme.ru/embed/imdb/tt0285351-1-5 -> 200 player page
//   vidsrc.xyz/.top/.la/.pw/.fun, vidsrcme.pro/.co -> dead
//
// findTitle() gets { title, season, episode } from bulk.js. The ids it needs
// are not in that ref — they are in the page we are already sitting on (SFlix
// and the 123movies catalogs all carry TMDB/IMDB ids in their markup), so we
// read them out of the live DOM first. If the current page has no ids there
// is nothing we can do without a search engine, and this site has none —
// return null and let the walker continue.
//
// fallbackRank 0: PRIMARY source. The cross-site walker in bulk.js reaches
// this FIRST. It is CF-free and id-keyed, so it is the shortest path to 1080p
// with no Cloudflare checkbox. It is a runtime relay: the /embed/ page fetches
// a short-lived gate token and points a nested iframe at a rotating player
// host (new.vidsrcme.ru, cloudorchestranova.com, ...). The stream lands in
// that nested iframe's webContents, which the sniffer folds into the
// discovery window — the same path as vidfast/videm. FMovies is the rank-1
// fallback (the known 1080p catalog that carries the one CF checkbox).

const { lookupMediaId, idFromPlayerUrl } = require('./findtitle');
const vidsrcDl = require('./vidsrc_dl');

const HOSTS = ['https://vidsrc.sh', 'https://vidsrcme.ru'];

function mirrorUrls(pageUrl) {
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
    if (!origin) return;
    const abs = `${origin.replace(/\/$/, '')}${path}`;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  if (current) add(current);
  for (const origin of HOSTS) add(origin);
  return out;
}

// TMDB/IMDB ids from the page currently loaded in the discovery window.
async function idsFromPage(hooks, onLog) {
  if (!hooks || !hooks.wc || typeof hooks.wc.executeJavaScript !== 'function') {
    return { tmdb: '', imdb: '' };
  }
  try {
    const r = await hooks.wc.executeJavaScript(
      `(() => {
        const html = ((document.documentElement && document.documentElement.innerHTML) || '').slice(0, 800000);
        const tmdb =
          html.match(/themoviedb\\.org\\/(?:tv|movie)\\/(\\d{4,8})/) ||
          html.match(/\\/(?:tv|movie)\\/(\\d{4,8})\\/\\d+\\//) ||
          html.match(/\\/embed\\/(?:tv|movie)\\/(\\d{4,8})/) ||
          html.match(/[?&]tmdb[=_-](\\d{4,8})/i);
        const imdb =
          (html.match(/\\btt\\d{6,}\\b/g) || [])[0] ||
          (html.match(/[?&]imdb[=_-](tt\\d{6,})/i) || [])[1];
        return { tmdb: tmdb ? tmdb[1] : '', imdb: imdb || '' };
      })()`,
      4000
    );
    if (r && (r.tmdb || r.imdb)) {
      onLog(`Vidsrc: using id from this page (tmdb=${r.tmdb || 'n/a'}, imdb=${r.imdb || 'n/a'}).`);
    } else {
      onLog('Vidsrc: no TMDB/IMDB id on the current page; cannot target this embed.');
    }
    return r || { tmdb: '', imdb: '' };
  } catch (e) {
    return { tmdb: '', imdb: '' };
  }
}

// Classify the audio of a Vidsrc file from its release name.
//   'dub'     - an English-dubbed copy ("... English ...", "HULU", "DUB", "Multi")
//   'sub'     - a non-English-audio copy ("CR" = Chinese release, "JP", "RAW", ...)
//   'multi'   - both kinds of markers (multi-audio file)
//   'unknown' - no marker (or no name): don't guess.
const DUB_MARKERS = /\b(english|eng|dub|multi|hulu|crunchyroll|netflix|hidive)\b/i;
const SUB_MARKERS = /\b(cr|jp|japanese|jap|chinese|korean|raw|original)\b/i;
function classifyAudio(fileName) {
  const n = String(fileName || '');
  if (!n) return 'unknown';
  const dub = DUB_MARKERS.test(n);
  const sub = SUB_MARKERS.test(n);
  if (dub && sub) return 'multi';
  if (dub) return 'dub';
  if (sub) return 'sub';
  return 'unknown';
}

module.exports = {
  id: 'vidsrc',
  name: 'Vidsrc',
  match: [/vidsrc\./i, /vidsrcme\.ru/i],
  // Anything under 1080p is rejected, same as the rest of the pool.
  minHeight: 1080,
  fallbackRank: 0,
  mirrorUrls,
  dub: {
    // Relay page + nested player iframe. Give the relay enough time to fetch
    // its gate token, point the nested iframe, and let that iframe's hls.js
    // start before dubselect moves on. A bit more generous than a single
    // in-page player because there is an extra hop (relay -> rotating host).
    sourceWaitMs: 18000
  },
  // Vidsrc's data API is IP-rate-limited and 429s bursts. The default pool of
  // 5-wide (concurrency 5 + prefetch 1) resolves a whole season's worth at
  // once and gets the whole batch 403/429'd. Serialize Vidsrc so only ONE
  // episode resolves at a time; the others wait their turn instead of storming
  // the API. (Other CF-free sites keep the global concurrency.)
  download: {
    concurrency: 1,
    prefetchDiscover: 0
  },
  urlTemplates: [
    'https://vidsrc.sh/embed/tv/{id}-{season}-{episode}',
    'https://vidsrc.sh/embed/movie/{id}',
    'https://vidsrc.sh/embed/imdb/{imdb}-{season}-{episode}'
  ],

  async findTitle(ref, hooks, onLog = () => {}) {
    // Season 0 is TMDB's "Specials" - a real season, not "no season".
    const season = ref && ref.season != null && ref.season !== '' ? String(ref.season) : '';
    const episode = ref && ref.episode ? String(ref.episode) : '';
    let ids = await idsFromPage(hooks, onLog);
    // The window has usually navigated off the source page by now, so its DOM
    // carries no id. The id-keyed page we started from (SFlix server tabs) may
    // have remembered one — that is the same episode, so it is safe to reuse.
    if (!ids.tmdb && !ids.imdb) {
      ids = lookupMediaId(ref && ref.title);
      if (ids.tmdb || ids.imdb) {
        onLog(
          `Vidsrc: using id remembered for "${ref.title}" ` +
            `(tmdb=${ids.tmdb || 'n/a'}, imdb=${ids.imdb || 'n/a'}).`
        );
      }
    }
    const { tmdb, imdb } = ids;
    let path = '';
    if (season !== '' && episode) {
      if (tmdb) path = `/embed/tv/${tmdb}-${season}-${episode}`;
      else if (imdb) path = `/embed/imdb/${imdb}-${season}-${episode}`;
    } else if (tmdb) {
      path = `/embed/movie/${tmdb}`;
    } else if (imdb) {
      path = `/embed/imdb/${imdb}`;
    }
    if (!path) return null;
    const url = `${HOSTS[0]}${path}`;
    onLog(`Vidsrc: trying ${url}`);
    return url;
  },

  // Vidsrc serves ONE fixed file per episode - the audio language is baked
  // into that file and the site offers NO dub/sub toggle (verified: the player
  // JS has no dub logic and the API returns a single file_name + CDN mirrors).
  // The data API does expose the release name, so we can detect what we are
  // about to download and say so when it contradicts the user's choice
  // (e.g. "CR WEB-DL" = Chinese release / Japanese audio while the user asked
  // for DUB - the English dub simply is not on Vidsrc for that show).
  classifyAudio,

  // Headless PRIMARY resolver. Given a series + season/episode (and a title the
  // id can be recovered from), it finds a verified >=1080p Vidsrc stream and
  // returns a detection the app's existing ffmpeg downloader can pull directly
  // (token baked into the URL; Vidsrc hosts are not in the token-CDN / player-
  // bound lists, so it is not misrouted to the browser). No Chromium, no CDP,
  // no Cloudflare checkbox. Returns null (not an error) when it cannot resolve
  // so the caller can fall back to the browser path.
  async directResolve(ref = {}, opts = {}) {
    const onLog = opts.onLog || (() => {});
    const season = ref.season != null && ref.season !== '' ? String(ref.season) : '';
    const episode = ref.episode ? String(ref.episode) : '';
    let tmdb = ref.tmdb || '';
    let imdb = ref.imdb || '';
    if ((!tmdb && !imdb) && ref.title) {
      const ids = lookupMediaId(ref.title) || {};
      tmdb = ids.tmdb || '';
      imdb = ids.imdb || '';
    }
    if (!tmdb && !imdb) {
      for (const u of [ref.url, ref.baseUrl]) {
        if (!u) continue;
        const ids = idFromPlayerUrl(u) || {};
        if (ids.tmdb && !tmdb) tmdb = ids.tmdb;
        if (ids.imdb && !imdb) imdb = ids.imdb;
        if (tmdb || imdb) break;
      }
    }
    if (!tmdb && !imdb) {
      onLog('Vidsrc (headless): no TMDB/IMDB id available; falling back to browser path.');
      return null;
    }
    const isMovie = season === '' && !episode;
    const dlRef = {
      type: isMovie ? 'movie' : 'tv',
      tmdb: tmdb || undefined,
      imdb: imdb || undefined,
      season: season !== '' ? season : undefined,
      episode: episode || undefined,
      title: ref.title || ''
    };
    onLog(
      `Vidsrc (headless): resolving ${ref.title || tmdb || imdb} ` +
        `${isMovie ? '(movie)' : `S${season}E${episode}`} via direct API…`
    );
    // Anime: accept the source's own resolution (often 720p) instead of 1080p.
    const minH = ref.anime ? 0 : 1080;
    const best = await vidsrcDl.pick1080(dlRef, onLog, minH);
    if (!best) {
      // No copy at/above the floor on any Vidsrc source. Return a distinct
      // status so the queue can log clearly and cap retries.
      onLog(`Vidsrc (headless): no ${minH ? minH + 'p' : 'usable'} stream on any source for ${ref.title || dlRef.tmdb || dlRef.imdb}.`);
      return { status: 'no_quality' };
    }
    onLog(`Vidsrc (headless): locked ${best.realWidth}x${best.realHeight} from ${best.host}.`);
    // Audio honesty: Vidsrc has no dub/sub selection, so the user's mode
    // choice (dub/sub dropdown) cannot be enforced here - but we CAN see which
    // audio the file carries and must not stay silent about a mismatch
    // ("Smoking Behind the Supermarket" = "CR WEB-DL" = Japanese audio while
    // the user asked for DUB: the English dub is simply not on Vidsrc).
    const mode = ref.mode === 'sub' ? 'sub' : 'dub';
    const fileName = (best.meta && best.meta.fileName) || '';
    if (fileName) onLog(`Vidsrc file: ${fileName}`);
    const audio = classifyAudio(fileName);
    if (mode === 'dub' && audio === 'sub') {
      onLog(
        `⚠ AUDIO: you chose DUB, but Vidsrc's only file for this episode is ` +
          `"${fileName}" (non-English audio). Vidsrc has no dub/sub toggle and ` +
          `no English-dub copy of this episode - an English dub (if it exists) ` +
          `is not on Vidsrc for this show. Downloading this copy.`
      );
    } else if (mode === 'sub' && audio === 'dub') {
      onLog(
        `Note: you chose SUB, but Vidsrc's file is an English-dubbed copy ` +
          `("${fileName}").`
      );
    }
    return {
      status: 'resolved',
      detection: {
        url: best.url,
        type: 'hls',
        headers: { 'User-Agent': vidsrcDl.UA },
        embedUrl: best.url,
        // Vidsrc CDNs reject requests that carry Electron session cookies or
        // extra Referer/Origin headers (HTTP 403). The headless path (vidsrc_dl.js)
        // uses plain https.get() with only User-Agent and works reliably. Flag the
        // downloader to do the same: no session cookies, no Referer, no Origin.
        plainHttp: true
      }
    };
  }
};
