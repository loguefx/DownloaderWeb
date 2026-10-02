'use strict';

// Shared helpers for cross-site 1080p discovery.
//
// When the site the user started from has no 1080p copy of an episode, bulk.js
// walks the site registry and asks every other profile that implements
// findTitle() for a page that plays the same S#E#. This file holds the generic
// "search page -> show link -> episode link" pipeline so each site adapter only
// declares its search URL and episode-link shape.
//
// Contract:
//   findTitle({ title, season, episode }, hooks, onLog) -> url | null
//   hooks.load(url)      loads the URL in the shared discovery window
//   hooks.cloudflare(url) passes the Cloudflare challenge if one is present
//   onLog(msg)           progress line for the episode log
//
// The pipeline is deliberately tolerant: search engines, slugs and episode
// markup all drift, so every step scores candidates instead of requiring an
// exact structure, and a site that cannot be read is skipped (null) rather
// than failing the whole run.

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function normTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanShowTitle(raw, originalUrl) {
  let t = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  // Site chrome and episode markers that search pages love to append.
  t = t.replace(/\s*[-–|]\s*(sflix|flixtor|vumoo|upcloud|9anime|akwatch|superfly|desistream)\b.*$/i, '');
  t = t.replace(/\s*[-–|:]\s*season\s+\d+.*$/i, '');
  t = t.replace(/\s*S\d{1,2}E\d{1,3}.*$/i, '');
  t = t.replace(/\s*[-–|]\s*(19|20)\d{2}\s*$/, '');
  return t;
}

// Extract { title, season, episode } from any source page URL. Mirrors the
// per-site helpers (sflix.titleFromSlug etc.) but is deliberately loose: the
// value only has to be good enough to type into another site's search box.
function episodeRefFromUrl(pageUrl) {
  const out = { title: '', season: null, episode: null };
  let s = '';
  try {
    s = String(pageUrl || '');
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    let slug = parts[parts.length - 1] || '';
    slug = decodeURIComponent(slug)
      .replace(/-season-\d+-episode-\d+.*$/i, '')
      .replace(/-s\d{1,2}e\d{1,3}(?:-.*)?$/i, '')
      .replace(/\.html?$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    out.title = slug;
  } catch (e) {
    out.title = '';
  }
  const se = s.match(/season[-_](\d+)[-_]episode[-_](\d+)/i);
  const sxe = s.match(/[sS](\d{1,2})[eE](\d{1,3})/);
  if (se) {
    out.season = parseInt(se[1], 10);
    out.episode = parseInt(se[2], 10);
  } else if (sxe) {
    out.season = parseInt(sxe[1], 10);
    out.episode = parseInt(sxe[2], 10);
  }
  return out;
}

// Scores every on-page link against the wanted show title. Returns the best
// show page and, if the search page already lists the episode, its direct URL.
function pickShowLink(title, { season = null, episode = null } = {}) {
  const want = normTitle(title);
  const wantS = String(season || '');
  const wantEp = String(episode || '');
  return `(() => {
    const want = ${JSON.stringify(want)};
    const wantS = ${JSON.stringify(wantS)};
    const wantEp = ${JSON.stringify(wantEp)};
    const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    let best = '';
    let bestScore = 0;
    let bestEp = '';
    let bestEpScore = 0;
    document.querySelectorAll('a[href]').forEach((a) => {
      let u;
      try { u = new URL(a.href, location.href); } catch (e) { return; }
      if (u.host !== location.host) return;
      const path = u.pathname || '';
      if (/\\/(?:category|categories|country|language|quality|years?|genres?|top|trending|popular|latest|new|home|search|page|wp-|genre|tags?)(?:\\/|$)/i.test(path)) return;
      const segs = path.split('/').filter(Boolean);
      if (!segs.length) return;
      const text = norm(a.textContent);
      const slug = norm(segs[segs.length - 1].replace(/\\.(?:html?|php)$/i, ''));
      let score = 0;
      if (text === want || slug === want) score = 100;
      else if (text.indexOf(want) === 0 || slug.indexOf(want) === 0) score = 80;
      else if (want.length >= 4 && (text.indexOf(want) !== -1 || slug.indexOf(want) !== -1)) score = 60;
      else return;
      const seMatch = path.match(/season[-_](\\d+)[-_]episode[-_](\\d+)/i) || path.match(/[sS](\\d{1,2})[eE](\\d{1,3})/) || path.match(/-s(\\d+)e(\\d+)/i);
      if (seMatch && wantS && wantEp) {
        if (seMatch[1] === wantS && seMatch[2] === wantEp) score += 40;
        else score -= 25;
      }
      if (score > bestScore) { bestScore = score; best = u.href; }
      // A link that already names the exact episode beats the show page.
      const isEp =
        (wantS && wantEp && (path.indexOf('-s' + wantS.toLowerCase() + 'e' + String(parseInt(wantEp, 10))) !== -1)) ||
        (wantS && wantEp && new RegExp('season[-_]' + wantS + '[-_]episode[-_]' + wantEp + '(?:[^0-9]|$)', 'i').test(path)) ||
        (wantS && wantEp && new RegExp('[sS]' + wantS + '[eE]' + String(parseInt(wantEp, 10)) + '(?:[^0-9]|$)', 'i').test(path + ' ' + (a.textContent || '')));
      if (isEp) {
        const epScore = score + 50;
        if (epScore > bestEpScore) { bestEpScore = epScore; bestEp = u.href; }
      }
    });
    return { best: bestScore >= 60 ? best : '', bestEp: bestEpScore >= 80 ? bestEp : '' };
  })()`;
}

// On a show/series page, find the link (or in-page control) for S#E#.
function pickEpisodeLink(season, episode) {
  const s = String(season || 1);
  const e = String(episode || 1);
  const padS = s.length < 2 ? '0' + s : s;
  const padE = e.length < 2 ? '0' + e : e;
  return `(() => {
    const s = ${JSON.stringify(s)};
    const e = ${JSON.stringify(e)};
    const padS = ${JSON.stringify(padS)};
    const padE = ${JSON.stringify(padE)};
    const candidates = [
      new RegExp('season[-_]' + s + '[-_]episode[-_]' + e + '(?:[^0-9]|$)', 'i'),
      new RegExp('[sS]' + s + '[eE]' + padE + '(?:[^0-9]|$)'),
      new RegExp('[sS]' + s + '[eE]' + e + '(?:[^0-9]|$)'),
      new RegExp('[sS]' + padS + '[eE]' + padE + '(?:[^0-9]|$)'),
      // FMovies family: /shows/{tmdb}-{season}-{episode}/{slug}/ (e.g. 1739-1-5).
      new RegExp('[-/]\\d{2,}-' + s + '-' + e + '(?![0-9])', 'i')
    ];
    const matches = (str) => candidates.some((re) => re.test(str));
    // Season tabs first: many catalogs render only the active season's list.
    const tab = document.querySelector('[data-season="' + s + '"], .season-tab-btn[data-season="' + s + '"], button[title="Season ' + s + '"]');
    if (tab && !/\\bactive\\b/.test(tab.className || '')) {
      try { tab.click(); } catch (err) {}
    }
    let found = '';
    document.querySelectorAll('a[href]').forEach((a) => {
      if (found) return;
      const h = a.href || '';
      const t = a.textContent || '';
      if (matches(h) || (h.indexOf('/e' + e) !== -1 && matches(t))) found = h;
    });
    return found;
  })()`;
}

/**
 * Generic cross-site lookup.
 *
 * @param {object} cfg
 *   cfg.searchUrls   string[] - full search-page URL templates; '{q}' is replaced with the title.
 *   cfg.episodeFromShowPage(showUrl, season, episode) -> url
 *                      optional; the site's episode URL is a pure function of the
 *                      show-page URL (FMovies family: /shows/{tmdb}/{slug}/ ->
 *                      /shows/{tmdb}-{s}-{e}/{slug}/). Used when only one
 *                      season renders at a time and a DOM scan cannot see S#E#.
 * @param {object} args { title, season, episode }
 * @param {object} hooks { load, cloudflare }
 * @param {function} onLog
 * @returns {Promise<string|null>} episode page URL, or the show page for movies, or null.
 */
async function genericFindTitle(cfg, args, hooks, onLog) {
  const title = String((args && args.title) || '').trim();
  const season = args && args.season;
  const episode = args && args.episode;
  if (!title || normTitle(title).length < 3 || !hooks || typeof hooks.load !== 'function') return null;
  const want = `${title}${season ? ' S' + season + 'E' + (episode || 1) : ''}`;
  const load = async (target) => {
    await hooks.load(target);
    if (typeof hooks.cloudflare === 'function') return hooks.cloudflare(target);
    return true;
  };
  const searchUrls = (cfg && cfg.searchUrls) || [];
  for (const tpl of searchUrls) {
    if (!tpl) continue;
    const q = String(tpl).replace(/\{q\}/g, encodeURIComponent(title));
    let cleared = false;
    try {
      cleared = await load(q);
    } catch (e) {
      onLog(`Search did not load: ${q}`);
      continue;
    }
    if (!cleared) continue;
    await delay(800); // let search results hydrate
    let pick = { best: '', bestEp: '' };
    try {
      pick = await hooks.wc.executeJavaScript(pickShowLink(title, { season, episode }), true);
    } catch (e) {
      pick = { best: '', bestEp: '' };
    }
    if (!pick || (!pick.best && !pick.bestEp)) {
      onLog(`No search result for "${title}".`);
      continue;
    }
    if (pick.bestEp) {
      onLog(`Found ${want} directly: ${pick.bestEp}`);
      return pick.bestEp;
    }
    // Show page: for movies this is done; for series, open it and pick the episode.
    if (!season || !episode) {
      onLog(`Found the title page: ${pick.best}`);
      return pick.best;
    }
    try {
      if (!(await load(pick.best))) continue;
    } catch (e) {
      continue;
    }
    // Some catalogs (FMovies family) render only ONE season's episode list at
    // a time, so a DOM scan for S1E5 fails when the page defaults to the last
    // season. If the episode URL is a pure function of the show URL, build it
    // directly instead.
    if (cfg && typeof cfg.episodeFromShowPage === 'function') {
      let direct = '';
      try {
        direct = cfg.episodeFromShowPage(pick.best, season, episode) || '';
      } catch (e) {
        direct = '';
      }
      if (direct && season && episode) {
        onLog(`Built ${want} URL directly: ${direct}`);
        return direct;
      }
    }
    await delay(800);
    let epUrl = '';
    for (let i = 0; i < 5 && !epUrl; i++) {
      try {
        epUrl = await hooks.wc.executeJavaScript(pickEpisodeLink(season, episode), true);
      } catch (e) {
        epUrl = '';
      }
      if (!epUrl) await delay(700);
    }
    if (epUrl) {
      onLog(`Found ${want} on this site: ${epUrl}`);
      return epUrl;
    }
    onLog(`Has "${title}" but not S${season}E${episode}.`);
  }
  return null;
}

// --- Shared media-id memory -------------------------------------------------
// The discovery window navigates AWAY from the source page before the
// cross-site walker runs (SFlix alternates, other catalogs), so a TMDB/IMDB id
// seen on that page is gone from the DOM by the time an id-keyed adapter
// (Vidsrc, NontonGo) needs it. Adapters remember ids here, keyed by
// normalized title, and findTitle() consumers look them up when the live page
// has none. Only ids seen in real player markup are stored — never ids from a
// title search (a mid-load "404" page title produced a wrong IMDB id once).
const mediaIdCache = new Map();

function rememberMediaId(title, id) {
  const key = normTitle(title);
  const v = String(id || '').trim().toLowerCase();
  if (!key || !v) return;
  const cur = mediaIdCache.get(key) || {};
  if (/^\d{4,8}$/.test(v) && !cur.tmdb) cur.tmdb = v;
  if (/^tt\d{6,}$/.test(v) && !cur.imdb) cur.imdb = v;
  if (cur.tmdb || cur.imdb) mediaIdCache.set(key, cur);
}

function lookupMediaId(title) {
  const cur = mediaIdCache.get(normTitle(title));
  return cur ? { tmdb: cur.tmdb || '', imdb: cur.imdb || '' } : { tmdb: '', imdb: '' };
}

// Pulls a TMDB/IMDB id out of a player/embed URL we already hold, e.g.
//   sv2.nontongo.stream/soap/tv/1739/1/2      -> tmdb 1739
//   vidfast.pro/tv/tt0285351/1/5              -> imdb tt0285351
//   moviesapi.to/tv/1739-1-2                  -> tmdb 1739
//   multiembed.mov/?video_id=tt0285351&s=1    -> imdb tt0285351
//   vidapi.xyz/embed/tv/1739/1/5              -> tmdb 1739
function idFromPlayerUrl(url) {
  const out = { tmdb: '', imdb: '' };
  const s = String(url || '');
  if (!s) return out;
  const mQ = s.match(/[?&](?:tmdb|id|video_id)=([A-Za-z0-9]+)/i);
  if (mQ) {
    const v = mQ[1].toLowerCase();
    if (/^\d{4,8}$/.test(v)) out.tmdb = v;
    else if (/^tt\d{6,}$/.test(v)) out.imdb = v;
  }
  const mI = s.match(/[?&]imdb=(tt\d{6,})/i);
  if (mI) out.imdb = mI[1].toLowerCase();
  const mP = s.match(/\/(?:embed\/)?(?:tv|movie)\/(?:tt(\d{6,})|(\d{4,8}))\b/i);
  if (mP) {
    if (mP[1]) out.imdb = 'tt' + mP[1];
    else if (mP[2] && !out.tmdb) out.tmdb = mP[2];
  }
  const mS = s.match(/\/(\d{4,8})-(\d{1,3})-(\d{1,3})(?:\/|&|$|\?)/);
  if (mS && !out.tmdb) out.tmdb = mS[1];
  return out;
}

// Season/episode pair carried by a URL, '' when absent. Used to make sure an
// id remembered from a player URL actually belongs to the episode on the page.
function seasonEpisodeFromUrl(url) {
  const s = String(url || '');
  const se = s.match(/season[-_](\d+)[-_]episode[-_](\d+)/i);
  if (se) return { season: se[1], episode: se[2] };
  const sxe = s.match(/[sS](\d{1,2})[eE](\d{1,3})/);
  if (sxe) return { season: sxe[1], episode: sxe[2] };
  return { season: '', episode: '' };
}

module.exports = {
  normTitle,
  cleanShowTitle,
  episodeRefFromUrl,
  pickShowLink,
  pickEpisodeLink,
  genericFindTitle,
  rememberMediaId,
  lookupMediaId,
  idFromPlayerUrl,
  seasonEpisodeFromUrl
};
