'use strict';

// Placement (library-drive move) tests.
//
// The move now runs in a CHILD process with a hard timeout (a hung NAS
// share must be killable, not freeze the engine). These tests pin:
//   1. new file, same volume -> renamed into place, staged consumed;
//   2. new file, cross-volume -> copied, size-checked, staged consumed;
//   3. overwrite of an unrelated file is REFUSED (child re-checks);
//   4. same-name replacement: old file trashed (never deleted), new in place;
//   5. different-name replacement (hand-named file -> canonical path):
//      old trashed, new in place (the old code path ENOENT'd here);
//   6. hung share (child sleeps) -> parent times out, kills it, and reports
//      a retryable error.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-place-'));

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
const listAll = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};
const mk = (p, bytes) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
};
const trashOf = (fileDir) => listAll(path.join(fileDir, '.mediadownloader-trash'));

async function main() {
  const library = M('library');
  const lib = library.createLibrary({ dataDir: path.join(DATA_DIR, 'libdata') });
  const root = path.join(DATA_DIR, 'drive');
  const stagedDir = path.join(DATA_DIR, 'staging');

  // ---- 1. new file, same volume ------------------------------------------------
  console.log('\n[1] Same-volume new file');
  lib._sameVolume = () => true;
  const f1 = path.join(root, 'Show/Season 1/Show S1E01.mp4');
  const s1 = mk(path.join(stagedDir, 'Show S1E01.mp4'), 'bytes-A');
  await lib.safePlace({ partPath: s1, finalPath: f1, replacePath: null });
  check('new file is in place', fs.existsSync(f1) && fs.readFileSync(f1, 'utf8') === 'bytes-A');
  check('staged copy consumed by the rename', !fs.existsSync(s1));
  check('ledger recorded', lib.isOurs(f1));

  // ---- 2. new file, cross-volume (copy + size check) ---------------------------
  console.log('\n[2] Cross-volume new file');
  lib._sameVolume = () => false;
  const f2 = path.join(root, 'Show/Season 1/Show S1E02.mp4');
  const s2 = mk(path.join(stagedDir, 'Show S1E02.mp4'), 'bytes-B'.repeat(1000));
  await lib.safePlace({ partPath: s2, finalPath: f2, replacePath: null });
  check('copied file is in place with the right bytes', fs.existsSync(f2) && fs.readFileSync(f2, 'utf8') === 'bytes-B'.repeat(1000));
  check('staged source consumed after the verified copy', !fs.existsSync(s2));
  check('no .partial left behind', !fs.existsSync(f2 + '.partial'));

  // ---- 3. overwrite refusal (the child re-checks) ------------------------------
  console.log('\n[3] Overwrite refusal');
  const foreign = path.join(root, 'Foreign/F.txt');
  mk(foreign, 'do-not-touch');
  const s3 = mk(path.join(stagedDir, 'F.txt'), 'new-bytes');
  let refused = null;
  try {
    await lib.safePlace({ partPath: s3, finalPath: foreign, replacePath: null });
  } catch (e) {
    refused = e;
  }
  check('refused', !!refused && /Refusing to overwrite/.test(refused.message), refused && refused.message);
  check('foreign file untouched', fs.readFileSync(foreign, 'utf8') === 'do-not-touch');

  // ---- 4. same-name replacement: old to trash, new in place ---------------------
  console.log('\n[4] Same-name replacement');
  lib._sameVolume = () => true;
  const f4 = path.join(root, 'Show/Season 1/Show S1E03.mp4');
  mk(f4, 'low-quality');
  lib.recordPlaced(f4, 11);
  const s4 = mk(path.join(stagedDir, 'Show S1E03.mp4'), 'higher-quality');
  await lib.safePlace({ partPath: s4, finalPath: f4, replacePath: f4 });
  check('new file in place', fs.readFileSync(f4, 'utf8') === 'higher-quality');
  const trashed4 = trashOf(path.dirname(f4)).some((p) => /Show S1E03\.mp4$/.test(p));
  check('old file in the trash (never deleted)', trashed4);

  // ---- 5. different-name replacement (hand-named -> canonical) ------------------
  console.log('\n[5] Different-name replacement');
  const f5 = path.join(root, 'Hand/Canonical S1E01.mp4');
  const handNamed = path.join(root, 'Hand/My Hand Named Episode.mp4');
  mk(handNamed, 'old-hand-named');
  lib.recordPlaced(handNamed, 14);
  const s5 = mk(path.join(stagedDir, 'Canonical S1E01.mp4'), 'new-canonical');
  let err5 = null;
  try {
    await lib.safePlace({ partPath: s5, finalPath: f5, replacePath: handNamed });
  } catch (e) {
    err5 = e;
  }
  check('no error (the old code path ENOENTed here)', !err5, err5 && err5.message);
  check('canonical path has the new file', fs.existsSync(f5) && fs.readFileSync(f5, 'utf8') === 'new-canonical');
  check('hand-named old file trashed (never deleted)', trashOf(path.dirname(f5)).some((p) => /My Hand Named Episode\.mp4$/.test(p)));

  // ---- 6. hung share: child is killed on timeout --------------------------------
  console.log('\n[6] Hung share: timeout kills the child, error is retryable');
  const f6 = path.join(root, 'Hang/H.mp4');
  const s6 = mk(path.join(stagedDir, 'H.mp4'), 'hang-bytes');
  let hung = null;
  const t0 = Date.now();
  try {
    await lib.runMove(
      { partPath: s6, finalPath: f6, expectExisting: false, sameVolume: true, sleepMs: 30000 },
      700
    );
  } catch (e) {
    hung = e;
  }
  const took = Date.now() - t0;
  check('timed out (not hung forever)', !!hung, 'resolved?!');
  check('error says the drive may be hung + retry', hung && /timed out/i.test(hung.message) && /retry/i.test(hung.message), hung && hung.message);
  check('failed fast (well under the child sleep)', took < 5000, took + 'ms');
  check('staged file still safe in staging', fs.existsSync(s6));
  check('no file appeared at the final path', !fs.existsSync(f6));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(1);
});
