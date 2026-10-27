'use strict';

// Speed/parallelism tests for the Vidsrc headless resolver (vidsrc_dl.js).
//
// The old path was 8-10 sequential HTTPS round-trips (token chain on the
// first relay host, data API, then per-source token->master->index->segment
// ->ffprobe), 20-30s timeouts per hop, a 1.2s throttle between EVERY call,
// and a sequential relay/source fallback. Over a VPN that measured 17-42s
// before a single episode's download could begin.
//
// These tests pin the fast behaviour with a fake HTTP router:
//   - a SLOW first relay host must not block the token (parallel race);
//   - a SLOW/DEAD source[0] must not block source[1]'s verification;
//   - the data-API throttle must not pad the per-source CDN calls.
// A fake `ffprobe` on PATH answers the real-height probe.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vsdl-speed-'));

// ---- electron shim (downloader.js may touch it via the ffmpeg resolver) ----
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

// ---- fake ffprobe (answers the real-height probe) ----------------------------
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vsdl-bin-'));
fs.writeFileSync(path.join(BIN_DIR, 'ffprobe'), '#!/bin/sh\necho "1920,1080"\n');
fs.chmodSync(path.join(BIN_DIR, 'ffprobe'), 0o755);
process.env.PATH = BIN_DIR + path.delimiter + (process.env.PATH || '');

// ---- fake HTTP router ---------------------------------------------------------
let t0 = Date.now();
const timeline = []; // { name, t }
function mark(name) {
  timeline.push({ name, t: Date.now() - t0 });
}
const SLOW_MS = 2500; // slow relay + slow source delays
// mode 'winner-first' (default): the SLOW attempts are the losers (they never
// settle first) - the happy race. mode 'loser-first': the failing attempts
// settle FIRST (immediately) and the winner answers late. Both orderings must
// produce a winner.
let mode = 'winner-first';
const LATE_MS = 400; // how late the winner answers in 'loser-first' mode

function routeFor(u) {
  if (u.includes('vidsrc.sh/vs_src.php')) {
    mark('slow-relay-vsrc');
    // winner-first: slow loser; loser-first: fast-failing loser
    return mode === 'loser-first' ? { status: 500 } : { delay: SLOW_MS, status: 500 };
  }
  if (u.includes('vidsrcme.ru/vs_src.php')) {
    mark('fast-relay-vsrc');
    const r = {
      status: 200,
      body: () => Buffer.from(JSON.stringify({ src: 'https://cdn-good.example/embed/movie/1?vs=x' }))
    };
    if (mode === 'loser-first') r.delay = LATE_MS;
    return r;
  }
  if (u.includes('cdn-good.example/embed/movie/1')) {
    mark('landing');
    return { status: 200, body: () => Buffer.from('window.CFG = {"playerUrl":"/embed/player/9?vs=y"};') };
  }
  if (u.includes('cdn-good.example/embed/player/9')) {
    mark('player-token');
    return { status: 200, body: () => Buffer.from('window.CONFIG = {"apiToken":"tokB"};') };
  }
  if (u.includes('data.vidsrc.sh/api.php')) {
    // The real API rejects token-less calls (403 "invalid api token").
    // Enforcing that here keeps the relay-race test honest: if the race loop
    // drops the winning token, this route 403s and the scenario fails.
    if (!u.includes('api_token=')) {
      mark('data-api-rejected');
      return { status: 403, body: () => Buffer.from(JSON.stringify({ status_code: 403 })) };
    }
    mark('data-api');
    return {
      status: 200,
      body: () =>
        Buffer.from(
          JSON.stringify({
            status_code: '200',
            data: {
              title: 'Test Show',
              season: 1,
              episode: 1,
              stream_urls: ['https://cdn-bad.example/master.m3u8', 'https://cdn-good2.example/master.m3u8']
            }
          })
        )
    };
  }
  if (u.includes('cdn-bad.example/generate.php')) {
    mark('bad-generate-start');
    // winner-first: slow loser; loser-first: fails instantly, before the good one
    return mode === 'loser-first' ? { status: 500, endMark: 'bad-generate-end' } : { delay: SLOW_MS, status: 500, endMark: 'bad-generate-end' };
  }
  if (u.includes('cdn-good2.example/generate.php')) {
    mark('good-generate');
    const r = { status: 200, body: () => Buffer.from('tokG') };
    if (mode === 'loser-first') r.delay = LATE_MS;
    return r;
  }
  if (u.includes('cdn-good2.example/master.m3u8')) {
    mark('good-master');
    return {
      status: 200,
      body: () =>
        Buffer.from(
          '#EXTM3U\n' +
            '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n' +
            'variants/1080.m3u8\n' +
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n' +
            'variants/720.m3u8\n'
        )
    };
  }
  if (u.includes('cdn-good2.example/variants/1080.m3u8')) {
    mark('good-index');
    return { status: 200, body: () => Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION=6\nseg0.ts\n') };
  }
  if (u.includes('cdn-good2.example/seg0.ts')) {
    mark('good-segment');
    return { status: 200, body: () => Buffer.alloc(4096, 1) };
  }
  throw new Error('unrouted URL in fake router: ' + u);
}

function fakeGet(url, options, cb) {
  const u = typeof url === 'string' ? url : url.href;
  const route = routeFor(u);
  const req = new EventEmitter();
  req.setTimeout = () => req;
  const fire = () => {
    if (route.endMark) mark(route.endMark); // marked when the (delayed) answer arrives
    const res = new EventEmitter();
    res.statusCode = route.status;
    cb(res);
    process.nextTick(() => {
      if (route.status === 200) res.emit('data', route.body());
      res.emit('end');
    });
  };
  setTimeout(fire, route.delay || 0);
  return req;
}
const https = require('https');
const http = require('http');
https.get = fakeGet;
http.get = fakeGet;

const vs = require(path.join(REPO, 'src/main/sites/vidsrc_dl.js'));

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
const at = (name) => {
  const e = timeline.find((x) => x.name === name);
  return e ? e.t : -1;
};

(async () => {
  const ref = { type: 'movie', tmdb: '12345', title: 'Test Show' };
  const start = Date.now();
  const best = await vs.pick1080(ref, () => {}, 1080);
  const total = Date.now() - start;

  console.log('\n[1] Slow first relay does not block the token (parallel race)');
  check(
    'the fast relay answered while the slow one was still pending',
    at('data-api') >= 0 && at('data-api') < SLOW_MS,
    `data-api at ${at('data-api')}ms, slow relay needs ${SLOW_MS}ms`
  );

  console.log('\n[2] Slow/dead source[0] does not block source[1] (parallel verify)');
  // With first-passing-wins, the resolve returned while the bad source was
  // STILL PENDING (bad-generate-end unmarked) - or at least before it failed.
  const gm = at('good-master');
  const be = at('bad-generate-end');
  check(
    'good source verified while the bad one was still pending',
    gm >= 0 && (be === -1 || gm < be),
    `good-master ${gm}ms, bad-generate-end ${be === -1 ? 'still pending (proves overlap)' : be + 'ms'}`
  );

  console.log('\n[3] Result is the verified 1080p stream');
  check('returned a stream', !!best, 'null');
  check('from the good host', best && best.host === 'cdn-good2.example', best && best.host);
  check('real 1080p verified', best && best.realHeight === 1080, best && `${best.realWidth}x${best.realHeight}`);
  check('variant playlist url', best && /variants\/1080\.m3u8$/.test(best.url), best && best.url);

  console.log('\n[4] Total wall time (fake network)');
  // Slow relay (2.5s) + slow source (2.5s) both overlap with the fast path,
  // so the whole resolve must finish close to the fast path alone (~1s of
  // fake latency). Sequential + throttled would be ~9s+.
  check(`finished in ${total}ms (< 5000ms)`, total < 5000, `${total}ms`);

  // ---- Scenario 2: the FIRST-settled attempt FAILS; the winner is late ----
  // Regression: the race loop used to splice by resolved VALUE (indexOf always
  // -1 -> splice(-1,1)), which dropped the still-pending WINNER the moment a
  // loser settled first. Both the relay race and the source race must survive.
  mode = 'loser-first';
  t0 = Date.now();
  timeline.length = 0;

  console.log('\n[5] Fast-failing relay does not discard a pending winner');
  const tok2 = await vs.acquireApiToken(ref).catch(() => '');
  check('token acquired from the LATER relay', tok2 === 'tokB', 'got: ' + JSON.stringify(tok2));

  t0 = Date.now();
  timeline.length = 0;
  const start2 = Date.now();
  let best2 = null;
  let err2 = null;
  try {
    best2 = await vs.pick1080(ref, () => {}, 1080);
  } catch (e) {
    err2 = e;
  }
  const total2 = Date.now() - start2;

  console.log('\n[6] Fast-failing source[0] does not discard a pending winner');
  check('no error', !err2, err2 && err2.message);
  check(
    'bad source settled BEFORE the good one verified',
    at('bad-generate-end') >= 0 && at('good-master') >= 0 && at('bad-generate-end') < at('good-master'),
    `bad-generate-end ${at('bad-generate-end')}ms, good-master ${at('good-master')}ms`
  );
  check('good source still won', !!best2 && best2.host === 'cdn-good2.example', best2 && best2.host);
  check('real 1080p', best2 && best2.realHeight === 1080, best2 && `${best2.realWidth}x${best2.realHeight}`);
  check(`finished in ${total2}ms (< 3000ms)`, total2 < 3000, `${total2}ms (includes the 1.2s data-API throttle)`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FATAL', e);
  process.exit(1);
});
