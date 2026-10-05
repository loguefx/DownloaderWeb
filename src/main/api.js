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
//   GET    /api/search?q=&type=             (stub - site search adapters land later)
//   POST   /api/jobs                        queue a movie / series / episodes
//   GET    /api/queue                       queue snapshot + counts
//   GET    /api/events                      Server-Sent Events live updates
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
//   POST   /api/library/verify              verify library drives (mount + write round-trip)

const http = require('http');
const { URL } = require('url');
const config = require('./config');
const vpn = require('./vpn');
const manager = require('./queue');
const service = require('./service');
const engineconfig = require('./engineconfig');

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
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : '',
      overview: (r.overview || '').slice(0, 120)
    }));
}

async function tmdbInfo(tmdbId, type) {
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
  // Fetch IMDB id (not in the main /tv response)
  let imdb = '';
  try {
    const ext = await tmdbFetch(`/tv/${tmdbId}/external_ids`, key);
    imdb = String((ext && ext.imdb_id) || '');
  } catch (e) { /* optional */ }

  return {
    tmdb: String(body.id),
    imdb,
    title: body.name || '',
    year: String(body.first_air_date || '').slice(0, 4),
    type: 'tv',
    poster: body.poster_path ? `https://image.tmdb.org/t/p/w342${body.poster_path}` : '',
    overview: (body.overview || '').slice(0, 300),
    seasons
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

    // ---- TMDB info (seasons/episodes for a title) ----
    if (req.method === 'GET' && seg === 'tmdb' && parts[2] === 'info') {
      const tmdb = u.searchParams.get('tmdb') || '';
      const type = (u.searchParams.get('type') || 'tv').trim(); // tv | movie
      if (!tmdb) {
        json(res, 400, { error: 'tmdb id is required' });
        return;
      }
      const info = await tmdbInfo(tmdb, type);
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
        json(res, 200, service.settingsGet());
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
