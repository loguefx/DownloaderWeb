'use strict';

// Diagnostic harness: runs the real discovery pipeline for ONE episode URL and
// prints every log line, then exits. Not part of the app.
//   npx electron scripts/probe-dub.js "<episode url>" [dub|sub]

const { app } = require('electron');
const path = require('path');
const fsBoot = require('fs');

const BOOT_LOG = process.env.PROBE_LOG || path.join(__dirname, 'probe-dub.log');
try {
  fsBoot.writeFileSync(BOOT_LOG, 'boot\n');
} catch (e) {
  /* ignore */
}
const boot = (m) => {
  try {
    fsBoot.appendFileSync(BOOT_LOG, m + '\n');
  } catch (e) {
    /* ignore */
  }
};
process.on('uncaughtException', (e) => boot(`UNCAUGHT ${e && e.stack}`));
process.on('unhandledRejection', (e) => boot(`UNHANDLED ${e && (e.stack || e)}`));

const SRC = path.join(__dirname, '..', 'src', 'main');
boot('requiring config');
const config = require(path.join(SRC, 'config'));
boot('requiring sniffer');
const sniffer = require(path.join(SRC, 'sniffer'));
boot('requiring sites');
const sites = require(path.join(SRC, 'sites'));
boot('requiring bulk');
const bulk = require(path.join(SRC, 'bulk'));
boot('requires done');

// NOTE: pass these via env, not argv. Electron on Windows exits immediately when
// a bare URL is given as an extra command-line argument.
const url =
  process.env.PROBE_URL ||
  'https://aniwaves.ru/watch/yuusha-party-ni-kawaii-ko-ga-ita-node-kokuhaku-shitemita-82453/ep-1';
const mode = process.env.PROBE_MODE || 'dub';

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,ThirdPartyCookiePhaseout,TrackingProtection3pcd'
);

const CHROME_VERSION = process.versions.chrome || '124.0.0.0';
app.userAgentFallback =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

const fs = require('fs');
const LOG_FILE = BOOT_LOG;
const t0 = Date.now();
const log = (msg) => {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    /* ignore */
  }
};

app.whenReady().then(async () => {
  sites.init(app.getPath('userData'));
  sniffer.attach();
  sniffer.on('embed', (e) => log(`EMBED api=${e.apiUrl || '?'} -> ${e.url}`));
  sniffer.on('detected', (d) => log(`SNIFF ${d.type} ${d.url.slice(0, 140)}`));

  log(`Probing ${mode.toUpperCase()} for ${url}`);
  log(`partition=${config.sessionPartition}`);
  try {
    const out = await bulk.makeDiscover(url, log, mode)();
    log(`RESULT status=${out && out.status} reason=${(out && out.reason) || ''}`);
    if (out && out.detection) log(`RESULT url=${out.detection.url}`);
  } catch (e) {
    log(`THREW ${e && e.message}`);
  }
  setTimeout(() => app.exit(0), 300);
});
