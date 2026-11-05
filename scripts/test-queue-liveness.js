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
  // The dub sources are not reachable from the tests: "is this episode listed
  // as dubbed?" answers unknown unless a section sets its own answer.
  M('dubstatus').isDubbedForJob = async () => null;

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

  // ---- 1b. A discovery that IGNORES the abort (House S1E1, 7 h) -------------
  console.log('\n[1b] A hung discovery that never listens to the abort still frees the worker');
  {
    const logs1b = [];
    const realLog1b = manager._log.bind(manager);
    manager._log = (m) => { logs1b.push(m); realLog1b(m); };
    let calls = 0;
    const id1b = manager.add({
      label: 'Deaf Show S1E1', series: 'Deaf Show', season: 1, episode: 1,
      url: 'https://example.invalid/deaf', outputRoot: path.join(DATA_DIR, 'staging'),
      discover: () => { calls += 1; return new Promise(() => {}); } // never settles, never looks at the signal
    });
    const it1b = manager.items.find((x) => x.id === id1b);
    for (let i = 0; i < 80 && !(it1b && it1b.attempts >= 2); i++) await sleep(100);
    check('killed, counted, and tried again (not stuck)', it1b && it1b.attempts >= 2 && calls >= 2, JSON.stringify([it1b && it1b.attempts, calls]));
    const kills = logs1b.filter((m) => /Deaf Show S1E1" was stuck/.test(m)).length;
    check('one kill line per kill (no log every tick)', kills <= it1b.attempts + 1, `${kills} kill lines for ${it1b.attempts} attempts`);
    manager._log = realLog1b;
    manager.removeByIds([id1b]);
    await sleep(150);
    check('worker exited after removal', manager._active.size === 0, String(manager._active.size));
  }

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

  // ---- 4. Licensed-exclusive titles stop after ONE attempt ------------------
  // Netflix/HBO originals are not on the CF-free catalogs; the gated fallbacks
  // need a solver. Old behaviour: 6 retries x ~4 min of "Still waiting for
  // Cloudflare" per episode. New: TMDB says licensed-only -> explain + stop.
  console.log('\n[4] Licensed exclusive stops retrying (no Cloudflare burn)');
  const tmdbMod = M('tmdb');
  const cfsolve = M('cfsolve');
  const origWatch = tmdbMod.watchProviders;
  const origEnabled = cfsolve.enabled;
  tmdbMod.watchProviders = async () => ['Netflix']; // Vivant-style original
  cfsolve.enabled = () => false; // no solver configured
  const xlogs = [];
  const realLog2 = manager._log.bind(manager);
  manager._log = (m) => {
    xlogs.push(m);
    realLog2(m);
  };
  let discovers = 0;
  const failDiscover = () => {
    discovers += 1;
    return Promise.resolve({ status: 'failed', reason: 'no sources' });
  };
  const xid = manager.add({
    label: 'Exclusive Show S1E1',
    series: 'Exclusive Show',
    season: 1,
    episode: 1,
    url: 'https://example.invalid/exclusive',
    tmdb: '218038',
    outputRoot: path.join(DATA_DIR, 'staging'),
    discover: failDiscover
  });
  const xitem = manager.items.find((x) => x.id === xid);
  for (let i = 0; i < 80 && !(xitem && xitem.status === 'failed'); i++) await sleep(100);
  check(
    'exclusive title failed after exactly 1 attempt',
    xitem && xitem.attempts === 1 && xitem.status === 'failed',
    JSON.stringify(xitem && [xitem.attempts, xitem.status, xitem.error])
  );
  check('the browser fallback was SKIPPED (discover never called)', discovers === 0, 'discovers=' + discovers);
  check(
    'log explains the licensed exclusive',
    xlogs.some((m) => /exclusive (per TMDB|and no Cloudflare solver)/i.test(m)),
    xlogs.slice(-6).join(' | ').slice(0, 400)
  );
  tmdbMod.watchProviders = origWatch;
  cfsolve.enabled = origEnabled;
  manager._log = realLog2;
  manager.removeByIds([xid]);
  await sleep(150);

  // Non-exclusive failure keeps the normal retry behaviour (regression guard).
  const origWatch2 = tmdbMod.watchProviders;
  tmdbMod.watchProviders = async () => null; // TMDB knows no exclusive
  let discovers2 = 0;
  const yid = manager.add({
    label: 'Normal Show S1E1',
    series: 'Normal Show',
    season: 1,
    episode: 1,
    url: 'https://example.invalid/normal',
    outputRoot: path.join(DATA_DIR, 'staging'),
    discover: () => {
      discovers2 += 1;
      return Promise.resolve({ status: 'failed', reason: 'no sources' });
    }
  });
  const yitem = manager.items.find((x) => x.id === yid);
  let tries = 0;
  for (let i = 0; i < 120 && !(yitem && yitem.attempts >= 3); i++) {
    await sleep(100);
    tries = i;
  }
  check(
    'non-exclusive title still retries (3 attempts reached)',
    yitem && yitem.attempts >= 3,
    JSON.stringify(yitem && [yitem.attempts, yitem.status])
  );
  check('...and the browser fallback ran each time', discovers2 >= 3, 'discovers=' + discovers2);
  tmdbMod.watchProviders = origWatch2;
  manager.removeByIds([yid]);
  await sleep(150);

  // ---- 5. Removing a parked item frees its worker -----------------------------
  // A paused / VPN-held / slot-waiting item that is removed must not keep its
  // worker forever (that site would lose a download slot until restart).
  console.log('\n[5] Removing a parked item frees its worker');
  manager.pause();
  const pid = manager.add({
    label: 'Parked Show S1E1',
    series: 'Parked Show',
    season: 1,
    episode: 1,
    url: 'https://example.invalid/parked',
    outputRoot: path.join(DATA_DIR, 'staging'),
    discover: () => Promise.resolve({ status: 'failed', reason: 'never reached' })
  });
  await sleep(100);
  check('item is parked at the gate (worker running)', manager._active.size === 1, String(manager._active.size));
  manager.removeByIds([pid]);
  await sleep(100);
  check('removing it frees the worker', manager._active.size === 0, String(manager._active.size));
  manager.resume();

  // ---- 6. Download errors with no progress stop retrying -----------------------
  console.log('\n[6] A download that fails the same way every time gives up');
  const http = require('http');
  const srv = http.createServer((req, res) => { res.statusCode = 500; res.end('nope'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  config.download.maxRetries = 2; // streak cap = 4
  const glogs = [];
  const realLog3 = manager._log.bind(manager);
  manager._log = (m) => { glogs.push(m); realLog3(m); };
  const gid = manager.add({
    label: 'Broken Show S1E1',
    series: 'Broken Show',
    season: 1,
    episode: 1,
    url: 'https://example.invalid/broken',
    outputRoot: path.join(DATA_DIR, 'staging'),
    discover: () => Promise.resolve({ status: 'resolved', detection: { url: `http://127.0.0.1:${port}/x.mp4`, type: 'mp4' } })
  });
  const gitem = manager.items.find((x) => x.id === gid);
  for (let i = 0; i < 100 && !(gitem && gitem.status === 'failed'); i++) await sleep(100);
  check('gave up after 4 no-progress failures', gitem && gitem.status === 'failed' && gitem.attempts === 4,
    JSON.stringify(gitem && [gitem.status, gitem.attempts, gitem.error]));
  check('log says why', glogs.some((m) => /Gave up on "Broken Show S1E1" after 4 tries in a row with no progress/.test(m)), glogs.slice(-3).join(' | '));
  await sleep(50);
  check('worker freed after giving up', manager._active.size === 0, String(manager._active.size));
  check('retry() puts it back with a fresh budget', manager.retry(gid) === true && gitem.attempts === 0 && gitem._failStreak === 0);
  await sleep(30);
  check('retry() refuses an item that is still active', manager.retry(gid) === null);
  check('retry() of an unknown id is false', manager.retry(987654) === false);
  manager.removeByIds([gid]);
  await sleep(150);
  manager._log = realLog3;
  srv.close();
  config.download.maxRetries = 6;

  // ---- 6a. Download progress reaches the queue snapshot (the plugin's bars) --
  console.log('\n[6a] A running download shows its progress in the queue snapshot');
  {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const N = 12;
    const psrv = http.createServer((req, res) => {
      res.setHeader('Content-Length', chunk.length * N);
      res.setHeader('Content-Type', 'video/mp4');
      let k = 0;
      const t = setInterval(() => {
        if (k >= N) { clearInterval(t); res.end(); return; }
        res.write(chunk);
        k += 1;
      }, 120);
      req.on('close', () => clearInterval(t));
    });
    await new Promise((r) => psrv.listen(0, '127.0.0.1', r));
    const pid = manager.add({
      label: 'Progress Show S1E1', series: 'Progress Show', season: 1, episode: 1,
      url: 'https://example.invalid/progress', outputRoot: path.join(DATA_DIR, 'staging'),
      discover: () => Promise.resolve({ status: 'resolved', detection: { url: `http://127.0.0.1:${psrv.address().port}/p.mp4`, type: 'mp4' } })
    });
    let seen = null;
    for (let i = 0; i < 100 && !seen; i++) {
      const snap = manager.snapshot().find((x) => x.id === pid);
      if (snap && snap.status === 'downloading' && snap.progress > 0 && snap.progress < 1) seen = snap;
      await sleep(50);
    }
    check('snapshot shows "downloading" with a percentage between 0 and 100', !!seen, JSON.stringify(seen));
    check('...and the bytes received, not a part count', seen && seen.bytes > 0 && !seen.parts, JSON.stringify(seen && [seen.bytes, seen.parts]));
    manager.removeByIds([pid]);
    await sleep(150);
    psrv.close();
  }

  // ---- 6b. Anime DUB: no dub source answers -> waiting list, not failed ----
  console.log('\n[6b] Anime DUB with no dub source answering goes on the waiting-for-dub list');
  {
    config.download.maxRetries = 2;
    const savedBase = config.download.retryBaseDelayMs;
    config.download.retryBaseDelayMs = 20;
    const dsB = require(path.join(__dirname, '..', 'src', 'main', 'dubstatus.js'));
    const realIsB = dsB.isDubbedForJob;
    dsB.isDubbedForJob = async () => null; // sources unknown (no network in the test)
    let parkedWith = null;
    const wid = manager.add({
      label: 'Chained Soldier S2E12',
      series: 'Chained Soldier',
      season: 2,
      episode: 12,
      anime: true,
      mode: 'dub',
      url: 'https://example.invalid/chained-s2e12',
      skipSources: ['animevillage'], // no network in the test
      outputRoot: path.join(DATA_DIR, 'staging'),
      discover: () => Promise.resolve({ status: 'failed', reason: 'no dub copy on the source site' }),
      onUnavailable: (o) => { parkedWith = o; }
    });
    const witem = manager.items.find((x) => x.id === wid);
    for (let i = 0; i < 100 && !(witem && (witem.status === 'waiting' || witem.status === 'failed')); i++) await sleep(50);
    check('given up -> "waiting", not "failed"', witem && witem.status === 'waiting', JSON.stringify(witem && [witem.status, witem.attempts, witem.error]));
    check('...handed to the waiting-for-dub list (onUnavailable)', parkedWith && parkedWith.status === 'unavailable', JSON.stringify(parkedWith));
    manager.removeByIds([wid]);
    await sleep(100);
    dsB.isDubbedForJob = realIsB;
    config.download.retryBaseDelayMs = savedBase;
    config.download.maxRetries = 6;
  }

  // ---- 6b2. "No DUB row" on the page while the sources list it as dubbed ----
  console.log('\n[6b2] A dub the sources list is never parked as "not released" from one page scan');
  {
    const ds = require(path.join(__dirname, '..', 'src', 'main', 'dubstatus.js'));
    const realIs = ds.isDubbedForJob;
    config.download.maxRetries = 2;
    const savedBase = config.download.retryBaseDelayMs;
    config.download.retryBaseDelayMs = 20;
    const mk = (label, ep, parked) => manager.add({
      label, series: 'One Piece', season: 1, episode: ep, anime: true, mode: 'dub',
      url: 'https://example.invalid/op-' + ep, skipSources: ['animevillage'],
      outputRoot: path.join(DATA_DIR, 'staging'),
      discover: () => Promise.resolve({ status: 'unavailable', reason: 'DUB not released yet' }),
      onUnavailable: () => { parked.push(ep); }
    });
    // Listed as dubbed -> retried, then failed (visible), never waiting.
    ds.isDubbedForJob = async () => true;
    const parked1 = [];
    const id1 = mk('One Piece S1E1140', 1140, parked1);
    const it1 = manager.items.find((x) => x.id === id1);
    for (let i = 0; i < 100 && !(it1 && (it1.status === 'failed' || it1.status === 'waiting')); i++) await sleep(50);
    check('listed dubbed + page shows no DUB row -> retried, ends "failed", not "waiting"', it1 && it1.status === 'failed' && parked1.length === 0, JSON.stringify(it1 && [it1.status, it1.attempts, parked1]));
    manager.removeByIds([id1]);
    await sleep(100);
    // Really not dubbed -> waiting list, as before.
    ds.isDubbedForJob = async () => false;
    const parked2 = [];
    const id2 = mk('One Piece S1E1170', 1170, parked2);
    const it2 = manager.items.find((x) => x.id === id2);
    for (let i = 0; i < 100 && !(it2 && (it2.status === 'failed' || it2.status === 'waiting')); i++) await sleep(50);
    check('not dubbed -> waiting list (unchanged)', it2 && it2.status === 'waiting' && parked2.length === 1, JSON.stringify(it2 && [it2.status, parked2]));
    manager.removeByIds([id2]);
    await sleep(100);
    // Stopped while the search runs -> cancelled, never parked.
    ds.isDubbedForJob = async () => null;
    const parked3 = [];
    let release = null;
    const id3 = manager.add({
      label: 'One Piece S1E1141', series: 'One Piece', season: 1, episode: 1141, anime: true, mode: 'dub',
      url: 'https://example.invalid/op-1141', skipSources: ['animevillage'], outputRoot: path.join(DATA_DIR, 'staging'),
      discover: () => new Promise((res) => { release = () => res({ status: 'unavailable', reason: 'DUB not released yet' }); }),
      onUnavailable: () => { parked3.push(1141); }
    });
    for (let i = 0; i < 100 && !release; i++) await sleep(20);
    manager.stopAll('test');
    release && release();
    await sleep(200);
    const it3 = manager.items.find((x) => x.id === id3);
    check('Stop during the dub search -> cancelled, not put on the waiting list', parked3.length === 0 && (!it3 || it3.status === 'cancelled'), JSON.stringify(it3 && [it3.status, parked3]));
    manager.removeByIds([id3]);
    manager.resume && manager.resume();
    manager._stopRequested = null;
    ds.isDubbedForJob = realIs;
    config.download.retryBaseDelayMs = savedBase;
    config.download.maxRetries = 6;
  }

  // ---- 6c. Not on any source: two tries, then the daily checks ------------
  console.log('\n[6c] An episode no source has is not retried six times back to back');
  {
    const savedBase = config.download.retryBaseDelayMs;
    config.download.retryBaseDelayMs = 20;
    config.download.maxRetries = 6;
    const vid = manager.add({
      label: 'Vivant S3E1',
      series: 'Vivant',
      season: 3,
      episode: 1,
      url: 'https://example.invalid/vivant-s3e1',
      outputRoot: path.join(DATA_DIR, 'staging'),
      discover: () => Promise.resolve({ status: 'failed', reason: 'No video sources found on the page' })
    });
    const vitem = manager.items.find((x) => x.id === vid);
    for (let i = 0; i < 100 && !(vitem && vitem.status === 'failed'); i++) await sleep(50);
    check('stops after 2 tries (not 6)', vitem && vitem.status === 'failed' && vitem.attempts === 2, JSON.stringify(vitem && [vitem.status, vitem.attempts]));
    manager.removeByIds([vid]);
    await sleep(100);
    config.download.retryBaseDelayMs = savedBase;
  }

  // ---- 6d. 1080p first, 720p as the fallback (TV/movies) ------------------
  console.log('\n[6d] No 1080p anywhere: one more round accepting 720p, then it stops');
  {
    const savedBase = config.download.retryBaseDelayMs;
    config.download.retryBaseDelayMs = 20;
    config.download.maxRetries = 6;
    const floors = [];
    const bid = manager.add({
      label: 'Breaking Bad S1E1',
      series: 'Breaking Bad',
      season: 1,
      episode: 1,
      minHeight: 1080,
      url: 'https://example.invalid/bb-s1e1',
      outputRoot: path.join(DATA_DIR, 'staging'),
      discover: (it) => {
        floors.push(it.minHeight);
        return Promise.resolve({ status: 'failed', reason: 'No 1080p stream on any source' });
      }
    });
    const bitem = manager.items.find((x) => x.id === bid);
    for (let i = 0; i < 200 && !(bitem && bitem.status === 'failed'); i++) await sleep(50);
    check('tried at 1080p first', floors[0] === 1080, JSON.stringify(floors));
    check('then at 720p', floors.includes(720) && floors.indexOf(720) > 0, JSON.stringify(floors));
    check('falls back only once, then stops', bitem && bitem.status === 'failed' && floors.filter((f) => f === 720).length <= 2, JSON.stringify([bitem && bitem.status, floors]));
    manager.removeByIds([bid]);
    await sleep(100);
    // Anime and a 720p floor never fall back.
    const floorsA = [];
    const aid = manager.add({
      label: 'Show S1E1', series: 'Show', season: 1, episode: 1, minHeight: 720,
      url: 'https://example.invalid/show-s1e1', outputRoot: path.join(DATA_DIR, 'staging'),
      discover: (it) => { floorsA.push(it.minHeight); return Promise.resolve({ status: 'failed', reason: 'No 720p stream on any source' }); }
    });
    const aitem = manager.items.find((x) => x.id === aid);
    for (let i = 0; i < 200 && !(aitem && aitem.status === 'failed'); i++) await sleep(50);
    check('a 720p floor has nothing lower to fall back to', aitem && aitem.status === 'failed' && floorsA.every((f) => f === 720), JSON.stringify(floorsA));
    manager.removeByIds([aid]);
    await sleep(100);
    config.download.retryBaseDelayMs = savedBase;
  }

  // ---- 6e. Vidsrc says "not here" (API 404): no replay of its pages ------
  console.log('\n[6e] Vidsrc API 404: its pages are skipped; specials / cinema-only films stop at once');
  {
    const savedBase = config.download.retryBaseDelayMs;
    config.download.retryBaseDelayMs = 20;
    config.download.maxRetries = 6;
    const sitesReg = M('sites');
    if (!sitesReg.profiles.length) sitesReg.init(DATA_DIR);
    const vs = sitesReg.resolve('https://vidsrc.sh/embed/tv/1408-0-1');
    const origDirect = vs.directResolve;
    vs.directResolve = async () => { throw Object.assign(new Error('Vidsrc API status 404'), { code: 'VIDSRC_NOT_FOUND' }); };
    const tmdbMod = M('tmdb');
    const origNotOut = tmdbMod.movieNotOutHint;
    tmdbMod.movieNotOutHint = async (id) => (String(id) === '1381071' ? 'only in cinemas so far (since 2026-11-03) - no digital release yet' : '');
    const run = async (spec) => {
      const seen = [];
      const id = manager.add(Object.assign({ outputRoot: path.join(DATA_DIR, 'staging'), minHeight: 1080 }, spec, {
        discover: (it) => { seen.push({ skip: !!it._skipVidsrcPages }); return Promise.resolve({ status: 'failed', reason: 'No video sources found on the page' }); }
      }));
      const it = manager.items.find((x) => x.id === id);
      for (let i = 0; i < 200 && !(it && it.status === 'failed'); i++) await sleep(50);
      manager.removeByIds([id]);
      await sleep(50);
      return { it, seen };
    };
    const sp = await run({ label: 'House S0E1', series: 'House', season: 0, episode: 1, url: 'https://vidsrc.sh/embed/tv/1408-0-1' });
    check('a special Vidsrc lacks: failed after 1 try, nothing searched', sp.it.status === 'failed' && sp.it.attempts === 1 && sp.seen.length === 0, JSON.stringify([sp.it.status, sp.it.attempts, sp.seen.length]));
    const mv = await run({ label: 'Godzilla Minus Zero', series: 'Godzilla Minus Zero', url: 'https://vidsrc.sh/embed/movie/1381071' });
    check('a film only in cinemas: failed after 1 try, nothing searched', mv.it.status === 'failed' && mv.it.attempts === 1 && mv.seen.length === 0 && /cinemas/.test(mv.it.error || ''), JSON.stringify([mv.it.status, mv.it.attempts, mv.seen.length, mv.it.error]));
    const ep = await run({ label: 'House S1E1', series: 'House', season: 1, episode: 1, url: 'https://vidsrc.sh/embed/tv/1408-1-1' });
    check('a normal episode Vidsrc lacks: the other sites are searched, Vidsrc pages skipped', ep.seen.length >= 1 && ep.seen.every((x) => x.skip), JSON.stringify(ep.seen));
    const out = await run({ label: 'Old Film', series: 'Old Film', url: 'https://vidsrc.sh/embed/movie/555' });
    check('a film that is out: still searched on the other sites', out.seen.length >= 1, JSON.stringify(out.seen));
    vs.directResolve = origDirect;
    tmdbMod.movieNotOutHint = origNotOut;
    config.download.retryBaseDelayMs = savedBase;
  }

  // ---- 6f. TV / films never wait for a dub ---------------------------------
  console.log('\n[6f] A TV episode a page calls "DUB not released" is not parked on the waiting-for-dub list');
  {
    const savedBase = config.download.retryBaseDelayMs;
    config.download.retryBaseDelayMs = 20;
    let parked = 0;
    const id = manager.add({
      label: 'Drama S1E1', series: 'Drama', season: 1, episode: 1, mode: 'dub', anime: false, minHeight: 1080,
      url: 'https://example.invalid/drama-s1e1', outputRoot: path.join(DATA_DIR, 'staging'),
      onUnavailable: () => { parked += 1; },
      discover: () => Promise.resolve({ status: 'unavailable', reason: 'DUB not released yet' })
    });
    const it = manager.items.find((x) => x.id === id);
    for (let i = 0; i < 200 && !(it && (it.status === 'failed' || it.status === 'waiting')); i++) await sleep(50);
    check('not on the waiting list (failed like any miss)', it && it.status === 'failed' && parked === 0, JSON.stringify([it && it.status, parked]));
    manager.removeByIds([id]);
    await sleep(50);
    config.download.retryBaseDelayMs = savedBase;
  }

  // ---- 6g. Vidsrc refusing this IP: TV is held, not given up --------------
  console.log('\n[6g] Vidsrc refuses this IP and no other site has it: held (worker freed), no try spent');
  {
    const sitesReg = M('sites');
    if (!sitesReg.profiles.length) sitesReg.init(DATA_DIR);
    const vs = sitesReg.resolve('https://vidsrc.sh/embed/tv/1408-1-9');
    const origDirect = vs.directResolve;
    vs.directResolve = async () => ({ status: 'busy', reason: 'refused', blocked: true });
    const vdl = M('sites/vidsrc_dl');
    vdl._setBlockedUntilForTests(Date.now() + 60000);
    const seen = [];
    const id = manager.add({
      label: 'House S1E9', series: 'House', season: 1, episode: 9, minHeight: 1080, tmdb: '1408',
      url: 'https://vidsrc.sh/embed/tv/1408-1-9', outputRoot: path.join(DATA_DIR, 'staging'),
      discover: (it) => { seen.push(!!it._skipVidsrcPages); return Promise.resolve({ status: 'failed', reason: 'No video sources found on the page' }); }
    });
    const it = manager.items.find((x) => x.id === id);
    for (let i = 0; i < 100 && !(it && it._notBefore); i++) await sleep(50);
    await sleep(100);
    check('held until the pause ends (queued, not failed)', it && it.status === 'queued' && it._notBefore > Date.now(), JSON.stringify([it && it.status, it && it._notBefore]));
    check('no try spent', it && it.attempts === 0, String(it && it.attempts));
    check('the other sites were asked, without Vidsrc\'s pages', seen.length === 1 && seen[0] === true, JSON.stringify(seen));
    check('its worker was freed', !manager._active.has(it));
    manager.removeByIds([id]);
    await sleep(50);
    vs.directResolve = origDirect;
    vdl._setBlockedUntilForTests(0);
  }

  // ---- 6h. 720p fallback is remembered per season ----------------------------
  console.log('\n[6h] After one episode fell back to 720p, the season\'s next episode skips the 1080p search');
  {
    const savedBase = config.download.retryBaseDelayMs;
    config.download.retryBaseDelayMs = 20;
    const sitesReg = M('sites');
    if (!sitesReg.profiles.length) sitesReg.init(DATA_DIR);
    const vs = sitesReg.resolve('https://vidsrc.sh/embed/tv/1408-2-1');
    const origDirect = vs.directResolve;
    const floors = [];
    vs.directResolve = async (ref) => { floors.push(ref.minHeight); return { status: 'no_quality' }; };
    const runEp = async (ep, season = 2) => {
      const discovers = [];
      const id = manager.add({
        label: `House S${season}E${ep}`, series: 'House', season, episode: ep, minHeight: 1080, tmdb: '1408',
        url: `https://vidsrc.sh/embed/tv/1408-${season}-${ep}`, outputRoot: path.join(DATA_DIR, 'staging'),
        discover: (it) => { discovers.push(it.minHeight); return Promise.resolve({ status: 'failed', reason: 'No 1080p stream on any source' }); }
      });
      const it = manager.items.find((x) => x.id === id);
      for (let i = 0; i < 200 && !(it && it.status === 'failed'); i++) await sleep(50);
      manager.removeByIds([id]);
      await sleep(50);
      return discovers;
    };
    const d1 = await runEp(1);
    check('first episode: the other sites are searched for 1080p before the fallback', d1.some((h) => h === 1080), JSON.stringify(d1));
    floors.length = 0;
    const d2 = await runEp(2);
    check('next episode of the season: no 1080p search on the other sites', !d2.some((h) => h === 1080), JSON.stringify(d2));
    check('...it goes straight to the 720p try on Vidsrc', floors.includes(720), JSON.stringify(floors));
    const d3 = await runEp(1, 5);
    check('another season of the same show skips it too (memory is per show)', !d3.some((h) => h === 1080), JSON.stringify(d3));
    check('the first episode searched the other sites only once before the fallback', d1.filter((h) => h === 1080).length === 1, JSON.stringify(d1));
    vs.directResolve = origDirect;
    config.download.retryBaseDelayMs = savedBase;
  }

  // ---- 7. Anime DUB: Vidsrc has only Japanese -> dub-aware sites; a
  //         finished file tagged only Japanese is rejected -------------------
  console.log('\n[7] Anime DUB never keeps a Japanese-only file');
  {
    const { spawnSync } = require('child_process');
    const media = path.join(DATA_DIR, 'ja.mp4');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=300',
      '-t', '25', '-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:a:0', 'language=jpn', '-movflags', '+faststart', media]);
    if (made.status !== 0) {
      check('ffmpeg made the test file', false, String(made.stderr));
    } else {
      const httpMod = require('http');
      const body = fs.readFileSync(media);
      const msrv = httpMod.createServer((req, res) => { res.setHeader('Content-Length', body.length); res.end(body); });
      await new Promise((r) => msrv.listen(0, '127.0.0.1', r));
      // The registry keeps its own copy of each profile: stub THAT one (and
      // load the registry, which the earlier sections never needed).
      const sitesReg = M('sites');
      if (!sitesReg.profiles.length) sitesReg.init(DATA_DIR);
      const vs = sitesReg.resolve('https://vidsrc.sh/embed/tv/123-1-1');
      check('the Vidsrc profile is the one stubbed (no real request)', vs && vs.id === 'vidsrc', vs && vs.id);
      const origDirect = vs.directResolve;
      let directCalls = 0;
      vs.directResolve = async () => { directCalls += 1; return { status: 'wrong_audio', reason: 'audio is Japanese (audio stream tags), not an English dub' }; };
      // Anime Village (asked first for anime): no dub of this show yet.
      const avMod = M('sites/animevillage');
      const origAv = avMod.resolveForJob;
      let avCalls = 0;
      avMod.resolveForJob = async () => { avCalls += 1; return { status: 'none', reason: 'Anime Village has no English dub of "Dub Show" E1 yet', notDubbed: true }; };
      let discovers = 0;
      const liveFlags = [];
      const dlogs = [];
      const realLog4 = manager._log.bind(manager);
      manager._log = (m) => { dlogs.push(m); realLog4(m); };
      const did = manager.add({
        label: 'Dub Show S1E1',
        series: 'Dub Show',
        season: 1,
        episode: 1,
        mode: 'dub',
        anime: true,
        minHeight: 0,
        url: 'https://vidsrc.sh/embed/tv/123-1-1',
        outputRoot: path.join(DATA_DIR, 'staging'),
        discover: (it) => {
          discovers += 1;
          liveFlags.push(!!(it && it._wrongAudio));
          // A server from a DUB row (so it passes the "proof of dub" rule)
          // that actually serves Japanese: the audio check must catch it.
          return Promise.resolve({ status: 'resolved', detection: { url: `http://127.0.0.1:${msrv.address().port}/ja.mp4`, type: 'mp4', sourceLabel: 'JapaneseServer', dubEvidence: 'row' } });
        }
      });
      const ditem = manager.items.find((x) => x.id === did);
      for (let i = 0; i < 150 && !(discovers >= 2 && ditem.attempts >= 2); i++) await sleep(100);
      check('anime: Anime Village first, then Aniwave discovery', avCalls >= 1 && discovers >= 1, 'avCalls=' + avCalls + ' discovers=' + discovers);
      check('anime never asks Vidsrc', directCalls === 0, 'directCalls=' + directCalls);
      check('the Japanese-only file was rejected, not kept', dlogs.some((m) => /downloaded audio is Japanese, not an English dub/.test(m)), dlogs.slice(-4).join(' | '));
      check('nothing was saved for the episode', !fs.existsSync(path.join(DATA_DIR, 'staging', 'Dub Show', 'Season 1', 'Dub Show S1E1.mp4')));
      check('the server that served it is skipped next time', (ditem.skipSources || []).includes('japaneseserver'), JSON.stringify(ditem.skipSources));
      // manager.add() copies the record: discovery must get the LIVE item,
      // or "skip the Vidsrc page" never reaches it (live run: 54 s wasted).
      check('discovery receives the live item with the skip-source flag set', liveFlags.length > 0 && liveFlags[0] === true, JSON.stringify(liveFlags));
      manager.removeByIds([did]);
      await sleep(200);

      // Anime Village's own file turns out not to be English: it is skipped
      // for the series from then on (like any server caught that way).
      avCalls = 0;
      avMod.resolveForJob = async () => {
        avCalls += 1;
        return { status: 'resolved', detection: { url: `http://127.0.0.1:${msrv.address().port}/ja.mp4`, type: 'mp4', sourceLabel: 'animevillage', dubEvidence: 'separate-dub-file' } };
      };
      let avDiscovers = 0;
      const aid = manager.add({
        label: 'Av Show S1E1', series: 'Av Show', season: 1, episode: 1, mode: 'dub', anime: true, minHeight: 0,
        url: 'https://vidsrc.sh/embed/tv/125-1-1', outputRoot: path.join(DATA_DIR, 'staging'),
        discover: () => { avDiscovers += 1; return Promise.resolve({ status: 'unavailable', reason: 'test' }); }
      });
      const aitem = manager.items.find((x) => x.id === aid);
      for (let i = 0; i < 150 && avDiscovers < 1; i++) await sleep(100);
      check('Anime Village file with Japanese audio: rejected, Anime Village skipped next', avCalls === 1 && avDiscovers >= 1 && (aitem.skipSources || []).includes('animevillage'), 'avCalls=' + avCalls + ' discovers=' + avDiscovers + ' skip=' + JSON.stringify(aitem.skipSources));
      check('...nothing was saved', !fs.existsSync(path.join(DATA_DIR, 'staging', 'Av Show', 'Season 1', 'Av Show S1E1.mp4')));
      manager.removeByIds([aid]);
      await sleep(150);
      avMod.resolveForJob = async () => ({ status: 'none', reason: 'test' });

      // The NEXT episode of the same series starts with that server skipped
      // (live: Aniwave's "MyCloud" DUB-row server served Chinese audio for
      // every Link Click S3 episode, ~3.5 min wasted each).
      let nextSkip = null;
      const nid = manager.add({
        label: 'Dub Show S1E2', series: 'Dub Show', season: 1, episode: 2, mode: 'dub', anime: true, minHeight: 0,
        url: 'https://example.invalid/e2', outputRoot: path.join(DATA_DIR, 'staging'),
        discover: (it) => { nextSkip = (it && it.skipSources) || []; return Promise.resolve({ status: 'unavailable', reason: 'test' }); }
      });
      for (let i = 0; i < 40 && nextSkip === null; i++) await sleep(100);
      check('the next episode of the series skips that server from the start', Array.isArray(nextSkip) && nextSkip.includes('japaneseserver'), JSON.stringify(nextSkip));
      manager.removeByIds([nid]);
      await sleep(100);

      // An UNLABELLED player (no DUB row, no -dub marker): nothing is
      // downloaded at all - the episode waits for its dub.
      const plogs = [];
      manager._log = (m) => { plogs.push(m); realLog4(m); };
      const uid = manager.add({
        label: 'Plain Show S1E1',
        series: 'Plain Show',
        season: 1,
        episode: 1,
        mode: 'dub',
        anime: true,
        minHeight: 0,
        url: 'https://vidsrc.sh/embed/tv/124-1-1',
        outputRoot: path.join(DATA_DIR, 'staging'),
        discover: () => Promise.resolve({ status: 'resolved', detection: { url: `http://127.0.0.1:${msrv.address().port}/ja.mp4`, type: 'mp4', sourceLabel: 'episode-page' } })
      });
      const uitem = manager.items.find((x) => x.id === uid);
      for (let i = 0; i < 60 && uitem.status !== 'waiting'; i++) await sleep(100);
      check('unlabelled player: not downloaded, waits for the dub', uitem.status === 'waiting', uitem.status);
      check('...and the log says it had no proof of a dub', plogs.some((m) => /no proof it is the English dub \(episode-page\)/.test(m)), plogs.slice(-3).join(' | '));
      check('...no file was saved', !fs.existsSync(path.join(DATA_DIR, 'staging', 'Plain Show', 'Season 1', 'Plain Show S1E1.mp4')));
      manager.removeByIds([uid]);
      await sleep(150);
      vs.directResolve = origDirect;
      avMod.resolveForJob = origAv;
      manager._log = realLog4;
      msrv.close();
    }
  }

  if (manager._watchdogTimer) clearInterval(manager._watchdogTimer);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(1);
});
