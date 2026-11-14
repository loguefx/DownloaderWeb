'use strict';
// "Find more sources" (Overview > Sources): the engine tries TMDB-id embed
// players itself - from this PC and VPN, in its hidden browser, the same way
// a download would - and adds the ones that really deliver a stream as TV /
// movie fallback sources (a JSON profile in <userData>/sites; loaded at once).
//
// Each candidate is asked for one episode and one film:
//   1080p    a stream at 1080p came through
//   below 1080p  a stream came through, smaller (used by the 720p fallback)
//   none     no stream / page did not load / Cloudflare check
// Only "1080p" / "below 1080p" ones are added. The engine keeps score of how they do
// in real searches afterwards (sourcestats: one that stops delivering goes to
// the end of the line, then is left out).
//
// The candidate list is unverified - sites like these come and go; the test is
// what decides.

const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  { id: 'vidlink', name: 'VidLink', tv: 'https://vidlink.pro/tv/{tmdb}/{season}/{episode}', movie: 'https://vidlink.pro/movie/{tmdb}' },
  { id: 'vidsrccc', name: 'Vidsrc.cc', tv: 'https://vidsrc.cc/v2/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://vidsrc.cc/v2/embed/movie/{tmdb}' },
  { id: 'vidfast', name: 'VidFast', tv: 'https://vidfast.pro/tv/{tmdb}/{season}/{episode}', movie: 'https://vidfast.pro/movie/{tmdb}' },
  { id: 'videasy', name: 'Videasy', tv: 'https://player.videasy.net/tv/{tmdb}/{season}/{episode}', movie: 'https://player.videasy.net/movie/{tmdb}' },
  { id: 'embedsu', name: 'Embed.su', tv: 'https://embed.su/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://embed.su/embed/movie/{tmdb}' },
  { id: 'autoembed', name: 'AutoEmbed', tv: 'https://player.autoembed.cc/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://player.autoembed.cc/embed/movie/{tmdb}' },
  { id: 'twoembed', name: '2Embed', tv: 'https://www.2embed.cc/embedtv/{tmdb}&s={season}&e={episode}', movie: 'https://www.2embed.cc/embed/{tmdb}' },
  { id: 'vidsrcsu', name: 'Vidsrc.su', tv: 'https://vidsrc.su/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://vidsrc.su/embed/movie/{tmdb}' },
  { id: 'multiembed', name: 'MultiEmbed', tv: 'https://multiembed.mov/?video_id={tmdb}&tmdb=1&s={season}&e={episode}', movie: 'https://multiembed.mov/?video_id={tmdb}&tmdb=1' },
  { id: 'vidsrcrip', name: 'Vidsrc.rip', tv: 'https://vidsrc.rip/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://vidsrc.rip/embed/movie/{tmdb}' },
  { id: 'moviesapi', name: 'MoviesAPI', tv: 'https://moviesapi.club/tv/{tmdb}-{season}-{episode}', movie: 'https://moviesapi.club/movie/{tmdb}' }
];
const TEST_TV = { tmdb: '1396', season: 1, episode: 1, series: 'Breaking Bad' };
const TEST_MOVIE = { tmdb: '27205', series: 'Inception' };
const PER_TEST_MS = 120 * 1000;

const state = { running: false, at: 0, current: '', results: [], added: [] };

const fill = (tpl, r) => String(tpl).replace(/\{tmdb\}/g, r.tmdb).replace(/\{season\}/g, r.season).replace(/\{episode\}/g, r.episode);

// Injectable for tests: (url, ref) -> { status, reason, height }
let tryPage = async (url, ref, onLog) => {
  const bulk = require('./bulk');
  const controller = new AbortController();
  const item = { _controller: controller };
  const timer = setTimeout(() => controller.abort(), PER_TEST_MS);
  try {
    const discover = bulk.makeDiscover(url, onLog, 'dub', () => ({
      onlyThisPage: true,
      anime: false,
      minHeight: 1080,
      series: ref.series,
      season: ref.season != null ? ref.season : null,
      episode: ref.episode != null ? ref.episode : null,
      tmdb: ref.tmdb,
      skipSources: []
    }));
    const out = (await discover(item)) || { status: 'failed', reason: 'no answer' };
    const det = out.detection || null;
    if (det && typeof det.releaseDiscover === 'function') {
      try { det.releaseDiscover(); } catch (e) { /* ignore */ }
    }
    const m = String(out.reason || '').match(/(\d{3,4})p/);
    return {
      status: out.status,
      reason: out.reason || '',
      height: out.status === 'resolved' ? (det && det.height) || 1080 : m ? Number(m[1]) : 0
    };
  } catch (e) {
    return { status: 'failed', reason: (e && e.message) || String(e), height: 0 };
  } finally {
    clearTimeout(timer);
  }
};

function verdictOf(t) {
  if (!t) return 'none';
  if (t.status === 'resolved') return '1080p';
  // A stream came, below 1080p: "Relay stream is 720p, not 1080p" (relay
  // players) or "No 1080p stream on this site" (server buttons, each stream
  // measured and found smaller).
  if (/stream is \d+p, not \d+p|No \d+p stream on this site/i.test(t.reason)) return 'below 1080p';
  return 'none';
}

function userSitesDir() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'sites');
}

function install(c) {
  const dir = userSitesDir();
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `embed-${c.id}.json`);
  fs.writeFileSync(f, JSON.stringify({ id: `embed-${c.id}`, name: c.name, tmdbEmbed: { tv: c.tv, movie: c.movie }, addedBy: 'Find more sources' }, null, 2));
  return f;
}

function installed() {
  try {
    return fs.readdirSync(userSitesDir()).filter((f) => /^embed-.*\.json$/.test(f)).map((f) => f.replace(/^embed-|\.json$/g, ''));
  } catch (e) {
    return [];
  }
}

async function run({ onLog = () => {}, candidates = CANDIDATES, doInstall = true } = {}) {
  if (state.running) return status();
  Object.assign(state, { running: true, at: Date.now(), current: '', results: [], added: [] });
  (async () => {
    const have = new Set(installed());
    onLog(`Find more sources: testing ${candidates.length} TV/movie players from this PC (one episode and one film each, up to ~4 min per player).`);
    for (const c of candidates) {
      state.current = c.name;
      const log = (m) => onLog(`[${c.name}] ${m}`);
      const tv = await tryPage(fill(c.tv, TEST_TV), TEST_TV, log);
      const movie = await tryPage(fill(c.movie, TEST_MOVIE), TEST_MOVIE, log);
      const vt = verdictOf(tv);
      const vm = verdictOf(movie);
      const best = [vt, vm].includes('1080p') ? '1080p' : [vt, vm].includes('below 1080p') ? 'below 1080p' : 'none';
      const r = { id: c.id, name: c.name, tv: vt, movie: vm, best, tvReason: tv.reason, movieReason: movie.reason, installed: have.has(c.id) };
      if (best !== 'none' && doInstall && !have.has(c.id)) {
        try {
          install(c);
          r.installed = true;
          state.added.push(c.name);
        } catch (e) {
          r.installError = (e && e.message) || String(e);
        }
      }
      state.results.push(r);
      onLog(`Find more sources: ${c.name} - TV ${vt}, film ${vm}${r.installed ? ' (added as a source)' : ''}.`);
    }
    if (state.added.length) {
      // Load the new profiles now (no restart needed).
      try {
        const { app } = require('electron');
        require('./sites').init(app.getPath('userData'));
      } catch (e) { /* they load on the next start */ }
    }
    onLog(`Find more sources: done - ${state.added.length ? 'added ' + state.added.join(', ') : 'no new player delivered a stream'}.`);
  })().catch((e) => {
    onLog('Find more sources failed: ' + ((e && e.message) || e));
  }).finally(() => {
    state.running = false;
    state.current = '';
    state.at = Date.now();
  });
  return status();
}

function status() {
  return { running: state.running, at: state.at, current: state.current, results: state.results.slice(), added: state.added.slice(), installed: installed(), total: CANDIDATES.length };
}

module.exports = {
  run,
  status,
  CANDIDATES,
  verdictOf,
  _setForTests({ tryFn } = {}) {
    if (tryFn) tryPage = tryFn;
  }
};
