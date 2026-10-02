'use strict';

// NontonGo (sv2.nontongo.day / .stream) — server-rendered episode pages plus a
// plain-JS player that pulls HLS/MP4 straight from its workers.dev CDN.
// No Cloudflare on the pages themselves (verified 2026: episode page 200,
// player page loads hls.js and requests the CDN). The CDN edge 502'd at
// verification time, which is a transient upstream failure, not a block.
//
// The app already speaks NontonGo: the sniffer ranks its token MP4 (/_stream)
// above HLS (sniffer.js), dubselect has clickNontonGoPlay + the "Waiting on
// the NontonGo player for a progressive MP4" branch, and sflix.js prefers
// NontonGo on Windows for exactly this quality. This adapter only adds the
// cross-site entry point: a player URL built from the TMDB id of the page we
// are sitting on, so the 1080p walker can reach NontonGo without a search
// page.
//
// Verified live:
//   https://sv2.nontongo.day/soap/tv/tt0285351/1/5        -> 200 episode page
//   https://sv2.nontongo.day/01russia/multisourcesoap.php?id=1739&season=1&episode=5&type=tv
//                                                          -> 200 player page
//   (both ids work: IMDB on /soap/tv/..., TMDB on multisourcesoap.php)
//   sv2.nontongo.stream 301 -> sv2.nontongo.day
//
// fallbackRank 2: after Vidsrc (0, the CF-free primary) and FMovies (1, the
// known 1080p catalog behind the CF checkbox). Before Flixtor/SolarMovie,
// which are Cloudflare 403s / dead TLDs right now.

const { lookupMediaId } = require('./findtitle');

const HOSTS = ['https://sv2.nontongo.day', 'https://sv2.nontongo.stream'];

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
          html.match(/[?&]tmdb[=_-](\\d{4,8})/i) ||
          html.match(/[?&]id=(\\d{4,8})/);
        const imdb =
          (html.match(/\\btt\\d{6,}\\b/g) || [])[0] ||
          (html.match(/[?&]imdb[=_-](tt\\d{6,})/i) || [])[1];
        return { tmdb: tmdb ? tmdb[1] : '', imdb: imdb || '' };
      })()`,
      4000
    );
    if (r && (r.tmdb || r.imdb)) {
      onLog(`NontonGo: using id from this page (tmdb=${r.tmdb || 'n/a'}, imdb=${r.imdb || 'n/a'}).`);
    } else {
      onLog('NontonGo: no TMDB/IMDB id on the current page; cannot target this player.');
    }
    return r || { tmdb: '', imdb: '' };
  } catch (e) {
    return { tmdb: '', imdb: '' };
  }
}

module.exports = {
  id: 'nontongo',
  name: 'NontonGo',
  match: [/nontongo\./i],
  minHeight: 1080,
  fallbackRank: 2,
  mirrorUrls,
  dub: {
    // The player starts hls.js on its own; give it a long window. dubselect's
    // NontonGo branches (clickNontonGoPlay, /_stream wait) take over from here.
    sourceWaitMs: 30000
  },
  urlTemplates: [
    'https://sv2.nontongo.day/01russia/multisourcesoap.php?id={id}&season={season}&episode={episode}&type=tv',
    'https://sv2.nontongo.day/01russia/multisourcesoap.php?id={id}&type=movie',
    'https://sv2.nontongo.day/soap/tv/{imdb}/{season}/{episode}'
  ],

  async findTitle(ref, hooks, onLog = () => {}) {
    const season = ref && ref.season ? String(ref.season) : '';
    const episode = ref && ref.episode ? String(ref.episode) : '';
    let ids = await idsFromPage(hooks, onLog);
    if (!ids.tmdb && !ids.imdb) {
      ids = lookupMediaId(ref && ref.title);
      if (ids.tmdb || ids.imdb) {
        onLog(
          `NontonGo: using id remembered for "${ref.title}" ` +
            `(tmdb=${ids.tmdb || 'n/a'}, imdb=${ids.imdb || 'n/a'}).`
        );
      }
    }
    const { tmdb, imdb } = ids;
    let url = '';
    if (season && episode) {
      if (tmdb) {
        url = `${HOSTS[0]}/01russia/multisourcesoap.php?id=${tmdb}&season=${season}&episode=${episode}&type=tv`;
      } else if (imdb) {
        url = `${HOSTS[0]}/soap/tv/${imdb}/${season}/${episode}`;
      }
    } else if (tmdb) {
      url = `${HOSTS[0]}/01russia/multisourcesoap.php?id=${tmdb}&type=movie`;
    }
    if (!url) return null;
    onLog(`NontonGo: trying ${url}`);
    return url;
  }
};
