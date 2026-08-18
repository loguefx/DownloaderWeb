'use strict';

// Diagnostic harness: loads ONE provider embed URL in a discovery-style window,
// clicks the player, and logs that provider's API traffic + console output. Used
// to work out why a server produces no stream. Not part of the app.
//
//   $env:EMBED_URL="https://host/e/id"; npx electron scripts/probe-embed.js

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = process.env.PROBE_LOG || path.join(require('os').tmpdir(), 'probe-embed.log');
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
const SHOT = process.env.PROBE_SHOT;
const RUN_MS = Number(process.env.PROBE_MS || 45000);

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
  const sess = session.fromPartition(process.env.PROBE_PARTITION || 'persist:web');

  const interesting = (u) => /\/api\/|\.m3u8|\.mp4|master|challenge|attest|stream/i.test(u);
  sess.webRequest.onCompleted((d) => {
    if (interesting(d.url)) log(`HTTP ${d.statusCode} ${d.method} ${d.url.slice(0, 160)}`);
  });
  sess.webRequest.onErrorOccurred((d) => {
    if (interesting(d.url)) log(`ERR ${d.error} ${d.url.slice(0, 160)}`);
  });

  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 720,
    opacity: process.env.PROBE_VISIBLE ? 1 : 0.01,
    skipTaskbar: true,
    webPreferences: {
      partition: process.env.PROBE_PARTITION || 'persist:web',
      backgroundThrottling: false,
      sandbox: false
    }
  });
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message) => {
    if (message && !/^Failed to load resource/.test(message)) log(`CONSOLE[${level}] ${message.slice(0, 300)}`);
  });

  log(`Loading ${EMBED} (referer ${REF})`);
  try {
    await wc.loadURL(EMBED, { httpReferrer: REF });
  } catch (e) {
    log(`LOAD FAILED ${e && e.message}`);
  }

  const clickCentre = async () => {
    try {
      const pt = await wc.executeJavaScript(
        `(() => {
          const r = (document.querySelector('video') || document.body).getBoundingClientRect();
          const w = r.width > 200 ? r : { left: 0, top: 0, width: innerWidth, height: innerHeight };
          return { x: Math.round(w.left + w.width / 2), y: Math.round(w.top + w.height / 2) };
        })()`,
        true
      );
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      log(`clicked ${pt.x},${pt.y}`);
    } catch (e) {
      log(`click failed ${e && e.message}`);
    }
  };

  const snap = async (tag) => {
    if (!SHOT) return;
    try {
      fs.mkdirSync(SHOT, { recursive: true });
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(SHOT, `${tag}.png`), img.toPNG());
    } catch (e) {
      /* ignore */
    }
  };

  await delay(4000);
  await snap('before');
  const deadline = Date.now() + RUN_MS;
  let n = 0;
  while (Date.now() < deadline) {
    await clickCentre();
    await delay(3000);
    await snap(`click${++n}`);
  }
  log('done');
  setTimeout(() => app.exit(0), 300);
});
