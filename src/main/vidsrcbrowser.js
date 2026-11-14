'use strict';
// Vidsrc's API token from a real browser, when reading it out of the player
// page's HTML no longer works ("player page has no apiToken (the site changed
// its page)"). The engine's hidden browser window opens the Vidsrc embed
// page like a viewer would; the player's own scripts obtain the token, and
// it is picked up two ways, whatever Vidsrc names or hides it as:
//   1. the token the player SENDS: api_token=... in any request it makes
//      (seen through the request sniffer);
//   2. a JWT ("eyJ...") in the page's globals or markup - in every frame.
// The token is bound to this IP (the same VPN connection the engine's own
// requests use), so it works for the headless API calls after.
//
// Electron only: registered by main.js (vidsrc_dl.setBrowserTokenProvider).

const vidsrcDl = require('./sites/vidsrc_dl');

// Runs inside a page: the first JWT whose payload carries an expiry.
const SCAN = `(() => {
  const isJwt = (v) => typeof v === 'string' && /^eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}$/.test(v);
  const ok = (v) => {
    if (!isJwt(v)) return false;
    try {
      const p = JSON.parse(atob(v.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return !!(p && (p.exp || p.ip));
    } catch (e) { return false; }
  };
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || depth > 3 || seen.has(o)) return '';
    seen.add(o);
    let keys = [];
    try { keys = Object.keys(o); } catch (e) { return ''; }
    for (const k of keys.slice(0, 400)) {
      let v;
      try { v = o[k]; } catch (e) { continue; }
      if (ok(v)) return v;
      if (v && typeof v === 'object' && !(v instanceof Node) && v !== window) {
        const r = walk(v, depth + 1);
        if (r) return r;
      }
    }
    return '';
  };
  for (const name of ['CONFIG', 'CFG', 'config', 'playerConfig', '__NEXT_DATA__']) {
    try { const r = walk(window[name], 0); if (r) return r; } catch (e) {}
  }
  try {
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const all = html.match(/eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}/g) || [];
    for (const v of all) if (ok(v)) return v;
  } catch (e) {}
  try { return walk(window, 0); } catch (e) { return ''; }
})()`;

const FAIL_PAUSE_MS = 5 * 60 * 1000;
let lastFailAt = 0;

async function browserApiToken(ref, { timeoutMs = 40000, onLog = () => {} } = {}) {
  if (Date.now() - lastFailAt < FAIL_PAUSE_MS) return '';
  const { createDiscoverWindow, destroyOwned } = require('./discoverwindow');
  const sniffer = require('./sniffer');
  const id = ref.imdb || ref.tmdb;
  if (!id) return '';
  const isTv = ref.type === 'tv';
  const url = `https://vidsrc.sh/embed/${isTv ? 'tv' : 'movie'}/${id}` + (isTv ? `-${ref.season}-${ref.episode}` : '');
  let win = null;
  let tok = '';
  const off = sniffer.addUrlTap((u) => {
    if (tok) return;
    const m = String(u).match(/[?&]api_token=([^&#]+)/);
    if (m && /^eyJ/.test(decodeURIComponent(m[1]))) tok = decodeURIComponent(m[1]);
  });
  try {
    win = createDiscoverWindow();
    win.loadURL(url).catch(() => {});
    const until = Date.now() + timeoutMs;
    while (!tok && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!win || win.isDestroyed()) break;
      let frames = [];
      try { frames = win.webContents.mainFrame.framesInSubtree || [win.webContents.mainFrame]; } catch (e) { frames = []; }
      for (const f of frames) {
        if (tok) break;
        try {
          const v = await Promise.race([f.executeJavaScript(SCAN, true), new Promise((r) => setTimeout(() => r(''), 3000))]);
          if (v) tok = String(v);
        } catch (e) { /* cross-origin frame not ready yet */ }
      }
    }
  } catch (e) {
    onLog(`Vidsrc: browser token fetch failed (${(e && e.message) || e}).`);
  } finally {
    off();
    try { if (win && !win.isDestroyed()) destroyOwned(win.webContents.id); } catch (e) { /* ignore */ }
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* ignore */ }
  }
  if (!tok) lastFailAt = Date.now();
  else onLog('Vidsrc: API token taken from the player in the browser (its page no longer shows it plainly).');
  return tok;
}

function register() {
  vidsrcDl.setBrowserTokenProvider(browserApiToken);
}

module.exports = { browserApiToken, register, SCAN };
