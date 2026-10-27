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
  let seasons = (body.seasons || [])
    .filter((s) => s.season_number > 0)
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

  // Anime season layout, additive-first (the user's rule: add on, never
  // re-adjust):
  //   - ANIWAVE answers -> use its layout wholesale (it is the user's source
  //     of truth and keyed by this TMDB id - anime-only catalog);
  //   - AniList is consulted ONLY when the caller flags the title as anime,
  //     or when TMDB lists NO seasons at all (nothing to corrupt). It may
  //     then only ADD seasons TMDB lacks (the "S2 exists but TMDB only
  //     lists S1" case) - it NEVER overrides a TMDB count (its counts have
  //     proven unreliable: 24 where the season has 12);
  //   - TV shows and movies keep their TMDB layout untouched. A live-action
  //     show that happens to share its exact title with an anime (e.g.
  //     "One Piece") can therefore never inherit the anime's season list.
  const tmdbSeasons = seasons.slice();
  let layout = 'tmdb';
  const allowAnilist = !!(opts && opts.anime) || tmdbSeasons.length === 0;
  const resolved = await animelayout.resolveLayout(String(body.id), body.name || '', { anime: allowAnilist, anilistId });
  if (resolved) {
    if (resolved.source === 'aniwave' || tmdbSeasons.length === 0) {
      layout = resolved.source;
      seasons = resolved.seasons
        .filter((s) => s && s.season > 0)
        .map((s) => ({
          season: s.season,
          episodes: (s.episodes || []).length,
          year: s.year || ''
        }));
    } else {
      seasons = animelayout.addMissingSeasons(tmdbSeasons, resolved.seasons);
      if (seasons.length > tmdbSeasons.length) layout = 'tmdb+anilist';
    }
  }

  return {
    tmdb: String(body.id),
    imdb,
    title: body.name || '',
    year: String(body.first_air_date || '').slice(0, 4),
    type: 'tv',
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
  let body = null;
  try {
    body = await tmdbFetch(`/tv/${encodeURIComponent(tmdbId)}/season/${encodeURIComponent(seasonNo)}?language=en-US`, key);
  } catch (e) {
    // The season may not exist in TMDB when the anime layout differs (anime
    // sequels, cour splits) - the authoritative layout below still answers.
  }
  const tmdbEps = (body && Array.isArray(body.episodes))
    ? body.episodes.filter((e) => e && e.episode_number > 0)
    : [];

  // The authoritative layout (Aniwave first, then AniList for anime) decides
  // WHICH episodes this season has; TMDB fills in names/air dates where its
  // numbering lines up. Non-anime shows never hit a tier (Aniwave's catalog
  // is anime-only and keyed by this TMDB id), so they keep the old behavior.
  let layout = 'tmdb';
  let authoritative = null;
  try {
    const aw = await animelayout.aniwaveSeasons(String(tmdbId));
    if (aw) {
      const hit = aw.find((s) => s.season === Number(seasonNo));
      if (hit && (hit.episodes || []).length) {
        authoritative = hit;
        layout = 'aniwave';
      }
    }
  } catch (e) { /* tier is best-effort */ }
  // AniList may answer for a season TMDB does NOT have at all (a missing
  // sequel). A season TMDB knows keeps TMDB's own episode list: AniList's
  // counts have proven unreliable (24 where the season has 12) and must
  // never override TMDB's correct one. (Aniwave, above, still wins when it
  // answers - that is the user's source of truth.)
  if (!authoritative && !tmdbEps.length && opts && opts.anime) {
    try {
      let title = (body && body.name) || '';
      if (!title) {
        const series = await tmdbFetch(`/tv/${encodeURIComponent(tmdbId)}?language=en-US`, key);
        title = (series && series.name) || '';
      }
      if (title) {
        // resolveLayout uses the TMDB->AniList id when available (exact work,
        // no title guessing) and falls back to the guarded title search.
        const resolved = await animelayout.resolveLayout(String(tmdbId), title, { anime: true });
        if (resolved) {
          const hit = resolved.seasons.find((s) => s && s.season === Number(seasonNo));
          if (hit && (hit.episodes || []).length) {
            authoritative = hit;
            layout = resolved.source;
          }
        }
      }
    } catch (e) { /* tier is best-effort */ }
  }

  let episodes;
  if (authoritative) {
    const byNum = new Map(tmdbEps.map((e) => [e.episode_number, e]));
    episodes = (authoritative.episodes || []).map((e) => {
      const t = byNum.get(e.episode);
      return {
        episode: e.episode,
        name: (t && t.name) || e.name || '',
        runtime: t ? t.runtime : null,
        airDate: t ? t.air_date : null
      };
    });
  } else {
    episodes = tmdbEps.map((e) => ({
      episode: e.episode_number,
      name: e.name || '',
      runtime: e.runtime || null,
      airDate: e.air_date || null
    }));
  }
  if (!episodes.length) return null;
  return {
    tmdb: String(tmdbId),
    season: Number(seasonNo),
    name: (body && body.name) || '',
    layout,
    episodes
  };
}

module.exports = {
  getTmdbKey,
  tmdbFetch,
  tmdbInfo,
  tmdbSeason,
  TMDB_CACHE_MS
};
