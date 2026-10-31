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
      let discovers = 0;
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
        discover: () => {
          discovers += 1;
          // A server from a DUB row (so it passes the "proof of dub" rule)
          // that actually serves Japanese: the audio check must catch it.
          return Promise.resolve({ status: 'resolved', detection: { url: `http://127.0.0.1:${msrv.address().port}/ja.mp4`, type: 'mp4', sourceLabel: 'JapaneseServer', dubEvidence: 'row' } });
        }
      });
      const ditem = manager.items.find((x) => x.id === did);
      for (let i = 0; i < 150 && !(discovers >= 2 && ditem.attempts >= 2); i++) await sleep(100);
      check('Vidsrc wrong audio -> dub-aware discovery runs', discovers >= 1 && directCalls >= 1, 'discovers=' + discovers + ' directCalls=' + directCalls);
      check('...and says why', dlogs.some((m) => /trying sites with a DUB option/.test(m)), dlogs.slice(0, 4).join(' | '));
      check('the Japanese-only file was rejected, not kept', dlogs.some((m) => /downloaded audio is Japanese, not an English dub/.test(m)), dlogs.slice(-4).join(' | '));
      check('nothing was saved for the episode', !fs.existsSync(path.join(DATA_DIR, 'staging', 'Dub Show', 'Season 1', 'Dub Show S1E1.mp4')));
      check('the server that served it is skipped next time', (ditem.skipSources || []).includes('japaneseserver'), JSON.stringify(ditem.skipSources));
      check('later attempts do not ask Vidsrc again', directCalls === 1, 'directCalls=' + directCalls);
      manager.removeByIds([did]);
      await sleep(200);

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
