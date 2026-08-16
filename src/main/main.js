'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const config = require('./config');
const sniffer = require('./sniffer');
const vpn = require('./vpn');
const manager = require('./queue');
const bulk = require('./bulk');
const organizer = require('./organizer');
const sites = require('./sites');
const pending = require('./pending');
const schedule = require('./schedule');
const watcher = require('./watcher');

// Suppress noisy Chromium ERROR logs (e.g. WebRTC "Failed to resolve address
// for stun.cloudflare.com" - harmless when STUN/DNS is blocked by the VPN).
app.commandLine.appendSwitch('log-level', '3');

// Allow video to start without a user gesture. This is essential for the hidden
// bulk windows (no one clicks play there) AND fixes some players that otherwise
// refuse to begin in the visible browser.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Keep offscreen discovery windows from suspending media / timers.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Windows Chromium marks off-screen / covered windows as occluded and freezes
// their media pipeline. Bulk discovery uses an off-screen window, so without
// this, stream resolution never fires on Windows while the same code works on Linux.
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,ThirdPartyCookiePhaseout,TrackingProtection3pcd'
);

// A realistic Chrome User-Agent. Many video hosts/players serve a broken page or
// refuse to play when they see Electron's default UA. We derive the real bundled
// Chromium version so it looks like ordinary Chrome.
const CHROME_VERSION = (process.versions.chrome || '124.0.0.0');
const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
// Default UA for any webContents that does not override it.
app.userAgentFallback = CHROME_UA;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'WebVideoDownloader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.maximize();
  mainWindow.on('closed', () => (mainWindow = null));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function wireEvents() {
  sniffer.on('detected', (d) => send('sniffer:detected', d));
  vpn.on('status', (s) => send('vpn:status', s));
  manager.on('update', (items) => send('queue:update', items));
  manager.on('log', (msg) => send('queue:log', { ts: Date.now(), msg }));
  manager.on('stopped', (info) => send('queue:stopped', info));
  schedule.on('update', (items) => send('schedule:update', items));
}

function wireIpc() {
  ipcMain.handle('choose-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose download folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('default-download-dir', () => app.getPath('downloads'));

  ipcMain.handle('sniffer-list', (_e, webContentsId) => sniffer.list(webContentsId));

  ipcMain.handle('sniffer-clear', (_e, webContentsId) => {
    sniffer.clear(webContentsId);
    return true;
  });

  // Single (manual) download of an already-detected stream.
  ipcMain.handle('download-single', (_e, { detection, meta, outputRoot }) => {
    const label =
      (meta && (meta.series || meta.name)) +
      (meta && meta.episode ? ` - Episode ${meta.episode}` : '');
    // A direct download of an already-detected stream: it does NOT run the
    // sub/dub picker (the user already chose the server in the player), so log
    // what we're saving instead of leaving the Activity Log blank until done.
    send('queue:log', {
      ts: Date.now(),
      msg: `Direct download queued: ${label || 'video'} - ${(detection && detection.url) || 'detected stream'}`
    });
    manager.add({
      label: label || 'Manual download',
      series: (meta && (meta.series || meta.name)) || 'Video',
      season: meta && meta.season,
      episode: meta && meta.episode,
      outputRoot,
      discover: async () => detection
    });
    return true;
  });

  ipcMain.handle('bulk-start', (_e, { entries, outputRoot }) => {
    const onLog = (msg) => send('queue:log', { ts: Date.now(), msg });
    return bulk.startBatch(entries, outputRoot, onLog);
  });

  ipcMain.handle('queue-pause', () => manager.pause());
  ipcMain.handle('queue-resume', () => manager.resume());
  ipcMain.handle('queue-stop', () => manager.stopAll('Stopped by user'));
  ipcMain.handle('queue-remove', (_e, ids) => {
    manager.removeByIds(ids);
    return true;
  });
  ipcMain.handle('queue-clear', () => {
    manager.clearAll();
    return true;
  });
  ipcMain.handle('queue-snapshot', () => manager.snapshot());
  ipcMain.handle('vpn-status', () => ({ connected: vpn.isConnected() }));

  // Scheduled series (auto-pull new episodes weekly).
  ipcMain.handle('schedule-list', () => schedule.list());
  ipcMain.handle('schedule-add', (_e, spec) => {
    const { template, season } = bulk.entryTemplate({ baseUrl: spec.baseUrl, season: spec.season });
    return schedule.add({
      series: spec.series,
      season: season,
      mode: spec.mode || 'dub',
      template,
      baseUrl: spec.baseUrl,
      outputRoot: spec.outputRoot
    });
  });
  ipcMain.handle('schedule-remove', (_e, key) => {
    schedule.remove(key);
    return true;
  });
  ipcMain.handle('schedule-check', () => watcher.checkSchedules());
}

app.whenReady().then(() => {
  // Ensure the shared session exists and looks like normal Chrome to sites.
  const ses = session.fromPartition(config.sessionPartition);
  ses.setUserAgent(CHROME_UA);
  // Some players probe Client Hints; keep them consistent with the UA.
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['User-Agent'] = CHROME_UA;
    cb({ requestHeaders: details.requestHeaders });
  });
  sites.init(app.getPath('userData'));
  pending.load();
  schedule.load();
  sniffer.attach();
  vpn.start();
  wireEvents();
  wireIpc();
  createWindow();

  const onLog = (msg) => send('queue:log', { ts: Date.now(), msg });

  // Resume any downloads that were still in flight when the app last closed.
  // We rebuild each item's live discover()/onUnavailable() here (main can see
  // bulk/pending, avoiding a circular require inside the queue module).
  manager.restore((rec) => {
    const meta = { series: rec.series, season: rec.season, episode: rec.episode };
    try {
      const expected = organizer.expectedPath(rec.outputRoot, meta, '.mp4');
      if (expected && fs.existsSync(expected)) return { skip: true };
    } catch (e) {
      // fall through and re-queue
    }
    const spec = {
      label: rec.label,
      series: rec.series,
      season: rec.season,
      episode: rec.episode,
      outputRoot: rec.outputRoot,
      template: rec.template,
      baseUrl: rec.baseUrl,
      mode: rec.mode
    };
    return {
      discover: bulk.makeDiscover(rec.url, onLog, rec.mode),
      onUnavailable: () => pending.add(spec)
    };
  });

  // Start the daily watcher for pending dubbed episodes.
  watcher.start(onLog);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  vpn.stop();
  watcher.stop();
  if (process.platform !== 'darwin') app.quit();
});
