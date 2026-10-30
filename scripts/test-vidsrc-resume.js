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

  // ---- [5] abort must KILL an in-flight fetch (the 12:53-01:13 regression) ---
  // A segment that never ends used to pin its worker forever: the watchdog's
  // abort could not reach it, so a killed download was un-killable and the
  // queue looped "killing every 30s" for hours. Now abort tears down the
  // in-flight request immediately.
  console.log('\n[5] Abort kills an in-flight fetch instantly');
  {
    const state = { done: [] };
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/stall.ts') {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.write('partial-bytes-');
        // connection stays open, response never ends
        return;
      }
      const m = u.pathname.match(/^\/seg(\d+)\.ts$/);
      if (m) {
        state.done.push(m[1]);
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        return res.end(SEG_BODY(Number(m[1])));
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    const dir = fs.mkdtempSync(path.join(DATA_DIR, 'abort-'));
    // 1 fast segment + 1 stalling segment
    const text = ['#EXTM3U', '#EXTINF:5,', `${base}/seg1.ts`, '#EXTINF:5,', `${base}/stall.ts`, '#EXT-X-ENDLIST', ''].join('\n');
    const ctrl = new AbortController();
    let err = null;
    const t0 = Date.now();
    const run = localizePlainSegments(text, base, dir, 'test-ua', { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    try {
      await run;
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    srv.close();
    check('rejected (did not hang forever)', !!err, 'no error - hung?');
    check('...as an AbortError', err && err.name === 'AbortError', err && `${err.name}: ${err.message}`);
    check('...promptly (< 2s after abort)', elapsed < 2500, elapsed + 'ms');
    check('the healthy part was still saved for resume', fs.existsSync(path.join(dir, 'seg00000.ts')),
      fs.readdirSync(dir).join(','));
  }

  // ---- [6] a drip-forever segment is bounded by the ABSOLUTE deadline -------
  // The idle timeout only fires on a fully silent socket; a connection that
  // keeps sending (or keep-alive noise) must still be cut off. Without the
  // deadline this pinned the worker indefinitely (the kill-loop regression).
  console.log('\n[6] Drip-forever segment hits the absolute deadline');
  {
    const config = M('config');
    const origIdle = config.download.segmentIdleMs;
    const origDeadline = config.download.segmentDeadlineMs;
    config.download.segmentIdleMs = 150;
    config.download.segmentDeadlineMs = 250;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const m = u.pathname.match(/^\/seg(\d+)\.ts$/);
      if (m) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        // Trickle: a byte every 50ms keeps the idle timer from ever firing,
        // but the response NEVER ends.
        res.write('x');
        const t = setInterval(() => {
          try {
            res.write('x');
          } catch (e) {
            clearInterval(t);
          }
        }, 50);
        req.on('close', () => clearInterval(t));
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    const text = ['#EXTM3U', '#EXTINF:5,', `${base}/seg1.ts`, '#EXT-X-ENDLIST', ''].join('\n');
    const dir = fs.mkdtempSync(path.join(DATA_DIR, 'drip-'));
    let err = null;
    const t0 = Date.now();
    try {
      await localizePlainSegments(text, base, dir, 'test-ua', {});
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    srv.close();
    config.download.segmentIdleMs = origIdle;
    config.download.segmentDeadlineMs = origDeadline;
    check('rejected (not pinned forever)', !!err, 'no error - hung?');
    check('deadline named in the error', err && /deadline|timeout/i.test(err.message), err && err.message);
    check('bounded (finished in < 15s despite the endless drip)', elapsed < 15000, elapsed + 'ms');
  }

  // ---- [7] 429: fail fast, no orphan siblings, counter never exceeds total ---
  // 02:40 PM incident: one part got a 429, but the other 7 workers kept
  // fetching (a second run then stacked on top), and the per-part retry
  // loop hammered the same 429 3x. Now: a 429 fails the run immediately,
  // tears down every in-flight sibling, and progress stays <= total.
  console.log('\n[7] 429 fails fast; no orphan workers; progress never exceeds total');
  {
    const TEN = 10; // more parts than workers (8): parts 9,10 are ONLY reachable
    // by a worker that loops back to the queue after the 429 already killed
    // the run - the exact orphan behavior the fix removes.
    const state = { segRequests: [] };
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const m = u.pathname.match(/^\/seg(\d+)\.ts$/);
      if (m) {
        const i = Number(m[1]);
        state.segRequests.push(i);
        if (i === 2) {
          res.writeHead(429, { 'Content-Type': 'text/plain' });
          return res.end('rate limited');
        }
        // Healthy segments land well AFTER the instant 429, so any worker
        // that finishes one and loops back must see the run already aborted.
        const t = setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'video/mp2t' });
            res.end(SEG_BODY(i));
          } catch (e) { /* aborted */ }
        }, 50);
        req.on('close', () => clearTimeout(t));
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    let text = '#EXTM3U\n';
    for (let i = 1; i <= TEN; i++) text += `#EXTINF:5.0,\n${base}/seg${i}.ts\n`;
    text += '#EXT-X-ENDLIST\n';
    const dir = fs.mkdtempSync(path.join(DATA_DIR, '429-'));
    let maxReceived = 0;
    let err = null;
    try {
      await localizePlainSegments(text, base, dir, 'test-ua', {
        onProgress: (p) => {
          if (p.received > maxReceived) maxReceived = p.received;
        }
      });
    } catch (e) {
      err = e;
    }
    check('rejected', !!err, 'no error - hung?');
    check('...with the 429, not a token-expiry error', err && err.status === 429 && !err.tokenExpired, err && `${err.status}: ${err.message}`);
    const hits = (i) => state.segRequests.filter((r) => r === i).length;
    check('the 429 part was NOT retried per-segment (exactly 1 hit)', hits(2) === 1, 'hits=' + hits(2));
    check('no orphan worker looped back to new parts (9,10 untouched)', hits(9) === 0 && hits(10) === 0, JSON.stringify(state.segRequests));
    check('total requests bounded (no stacked double-run)', state.segRequests.length <= 8, 'total=' + state.segRequests.length + ' ' + JSON.stringify(state.segRequests));
    check('progress never exceeded the total', maxReceived <= TEN, `max=${maxReceived}/${TEN}`);
    srv.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
