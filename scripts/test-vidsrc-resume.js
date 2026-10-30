'use strict';

// Vidsrc headless segment download: resume + fail-fast-on-403 tests.
//
// The CDN's signed segment URLs are short-lived: a long download can outlive
// its own token, and a killed/retried download must NOT re-download the parts
// it already saved. localizePlainSegments:
//   1. fetches every playlist part over plain HTTP into the work dir;
//   2. RESUMES: parts already on disk are skipped (no request at all);
//   3. FAILS FAST on a 403 (expired token) so the queue can re-resolve a
//      fresh token and resume, keeping the parts already saved;
//   4. rewrites the playlist to local names for the final local remux.
// A fake CDN on 127.0.0.1 counts requests so resume is provable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-resume-'));

// ---- electron shim (downloader.js touches it via config/session) -----------
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
      throw new Error('BrowserWindow unavailable in test (expected)');
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

const N = 5; // segments per playlist
const SEG_BODY = (i) => Buffer.from(`segment-${i}-payload-${'x'.repeat(64)}`);
// localizePlainSegments names parts zero-based: segment 1 -> seg00000.ts.
const partName = (segI) => 'seg' + String(segI - 1).padStart(5, '0') + '.ts';

function playlistText(base) {
  let t = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
  for (let i = 1; i <= N; i++) {
    t += '#EXTINF:5.0,\n';
    t += `${base}/seg${i}.ts\n`;
  }
  t += '#EXT-X-ENDLIST\n';
  return t;
}

// Fake CDN: counts segment requests; can 403 a chosen segment.
function startCdn({ fail403 } = {}) {
  const state = { segRequests: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/media.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(playlistText('http://127.0.0.1:' + srv._port));
    }
    const m = u.pathname.match(/^\/seg(\d+)\.ts$/);
    if (m) {
      const i = Number(m[1]);
      state.segRequests.push(i);
      if (fail403 && i === fail403) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('invalid token');
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      return res.end(SEG_BODY(i));
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      srv._port = srv.address().port;
      resolve({ srv, state });
    });
  });
}

async function main() {
  const dl = M('downloader');
  const { localizePlainSegments } = dl;

  // ---- [1] full download: every part saved + playlist localized -------------
  console.log('\n[1] Full download saves every part and rewrites the playlist');
  {
    const { srv, state } = await startCdn();
    const dir = fs.mkdtempSync(path.join(DATA_DIR, 'full-'));
    const base = `http://127.0.0.1:${srv._port}`;
    const text = playlistText(base);
    let lastPct = null;
    const logs = [];
    try {
      const pl = await localizePlainSegments(text, base, dir, 'test-ua', {
        onProgress: (p) => {
          lastPct = p.percent;
        },
        onLog: (m) => logs.push(m)
      });
      const files = fs.readdirSync(dir).filter((f) => /^seg\d{5}\.ts$/.test(f)).sort();
      check('all 5 parts saved', files.length === N, files.join(','));
      check('part content intact', fs.readFileSync(path.join(dir, partName(1))).equals(SEG_BODY(1)) && fs.readFileSync(path.join(dir, partName(5))).equals(SEG_BODY(5)));
      const idx = fs.readFileSync(pl, 'utf8');
      check('playlist rewritten to local names', /seg00001\.ts/.test(idx) && !/127\.0\.0\.1/.test(idx), idx.slice(0, 120));
      check('progress reached ~100%', lastPct != null && lastPct > 0.99, String(lastPct));
      check('all segments requested exactly once', state.segRequests.length === N, JSON.stringify(state.segRequests));
    } finally {
      srv.close();
    }
  }

  // ---- [2] resume: parts on disk are skipped (zero requests for them) -------
  console.log('\n[2] Resume skips parts already on disk');
  {
    const { srv, state } = await startCdn();
    const dir = fs.mkdtempSync(path.join(DATA_DIR, 'resume-'));
    const base = `http://127.0.0.1:${srv._port}`;
    const text = playlistText(base);
    // A previous (killed) attempt saved parts 1-3.
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(dir, partName(i)), SEG_BODY(i));
    const logs = [];
    try {
      const pl = await localizePlainSegments(text, base, dir, 'test-ua', { onLog: (m) => logs.push(m) });
      check('only the 2 missing parts were requested', [...state.segRequests].sort().join(',') === '4,5', JSON.stringify(state.segRequests));
      check('resumed parts kept their content', fs.readFileSync(path.join(dir, partName(2))).equals(SEG_BODY(2)));
      check('missing part fetched', fs.readFileSync(path.join(dir, partName(5))).equals(SEG_BODY(5)));
      check('log announces the resume', logs.some((m) => /Resuming download: 3\/5/.test(m)), logs.join(' | '));
      const idx = fs.readFileSync(pl, 'utf8');
      check('playlist still complete and local', (idx.match(/seg0000\d\.ts/g) || []).length === N, idx.slice(0, 160));
    } finally {
      srv.close();
    }
  }

  // ---- [3] 403 mid-download: fail fast, keep saved parts --------------------
  console.log('\n[3] Expired token (403) fails fast and keeps saved parts');
  {
    const { srv, state } = await startCdn({ fail403: 4 });
    const dir = fs.mkdtempSync(path.join(DATA_DIR, '403-'));
    const base = `http://127.0.0.1:${srv._port}`;
    const text = playlistText(base);
    let err = null;
    try {
      await localizePlainSegments(text, base, dir, 'test-ua', {});
    } catch (e) {
      err = e;
    }
    check('threw an error', !!err, 'no error');
    check('error flags the expired token', err && !!err.tokenExpired, err && err.message);
    check('error message says resume will continue', err && /resume from \d+\/5 part/.test(err.message), err && err.message);
    // Parts 1-3 should be saved (4 is 403, 5 may or may not have landed).
    const saved = [1, 2, 3].filter((i) => fs.existsSync(path.join(dir, partName(i))));
    check('parts before the 403 were kept for resume', saved.length === 3, 'saved=' + saved.join(','));
    // A follow-up run with a "fresh token" (server no longer 403s) completes.
    // Simulate an interrupted run: part 5 may already have landed during the
    // first (failed) pass - drop it so the resume must demonstrably refetch.
    try { fs.unlinkSync(path.join(dir, partName(5))); } catch (e) { /* may be absent */ }
    const { srv: srv2, state: state2 } = await startCdn();
    const dir2 = dir; // same dir -> resume
    const base2 = `http://127.0.0.1:${srv2._port}`;
    // Rewrite the playlist to the new CDN (fresh token = new URLs), same order.
    const text2 = playlistText(base2);
    try {
      const pl = await localizePlainSegments(text2, base2, dir2, 'test-ua', {});
      const complete = [1, 2, 3, 4, 5].every((i) => fs.existsSync(path.join(dir2, partName(i))) && fs.readFileSync(path.join(dir2, partName(i))).length > 0);
      check('retry completed the download', complete, 'incomplete');
      const reqSet = [...state2.segRequests].sort().join(',');
      check('retry only fetched the missing tail (4,5)', reqSet === '4,5', JSON.stringify(state2.segRequests));
      const idx = fs.readFileSync(pl, 'utf8');
      check('final playlist is local + complete', (idx.match(/seg0000\d\.ts/g) || []).length === N, idx.slice(0, 160));
    } finally {
      srv.close();
      srv2.close();
    }
  }

  // ---- [4] diagnostics API shape --------------------------------------------
  console.log('\n[4] lastFfmpegStderr shape');
  {
    const snap = dl.lastFfmpegStderr();
    check('returns { tail, at }', snap && typeof snap.tail === 'string' && typeof snap.at === 'number', JSON.stringify(snap));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
