'use strict';

// Shared factory for the throwaway windows discovery loads pages in. Lives in its
// own module so bulk.js and dubselect.js can both create one without requiring
// each other.

const path = require('path');
const { BrowserWindow, screen, session, webContents } = require('electron');
const config = require('./config');

// Every discovery window, keyed by the webContents id of the window that owns the
// discovery run. A run may open extra windows (a provider's player opened as its
// own page), and only that run may tear them down - destroying another run's
// windows aborts a healthy episode with "Object has been destroyed".
const owned = new Map();
const live = new Set();
const ownerPartitions = new Map();

function partitionForOwner(ownerId) {
  if (ownerId && ownerPartitions.has(ownerId)) return ownerPartitions.get(ownerId);
  const name = `persist:wvd-${ownerId || Date.now()}`;
  if (ownerId) ownerPartitions.set(ownerId, name);
  return name;
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
    cloakForPlayback(child);
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

function createDiscoverWindow(ownerId = null) {
  cloakAll();
  const linux = process.platform === 'linux';
  const park = linux ? linuxParkOrigin() : { x: -32000, y: -32000 };
  // The catalog page on Windows must use the visible browser's session.
  // A fresh partition has no Cloudflare clearance and sits on "Just a moment…".
  // Player windows (ownerId set) still get a private partition so Vidfast
  // one-shot tokens are not shared between episodes.
  let partition;
  if (!linux && !ownerId) {
    partition = config.sessionPartition;
  } else if (ownerId) {
    partition = partitionForOwner(ownerId);
  } else {
    partition = `persist:wvd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
    ...(linux ? { type: 'toolbar' } : {}),
    webPreferences: playerPrefs(partition)
  });
  const owner = ownerId || win.webContents.id;
  if (!ownerId && partition !== config.sessionPartition) ownerPartitions.set(owner, partition);
  track(win, owner);
  try {
    win.webContents.setBackgroundThrottling(false);
  } catch (e) {
    // ignore
  }
  attachOpenHandler(win, owner, partition);
  win._wvdPartition = partition;
  win._wvdReady = seedSharedCookies(partition);
  try {
    win.showInactive();
  } catch (e) {
    // ignore
  }
  // Catalog pages stay off-screen. Player windows call cloakForPlayback so
  // HLS.js keeps decoding on Windows the same way it does on Linux.
  cloak(win);
  return win;
}

// A brand-new partition has no Cloudflare clearance, so SFlix sits on
// "Just a moment…" and discovery sees no server tabs. Copy the visible
// browser's cookies across, but not token-CDN cookies — those are one-shot
// and must stay inside the episode that earned them.
const TOKEN_COOKIE_RE =
  /vidfast|peakstorm|ashencloud|ashenlion|orbitnorth|hiddenmesa|solidbear|primecomet|calmcanvas|nobleember|plainorbit|nobletrail|rapidtree|metaldisk|thunderpencil|pearlmaple|novaoak|lightgrove|peakbadger|videm|vidapi/i;

async function seedSharedCookies(partition) {
  if (!partition || partition === config.sessionPartition) return;
  let cookies = [];
  try {
    cookies = await session.fromPartition(config.sessionPartition).cookies.get({});
  } catch (e) {
    return;
  }
  const to = session.fromPartition(partition);
  for (const c of cookies) {
    const domain = String(c.domain || '');
    if (!domain || TOKEN_COOKIE_RE.test(domain)) continue;
    const host = domain.replace(/^\./, '');
    const details = {
      url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly
    };
    if (c.domain && !String(c.name || '').startsWith('__Host-')) details.domain = c.domain;
    if (c.expirationDate) details.expirationDate = c.expirationDate;
    if (c.sameSite && c.sameSite !== 'unspecified') details.sameSite = c.sameSite;
    try {
      await to.cookies.set(details);
    } catch (e) {
      // ignore cookies Chromium will not accept on this partition
    }
  }
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
  seedSharedCookies
};
