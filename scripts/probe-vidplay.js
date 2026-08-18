'use strict';

// Diagnostic harness: opens an episode page, picks the DUB row's first server,
// captures the FULL playlist URL its player requests, then retries that exact
// path on every sibling CDN host. Echovideo/Vidplay hands out a random hlsxNcdn
// host per session, so a 404 from one host does not prove the file is missing.
//
//   $env:PAGE_URL="https://aniwaves.ru/watch/<slug>/ep-10"; npx electron scripts/probe-vidplay.js

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = process.env.PROBE_LOG || path.join(require('os').tmpdir(), 'probe-vidplay.log');
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

const PAGE = process.env.PAGE_URL;
const WANT = process.env.PAGE_MODE || 'dub';
const SERVER = Number(process.env.PAGE_SERVER || 0); // 0=vidplay, 1=byfms, 2=dghg

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
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
  const partition = process.env.PROBE_PARTITION || 'probe-vidplay';
  const sess = session.fromPartition(partition);
  const seen = new Set();
  let playlist = null;
  let playlistOverride = process.env.PLAYLIST_URL || null;
  sess.webRequest.onCompleted((d) => {
    if (/\.m3u8(\?|$)|\.m3u8$|hlsx\d+cdn/i.test(d.url) && !/ping\.gif/i.test(d.url) && !seen.has(d.url)) {
      seen.add(d.url);
      log(`HTTP ${d.statusCode} ${d.url}`);
      if (!playlist) playlist = d.url;
    }
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
  if (playlistOverride) {
    playlist = playlistOverride;
    log(`using given playlist ${playlist.slice(0, 90)}...`);
  }
  if (!playlistOverride) {
  log(`Loading ${PAGE}`);
  await wc.loadURL(PAGE).catch((e) => log(`LOAD ${e && e.message}`));

  await wc
    .executeJavaScript(`document.cookie = 'prefered_server_type=${WANT};path=/;max-age=86400';`, true)
    .catch(() => {});
  await delay(4000);

  const clicked = await wc
    .executeJavaScript(
      `(() => {
        const row = document.querySelector('.servers .type[data-type="${WANT}"], #w-servers .type[data-type="${WANT}"]');
        if (!row) return { row: false };
        const lis = Array.from(row.querySelectorAll('li'));
        const el = lis[${SERVER}];
        if (!el) return { row: true, count: lis.length, clicked: false };
        el.click();
        return { row: true, count: lis.length, clicked: true, label: (el.textContent || '').trim().slice(0, 30) };
      })()`,
      true
    )
    .catch((e) => ({ error: String(e) }));
  log(`click: ${JSON.stringify(clicked)}`);

  for (let i = 0; i < 15 && !playlist; i++) await delay(1000);
  }
  if (!playlist) {
    log('no playlist request seen');
    return setTimeout(() => app.exit(1), 200);
  }

  const u = new URL(playlist);
  const m = u.host.match(/^hlsx(\d+)cdn\./i);
  const hosts = [];
  if (m) {
    for (let n = 1; n <= 10; n++) hosts.push(u.host.replace(/^hlsx\d+cdn\./i, `hlsx${n}cdn.`));
  } else {
    hosts.push(u.host);
  }
  log(`testing ${hosts.length} host(s) for ${u.pathname.slice(0, 60)}...`);
  for (const h of hosts) {
    const t = new URL(playlist);
    t.host = h;
    try {
      const r = await sess.fetch(t.toString(), {
        headers: { Referer: 'https://play.echovideo.ru/', Origin: 'https://play.echovideo.ru' }
      });
      const body = r.status === 200 ? (await r.text()).slice(0, 200) : '';
      log(`host ${h} HTTP ${r.status}${body ? ` playlist=${/#EXTM3U/.test(body)} head=${body.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
    } catch (e) {
      log(`host ${h} FAILED ${e && e.message}`);
    }
  }
  setTimeout(() => app.exit(0), 200);
});
