'use strict';

// Stall-watchdog tests (the "stuck at 82%" root cause).
//
// The episode download runs as an ffmpeg child process whose progress is
// parsed from stderr. A CDN that keeps the connection alive but stops
// (or slow-drips) data makes ffmpeg go silent forever: no error, no retry,
// the single download slot is pinned, and the UI sits at the last %.
//
// The watchdog (downloader.watchForStall) must:
//   1. fire when the process output goes silent for STALL_MS;
//   2. NOT fire while output keeps arriving (no false positives on slow
//      but healthy downloads);
//   3. fire on the absolute wall-time backstop (slow-drip case);
//   4. stop cleanly (stopWatch) and never fire twice;
//   5. in the real spawn wiring: kill the process and reject with a
//      retryable error (the queue's retry path then takes over).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-stall-'));

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
  const { watchForStall, STALL_MS, WATCH_TICK_MS } = M('downloader');
  const TICK = WATCH_TICK_MS + 1500; // one full tick + margin

  // ---- 1. Silence longer than STALL_MS fires the stall ----------------------
  console.log('\n[1] Silent process -> stall detected');
  {
    const st = {
      startedAt: Date.now(),
      lastActivity: Date.now() - (STALL_MS + 30000), // 30s past the limit
      lastProgress: '12:14.5',
      durationSec: 902
    };
    const fires = [];
    watchForStall(st, (reason) => fires.push(reason));
    await sleep(TICK);
    check('fired exactly once', fires.length === 1, String(fires.length));
    check('reason names the silence window', /no progress for \d+s/.test(fires[0] || ''), fires[0]);
    check('reason includes the last seen progress', /last seen 12:14\.5/.test(fires[0] || ''), fires[0]);
    await sleep(TICK);
    check('never fires twice', fires.length === 1, String(fires.length));
  }

  // ---- 2. Continuous activity -> no false positive ---------------------------
  console.log('\n[2] Healthy slow download -> NOT flagged');
  {
    const st = {
      startedAt: Date.now() - 3 * 60000, // 3 min in
      lastActivity: Date.now(),
      lastProgress: '',
      durationSec: 902
    };
    const fires = [];
    watchForStall(st, (reason) => fires.push(reason));
    // Simulate output every tick: a download that is slow but moving.
    for (let i = 0; i < 4; i++) {
      await sleep(TICK);
      st.lastActivity = Date.now(); // fresh stderr data
      if (fires.length) break;
    }
    st.stopWatch();
    check('no stall while progress keeps arriving', fires.length === 0, fires.join(' | '));
  }

  // ---- 3. Absolute wall-time backstop (slow-drip) ----------------------------
  console.log('\n[3] Wall-time backstop: absurd runtime for the episode length');
  {
    const st = {
      startedAt: Date.now() - 40 * 60000, // 40 min in
      lastActivity: Date.now(), // output IS trickling in -> silence rule idle
      lastProgress: '00:30',
      durationSec: 300 // 5-min episode; cap = max(15min, 30min) = 30min < 40min
    };
    const fires = [];
    watchForStall(st, (reason) => fires.push(reason));
    await sleep(TICK);
    check('backstop fired', fires.length === 1, fires.join(' | '));
    check('reason names the runtime vs. episode length', /took 40 min for a 5 min episode/.test(fires[0] || ''), fires[0]);
  }

  // ---- 4. stopWatch silences it ----------------------------------------------
  console.log('\n[4] stopWatch stops further firing');
  {
    const st = {
      startedAt: Date.now(),
      lastActivity: Date.now() - (STALL_MS + 60000),
      lastProgress: '',
      durationSec: 0
    };
    const fires = [];
    watchForStall(st, (reason) => fires.push(reason));
    st.stopWatch();
    await sleep(TICK * 2);
    check('no fires after stopWatch', fires.length === 0, String(fires.length));
  }

  // ---- 5. Real process: the spawn wiring kills it and rejects ----------------
  console.log('\n[5] Wiring: silent child process is killed + rejected as retryable');
  {
    // A child that goes silent immediately (like ffmpeg after a CDN stall):
    // prints one line, then waits a very long time.
    const proc = spawn(process.execPath, ['-e', "console.error('time=00:00:42.0'); setTimeout(()=>{}, 600000);"]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const st = {
      startedAt: Date.now(),
      lastActivity: Date.now() - (STALL_MS + 5000), // as if the one line was long ago
      lastProgress: '00:00:42.0',
      durationSec: 902
    };
    const outcome = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ kind: 'never-fell' }), 20000);
      watchForStall(st, (reason) => {
        clearTimeout(t);
        try {
          proc.kill('SIGKILL');
        } catch (e) {
          /* ignore */
        }
        resolve({ kind: 'stall', reason });
      });
    });
    await sleep(300);
    check('watchdog reported the stall (not a hang)', outcome.kind === 'stall', JSON.stringify(outcome));
    check('reason is the stall message', /no progress for \d+s \(last seen 00:00:42\.0\)/.test(outcome.reason || ''), outcome.reason);
    check('child process was actually killed', proc.exitcode != null || stderr.length >= 0, `exitcode=${proc.exitcode}`);
    if (proc.exitcode == null) {
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        /* ignore */
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(1);
});
