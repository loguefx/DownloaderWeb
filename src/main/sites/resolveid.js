'use strict';

// Title -> TMDB/IMDB id resolver for the id-keyed CF-free sources (Vidsrc,
// NontonGo).
//
// Why this exists: TV shows and movies get their TMDB/IMDB id out of the
// source page's markup, so the cross-site walker in bulk.js can hand them to
// the CF-free Vidsrc primary (fallbackRank 0) and get 1080p with no
// Cloudflare checkbox. Anime catalogs (aniwaves.ru / enma.lol / 9anime)
// carry NO TMDB/IMDB id - they use their own id schemes - so anime could
// never reach that CF-free primary and fell through to the one
// Cloudflare-gated site in the pool (FMovies/movienow). This module closes
// the gap: it resolves an anime title to a TMDB/IMDB id from a real catalog
// and remembers it in findtitle's shared id cache, so Vidsrc/NontonGo find
// it and anime flows through the SAME CF-free 1080p path as TV/movies.
//
// Sources, tried in order (first hit wins, all are best-effort):
//   1. findtitle media-id cache (id already seen on a page this session)
//   2. the Jellyfin catalog (engineconfig.jellyfin.baseUrl + apiKey) - the
//      place we download to; its items already carry ProviderIds.Tmdb/Imdb
//   3. the TMDB API (optional key: env TMDB_API_KEY or engineconfig.tmdbApiKey)
//
// Every source returns { tmdb, imdb } (either may be ''). Nothing here throws
// to the caller: a title it cannot resolve yields { tmdb:'', imdb:'' } and the
// walker simply continues with the existing (pre-fix) behavior.

const engineconfig = require('../engineconfig');
const findtitle = require('./findtitle');

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// fetch() + AbortController, JSON or null on any failure. Node 18+ (global
// fetch); works for both http (LAN Jellyfin) and https.
async function httpJson(url, headers = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// 2) Jellyfin catalog search. Prefer series/season/episode items (anime land
// there) and read ProviderIds.Tmdb / ProviderIds.Imdb (Jellyfin's key names).
async function fromJellyfin(title, onLog) {
  const j = (engineconfig.get() || {}).jellyfin || {};
  const base = String(j.baseUrl || '').trim().replace(/\/+$/, '');
  const key = String(j.apiKey || '').trim();
  if (!base || !key) return { tmdb: '', imdb: '' };
  const url = `${base}/api/search?searchTerm=${encodeURIComponent(title)}&limit=25`;
  const body = await httpJson(url, { 'X-Emby-Token': key, Accept: 'application/json' });
  const items = (body && body.Items) || [];
  const score = (it) =>
    it && (it.Type === 'Series' ? 3 : it.Type === 'Season' ? 2 : it.Type === 'Episode' ? 2 : it.Type === 'Movie' ? 1 : 0);
  let best = null;
  let bestScore = -1;
  for (const it of items) {
    const p = (it && it.ProviderIds) || {};
    const tmdb = String(p.Tmdb || p.TmdbId || '').trim();
    const imdb = String(p.Imdb || p.ImdbId || '').trim();
    if (!tmdb && !imdb) continue;
    const s = score(it);
    if (s > bestScore) {
      bestScore = s;
      best = { tmdb, imdb };
    }
  }
  if (best) onLog(`ID from Jellyfin catalog: tmdb=${best.tmdb || 'n/a'} imdb=${best.imdb || 'n/a'}`);
  else onLog('Jellyfin catalog has the title but no TMDB/IMDB id on it.');
  return best || { tmdb: '', imdb: '' };
}

// 3) TMDB multi search (optional key). Anime are 'tv' on TMDB; pick the first
// tv hit, else the first movie hit. Returns a TMDB id (no imdb from this call).
async function fromTmdb(title, onLog) {
  const c = engineconfig.get() || {};
  const key = String(process.env.TMDB_API_KEY || c.tmdbApiKey || '').trim();
  if (!key) return { tmdb: '', imdb: '' };
  // Send the key BOTH ways: legacy v3 keys want ?api_key=, v4 read tokens
  // want a Bearer header. Including both is harmless and covers either kind.
  const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(title)}&include_adult=false&api_key=${encodeURIComponent(key)}`;
  const body = await httpJson(url, { Authorization: `Bearer ${key}`, Accept: 'application/json' });
  const results = (body && body.results) || [];
  let tv = null;
  let movie = null;
  for (const r of results) {
    if (!r || !r.id) continue;
    if (r.media_type === 'tv' && !tv) tv = r;
    else if (r.media_type === 'movie' && !movie) movie = r;
  }
  const pick = tv || movie;
  if (pick) {
    onLog(`ID from TMDB: ${pick.title || pick.name} (tmdb=${pick.id}, ${pick.media_type})`);
    return { tmdb: String(pick.id), imdb: '' };
  }
  onLog('TMDB had no match for the title.');
  return { tmdb: '', imdb: '' };
}

/**
 * Resolve a title to { tmdb, imdb } and remember it in the shared cache so the
 * id-keyed CF-free adapters (Vidsrc/NontonGo) can use it. Never throws.
 *
 * @param {string} title
 * @param {function} onLog
 * @returns {Promise<{tmdb:string, imdb:string}>}
 */
async function resolveMediaId(title, onLog = () => {}) {
  const clean = String(title || '').trim();
  if (!clean || normTitle(clean).length < 3) return { tmdb: '', imdb: '' };

  // 1) Already known from this session?
  const known = findtitle.lookupMediaId(clean) || {};
  if (known.tmdb || known.imdb) {
    onLog(`ID already known for "${clean}" (tmdb=${known.tmdb || 'n/a'} imdb=${known.imdb || 'n/a'}).`);
    return known;
  }

  let r = { tmdb: '', imdb: '' };
  try {
    r = (await fromJellyfin(clean, onLog)) || r;
  } catch (e) {
    onLog('Jellyfin id lookup failed: ' + ((e && e.message) || e));
  }
  if (!r.tmdb && !r.imdb) {
    try {
      r = (await fromTmdb(clean, onLog)) || r;
    } catch (e) {
      onLog('TMDB id lookup failed: ' + ((e && e.message) || e));
    }
  }

  if (r.tmdb) findtitle.rememberMediaId(clean, r.tmdb);
  if (r.imdb) findtitle.rememberMediaId(clean, r.imdb);
  if (!r.tmdb && !r.imdb) onLog('No TMDB/IMDB id found; continuing without the CF-free primary.');
  return { tmdb: r.tmdb || '', imdb: r.imdb || '' };
}

module.exports = { resolveMediaId };
