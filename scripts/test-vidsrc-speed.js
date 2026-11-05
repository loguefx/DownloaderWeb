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
let staleTokenOnce = false; // scenario: first data-API call 403s (stale token)
let dataApiCalls = 0;
let playerTokenHits = 0;
let pageChanged = false;
let relayDnsGone = false;
let lowFirst = 0;
let notFound = false;
let genRefused = false; // scenario: every CDN server refuses generate.php (403) // scenario: the API says the title is not on Vidsrc // scenario: the first N stream lists are on a 720p-only server
let vsrcRelayHits = 0; // scenario: vidsrc.sh's name does not resolve // scenario: the landing page no longer carries playerUrl

function routeFor(u) {
  if (genRefused && /generate\.php/.test(u)) return { status: 403, body: () => Buffer.from('Forbidden') };
  if (u.includes('vidsrc.sh/vs_src.php')) {
    mark('slow-relay-vsrc');
    if (relayDnsGone) {
      vsrcRelayHits += 1;
      return { error: Object.assign(new Error('getaddrinfo ENOTFOUND vidsrc.sh'), { code: 'ENOTFOUND' }) };
    }
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
    if (pageChanged) return { status: 200, body: () => Buffer.from('<html>new player</html>') };
    return { status: 200, body: () => Buffer.from('window.CFG = {"playerUrl":"/embed/player/9?vs=y"};') };
  }
  if (u.includes('cdn-good.example/embed/player/9')) {
    mark('player-token');
    playerTokenHits += 1;
    return { status: 200, body: () => Buffer.from('window.CONFIG = {"apiToken":"tokB"};') };
  }
  if (u.includes('data.vidsrc.sh/api.php')) {
    dataApiCalls += 1;
    if (staleTokenOnce && dataApiCalls === 1) {
      mark('data-api-403-stale');
      // First call carries the STALE token: rejected, exactly like the real
      // API does for a rotated egress IP.
      return { status: 403, body: () => Buffer.from(JSON.stringify({ status_code: 403, error: 'invalid api token' })) };
    }
    // The real API rejects token-less calls (403 "invalid api token").
    // Enforcing that here keeps the relay-race test honest: if the race loop
    // drops the winning token, this route 403s and the scenario fails.
    if (!u.includes('api_token=')) {
      mark('data-api-rejected');
      return { status: 403, body: () => Buffer.from(JSON.stringify({ status_code: 403 })) };
    }
    mark('data-api');
    if (notFound) return { status: 404, body: () => Buffer.from(JSON.stringify({ status_code: 404, message: 'Not found' })) };
    if (lowFirst > 0) {
      lowFirst -= 1;
      return { status: 200, body: () => Buffer.from(JSON.stringify({ status_code: '200', data: { title: 'Test Show', stream_urls: ['https://cdn-low.example/a/master.m3u8', 'https://cdn-low.example/b/master.m3u8'] } })) };
    }
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
  if (u.includes('cdn-low.example/generate.php')) return { status: 200, body: () => Buffer.from('tokL') };
  if (u.includes('cdn-low.example/')) {
    return { status: 200, body: () => Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720.m3u8\n') };
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
  if (u.includes('cdn-good2.example/seg0.ts') || u.includes('cdn-good2.example/variants/seg0.ts')) {
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
  if (route.error) {
    setTimeout(() => req.emit('error', route.error), 0);
    return req;
  }
  const fire = () => {
    if (route.endMark) mark(route.endMark); // marked when the (delayed) answer arrives
    const res = new EventEmitter();
    res.statusCode = route.status;
    cb(res);
    process.nextTick(() => {
      if (route.body) res.emit('data', route.body());
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

  // ---- Scenario 3: a STALE token 403s the first API call ------------------
  // The token is IP-bound: a VPN egress rotation between token issue and use
  // (or a briefly-dead relay chain on the first pass) makes the API answer
  // 403 "invalid api token". Old code kept retrying the SAME stale token and
  // then dumped the episode on the slow browser path. New code re-acquires a
  // FRESH token on every 403 and recovers.
  staleTokenOnce = true;
  dataApiCalls = 0;
  playerTokenHits = 0;
  mode = 'winner-first';

  console.log('\n[7] Stale-token 403 is recovered by re-acquiring a fresh token');
  let best3 = null;
  let err3 = null;
  const start3 = Date.now();
  try {
    best3 = await vs.pick1080(ref, () => {}, 1080);
  } catch (e) {
    err3 = e;
  }
  const total3 = Date.now() - start3;
  check('no error', !err3, err3 && err3.message);
  check('the first data-API call was 403ed', dataApiCalls >= 2, 'data-api calls: ' + dataApiCalls);
  // The first call may use the shared cached token (no chain walk); the 403
  // must then force exactly the fresh walk.
  check('a FRESH token was re-acquired after the 403 (player chain walked again)', playerTokenHits >= 1, 'player-token hits: ' + playerTokenHits);
  check('resolved to verified 1080p despite the stale token', !!best3 && best3.realHeight === 1080, best3 && `${best3.host} ${best3.realWidth}x${best3.realHeight}`);
  check(`finished in ${total3}ms (< 15000ms)`, total3 < 15000, total3 + 'ms');

  // ---- Scenario 4: the site changed its page; no token can be had --------
  // The API refuses token-less calls. The error must say which hop broke
  // (not just "Vidsrc API status 403"), and the resolver must not spend
  // ~75 s repeating token-less calls before the browser path.
  pageChanged = true;
  staleTokenOnce = false;
  dataApiCalls = 0;
  mode = 'winner-first';
  console.log('\n[8] No API token (site changed its page): the error says why, and it gives up fast');
  await vs.getApiToken({ type: 'tv', tmdb: '777777', season: 1, episode: 1 }, { fresh: true }); // drop the cached token
  dataApiCalls = 0;
  let err4 = null;
  const start4 = Date.now();
  try {
    await vs.fetchStreamUrls({ type: 'tv', tmdb: '777777', season: 1, episode: 1 });
  } catch (e) {
    err4 = e;
  }
  const total4 = Date.now() - start4;
  check('failed', !!err4);
  check('the error names the broken hop', err4 && /no API token.*landing page has no playerUrl/.test(err4.message), err4 && err4.message);
  check('at most 2 token-less API calls', dataApiCalls <= 2, 'data-api calls: ' + dataApiCalls);
  check(`gave up in ${total4}ms (< 20000ms)`, total4 < 20000, total4 + 'ms');
  check('JS-literal / escaped page values are read', vs.pageValue("CFG = {playerUrl: '\\/embed\\/player\\/9'}", 'playerUrl') === '/embed/player/9');

  // ---- Scenario 5: a relay mirror's domain is gone (vidsrcme.ru) --------
  console.log('\n[9] A mirror whose name does not resolve is skipped afterwards');
  pageChanged = false;
  relayDnsGone = true;
  vsrcRelayHits = 0;
  const r9 = { type: 'tv', tmdb: '888888', season: 1, episode: 1 };
  const tA = await vs.getApiToken(r9, { fresh: true });
  check('the other mirror still gives the token', tA === 'tokB', JSON.stringify(tA));
  check('the dead mirror is marked', vs.isDeadHost('https://vidsrc.sh'));
  const hitsBefore = vsrcRelayHits;
  await vs.getApiToken(r9, { fresh: true });
  check('...and not asked again', vsrcRelayHits === hitsBefore, `${vsrcRelayHits - hitsBefore} more`);
  const mirrors = require(path.join(REPO, 'src/main/sites/vidsrc.js')).mirrorUrls('https://vidsrcme.ru/embed/tv/1-1-1');
  check('the browser path does not load the dead mirror', !mirrors.some((m) => m.includes('vidsrc.sh')), JSON.stringify(mirrors));
  vs._resetDeadHostsForTests();
  relayDnsGone = false;

  console.log('\n[11] Every source on a 720p-only server: Vidsrc is asked again for another server');
  const r11 = { type: 'tv', tmdb: '999999', season: 1, episode: 1 };
  lowFirst = 1;
  const logs11 = [];
  const b11 = await vs.pick1080(r11, (m) => logs11.push(m), 1080);
  check('the second list (another server) gives the 1080p', !!b11 && b11.host === 'cdn-good2.example', b11 && b11.host);
  check('...and says why it asked again', logs11.some((m) => /asking Vidsrc again/.test(m)), logs11.join(' | '));
  lowFirst = 5;
  logs11.length = 0;
  const b12 = await vs.pick1080(r11, (m) => logs11.push(m), 1080);
  check('the same 720p server every time: stops after the second list', b12 === null && logs11.filter((m) => /source\(s\) available/.test(m)).length === 2, logs11.join(' | '));
  lowFirst = 0;

  console.log('\n[12] API 404 with a valid token = not on Vidsrc: one call, typed error');
  notFound = true;
  dataApiCalls = 0;
  let e12 = null;
  const t12 = Date.now();
  try { await vs.fetchStreamUrls({ type: 'movie', tmdb: '1381071' }); } catch (e) { e12 = e; }
  check('typed VIDSRC_NOT_FOUND', e12 && e12.code === 'VIDSRC_NOT_FOUND', e12 && (e12.code + ' ' + e12.message));
  check('not retried', dataApiCalls === 1, 'data-api calls: ' + dataApiCalls);
  check(`answered in ${Date.now() - t12}ms (< 3000ms)`, Date.now() - t12 < 3000);
  notFound = false;

  console.log('\n[13] Every video server refuses its token (403): Vidsrc is paused, not retried per episode');
  genRefused = true;
  const o13 = {};
  const b13 = await vs.pick1080({ type: 'tv', tmdb: '1408', season: 1, episode: 9 }, () => {}, 1080, o13);
  check('no stream, flagged as a CDN block', b13 === null && o13.cdnBlocked === true, JSON.stringify(o13));
  check('Vidsrc paused engine-wide', vs.isBlocked() && vs.blockedUntilMs() > Date.now());
  genRefused = false;
  vs._setBlockedUntilForTests(0);
  const { episodeRefFromUrl } = require(path.join(REPO, 'src/main/sites/findtitle.js'));
  const e1 = episodeRefFromUrl('https://vidsrc.sh/embed/tv/1408-1-9');
  check('House embed: id 1408, S1E9 (not the title "1408 1 9")', e1.embed && e1.embed.id === '1408' && e1.season === 1 && e1.episode === 9 && e1.title === '', JSON.stringify(e1));
  const e2 = episodeRefFromUrl('https://vidsrc.sh/embed/movie/1381071');
  check('movie embed: id, no season', e2.embed && e2.embed.kind === 'movie' && e2.embed.id === '1381071' && e2.season === null, JSON.stringify(e2));
  const e3 = episodeRefFromUrl('https://vidsrc.sh/embed/tv/1396/2/5');
  check('slash form 1396/2/5', e3.embed && e3.embed.id === '1396' && e3.season === 2 && e3.episode === 5, JSON.stringify(e3));
  const e4 = episodeRefFromUrl('https://site.example/watch/show-name-season-2-episode-3');
  check('other sites unchanged', e4.title === 'show name' && e4.season === 2 && e4.episode === 3 && !e4.embed, JSON.stringify(e4));

  console.log('\n[10] Master playlists the parser used to drop silently (Breaking Bad: "NO source reached 1080p")');
  const M = 'https://cdn.example/hls/abc/master.m3u8?token=t';
  let v = vs.parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080/index.m3u8\n', M);
  check('a relative variant lives next to the master', v[0] && v[0].url === 'https://cdn.example/hls/abc/1080/index.m3u8', v[0] && v[0].url);
  v = vs.parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\n/v/1.m3u8\n', M);
  check('a variant without RESOLUTION is kept (size measured later)', v.length === 1 && v[0].height === 0 && v[0].url === 'https://cdn.example/v/1.m3u8', JSON.stringify(v));
  v = vs.parseMaster('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n', M);
  check('a single media playlist is its own variant', v.length === 1 && v[0].single && v[0].url === M, JSON.stringify(v));
  v = vs.parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\n\n#comment\nhttps://x.example/a.m3u8\n', M);
  check('blank/comment lines before the URI are skipped', v[0] && v[0].url === 'https://x.example/a.m3u8', JSON.stringify(v));
  check('1916x1076 counts as 1080p', vs.meetsFloor(1916, 1076, 1080) && vs.meetsFloor(1920, 1072, 1080));
  check('1600x900 and 1280x720 do not', !vs.meetsFloor(1600, 900, 1080) && !vs.meetsFloor(1280, 720, 1080));
  check('wide 1920x800 still counts', vs.meetsFloor(1920, 800, 1080));
  const verify = require(path.join(REPO, 'src/main/verify.js'));
  check('the finished-file check agrees (1916x1076 not below 1080)', !verify.belowMinHeight({ width: 1916, height: 1076 }, 1080));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FATAL', e);
  process.exit(1);
});
