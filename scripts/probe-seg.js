'use strict';

// Diagnostic harness: loads a provider embed, grabs the variant playlist it
// fetches, then requests individual segments through the SAME Chromium session
// (cookies + headers) and reports each status/size. Tells us whether a playlist
// that looks like a "stub" is really unplayable or just fussy about the client.
//
//   $env:EMBED_URL="https://host/e/id"; npx electron scripts/probe-seg.js

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = process.env.PROBE_LOG || path.join(require('os').tmpdir(), 'probe-seg.log');
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
  const partition = process.env.PROBE_PARTITION || 'persist:web';
  const sess = session.fromPartition(partition);
  let variant = null;
  sess.webRequest.onCompleted((d) => {
    if (/index.*\.m3u8|\/master\.m3u8/i.test(d.url) && d.statusCode === 200) {
      if (!variant || /index/i.test(d.url)) variant = d.url;
      log(`PLAYLIST ${d.statusCode} ${d.url.slice(0, 160)}`);
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
  await wc.loadURL(EMBED, { httpReferrer: REF }).catch((e) => log(`LOAD ${e && e.message}`));

  for (let i = 0; i < 12 && !variant; i++) {
    const pt = await wc
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); const r = v ? v.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
        true
      )
      .catch(() => null);
    if (pt) {
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }
    await delay(1500);
  }
  if (!variant) {
    log('no playlist seen');
    return setTimeout(() => app.exit(1), 200);
  }

  const origin = new URL(EMBED).origin;
  if (process.env.PROBE_QUALITIES) {
    // Same file id, other quality ladders (_n/_l/_x): if the high-quality copy is
    // broken on this edge another rung may still be servable.
    const sess2 = sess;
    for (const q of ['_n', '_l', '_x', '_o', '']) {
      const u = variant.replace(/_h\//, `${q}/`);
      try {
        const r = await sess2.fetch(u, { headers: { Referer: origin + '/', Origin: origin } });
        const t = r.status === 200 ? await r.text() : '';
        log(`quality[${q || 'bare'}] HTTP ${r.status} bytes=${t.length}`);
      } catch (e) {
        log(`quality[${q || 'bare'}] FAILED ${e && e.message}`);
      }
    }
  }
  const get = (url, extra = {}) =>
    sess.fetch(url, {
      headers: Object.assign({ Referer: origin + '/', Origin: origin }, extra)
    });

  let res = await get(variant);
  let body = await res.text();
  // A master playlist only lists variants; follow the first one to reach segments.
  if (/#EXT-X-STREAM-INF/i.test(body)) {
    const next = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (next) {
      variant = new URL(next, variant).toString();
      log(`following master -> ${variant.slice(0, 120)}`);
      res = await get(variant);
      body = await res.text();
    }
  }
  log(`variant HTTP ${res.status} bytes=${body.length}`);
  const lines = body.split(/\r?\n/);
  const segs = lines.filter((l) => l && !l.startsWith('#'));
  const durs = lines.filter((l) => l.startsWith('#EXTINF')).map((l) => parseFloat(l.split(':')[1]));
  log(`segments=${segs.length} firstEXTINF=${durs[0]} total=${Math.round(durs.reduce((a, b) => a + (b || 0), 0))}s`);
  log(`head:\n${lines.slice(0, 12).join('\n')}`);

  const abs = (s) => new URL(s, variant).toString();

  // The big first segment is the one that matters: these hosts pack the whole
  // episode into it. Try the ways a player/downloader might ask for it.
  if (segs[0]) {
    const first = abs(segs[0]);
    const attempts = [
      ['plain', {}],
      ['range-1MB', { Range: 'bytes=0-1048575' }],
      ['range-open', { Range: 'bytes=0-' }],
      ['identity', { 'Accept-Encoding': 'identity' }],
      ['no-referer', null]
    ];
    for (const [name, extra] of attempts) {
      try {
        const r = extra === null
          ? await sess.fetch(first)
          : await get(first, extra);
        const buf = await r.arrayBuffer();
        log(
          `first[${name}] HTTP ${r.status} bytes=${buf.byteLength} cl=${r.headers.get('content-length')} cr=${r.headers.get('content-range')}`
        );
      } catch (e) {
        log(`first[${name}] FAILED ${e && e.message}`);
      }
    }
  }
  const pick = [0, 1, 2, Math.floor(segs.length / 2), segs.length - 1].filter(
    (i, k, arr) => segs[i] && arr.indexOf(i) === k
  );
  for (const i of pick) {
    const u = abs(segs[i]);
    try {
      const r = await get(u);
      const buf = await r.arrayBuffer();
      log(`seg[${i}] HTTP ${r.status} bytes=${buf.byteLength} ${segs[i].slice(0, 60)}`);
    } catch (e) {
      log(`seg[${i}] FAILED ${e && e.message} ${segs[i].slice(0, 60)}`);
    }
  }
  setTimeout(() => app.exit(0), 200);
});
