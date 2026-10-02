'use strict';

// Shared factory for the throwaway windows discovery loads pages in. Lives in its
// own module so bulk.js and dubselect.js can both create one without requiring
// each other.

const path = require('path');
const { BrowserWindow, screen, session, webContents } = require('electron');
const config = require('./config');
const cfsolve = require('./cfsolve');

// Every discovery window, keyed by the webContents id of the window that owns the
// discovery run. A run may open extra windows (a provider's player opened as its
// own page), and only that run may tear them down - destroying another run's
// windows aborts a healthy episode with "Object has been destroyed".
const owned = new Map();
const live = new Set();
const ownerPartitions = new Map();

// Episode pages use the main app session so one Cloudflare clearance — from
// the in-app browser or from a single on-screen check — covers the queue.
// Player windows must not use it: Vidfast's one-shot tokens break when several
// episodes share a jar.

// Token CDNs bind one-shot edge tokens to the session that fetched the
// playlist. Two episodes sharing that jar spend each other's tokens, so these
// hosts keep a unique partition per owner (the old behavior). Everyone else is
// safe to share — and sharing is what lets a Cloudflare clearance won on one
// player page be reused by every later player page on the same host.
const TOKEN_CDN_HOSTS =
  /vidfast|peakstorm|soap2day|netocdn|nontongo|vidspark|zenoak|whysosigmabro|ashencloud|ashenlion|orbitnorth|primecomet|calmcanvas|nobleember/i;

function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    return new URL(s, 'https://localhost/').host;
  } catch (e) {
    return '';
  }
}

function playerPartition(ownerId, embedUrl = '') {
  const host = hostOf(embedUrl);
  if (host && TOKEN_CDN_HOSTS.test(host)) {
    if (ownerId && ownerPartitions.has(ownerId)) return ownerPartitions.get(ownerId);
    const name = `persist:wvd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    if (ownerId) ownerPartitions.set(ownerId, name);
    return name;
  }
  // Per-host shared jar. cf_clearance is host-scoped, so one passed challenge
  // (or clearance inherited from the main session) covers all later episodes
  // on that host for its ~15-minute life, instead of re-challenging every time.
  return `persist:wvd-player-${host || 'shared'}`;
}

// If the main app session already cleared Cloudflare for this host (the user
// browsed it, or the episode page passed), give the player partition the same
// host-scoped cookies before its first request. The player page then often
// never sees a challenge at all. Token-CDN hosts are excluded: their session
// cookies are one-shot tokens and must stay in the unique jar.
async function seedPlayerCookies(partition, host) {
  if (!host) return;
  try {
    const src = session.fromPartition(config.sessionPartition);
    const dest = session.fromPartition(partition);
    const cookies = await src.cookies.get({});
    const bare = host.replace(/^www\./, '');
    for (const c of cookies) {
      const d = (c.domain || '').replace(/^\./, '');
      if (!d || (d !== bare && !bare.endsWith('.' + d))) continue;
      try {
        await dest.cookies.set({
          url: `https://${host}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
          sameSite: 'lax'
        });
      } catch (e) {
        // ignore one bad cookie
      }
    }
  } catch (e) {
    // ignore — the challenge path still works
  }
}

function playerPrefs(partition) {
  return {
    partition: partition || config.sessionPartition,
    backgroundThrottling: false,
    sandbox: false,
    contextIsolation: false,
    preload: path.join(__dirname, 'player-hook-preload.js')
  };
}

function mainBrowserWindow() {
  return (
    BrowserWindow.getAllWindows().find((w) => {
      if (w.isDestroyed()) return false;
      if (live.has(w)) return false;
      const b = w.getBounds();
      return b.width >= 800 && b.height >= 500;
    }) || null
  );
}

function linuxParkOrigin() {
  try {
    const d = screen.getPrimaryDisplay();
    const b = d.bounds || d.workArea;
    return { x: b.x, y: b.y + b.height + 80 };
  } catch (e) {
    return { x: 0, y: 4000 };
  }
}

// Keep the player mapped so Chromium will fetch/decode, but never as a normal
// on-screen window. Windows stays at -32000. Linux parks just below the
// monitor: XWayland still maps that, unlike -32000, without alt-tab popups.
function cloak(win) {
  if (!win || win.isDestroyed()) return;
  const linux = process.platform === 'linux';
  try {
    win.setSkipTaskbar(true);
  } catch (e) {
    // ignore
  }
  try {
    win.setFocusable(false);
  } catch (e) {
    // ignore
  }
  try {
    win.setMenuBarVisibility(false);
  } catch (e) {
    // ignore
  }
  try {
    win.setAlwaysOnTop(false);
  } catch (e) {
    // ignore
  }
  if (linux) {
    const { x, y } = linuxParkOrigin();
    try {
      win.setBounds({ x, y, width: 1280, height: 720 });
    } catch (e) {
      // ignore
    }
    try {
      win.setIgnoreMouseEvents(true, { forward: true });
    } catch (e) {
      // ignore
    }
  } else {
    try {
      win.setPosition(-32000, -32000);
    } catch (e) {
      // ignore
    }
  }
}

// Capture needs Chromium to actually play the video (parked-below-monitor
// windows stop decoding, so HLS.js only buffers ~7% then stalls). Keep a
// 1-cell mapped window on the real display, click-through and nearly
// transparent — not reveal(), which shows a full player the user cannot close.
function cloakForPlayback(win, size = null) {
  cloak(win);
  if (!win || win.isDestroyed()) return;
  try {
    win._wvdPlayback = true;
  } catch (e) {
    // ignore
  }
  if (process.platform !== 'linux') return;
  try {
    const wc = win.webContents;
    if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(false);
  } catch (e) {
    // ignore
  }
  try {
    win.setOpacity(0.01);
  } catch (e) {
    // ignore
  }
  try {
    const d = screen.getPrimaryDisplay();
    const b = d.workArea || d.bounds;
    // Window size does not influence the rendition here: measured identical
    // per-episode results with an 8x8 and a 1920x1080 playback window, so keep
    // the small one-cell park.
    const width = Math.max(8, (size && size.width) || 8);
    const height = Math.max(8, (size && size.height) || 8);
    win.setBounds({
      x: Math.max(b.x, b.x + (b.width || 1280) - width),
      y: Math.max(b.y, b.y + (b.height || 720) - height),
      width,
      height
    });
  } catch (e) {
    // ignore
  }
  try {
    win.setIgnoreMouseEvents(true, { forward: true });
  } catch (e) {
    // ignore
  }
  try {
    win.setSkipTaskbar(true);
  } catch (e) {
    // ignore
  }
  try {
    win.setFocusable(false);
  } catch (e) {
    // ignore
  }
  try {
    win.setTitle(' ');
  } catch (e) {
    // ignore
  }
  try {
    win.showInactive();
  } catch (e) {
    // ignore
  }
}

// Bring a parked Linux player on-screen so Chromium will actually decode.
function reveal(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setIgnoreMouseEvents(false);
  } catch (e) {
    // ignore
  }
  try {
    win.setFocusable(false);
  } catch (e) {
    // ignore
  }
  try {
    win.setBounds({ x: 60, y: 60, width: 1280, height: 720 });
  } catch (e) {
    // ignore
  }
  try {
    win.showInactive();
  } catch (e) {
    // ignore
  }
  try {
    const wc = win.webContents;
    if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(false);
  } catch (e) {
    // ignore
  }
}

function track(win, owner) {
  if (!owned.has(owner)) owned.set(owner, new Set());
  owned.get(owner).add(win);
  live.add(win);
  win.on('closed', () => {
    live.delete(win);
    const set = owned.get(owner);
    if (set) {
      set.delete(win);
      if (!set.size) owned.delete(owner);
    }
  });
}

function attachOpenHandler(win, owner, partition) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        skipTaskbar: true,
        focusable: false,
        autoHideMenuBar: true,
        width: 1280,
        height: 720,
        webPreferences: playerPrefs(partition)
      }
    }));
  } catch (e) {
    // ignore
  }
  win.webContents.on('did-create-window', (child) => {
    if (!child || child.isDestroyed()) return;
    track(child, owner);
    try {
      child.webContents.setBackgroundThrottling(false);
    } catch (e) {
      // ignore
    }
    try {
      child.webContents.setMaxListeners(60);
    } catch (e) {
      // ignore
    }
    if (process.platform === 'linux') cloakForPlayback(child);
    else cloak(child);
    attachOpenHandler(child, owner, partition);
  });
}

// Discovery windows must never steal the UI: several run at once and they load
// autoplaying players. On Windows they are parked far off-screen; Chromium still
// decodes because CalculateNativeWinOcclusion is disabled.
function cloakAll() {
  for (const w of [...live]) {
    if (w && w._wvdPlayback) continue;
    cloak(w);
  }
}

function createDiscoverWindow(ownerId = null, hostHint = '') {
  cloakAll();
  const linux = process.platform === 'linux';
  const park = linux ? linuxParkOrigin() : { x: -32000, y: -32000 };
  // A numeric owner is a player popup for an episode already being discovered.
  // Everything else (the episode page, a season scan) is a site document.
  const player = typeof ownerId === 'number';
  let partition = config.sessionPartition;
  if (linux && player) {
    partition = playerPartition(ownerId, hostHint);
    const host = hostOf(hostHint);
    if (host && !TOKEN_CDN_HOSTS.test(host)) seedPlayerCookies(partition, host);
  }
  try {
    require('./sniffer').attachSession(session.fromPartition(partition));
  } catch (e) {
    // ignore
  }
  const win = new BrowserWindow({
    show: false,
    x: park.x,
    y: park.y,
    width: 1280,
    height: 720,
    skipTaskbar: true,
    focusable: false,
    autoHideMenuBar: true,
    paintWhenInitiallyHidden: true,
    // Toolbar popups never finish Turnstile. Only player windows use that type;
    // the episode page is a normal window so the check can clear.
    ...(linux && player ? { type: 'toolbar' } : {}),
    webPreferences: playerPrefs(partition)
  });
  const owner = ownerId || win.webContents.id;
  track(win, owner);
  try {
    win.webContents.setBackgroundThrottling(false);
  } catch (e) {
    // ignore
  }
  try {
    // Each in-flight loadURL() attaches its own did-stop-loading listener and
    // drops it when the promise settles. A player kept open for a 30-minute
    // capture leaves that load pending, so trying several servers crosses
    // Node's default limit of 10 and prints MaxListenersExceededWarning.
    // The listeners are released, so raise the cap rather than log the noise.
    win.webContents.setMaxListeners(60);
  } catch (e) {
    // ignore
  }
  attachOpenHandler(win, owner, partition);
  try {
    win.showInactive();
  } catch (e) {
    // ignore
  }
  cloak(win);
  return win;
}

// All webContents belonging to the same discovery run as `webContentsId`,
// including player popups the embed opened with window.open.
function idsSharingOwner(webContentsId) {
  const ids = new Set();
  if (webContentsId == null) return ids;
  let probeWin = null;
  try {
    const wc = webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed() && typeof wc.getOwnerBrowserWindow === 'function') {
      probeWin = wc.getOwnerBrowserWindow();
    }
  } catch (e) {
    // ignore
  }
  let group = null;
  for (const set of owned.values()) {
    if (probeWin && set.has(probeWin)) {
      group = set;
      break;
    }
    for (const w of set) {
      if (!w || w.isDestroyed()) continue;
      try {
        if (w.webContents && !w.webContents.isDestroyed() && w.webContents.id === webContentsId) {
          group = set;
          break;
        }
      } catch (e) {
        // ignore
      }
    }
    if (group) break;
  }
  if (!group) return ids;
  for (const w of group) {
    if (!w || w.isDestroyed()) continue;
    try {
      if (w.webContents && !w.webContents.isDestroyed()) ids.add(w.webContents.id);
    } catch (e) {
      // ignore
    }
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc || wc.isDestroyed()) continue;
        try {
          if (typeof wc.getOwnerBrowserWindow === 'function' && wc.getOwnerBrowserWindow() === w) {
            ids.add(wc.id);
          }
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return ids;
}

// Closes every discovery / player popup. Used when a run is stopped so a
// leftover always-on-top window cannot sit on the app with no working close
// button (those windows are created focusable:false).
function destroyAll() {
  for (const w of [...live]) {
    try {
      if (w && !w.isDestroyed()) w.destroy();
    } catch (e) {
      // ignore
    }
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function isChallenge(wc) {
  if (!wc || wc.isDestroyed()) return false;
  let title = '';
  try {
    title = wc.getTitle() || '';
  } catch (e) {
    // ignore
  }
  if (/just a moment|attention required/i.test(title)) return true;
  // A real episode title means the interstitial is gone, even if the eval races
  // a navigation or the HTML still mentions Cloudflare.
  if (title && !/cloudflare/i.test(title)) return false;
  try {
    return !!(await wc.executeJavaScript(
      `(() => {
        const pageTitle = document.title || '';
        if (pageTitle && !/just a moment|attention required/i.test(pageTitle)) return false;
        const html = (document.documentElement && document.documentElement.innerHTML) || '';
        return /cf-turnstile|challenge-platform|cdn-cgi\\/challenge|__cf_chl/i.test(html);
      })()`,
      true
    ));
  } catch (e) {
    // Navigation between the interstitial and the real page rejects the eval.
    return true;
  }
}

// "Sorry, you have been blocked" is a hard block, not a challenge. Waiting
// (even the full 5 minutes) can never turn it into a pass, so callers skip
// the page immediately instead of parking a window on the user's screen.
async function isHardBlock(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    return !!(await wc.executeJavaScript(
      `(() => {
        const body = document.body ? document.body.innerText : '';
        const t = ((document.title || '') + ' ' + body).slice(0, 600);
        if (/sorry,? you (?:have been|are) blocked|you are unable to access|access to this (?:site|page) has been denied|access denied|request blocked/i.test(t)) return true;
        const html = (document.documentElement && document.documentElement.innerHTML || '').slice(0, 6000);
        if (/cf-error/i.test(html) && /error 10(15|16|20|28|32|40)|blocked|denied|unavailable|too many/i.test(html)) return true;
        return false;
      })()`,
      true
    ));
  } catch (e) {
    return false;
  }
}

// Turnstile does not finish in a window parked below the monitor. Bring it
// on screen until the episode document replaces "Just a moment...".
function presentChallenge(win) {
  reveal(win);
  if (!win || win.isDestroyed()) return;
  try {
    win.setFocusable(true);
  } catch (e) {
    // ignore
  }
  try {
    win.setIgnoreMouseEvents(false);
  } catch (e) {
    // ignore
  }
  try {
    win.setTitle('Cloudflare check');
  } catch (e) {
    // ignore
  }
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
  } catch (e) {
    // ignore
  }
  try {
    win.show();
  } catch (e) {
    // ignore
  }
  try {
    win.focus();
  } catch (e) {
    // ignore
  }
}

// Turnstile does not finish in a window parked below the monitor. Hold the
// episode window on screen until "Just a moment..." is replaced by the page.
// The clearance is stored in the main app session, so later episodes skip it.
async function passCloudflare(win, _pageUrl, onLog = () => {}) {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!(await isChallenge(wc))) return true;
  if (await isHardBlock(wc)) {
    onLog('Cloudflare hard-blocked this page; skipping it without waiting.');
    return false;
  }
  // First try the optional solver: it clears the challenge in its own
  // browser and hands us the cookies, so no on-screen click is needed.
  if (cfsolve.enabled()) {
    if (await cfsolve.trySolver(pageUrl, wc, onLog)) {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        await delay(1000);
        if (win.isDestroyed() || wc.isDestroyed()) return false;
        if (!(await isChallenge(wc))) {
          onLog('Cloudflare check cleared (solver).');
          return true;
        }
      }
    }
  }
  onLog(
    'Cloudflare check is blocking the page. Leaving the window on screen until it clears. Click the checkbox if one is showing.'
  );
  presentChallenge(win);
  // The interstitial usually starts while the window is parked off-screen, and
  // that attempt never finishes. Reload once it is visible so Turnstile runs again.
  let reloads = 0;
  const doReload = () => {
    if (reloads >= 2) return;
    reloads += 1;
    try {
      wc.reload();
    } catch (e) {
      // ignore
    }
  };
  doReload();
  // A human clicking the checkbox can take a while (they may be reading the
  // episode log or stepping away). 90s made episodes die with
  // "Cloudflare check did not clear" while the user was still about to click.
  // Wait up to five minutes; the periodic log also keeps the discovery stall
  // watchdog in bulk.js happy while we sit here.
  const deadline = Date.now() + 300000;
  let nextReload = Date.now() + 30000;
  let lastLog = Date.now();
  while (Date.now() < deadline) {
    await delay(1000);
    if (win.isDestroyed() || wc.isDestroyed()) return false;
    if (!(await isChallenge(wc))) {
      await delay(600);
      if (!(await isChallenge(wc))) break;
    } else {
      if (Date.now() >= nextReload) {
        nextReload = Date.now() + 30000;
        onLog('Still on the Cloudflare check; reloading the challenge once more...');
        doReload();
      } else if (Date.now() - lastLog > 8000) {
        lastLog = Date.now();
        onLog('Still waiting for the Cloudflare check to finish...');
      }
    }
  }
  const ok = !win.isDestroyed() && !wc.isDestroyed() && !(await isChallenge(wc));
  onLog(
    ok
      ? 'Cloudflare check cleared.'
      : 'Cloudflare check did not clear, so the episode page never loaded.'
  );
  cloak(win);
  return ok;
}

// Tears down the windows belonging to one discovery run only.
function destroyOwned(ownerId) {
  const set = owned.get(ownerId);
  if (!set) return;
  for (const w of [...set]) {
    try {
      if (w && !w.isDestroyed()) w.destroy();
    } catch (e) {
      // ignore
    }
  }
  owned.delete(ownerId);
}

module.exports = {
  createDiscoverWindow,
  mainBrowserWindow,
  destroyOwned,
  destroyAll,
  idsSharingOwner,
  cloak,
  cloakAll,
  cloakForPlayback,
  reveal,
  passCloudflare,
  presentChallenge
};
