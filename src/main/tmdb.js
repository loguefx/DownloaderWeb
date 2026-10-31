'use strict';

// TMDB client shared by the HTTP API and the daily watcher.
//
// The watcher needs the SAME cached, anime-layout-aware answers the plugin
// screen shows (seasons with the Aniwave/AniList layout for anime, air dates
// for the "what has aired" decision), so both go through this one module -
// one source of truth, one cache.

const engineconfig = require('./engineconfig');
const animelayout = require('./anime-layout');

function getTmdbKey() {
  const c = engineconfig.get() || {};
  return String(process.env.TMDB_API_KEY || c.tmdbApiKey || '').trim();
}

async function tmdbFetch(pathname, key) {
  const url = `https://api.themoviedb.org/3${pathname}${pathname.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Small in-memory TTL cache for TMDB answers. Re-opening a title (or
// re-rendering its seasons) is then instant, and the TMDB API stays out of
// the hot path while the user is picking episodes. Ten minutes is long
// enough for a session, short enough that newly aired episodes show up on
// the next visit. Failed lookups are NOT cached, so a retry can succeed.
const TMDB_CACHE_MS = 10 * 60 * 1000;
const tmdbCache = new Map();
function tmdbCacheGet(key) {
  const hit = tmdbCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > TMDB_CACHE_MS) {
    tmdbCache.delete(key);
    return undefined;
  }
  return hit.value;
}
function tmdbCacheSet(key, value) {
  if (tmdbCache.size > 200) tmdbCache.delete(tmdbCache.keys().next().value);
  tmdbCache.set(key, { ts: Date.now(), value });
}

// Animation (genre 16) made in Japan, China, Korea or Taiwan = anime for the
// engine's purposes (Japanese anime, Chinese donghua, ...), whichever plugin
// tab the title was opened from. Anime gets the strict English-dub rule and
// the anime sources; as plain TV a DUB request would only PREFER English.
const ANIME_COUNTRIES = new Set(['JP', 'CN', 'KR', 'TW']);
function looksAnime(body) {
  if (!body) return false;
  const genres = (body.genres || []).map((g) => Number(g && g.id)).concat((body.genre_ids || []).map(Number));
  const countries = [].concat(body.origin_country || [], (body.production_countries || []).map((c) => c && c.iso_3166_1));
  return genres.includes(16) && countries.some((c) => ANIME_COUNTRIES.has(String(c || '').toUpperCase()));
}

async function tmdbInfo(tmdbId, type, opts = {}) {
  const key = getTmdbKey();
  if (!key) return null;
  const cacheKey = 'info|' + type + '|' + tmdbId + '|' + !!(opts && opts.anime);
  const cached = tmdbCacheGet(cacheKey);
  if (cached) return cached;
  const value = await tmdbInfoFetch(tmdbId, type, opts);
  if (value) tmdbCacheSet(cacheKey, value);
  return value;
}

async function tmdbInfoFetch(tmdbId, type, opts = {}) {
  const key = getTmdbKey();
  if (!key) return null;
  if (type === 'movie') {
    const body = await tmdbFetch(`/movie/${tmdbId}?language=en-US`, key);
    if (!body) return null;
    return {
      tmdb: String(body.id),
      imdb: String(body.imdb_id || ''),
      title: body.title || '',
      year: String(body.release_date || '').slice(0, 4),
      type: 'movie',
      poster: body.poster_path ? `https://image.tmdb.org/t/p/w342${body.poster_path}` : '',
      overview: (body.overview || '').slice(0, 300),
      runtime: body.runtime || null
    };
  }
  // TV series: return seasons with episode counts.
  // NOTE: `seasons` MUST be `let` - the anime-layout merge below replaces it
  // (Aniwave wins wholesale / AniList adds missing seasons). A `const` here
  // was a runtime "Assignment to constant variable" that broke every anime
  // title while TV (resolved = null) skipped the merge and kept working.
  const body = await tmdbFetch(`/tv/${tmdbId}?language=en-US`, key);
  if (!body) return null;
  // Season 0 is TMDB's "Specials" (OVAs, movies, extras). It is listed when
  // it has episodes; it sits first, like TMDB orders it.
  let seasons = (body.seasons || [])
    .filter((s) => s.season_number > 0 || (s.season_number === 0 && s.episode_count > 0))
    .map((s) => ({
      season: s.season_number,
      episodes: s.episode_count || 0,
      year: String(s.air_date || '').slice(0, 4)
    }));
  // Fetch IMDB id (not in the main /tv response); the AniList id from the
  // same call is the deterministic bridge to the AniList season layout.
  let imdb = '';
  let anilistId = '';
  try {
    const ext = await tmdbFetch(`/tv/${tmdbId}/external_ids`, key);
    imdb = String((ext && ext.imdb_id) || '');
    anilistId = String((ext && ext.anilist_id) || '');
  } catch (e) { /* optional */ }

  // Seasons follow TMDB's numbering - the numbering Jellyfin shows, so files
  // named from it land in the right Jellyfin season (Link Click: S3 is the
  // Bridon Arc, S4 the 2026 season; Ranma ½ 2024 is one 36-episode season).
  // The anime sources number their entries differently; downloads translate
  // TMDB's numbers per episode (anime-layout.animeSourceEpisode), the layout
  // shown never changes.
  //
  // AniList only ADDS a season TMDB does not list at all yet (a sequel TMDB
  // has not added), and only for anime (the caller's flag, or animation from
  // JP/CN/KR/TW). It never renumbers or re-counts a TMDB season, and it is
  // ignored when its seasons are a finer split of TMDB's (addMissingSeasons).
  // With no TMDB seasons at all, AniList's layout is used as-is.
  const tmdbSeasons = seasons.slice();
  let layout = 'tmdb';
  const tmdbNumbered = tmdbSeasons.filter((s) => s.season > 0).length;
  const allowAnilist = !!(opts && opts.anime) || looksAnime(body) || tmdbNumbered === 0;
  const firstYear = Number(String(body.first_air_date || '').slice(0, 4)) || 0;
  if (allowAnilist) {
    const al = await animelayout.anilistLayout(String(body.id), body.name || '', { anilistId, year: firstYear });
    if (al) {
      if (tmdbNumbered === 0) {
        layout = 'anilist';
        seasons = al.filter((s) => s && (s.season > 0 || (s.episodes || []).length))
          .map((s) => ({ season: s.season, episodes: (s.episodes || []).length, year: s.year || '' }));
      } else {
        seasons = animelayout.addMissingSeasons(tmdbSeasons, al);
        if (seasons.length > tmdbSeasons.length) layout = 'tmdb+anilist';
      }
    }
  }

  return {
    tmdb: String(body.id),
    imdb,
    title: body.name || '',
    year: String(body.first_air_date || '').slice(0, 4),
    type: 'tv',
    animeLike: looksAnime(body),
    poster: body.poster_path ? `https://image.tmdb.org/t/p/w342${body.poster_path}` : '',
    overview: (body.overview || '').slice(0, 300),
    seasons,
    layout,
    tmdbSeasons
  };
}

// One season's episodes (name, runtime, air date). The plugin lists these on
// the Choose episodes screen and greys out episodes that have not aired yet,
// so a season is never cut short or padded with episodes that do not exist.
async function tmdbSeason(tmdbId, seasonNo, opts = {}) {
  const key = getTmdbKey();
  if (!key) return null;
  const cacheKey = 'season|' + tmdbId + '|' + seasonNo + '|' + !!(opts && opts.anime);
  const cached = tmdbCacheGet(cacheKey);
  if (cached) return cached;
  const value = await tmdbSeasonFetch(tmdbId, seasonNo, opts);
  if (value) tmdbCacheSet(cacheKey, value);
  return value;
}

async function tmdbSeasonFetch(tmdbId, seasonNo, opts = {}) {
  const key = getTmdbKey();
  if (!key) return null;
  // TMDB's own season - the numbering Jellyfin shows (see tmdbInfoFetch).
  let body = null;
  try {
    body = await tmdbFetch(`/tv/${encodeURIComponent(tmdbId)}/season/${encodeURIComponent(seasonNo)}?language=en-US`, key);
  } catch (e) {
    body = null;
  }
  const tmdbEps = (body && Array.isArray(body.episodes))
    ? body.episodes.filter((e) => e && e.episode_number > 0)
    : [];
  if (tmdbEps.length) {
    return {
      tmdb: String(tmdbId),
      season: Number(seasonNo),
      name: (body && body.name) || '',
      layout: 'tmdb',
      episodes: tmdbEps.map((e) => ({
        episode: e.episode_number,
        name: e.name || '',
        runtime: e.runtime || null,
        airDate: e.air_date || null
      }))
    };
  }
  // A season TMDB does not list yet, added from AniList (tmdbInfoFetch adds
  // it only for anime): its episodes are a plain 1..N list.
  const info = await tmdbInfo(tmdbId, 'tv', opts).catch(() => null);
  const added = info && info.layout !== 'tmdb' && (info.seasons || []).find((x) => x.season === Number(seasonNo));
  if (!added || !(added.episodes > 0)) return null;
  return {
    tmdb: String(tmdbId),
    season: Number(seasonNo),
    name: 'Season ' + seasonNo,
    layout: info.layout,
    episodes: Array.from({ length: added.episodes }, (_, i) => ({ episode: i + 1, name: '', runtime: null, airDate: null }))
  };
}

// Best-effort: licensed providers for a title (TMDB /watch/providers).
// Used to EXPLAIN a total discovery failure: a Netflix exclusive is simply
// not on the CF-free catalogs, and that is the answer the user needs instead
// of six retries of "No video sources found on the page".
async function watchProviders(tmdbId, type) {
  const key = getTmdbKey();
  if (!key || !tmdbId) return null;
  const t = type === 'movie' ? 'movie' : 'tv';
  const cacheKey = 'wp|' + t + '|' + tmdbId;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;
  const body = await tmdbFetch(`/${t}/${tmdbId}/watch/providers?language=en-US`, key);
  const flat = body && Array.isArray(body.flatrate) ? body.flatrate : null;
  const names = (flat || [])
    .map((p) => (p && (p.provider_name || p.name) || ''))
    .filter(Boolean);
  const out = names.length ? names : null;
  if (out) tmdbCacheSet(cacheKey, out);
  return out;
}

// An actionable, single-clause explanation of a total source failure when TMDB
// says the title is a licensed exclusive. '' when TMDB knows nothing useful,
// so the failure message never invents a reason.
function exclusiveHint(providerNames) {
  const names = (providerNames || [])
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  if (!names.length) return '';
  const list = names.slice(0, 4).join(', ');
  const kind = names.length === 1 ? `a ${list} exclusive` : `licensed on ${list}`;
  return (
    `${kind} per TMDB - such titles are rarely on the CF-free catalogs. ` +
    'The Cloudflare-gated fallbacks are the best remaining chance; set a Cloudflare solver (Settings) to unlock them without the checkbox.'
  );
}

module.exports = {
  getTmdbKey,
  tmdbFetch,
  tmdbInfo,
  tmdbSeason,
  watchProviders,
  exclusiveHint,
  looksAnime,
  TMDB_CACHE_MS
};
