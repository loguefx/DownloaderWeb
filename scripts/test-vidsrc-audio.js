'use strict';

// Vidsrc audio honesty + segment integrity tests.
//
// [1] classifyAudio: the release-name heuristic that tells us which audio a
//     Vidsrc file carries (Vidsrc has NO dub/sub toggle - one fixed file per
//     episode - so this is the only way to know before downloading).
// [2] plainHttpBuffer: a 200 response that closes BEFORE delivering its
//     Content-Length bytes must FAIL (a truncated segment used to be written
//     to disk and muxed into the final MP4 as a visible skip/glitch).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-audio-'));

const shim = {
  app: { getPath: () => DATA_DIR, on: () => {}, once: () => {}, whenReady: () => Promise.resolve(), quit: () => {}, setLoginItemSettings: () => {}, getName: () => 'wvd' },
  ipcMain: { handle() {}, on() {} },
  session: { fromPartition: () => ({ setUserAgent() {}, setPermissionRequestHandler() {}, webRequest: { onBeforeSendHeaders() {} }, clearCache: () => Promise.resolve() }) },
  BrowserWindow: class { constructor() { throw new Error('no window in test'); } }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return shim;
  return origLoad.apply(this, arguments);
};

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

async function main() {
  // ---- [1] classifyAudio ----------------------------------------------------
  console.log('\n[1] classifyAudio (release-name -> audio kind)');
  const v = require(path.join(REPO, 'src/main/sites/vidsrc.js'));
  const realCr = 'Smoking Behind the Supermarket with You S01E03 Episode 3 1080p CR WEB-DL DDP2 0 H 264-Kitsune.mkv';
  const realHulu = 'One Piece (1999) S01E01 (1080p HULU WEB-DL H264 SDR AAC 2.0 English - HONE).mkv';
  check('CR WEB-DL (the Smoking Behind file) -> sub', v.classifyAudio(realCr) === 'sub', v.classifyAudio(realCr));
  check('HULU English (the One Piece file) -> dub', v.classifyAudio(realHulu) === 'dub', v.classifyAudio(realHulu));
  check('multi-audio name -> multi', v.classifyAudio('Foo S01E01 Multi Audio (English + Japanese) 1080p') === 'multi');
  check('no markers -> unknown (never guess)', v.classifyAudio('Vivant S03E01 1080p WEB-DL') === 'unknown', v.classifyAudio('Vivant S03E01 1080p WEB-DL'));
  check('empty -> unknown', v.classifyAudio('') === 'unknown');
  check('RAW -> sub', v.classifyAudio('Some Show S01E01 1080p RAW H 265') === 'sub');

  // ---- [2] truncated body must fail ----------------------------------------
  console.log('\n[2] plainHttpBuffer rejects a body cut short of its Content-Length');
  const dl = require(path.join(REPO, 'src/main/downloader.js'));
  {
    const srv = http.createServer((req, res) => {
      if (req.url === '/trunc.ts') {
        // Announce 1000 bytes, deliver 10, then HARD-CLOSE the socket - the
        // CDN's rate-limit cut. (res.end alone would let Node keep the
        // connection open and the client would idle-timeout instead of seeing
        // the early end, which is not the real-world shape of the bug.)
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': '1000' });
        res.write('0123456789');
        setImmediate(() => {
          try {
            res.socket.destroy();
          } catch (e) {
            /* already gone */
          }
        });
        return;
      }
      if (req.url === '/ok.ts') {
        const body = 'x'.repeat(512);
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(body.length) });
        return res.end(body);
      }
      if (req.url === '/chunked.ts') {
        // No Content-Length (chunked): integrity cannot be checked; a complete
        // body must still pass.
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Transfer-Encoding': 'chunked' });
        return res.end('chunked-body');
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    let truncErr = null;
    try {
      await dl.plainHttpBuffer(`${base}/trunc.ts`, 'test-ua', 5000);
    } catch (e) {
      truncErr = e;
    }
    check('truncated body rejected', !!truncErr, 'resolved - bug still present');
    check('...named as truncation', truncErr && /truncated/i.test(truncErr.message), truncErr && truncErr.message);

    const okBuf = await dl.plainHttpBuffer(`${base}/ok.ts`, 'test-ua', 5000);
    check('exact-length body accepted', okBuf.length === 512, String(okBuf.length));

    const ch = await dl.plainHttpBuffer(`${base}/chunked.ts`, 'test-ua', 5000);
    check('chunked (no Content-Length) body accepted', ch.toString() === 'chunked-body', ch.toString());

    srv.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
