'use strict';

// Linux-only visible browser. Windows keeps <webview>.
//
// Electron <webview> on Wayland/AMD often paints a black rectangle. A
// WebContentsView is a real child of the window and does paint. It sits above
// the HTML, so it MUST be removed from the window (removeChildView) whenever
// the user leaves the Browser tab - otherwise Activity Log/Queue look blank.
// (BrowserView, used before, is deprecated since Electron 30.)

const { ipcMain, WebContentsView, webFrameMain } = require('electron');

// Back/forward through navigationHistory (webContents.canGoBack & co. are
// deprecated since Electron 32); the old calls remain as a fallback.
function nav(c) {
  const h = c && c.navigationHistory;
  return {
    canBack: () => (h && typeof h.canGoBack === 'function' ? h.canGoBack() : !!(c && c.canGoBack && c.canGoBack())),
    canFwd: () => (h && typeof h.canGoForward === 'function' ? h.canGoForward() : !!(c && c.canGoForward && c.canGoForward())),
    back: () => (h && typeof h.goBack === 'function' ? h.goBack() : c.goBack()),
    fwd: () => (h && typeof h.goForward === 'function' ? h.goForward() : c.goForward())
  };
}
const config = require('./config');
const sniffer = require('./sniffer');

const MEDIA_HOOK = `(() => {
  if (window.__wvdMediaHook) return true;
  window.__wvdMediaHook = true;
  const report = (el, ev) => {
    const err = el.error ? (el.error.code + ':' + (el.error.message || '')) : '';
    console.warn(
      '[wvd-media]',
      ev,
      String(el.currentSrc || el.src || '').slice(0, 180),
      'rs=' + el.readyState,
      'net=' + el.networkState,
      'wh=' + el.videoWidth + 'x' + el.videoHeight,
      err
    );
  };
  const hook = (el) => {
    if (!el || el.__wvd) return;
    el.__wvd = true;
    ['error', 'stalled', 'playing'].forEach((ev) => el.addEventListener(ev, () => report(el, ev)));
    if (el.error) report(el, 'existing-error');
  };
  document.querySelectorAll('video,audio').forEach(hook);
  new MutationObserver(() => document.querySelectorAll('video,audio').forEach(hook)).observe(
    document.documentElement,
    { subtree: true, childList: true }
  );
  return true;
})();`;

let onLog = null;
function setLogger(fn) {
  onLog = fn;
}

function logMedia(msg) {
  const payload = { ts: Date.now(), msg };
  if (onLog) onLog(payload);
  else send('queue:log', payload);
}

function injectMediaHook(contents, processId, routingId) {
  const run = (frame) => {
    if (!frame || (typeof frame.isDestroyed === 'function' && frame.isDestroyed())) return;
    frame.executeJavaScript(MEDIA_HOOK, true).catch(() => {});
  };
  try {
    if (processId != null && routingId != null) {
      run(webFrameMain.fromId(processId, routingId));
      return;
    }
  } catch (e) {
    // fall through to main frame
  }
  try {
    run(contents.mainFrame);
  } catch (e) {
    contents.executeJavaScript(MEDIA_HOOK, true).catch(() => {});
  }
}

let win = null;
let view = null;
let lastBounds = null;
let wantVisible = false;
let attached = false;

function send(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function wc() {
  return view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null;
}

function layout() {
  if (!view || !win || win.isDestroyed()) return;
  const canShow =
    wantVisible && lastBounds && lastBounds.width >= 8 && lastBounds.height >= 8;
  if (!canShow) {
    if (attached) {
      try {
        win.contentView.removeChildView(view);
      } catch (e) {
        // ignore
      }
      attached = false;
    }
    return;
  }
  if (!attached) {
    try {
      win.contentView.addChildView(view);
      attached = true;
    } catch (e) {
      attached = false;
      return;
    }
  }
  try {
    view.setBounds({
      x: Math.round(lastBounds.x),
      y: Math.round(lastBounds.y),
      width: Math.round(lastBounds.width),
      height: Math.round(lastBounds.height)
    });
  } catch (e) {
    // ignore
  }
}

function attach(mainWindow, userAgent) {
  win = mainWindow;
  view = new WebContentsView({
    webPreferences: {
      partition: config.sessionPartition,
      // Untrusted sites: keep Chromium's sandbox on (no preload here needs Node).
      sandbox: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  try {
    view.setBackgroundColor('#ffffff');
  } catch (e) {
    // ignore
  }

  const contents = wc();
  if (!contents) return;
  sniffer.registerGuestTab(contents.id);

  try {
    contents.setUserAgent(userAgent);
  } catch (e) {
    // ignore
  }
  try {
    contents.setBackgroundThrottling(false);
  } catch (e) {
    // ignore
  }

  try {
    contents.setAudioMuted(false);
  } catch (e) {
    // ignore
  }

  contents.on('did-finish-load', () => {
    injectMediaHook(contents);
    send('linux-browser:event', {
      type: 'dom-ready',
      url: contents.getURL(),
      title: contents.getTitle(),
      webContentsId: contents.id,
      canGoBack: nav(contents).canBack(),
      canGoForward: nav(contents).canFwd()
    });
  });
  contents.on('did-frame-finish-load', (_e, _isMain, processId, routingId) => {
    injectMediaHook(contents, processId, routingId);
  });
  // One details object ({ message, level, ... }) since Electron 35; declaring
  // the old (event, level, message) arguments triggers a deprecation warning.
  contents.on('console-message', (details) => {
    const message = details && details.message;
    if (typeof message === 'string' && message.includes('[wvd-media]')) {
      logMedia(message.replace(/^.*\[wvd-media\]\s*/, 'Player: '));
    }
  });
  contents.on('media-started-playing', () => {
    logMedia('Video pipeline started (Chromium is decoding).');
  });
  contents.on('page-title-updated', (_e, title) => {
    send('linux-browser:event', { type: 'title', title });
  });
  contents.on('did-navigate', (_e, url) => {
    send('linux-browser:event', {
      type: 'did-navigate',
      url,
      webContentsId: contents.id,
      canGoBack: nav(contents).canBack(),
      canGoForward: nav(contents).canFwd()
    });
  });
  contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    send('linux-browser:event', {
      type: 'did-navigate-in-page',
      url,
      isMainFrame,
      canGoBack: nav(contents).canBack(),
      canGoForward: nav(contents).canFwd()
    });
  });
  contents.on('render-process-gone', () => {
    send('linux-browser:event', { type: 'crashed' });
  });
  contents.on('destroyed', () => sniffer.unregisterGuestTab(contents.id));
  try {
    contents.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:/i.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  } catch (e) {
    // ignore
  }

  contents.loadURL('https://www.google.com');

  win.on('resize', layout);
  win.on('maximize', () => setTimeout(layout, 80));
  win.on('unmaximize', () => setTimeout(layout, 80));
  win.on('closed', () => {
    sniffer.unregisterGuestTab(contents.id);
    view = null;
    win = null;
    attached = false;
  });
}

function wireIpc() {
  ipcMain.handle('linux-browser:bounds', (_e, bounds) => {
    lastBounds = bounds;
    layout();
    return true;
  });
  ipcMain.handle('linux-browser:set-visible', (_e, show) => {
    wantVisible = !!show;
    layout();
    return true;
  });
  ipcMain.handle('linux-browser:load-url', (_e, url) => {
    const c = wc();
    if (c && url) c.loadURL(url);
    return true;
  });
  ipcMain.handle('linux-browser:go-back', () => {
    const c = wc();
    if (c && nav(c).canBack()) nav(c).back();
    return true;
  });
  ipcMain.handle('linux-browser:go-forward', () => {
    const c = wc();
    if (c && nav(c).canFwd()) nav(c).fwd();
    return true;
  });
  ipcMain.handle('linux-browser:reload', () => {
    const c = wc();
    if (c) c.reload();
    return true;
  });
  ipcMain.handle('linux-browser:get-url', () => {
    const c = wc();
    return c ? c.getURL() : '';
  });
  ipcMain.handle('linux-browser:get-wc-id', () => {
    const c = wc();
    return c ? c.id : null;
  });
  ipcMain.handle('linux-browser:exec', async (_e, code) => {
    const c = wc();
    if (!c) return '';
    return c.executeJavaScript(code, true);
  });
}

module.exports = { attach, wireIpc, setLogger };
