'use strict';

// Diagnostic harness: loads ONE provider embed, clicks it, then reports what the
// page's own <video> element actually does (duration / currentTime / buffered)
// plus every media HTTP status. Answers "does this server really have the file?"
// without trusting our own Node-side probes.
//
//   $env:EMBED_URL="https://host/e/id"; npx electron scripts/probe-play.js

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = process.env.PROBE_LOG || path.join(require('os').tmpdir(), 'probe-play.log');
const t0 = Date.now();
const log = (m) => {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch (e) {
    /* ignore */
  }
};
try {
  fs.writeFileSync(LOG, '');
} catch (e) {
  /* ignore */
}

const EMBED = process.env.EMBED_URL;
const REF = process.env.EMBED_REF || 'https://aniwaves.ru/';
const RUN_MS = Number(process.env.PROBE_MS || 60000);

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,ThirdPartyCookiePhaseout,TrackingProtection3pcd'
);
const CHROME = process.versions.chrome || '124.0.0.0';
app.userAgentFallback =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const partition = process.env.PROBE_PARTITION || 'persist:web';
  const sess = session.fromPartition(partition);
  const media = (u) => /\.m3u8|\.mp4|\.ts(\?|$)|\.jpg\?|seg|hls/i.test(u);
  sess.webRequest.onCompleted((d) => {
    if (media(d.url)) log(`HTTP ${d.statusCode} ${d.url.slice(0, 150)}`);
  });
  sess.webRequest.onErrorOccurred((d) => {
    if (media(d.url)) log(`ERR ${d.error} ${d.url.slice(0, 150)}`);
  });

  const win = new BrowserWindow({
    show: false,
    x: -32000,
    y: -32000,
    width: 1280,
    height: 720,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { partition, backgroundThrottling: false, sandbox: false }
  });
  win.showInactive();
  const wc = win.webContents;

  log(`Loading ${EMBED}`);
  await wc.loadURL(EMBED, { httpReferrer: REF }).catch((e) => log(`LOAD ${e && e.message}`));
  log('loaded');

  const state = async () =>
    wc
      .executeJavaScript(
        `(() => {
          const v = document.querySelector('video');
          if (!v) return { video: false };
          const b = [];
          for (let i = 0; i < v.buffered.length; i++) b.push([Math.round(v.buffered.start(i)), Math.round(v.buffered.end(i))]);
          return {
            video: true,
            src: (v.currentSrc || '').slice(0, 120),
            duration: v.duration,
            time: v.currentTime,
            paused: v.paused,
            readyState: v.readyState,
            networkState: v.networkState,
            error: v.error ? v.error.code : null,
            buffered: b
          };
        })()`,
        true
      )
      .catch(() => null);

  const click = async () => {
    const pt = await wc
      .executeJavaScript(
        `(() => {
          const v = document.querySelector('video');
          const r = v ? v.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
        true
      )
      .catch(() => null);
    if (!pt) return;
    wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
    wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  };

  const deadline = Date.now() + RUN_MS;
  while (Date.now() < deadline) {
    await click();
    await delay(4000);
    const s = await state();
    log(`VIDEO ${JSON.stringify(s)}`);
  }
  log('done');
  setTimeout(() => app.exit(0), 300);
});
