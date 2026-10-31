'use strict';

// Minimal Jellyfin REST client shared by the engine: catalog search (title ->
// TMDB/IMDB ids, plugin search fallback) and the per-folder library refresh
// after a file is placed.
//
// Auth uses the current scheme, `Authorization: MediaBrowser Token="<key>"`.
// The legacy X-Emby-Token / X-Emby-Authorization headers are disabled by
// default since Jellyfin 10.11, so requests sent with them were rejected.

const engineconfig = require('./engineconfig');

const CLIENT = 'WebVideoDownloader';

function settings() {
  const j = (engineconfig.get() || {}).jellyfin || {};
  return {
    base: String(j.baseUrl || '').trim().replace(/\/+$/, ''),
    key: String(j.apiKey || '').trim()
  };
}

function authHeader(key) {
  return `MediaBrowser Client="${CLIENT}", Device="engine", DeviceId="webvideodownloader-engine", Version="1", Token="${key}"`;
}

async function request(method, apiPath, { body, timeoutMs = 8000 } = {}) {
  const { base, key } = settings();
  if (!base || !key) return { ok: false, status: 0, body: null, reason: 'not-configured' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + apiPath, {
      method,
      signal: ctrl.signal,
      headers: Object.assign(
        { Authorization: authHeader(key), Accept: 'application/json' },
        body !== undefined ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (e) {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed, reason: res.ok ? '' : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, body: null, reason: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'network' };
  } finally {
    clearTimeout(t);
  }
}

// Catalog search. `types` is a list of Jellyfin item types (Series, Movie, ...).
// Returns the raw Items (with ProviderIds, ProductionYear, PremiereDate,
// ImageTags), or [] when Jellyfin is not configured / unreachable.
async function searchItems(term, types = ['Series', 'Movie'], limit = 25) {
  const q =
    `/Items?searchTerm=${encodeURIComponent(term)}&Recursive=true` +
    `&IncludeItemTypes=${encodeURIComponent(types.join(','))}` +
    `&Fields=ProviderIds,PremiereDate,ProductionYear&Limit=${limit}`;
  const r = await request('GET', q);
  return (r.ok && r.body && Array.isArray(r.body.Items)) ? r.body.Items : [];
}

// Tell Jellyfin a file was added so it scans just that folder.
// `jellyfinPath` must be the path as JELLYFIN sees it (see placer.toJellyfinPath).
async function notifyCreated(jellyfinPath) {
  return request('POST', '/Library/Media/Updated', {
    body: { Updates: [{ Path: jellyfinPath, UpdateType: 'Created' }] },
    timeoutMs: 15000
  });
}

module.exports = { settings, authHeader, request, searchItems, notifyCreated };
