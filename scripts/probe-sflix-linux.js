'use strict';

// Linux discovery probe: load one SFlix episode with the same Chromium flags
// as the app, log every media-ish request + sniffer state, then try a download.
//
//   PROBE_URL='https://sflix.soap2day.day/episodes/...' \
//   PROBE_DOWNLOAD=/tmp/sflix-probe.mp4 \
//   node scripts/start.js scripts/probe-sflix-linux.js

const fs = require('fs');
const path = require('path');
const { app, webContents } = require('electron');

if (!app || typeof app.commandLine === 'undefined') {
  console.error('Run via: node scripts/start.js scripts/probe-sflix-linux.js');
  process.exit(1);
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  app.commandLine.appendSwitch('disable-accelerated-video-encode');
  app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
  app.commandLine.appendSwitch('disable-site-isolation-trials');
}

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const disabledFeatures = [
  'CalculateNativeWinOcclusion',
  'ThirdPartyCookiePhaseout',
  'TrackingProtection3pcd'
];
if (process.platform === 'linux') {
  disabledFeatures.push(
    'VaapiVideoDecoder',
    'VaapiVideoEncoder',
    'VaapiVideoDecodeLinuxGL',
    'IsolateOrigins',
    'site-per-process'
  );
}
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));

const CHROME = process.versions.chrome || '124.0.0.0';
app.userAgentFallback =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;

const SRC = path.join(__dirname, '..', 'src', 'main');
const LOG = process.env.PROBE_LOG || path.join(__dirname, 'probe-sflix-linux.log');
const URL =
  process.env.PROBE_URL ||
  'https://sflix.soap2day.day/episodes/dark-matter-s01e01-pilot-part-1/';
const DOWNLOAD = process.env.PROBE_DOWNLOAD || '';
const t0 = Date.now();
const log = (m) => {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch (e) {
    // ignore
  }
};
try {
  fs.writeFileSync(LOG, '');
} catch (e) {
  // ignore
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const config = require(path.join(SRC, 'config'));
  const sniffer = require(path.join(SRC, 'sniffer'));
  const sites = require(path.join(SRC, 'sites'));
  const bulk = require(path.join(SRC, 'bulk'));

  sites.init(app.getPath('userData'));
  sniffer.attach();

  sniffer.on('detected', (d) => log(`SNIFF ${d.type} wc=${d.webContentsId} ${String(d.url).slice(0, 180)}`));
  sniffer.on('media-error', (e) =>
    log(`MEDIA HTTP ${e.status}${e.dropped ? ' DROPPED' : ''} wc=${e.webContentsId} ${String(e.url).slice(0, 140)}`)
  );

  log(`Probing ${URL}`);
  log(`platform=${process.platform} chrome=${process.versions.chrome}`);

  let out = null;
  try {
    out = await bulk.makeDiscover(URL, (m) => log(`discover ${m}`), 'dub')();
    log(`RESULT status=${out && out.status} reason=${(out && out.reason) || ''}`);
    if (out && out.detection) log(`RESULT url=${out.detection.url}`);
  } catch (e) {
    log(`THREW ${e && e.message}`);
  }

  log('--- sniffer.byTab ---');
  for (const [id, map] of sniffer.byTab) {
    log(`tab ${id} n=${map.size}`);
    for (const d of map.values()) {
      log(`  ${d.type} ${String(d.url).slice(0, 180)}`);
    }
  }
  try {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc || wc.isDestroyed()) continue;
      const type = typeof wc.getType === 'function' ? wc.getType() : '?';
      let winId = '?';
      try {
        const w = wc.getOwnerBrowserWindow && wc.getOwnerBrowserWindow();
        winId = w && !w.isDestroyed() ? w.id : 'none';
      } catch (e) {
        // ignore
      }
      log(`wc id=${wc.id} type=${type} win=${winId} url=${String(wc.getURL()).slice(0, 140)}`);
    }
  } catch (e) {
    log(`wc dump failed ${e && e.message}`);
  }

  if (DOWNLOAD && out && out.detection) {
    const downloader = require(path.join(SRC, 'downloader'));
    const { verifyFile } = require(path.join(SRC, 'verify'));
    try {
      await downloader.download(out.detection, DOWNLOAD, {
        onLog: (m) => log(`DOWNLOAD ${m}`),
        onProgress: (p) => {
          const pct = Math.round((p.percent || 0) * 100);
          if (pct && pct % 20 === 0) log(`DOWNLOAD ${pct}%`);
        }
      });
      const v = await verifyFile(DOWNLOAD);
      log(`VERIFY ok=${v.ok} reason=${v.reason || ''} bytes=${fs.existsSync(DOWNLOAD) ? fs.statSync(DOWNLOAD).size : 0}`);
    } catch (e) {
      log(`DOWNLOAD FAILED ${e && e.message}`);
    } finally {
      if (out.detection && typeof out.detection.releaseDiscover === 'function') {
        try {
          out.detection.releaseDiscover();
        } catch (e2) {
          // ignore
        }
      }
    }
  }

  setTimeout(() => app.exit(0), 500);
});
