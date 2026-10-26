'use strict';

// Engine HTTP API (Jellyfin build plan, Part 1).
//
// Plain Node http server, started in --engine mode. Every request must carry
// `Authorization: Bearer <api key>`; the key lives in engine.json. The server
// binds to the LAN so the Jellyfin plugin (on the Jellyfin machine) can reach
// the engine; the firewall should allow only that machine.
//
// Endpoints:
//   GET    /api/health                      version, VPN state, queue, staging
//   GET    /api/title?url=                  episode list + per-episode status
//   GET    /api/search?q=&type=             TMDB multi-search (or the Jellyfin catalog)
//   GET    /api/tmdb/info?tmdb=&type=[&anime=1]   seasons + counts (anime layout: Aniwave/AniList truth)
//   GET    /api/tmdb/season?tmdb=&season=[&anime=1]   one season's episodes (name, runtime, air date)
//   POST   /api/jobs                        queue a movie / series / episodes
//   GET    /api/queue                       queue snapshot + counts
//   GET    /api/events                      Server-Sent Events live updates
//   GET    /api/log?since=                  last 200 log lines (polled by the plugin)
//   POST   /api/queue/pause | /resume | /stop
//   DELETE /api/queue/{id}
//   POST   /api/queue/{id}/retry
//   GET    /api/waiting                     waiting-for-dub list
//   DELETE /api/waiting/{key}
//   GET    /api/schedules                   keep-watching series
//   POST   /api/schedules
//   DELETE /api/schedules/{key}
//   GET    /api/settings
//   PUT    /api/settings
//   POST   /api/library/check               engine-side duplicate check (Part 6)
//   POST   /api/library/report              dry-run: recognize vs. on-disk, before downloading
//   POST   /api/library/verify              verify library drives (mount + write round-trip)

const http = require('http');
const { URL } = require('url');
const config = require('./config');
const vpn = require('./vpn');
const manager = require('./queue');
const service = require('./service');
const engineconfig = require('./engineconfig');
const animelayout = require('./anime-layout');

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'BAD_REQUEST', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_REQUEST', status: 400 }));
      }
    });
    req.on('error', (e) => reject(e));
  });
}

function authorized(req) {
  const key = engineconfig.get().apiKey;
  const header = String(req.headers['authorization'] || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !key) return false;
  const given = m[1].trim();
  if (given.length !== key.length) return false;
  // Constant-time-ish comparison to avoid trivial timing leaks on the LAN.
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload == null ? {} : payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, err) {
  const status = err && err.status ? err.status : err && err.code === 'NO_SPACE' ? 507 : 500;
  json(res, status, { error: (err && err.message) || 'internal error' });
}

// Server-Sent Events: queue updates, log lines and VPN status changes.
function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });
  res.write('event: hello\ndata: ' + JSON.stringify({ ok: true }) + '\n\n');
  res.write('event: queue\ndata: ' + JSON.stringify(service.queueSnapshot()) + '\n\n');
  res.write('event: vpn\ndata: ' + JSON.stringify(vpn.status()) + '\n\n');

  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // client went away
    }
  };
  const onUpdate = (items) => send('queue', { items });
  const onLog = (msg) => send('log', { ts: Date.now(), msg });
  const onVpn = (s) => send('vpn', s);
  manager.on('update', onUpdate);
  manager.on('log', onLog);
  vpn.on('status', onVpn);

  const ping = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': ping\n\n');
    } catch (e) {
      // ignore
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    manager.removeListener('update', onUpdate);
    manager.removeListener('log', onLog);
    vpn.removeListener('status', onVpn);
  });
}

// ---------------------------------------------------------------------------
// Title search + TMDB info (for the plugin's search-then-queue flow)
// ---------------------------------------------------------------------------

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

async function searchTitles(q, type) {
  const key = getTmdbKey();
  if (!key) {
    // Fallback: Jellyfin catalog search
    const j = (engineconfig.get() || {}).jellyfin || {};
    const base = String(j.baseUrl || '').trim().replace(/\/+$/, '');
    const jkey = String(j.apiKey || '').trim();
    if (!base || !jkey) return [];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const url = `${base}/api/search?searchTerm=${encodeURIComponent(q)}&limit=25`;
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'X-Emby-Token': jkey, Accept: 'application/json' } });
      if (!res.ok) return [];
      const body = await res.json();
      const items = (body && body.Items) || [];
      return items
        .filter((it) => {
          if (type === 'tv' && it.Type !== 'Series' && it.Type !== 'Season') return false;
          if (type === 'movie' && it.Type !== 'Movie') return false;
          return true;
        })
        .slice(0, 15)
        .map((it) => ({
          tmdb: String((it.ProviderIds && it.ProviderIds.Tmdb) || ''),
          imdb: String((it.ProviderIds && it.ProviderIds.Imdb) || ''),
          title: it.Name || it.OriginalTitle || q,
          year: (it.PremiereDate || it.ProductionYear || '').slice(0, 4) || '',
          type: (it.Type === 'Movie') ? 'movie' : 'tv',
          poster: it.ImageTags && it.PrimaryImageTag
            ? `${base}/Items/${it.Id}/Images/Primary?tag=${it.ImageTags.Primary}`
            : ''
        }));
    } catch (e) {
      return [];
    } finally {
      clearTimeout(t);
    }
  }

  // TMDB multi search
  const body = await tmdbFetch(`/search/multi?query=${encodeURIComponent(q)}&include_adult=false&language=en-US`, key);
  if (!body || !Array.isArray(body.results)) return [];
  return body.results
    .filter((r) => {
      if (!r || !r.id) return false;
      if (type === 'tv' && r.media_type !== 'tv') return false;
      if (type === 'movie' && r.media_type !== 'movie') return false;
      return true;
    })
    .slice(0, 15)
    .map((r) => ({
      tmdb: String(r.id),
      imdb: String(r.imdb_id || ''),
      title: r.title || r.name || q,
      year: String((r.release_date || r.first_air_date || '') || '').slice(0, 4),
      type: r.media_type === 'movie' ? 'movie' : 'tv',
      // w342: the plugin shows these as poster cards, not thumbnails.
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : '',
      overview: (r.overview || '').slice(0, 240)
    }));
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
  // TV series: return seasons with episode counts
  const body = await tmdbFetch(`/tv/${tmdbId}?language=en-US`, key);
  if (!body) return null;
  const seasons = (body.seasons || [])
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

async function handle(req, res, u) {
  const parts = u.pathname.split('/').filter(Boolean);
  // parts: ['api', ...]
  const api = parts[0];
  if (api !== 'api') {
    json(res, 404, { error: 'not found' });
    return;
  }
  const seg = parts[1];

  try {
    // ---- health ----
    if (req.method === 'GET' && seg === 'health') {
      json(res, 200, service.health());
      return;
    }

    // ---- sources health (Overview "Sources" row) ----
    // Probes run FROM THE ENGINE, so the statuses reflect the engine's own
    // IP - the one downloads actually go out through.
    if (req.method === 'GET' && seg === 'sources' && parts[2] === 'health') {
      json(res, 200, await service.sourcesHealth());
      return;
    }

    // ---- anime layout diagnostics: what each tier answered for a title ----
    // GET /api/anime/diag?tmdb=&title=  (no mutation; read-only)
    if (req.method === 'GET' && seg === 'anime' && parts[2] === 'diag') {
      const tmdb = u.searchParams.get('tmdb') || '';
      const title = u.searchParams.get('title') || '';
      const out = { tmdb, title, aniwave: null, anilist: null, tmdbSeasons: null };
      try { out.aniwave = await animelayout.aniwaveSeasons(tmdb); } catch (e) { out.aniwave = 'error: ' + e.message; }
      try {
        const alId = tmdb ? await animelayout.anilistIdFor(tmdb) : null;
        const al = title ? await animelayout.anilistSeasons(title, { anilistId: alId }) : null;
        out.anilist = { anilistId: alId || null, seasons: al ? al.map((s) => ({ season: s.season, episodes: (s.episodes || []).length })) : null };
      } catch (e) { out.anilist = 'error: ' + e.message; }
      if (getTmdbKey()) {
        try { out.tmdbSeasons = await animelayout.tmdbSeasonCounts(tmdb); } catch (e) { out.tmdbSeasons = 'error: ' + e.message; }
      }
      json(res, 200, out);
      return;
    }

    // ---- search (TMDB multi-search or Jellyfin catalog) ----
    if (req.method === 'GET' && seg === 'search') {
      const q = (u.searchParams.get('q') || '').trim();
      const type = (u.searchParams.get('type') || 'all').trim(); // all | tv | movie
      if (!q || q.length < 2) {
        json(res, 400, { error: 'q must be at least 2 characters' });
        return;
      }
      const results = await searchTitles(q, type);
      json(res, 200, { results });
      return;
    }

    // ---- browse (TMDB trending / popular) ----
    if (req.method === 'GET' && seg === 'browse') {
      const type = (u.searchParams.get('type') || 'tv').trim(); // tv | movie | anime
      const category = (u.searchParams.get('category') || 'trending').trim(); // trending | popular
      const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
      const key = getTmdbKey();
      if (!key) {
        json(res, 503, { error: 'TMDB API key not configured on the engine' });
        return;
      }
      // Anime = TV with Animation genre (16)
      const isAnime = type === 'anime';
      const mediaType = isAnime ? 'tv' : type; // tv or movie
      const genreParam = isAnime ? '&with_genres=16' : '';
      const base = category === 'popular'
        ? `/${mediaType}/popular`
        : `/trending/${mediaType}/week`;
      try {
        const body = await tmdbFetch(`${base}?language=en-US&page=${page}${genreParam}`, key);
        if (!body || !Array.isArray(body.results)) {
          json(res, 502, { error: 'TMDB returned no results' });
          return;
        }
        const results = body.results.slice(0, 20).map((r) => ({
          tmdb: String(r.id),
          type: isAnime ? 'anime' : (mediaType === 'tv' ? 'tv' : 'movie'),
          title: r.title || r.name || '',
          year: (r.release_date || r.first_air_date || '').slice(0, 4),
          poster: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : '',
          rating: r.vote_average != null ? Math.round(r.vote_average * 10) / 10 : null,
          overview: (r.overview || '').slice(0, 200)
        })).filter((r) => r.title && r.poster);
        json(res, 200, { results, page, total_pages: body.total_pages || 1 });
      } catch (e) {
        json(res, 502, { error: 'TMDB browse failed: ' + ((e && e.message) || e) });
      }
      return;
    }

    // ---- anime browse (AniList API - free, no key needed) ----
    if (req.method === 'GET' && seg === 'anime' && parts[2] === 'browse') {
      const category = (u.searchParams.get('category') || 'trending').trim();
      const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
      const perPage = 20;
      const sort = [category === 'popular' ? 'POPULARITY_DESC' : 'TRENDING_DESC'];
      const graphqlQuery = JSON.stringify({
        query: `query($page: Int, $perPage: Int, $sort: [MediaSort]) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { currentPage total }
            media(sort: $sort, type: ANIME, isAdult: false) {
              id
              title { english romaji }
              coverImage { large }
              description(asHtml: false)
              episodes
              season
              seasonYear
              averageScore
            }
          }
        }`,
        variables: { page, perPage, sort }
      });
      try {
        const body = await new Promise((resolve, reject) => {
          const https = require('https');
          const req = https.request(
            { hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers: {
              'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(graphqlQuery)
            }},
            (res) => {
              const chunks = [];
              res.on('data', (d) => chunks.push(d));
              res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(new Error('AniList returned non-JSON')); }
              });
            }
          );
          req.on('error', reject);
          req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
          req.write(graphqlQuery);
          req.end();
        });
        const pg = body && body.data && body.data.Page;
        if (!pg || !Array.isArray(pg.media)) {
          json(res, 502, { error: 'AniList returned no results' });
          return;
        }
        const results = pg.media.map((m) => ({
          anilist: String(m.id),
          title: (m.title && (m.title.english || m.title.romaji)) || '',
          poster: (m.coverImage && m.coverImage.large) || '',
          episodes: m.episodes || 0,
          season: m.season ? m.season.charAt(0) + m.season.slice(1).toLowerCase() : '',
          year: m.seasonYear || '',
          rating: m.averageScore ? Math.round(m.averageScore / 10) : null,
          overview: (m.description || '').replace(/<[^>]+>/g, '').slice(0, 200)
        })).filter((r) => r.title && r.poster);
        const pi = pg.pageInfo || {};
        const totalPages = pi.total ? Math.ceil(pi.total / perPage) : 1;
        json(res, 200, { results, page, total_pages: totalPages });
      } catch (e) {
        json(res, 502, { error: 'AniList browse failed: ' + ((e && e.message) || e) });
      }
      return;
    }

    // ---- anime info (all seasons from AniList) ----
    if (req.method === 'GET' && seg === 'anime' && parts[2] === 'info') {
      const title = (u.searchParams.get('title') || '').trim();
      if (!title) { json(res, 400, { error: 'title is required' }); return; }
      const graphqlQuery = JSON.stringify({
        query: `query($title: String) {
          Media(search: $title, type: ANIME, sort: START_DATE) {
            id
            title { english romaji }
            coverImage { large }
            description(asHtml: false)
            episodes
            season
            seasonYear
            averageScore
            relations { edges { relationType node { id title { english romaji } episodes seasonYear } } }
          }
        }`,
        variables: { title }
      });
      try {
        const body = await new Promise((resolve, reject) => {
          const https = require('https');
          const req = https.request(
            { hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers: {
              'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(graphqlQuery)
            }},
            (res) => {
              const chunks = [];
              res.on('data', (d) => chunks.push(d));
              res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(new Error('AniList returned non-JSON')); }
              });
            }
          );
          req.on('error', reject);
          req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
          req.write(graphqlQuery);
          req.end();
        });
        const media = body && body.data && body.data.Media;
        if (!media) { json(res, 404, { error: 'Anime not found on AniList' }); return; }
        let seasons = [{
          season: 1,
          episodes: media.episodes || 0,
          year: media.seasonYear || '',
          title: (media.title && (media.title.english || media.title.romaji)) || '',
          anilist: String(media.id)
        }];
        // Relations are already included in the query above
        const edges = (media.relations && media.relations.edges) || [];
        let seasonNum = 1;
        for (const edge of edges) {
          if (!edge.node || !edge.relationType) continue;
          if (!/SEQUEL|NEXT_SEASON/i.test(edge.relationType)) continue;
          seasonNum++;
          seasons.push({
            season: seasonNum,
            episodes: edge.node.episodes || 0,
            year: edge.node.seasonYear || '',
            title: (edge.node.title && (edge.node.title.english || edge.node.title.romaji)) || '',
            anilist: String(edge.node.id)
          });
        }

        json(res, 200, {
          title: (media.title && (media.title.english || media.title.romaji)) || title,
          poster: (media.coverImage && media.coverImage.large) || '',
          overview: (media.description || '').replace(/<[^>]+>/g, '').slice(0, 400),
          rating: media.averageScore ? Math.round(media.averageScore / 10) : null,
          seasons
        });
      } catch (e) {
        json(res, 502, { error: 'AniList info failed: ' + ((e && e.message) || e) });
      }
      return;
    }

    // ---- TMDB info (seasons/episodes for a title) ----
    if (req.method === 'GET' && seg === 'tmdb' && parts[2] === 'info') {
      const tmdb = u.searchParams.get('tmdb') || '';
      const type = (u.searchParams.get('type') || 'tv').trim(); // tv | movie
      const anime = ['1', 'true', 'yes'].includes((u.searchParams.get('anime') || '').toLowerCase());
      if (!tmdb) {
        json(res, 400, { error: 'tmdb id is required' });
        return;
      }
      const info = await tmdbInfo(tmdb, type, { anime });
      if (!info) {
        json(res, 404, { error: 'not found or TMDB key not configured' });
        return;
      }
      json(res, 200, info);
      return;
    }

    // ---- TMDB season (episode names + air dates) ----
    if (req.method === 'GET' && seg === 'tmdb' && parts[2] === 'season') {
      const tmdb = u.searchParams.get('tmdb') || '';
      const season = parseInt(u.searchParams.get('season') || '', 10);
      const anime = ['1', 'true', 'yes'].includes((u.searchParams.get('anime') || '').toLowerCase());
      if (!tmdb || !(season >= 0)) {
        json(res, 400, { error: 'tmdb and season are required' });
        return;
      }
      const info = await tmdbSeason(tmdb, season, { anime });
      if (!info) {
        json(res, 404, { error: 'not found or TMDB key not configured' });
        return;
      }
      json(res, 200, info);
      return;
    }

    // ---- title / episode list ----
    if (req.method === 'GET' && seg === 'title') {
      const url = u.searchParams.get('url') || '';
      let locations = [];
      const libParam = u.searchParams.get('library');
      if (libParam) {
        try {
          const parsed = JSON.parse(decodeURIComponent(libParam));
          if (parsed && Array.isArray(parsed.locations)) locations = parsed.locations;
        } catch (e) {
          // ignore malformed library param
        }
      }
      json(res, 200, await service.title(url, locations));
      return;
    }

    // ---- jobs ----
    if (req.method === 'POST' && seg === 'jobs') {
      // Jobs are accepted even while the tunnel is down: they stay queued and
      // start when Mullvad is back (fail-closed hold, Part 3).
      const job = await readBody(req);
      json(res, 202, await service.submitJob(job));
      return;
    }

    // ---- queue ----
    if (seg === 'queue') {
      const id = parts[2];
      const action = parts[3];
      if (req.method === 'GET' && !id) {
        json(res, 200, service.queueSnapshot());
        return;
      }
      if (req.method === 'POST' && action === 'pause') {
        json(res, 200, service.queuePause());
        return;
      }
      if (req.method === 'POST' && action === 'resume') {
        json(res, 200, service.queueResume());
        return;
      }
      if (req.method === 'POST' && action === 'stop') {
        json(res, 200, service.queueStop());
        return;
      }
      if (req.method === 'DELETE' && id && !action) {
        json(res, 200, service.queueRemove(id));
        return;
      }
      if (req.method === 'POST' && id && action === 'retry') {
        json(res, 200, service.queueRetry(id));
        return;
      }
    }

    // ---- recent log lines (polled by the plugin) ----
    if (req.method === 'GET' && seg === 'log') {
      json(res, 200, service.recentLog(u.searchParams.get('since')));
      return;
    }

    // ---- events (SSE) ----
    if (req.method === 'GET' && seg === 'events') {
      sse(req, res);
      return;
    }

    // ---- waiting for dub ----
    if (seg === 'waiting') {
      const key = parts[2];
      if (req.method === 'GET' && !key) {
        json(res, 200, { items: service.waitingList() });
        return;
      }
      if (req.method === 'DELETE' && key) {
        const decoded = decodeURIComponent(key);
        json(res, 200, service.waitingRemove(decoded));
        return;
      }
    }

    // ---- schedules ----
    if (seg === 'schedules') {
      const key = parts[2];
      if (req.method === 'GET' && !key) {
        json(res, 200, { items: service.schedulesList() });
        return;
      }
      if (req.method === 'POST' && !key) {
        const spec = await readBody(req);
        if (!spec || !spec.series || !spec.baseUrl) {
          json(res, 400, { error: 'series and baseUrl are required' });
          return;
        }
        json(res, 200, service.schedulesAdd(spec));
        return;
      }
      if (req.method === 'POST' && key === 'check') {
        json(res, 200, service.schedulesCheckNow());
        return;
      }
      if (req.method === 'DELETE' && key) {
        json(res, 200, service.schedulesRemove(decodeURIComponent(key)));
        return;
      }
    }

    // ---- settings ----
    if (seg === 'settings') {
      if (req.method === 'GET') {
        // Async: includes a live Cloudflare-solver reachability probe.
        json(res, 200, await service.settingsGetAsync());
        return;
      }
      if (req.method === 'PUT') {
        json(res, 200, service.settingsPut(await readBody(req)));
        return;
      }
    }

    // ---- library check (Part 6) ----
    if (req.method === 'POST' && seg === 'library' && parts[2] === 'check') {
      json(res, 200, await service.libraryCheck(await readBody(req)));
      return;
    }

    // ---- library report (dry-run: recognize vs. on-disk) ----
    if (req.method === 'POST' && seg === 'library' && parts[2] === 'report') {
      json(res, 200, await service.libraryReport(await readBody(req)));
      return;
    }

    // ---- library drives verify (Part 5 safety net) ----
    if (req.method === 'POST' && seg === 'library' && parts[2] === 'verify') {
      json(res, 200, await service.verifyDrives(await readBody(req)));
      return;
    }

    json(res, 404, { error: `no such endpoint: ${req.method} ${u.pathname}` });
  } catch (err) {
    fail(res, err);
  }
}

let server = null;

function start() {
  return new Promise((resolve, reject) => {
    const c = engineconfig.get();
    server = http.createServer((req, res) => {
      let u;
      try {
        u = new URL(req.url, 'http://localhost');
      } catch (e) {
        json(res, 400, { error: 'bad URL' });
        return;
      }
      if (!authorized(req)) {
        json(res, 401, { error: 'unauthorized - send Authorization: Bearer <api key>' });
        return;
      }
      handle(req, res, u);
    });
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`engine API port ${c.port} is already in use`));
      } else {
        reject(e);
      }
    });
    server.listen(c.port, c.bind, () => {
      const addr = server.address();
      console.log(`[engine] API listening on ${addr.address}:${addr.port}`);
      resolve({ port: addr.port });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

module.exports = { start, stop };
