'use strict';

// Queue liveness tests (future-proofing: nothing may sit stuck forever).
//
// The queue has two independent guards, both tested here:
//   1. PHASE CAPS - an item stuck in any active phase (resolving, ready,
//      downloading, verifying, placing) past its cap is KILLED and retried
//      like a normal failed attempt. A hang can never park an item or wedge
//      the queue, no matter which code path causes it.
//   2. RE-KICK - queued items with no running worker (dead worker / lost
//      kick) are kicked again by the liveness tick.
//
// Plus unit checks on the per-item downloading cap (must be looser than the
// downloader's own 6x-duration allowance).

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-live-'));

// ---- electron shim (must be in place before any app module loads) ----------
const shim = {
  app: {
    getPath: () => DATA_DIR,
    on: () => {},
    once: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    setLoginItemSettings: () => {},
    getName: () => 'webvideodownloader'
  },
  BrowserWindow: class {
    constructor() {
      throw new Error('BrowserWindow is not available in the test (expected fail-fast)');
    }
  },
  session: {
    fromPartition: () => ({
      setUserAgent() {},
      setPermissionRequestHandler() {},
      webRequest: { onBeforeSendHeaders() {} },
      clearCache: () => Promise.resolve()
    })
  },
  ipcMain: { handle() {}, on() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  nativeTheme: { on() {} },
  Menu: { setApplicationMenu() {} },
  shell: { openExternal() {} },
  clipboard: { readText: () => '', writeText() {} },
  globalShortcut: { on() {}, register() {}, unregister() {} }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return shim;
  return origLoad.apply(this, arguments);
};

const M = (p) => require(path.join(REPO, 'src/main', p));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = M('config');
  const vpn = M('vpn');
  const library = M('library');
  const manager = M('queue');

  vpn._setStatus(true, 'liveness-test', 'test'); // gate must not block
  library.dataDir = path.join(DATA_DIR, 'libdata');
  // Fast retries so the test does not wait on backoff.
  config.download.retryBaseDelayMs = 50;
  config.download.retryMaxDelayMs = 50;
  // Short caps + fast tick for the test (mutates the shared caps object the
  // manager reads on every tick).
  manager.watchdogTickMs = 100;
  manager.PHASE_CAPS_MS.resolving = 500;

  // ---- 1. Stuck resolving -> killed + retried (never parked) ------------------
  console.log('\n[1] Stuck "resolving" is killed and retried');
  let itemRef = null;
  const hangDiscover = () =>
    new Promise((resolve, reject) => {
      const t = setInterval(() => {
        const c = itemRef && itemRef._controller;
        if (c && c.signal && c.signal.aborted) {
          clearInterval(t);
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        }
      }, 15);
    });
  // Capture manager logs BEFORE the item is added: "Will keep retrying ..."
  // is only logged by the generic retry path (the item went BACK ON THE
  // QUEUE), so it is the reliable proof that the kill was not treated as a
  // pause or a hard fail (the worker re-picks the item almost instantly, so
  // a live status sample would race the queued window).
  const logs = [];
  const realLog = manager._log.bind(manager);
  manager._log = (m) => {
    logs.push(m);
    realLog(m);
  };
  fs.mkdirSync(path.join(DATA_DIR, 'staging'), { recursive: true });
  const id = manager.add({
    label: 'Hang Show S1E1',
    series: 'Hang Show',
    season: 1,
    episode: 1,
    url: 'https://example.invalid/hang',
    outputRoot: path.join(DATA_DIR, 'staging'),
    discover: hangDiscover
  });
  itemRef = manager.items.find((x) => x.id === id);
  let saw = null;
  for (let i = 0; i < 60 && !(itemRef && itemRef.attempts >= 1); i++) {
    await sleep(100);
    saw = itemRef;
  }
  check('stuck item was killed and counted as a failed attempt', saw && saw.attempts >= 1, JSON.stringify(saw && [saw.attempts, saw.status, saw.error]));
  // item.error is transient (the worker clears it when re-picking), so the
  // durable record of the kill reason is the manager log line.
  check(
    '...with the stuck-phase reason',
    logs.some((m) => /Error on "Hang Show S1E1" \(attempt \d+\): stuck in "resolving" for \d+ min/.test(m)),
    logs.join(' | ')
  );
  check('...back on the queue (not parked, not failed)', logs.some((m) => /Will keep retrying "Hang Show S1E1"/.test(m)), logs.join(' | '));
  manager._log = realLog;
  // Tear the retry loop down.
  manager.removeByIds([id]);
  await sleep(150);
  check('worker exited after removal', manager._active.size === 0, String(manager._active.size));

  // ---- 2. Re-kick: queued items + no worker -> kicked -------------------------
  console.log('\n[2] Re-kick liveness');
  let kicked = 0;
  const realKick = manager._kick.bind(manager);
  manager._kick = () => {
    kicked += 1;
  };
  const fake = {
    id: 999001,
    status: 'queued',
    label: 'Ghost',
    series: 'Ghost',
    season: 1,
    episode: 1,
    url: 'https://example.invalid/ghost',
    discover: () => Promise.resolve({ status: 'failed', reason: 'nope' })
  };
  manager.items.push(fake);
  manager._active.clear();
  manager._watchdogTick();
  check('queued item with no running worker re-kicks the queue', kicked === 1, 'kicked=' + kicked);
  manager._kick = realKick;
  manager.items = manager.items.filter((x) => x.id !== fake.id);

  // Paused queue must NOT be re-kicked (legitimate hold).
  manager._paused = true;
  kicked = 0;
  manager._watchdogTick();
  check('paused queue is left alone', kicked === 0, 'kicked=' + kicked);
  manager._paused = false;

  // ---- 3. Per-item downloading cap --------------------------------------------
  console.log('\n[3] Downloading cap is looser than the downloader allowance');
  const capShort = manager._phaseCap({ status: 'downloading', expectedDuration: 0 });
  check('short media: minimum cap applies', capShort === manager.DOWNLOAD_CAP_MIN_MS, capShort + 'ms');
  const capLong = manager._phaseCap({ status: 'downloading', expectedDuration: 7200 }); // 2h movie
  const allowed = (7200 * 6 + 30 * 60) * 1000;
  check('2h media: cap = 6x duration + 30 min', capLong === allowed, capLong + 'ms vs ' + allowed + 'ms');
  check('paused has no cap (legitimate hold)', manager._phaseCap({ status: 'paused' }) == null);
  check('waiting has no cap (dub not out yet)', manager._phaseCap({ status: 'waiting' }) == null);
  check('placing cap exceeds the 90-min placement timeout', manager._phaseCap({ status: 'placing' }) > 90 * 60000, manager._phaseCap({ status: 'placing' }) + 'ms');

  if (manager._watchdogTimer) clearInterval(manager._watchdogTimer);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(1);
});
