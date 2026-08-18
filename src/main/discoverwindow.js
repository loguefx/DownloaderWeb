'use strict';

// Shared factory for the throwaway windows discovery loads pages in. Lives in its
// own module so bulk.js and dubselect.js can both create one without requiring
// each other.

const { BrowserWindow } = require('electron');
const config = require('./config');

// Every discovery window, keyed by the webContents id of the window that owns the
// discovery run. A run may open extra windows (a provider's player opened as its
// own page), and only that run may tear them down - destroying another run's
// windows aborts a healthy episode with "Object has been destroyed".
const owned = new Map();
const live = new Set();

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

// Discovery windows must never be visible: several run at once and they load
// autoplaying players, so on-screen they behave like popups over the app.
// They're parked far off-screen instead of hidden, because a window that was
// never shown doesn't always start playback. Native occlusion is disabled in
// main.js (CalculateNativeWinOcclusion), so off-screen windows keep decoding.
function createDiscoverWindow(ownerId = null) {
  const win = new BrowserWindow({
    show: false,
    x: -32000,
    y: -32000,
    width: 1280,
    height: 720,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: config.sessionPartition,
      backgroundThrottling: false,
      sandbox: false
    }
  });
  const owner = ownerId || win.webContents.id;
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
  try {
    win.webContents.setBackgroundThrottling(false);
  } catch (e) {
    // ignore
  }
  try {
    win.showInactive();
  } catch (e) {
    // ignore
  }
  return win;
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

module.exports = { createDiscoverWindow, mainBrowserWindow, destroyOwned };
