'use strict';

// Vidsrc headless 1080p resolver + downloader.
//
// This is the PRIMARY path for the Vidsrc family (vidsrc.sh / vidsrcme.ru).
// It needs no browser, no CDP, and no Cloudflare challenge: the whole chain is
// plain HTTPS, verified live against the current rotating CDN.
//
// Chain (all HTTP, all tokenised with a single per-host JWT):
//   1. https://data.vidsrc.sh/api.php?type=tv&tmdb=<id>[&season=S&episode=E]&stream_urls
//      -> data.stream_urls (a base64 ChaCha20 blob) + vs.{w, wasm_url}.
//   2. The per-window WASM module decrypts stream_urls into N master.m3u8 URLs
//      (N sources; one is usually a true 1080p encode).
//   3. For a master host: GET <host>/generate.php -> a JWT token bound to our
//      IP CIDR. The CDN stamps that SAME token into every variant + segment URL,
//      so one token covers the master, the chosen variant and all segments.
//   4. Pick the highest-resolution variant, verify its FIRST segment really
//      decodes to >=1080 (the CDN occasionally mislabels 720p as 1080p), and
//      hand the tokenised variant playlist straight to ffmpeg (-c copy remux).
//
// Tokens are IP-bound and short-lived, so everything is resolved just-in-time,
// per episode, at download time.

const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const audiolang = require('../audiolang');

// Cross-platform ffmpeg/ffprobe resolution (was hardcoded to /usr/bin/ which
// doesn't exist on Windows — the engine PC). Use the main downloader's resolver
// when available; fall back to PATH search.
function getFfmpeg() {
  try {
    const dl = require('../downloader');
    if (typeof dl.ffmpegPath === 'function') return dl.ffmpegPath();
  } catch (e) { /* downloader not loaded yet */ }
  // Fallback: search PATH
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return name;
}
function getFfprobe() {
  try {
    const dl = require('../downloader');
    if (typeof dl.ffprobePath === 'function') return dl.ffprobePath();
  } catch (e) { /* downloader not loaded yet */ }
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  return name;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API_BASE = 'https://data.vidsrc.sh/api.php';
const RELAY_HOSTS = ['https://vidsrc.sh', 'https://vidsrcme.ru'];

// Reuse the TLS connection per host (master -> variant index -> first segment
// all hit the same CDN). Over a VPN a fresh handshake per hop costs 100-500ms.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 1500 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 1500 });

// Throttle ONLY the Vidsrc data API (data.vidsrc.sh/api.php), which is
// IP-rate-limited and 429s bursts. The per-source CDN calls (generate.php,
// playlists, segments) run on different hosts with separate limits - the old
// global 1.2s spacing between EVERY call added ~4s of pure sleep per episode
// for no protection. (See vidsrc.js download.concurrency=1 for the rest of
// the rate-limit defence.)
let _lastApiCall = 0;
const API_MIN_INTERVAL_MS = 1200;
function throttleApi() {
  const now = Date.now();
  const wait = Math.max(0, _lastApiCall + API_MIN_INTERVAL_MS - now);
  _lastApiCall = now + wait;
  if (wait > 0) return new Promise((r) => setTimeout(r, wait));
  return Promise.resolve();
}

function request(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(
      url,
      {
        headers: Object.assign({ 'User-Agent': UA }, headers || {}),
        timeout: timeoutMs || 30000,
        agent: u.protocol === 'http:' ? httpAgent : httpsAgent
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

// Vidsrc's data API now demands an IP-bound JWT ("api_token") that it issues
// only through the player chain — the same chain the browser walks:
//   1. <relay>/vs_src.php?type=<tv|movie>&id=<id>[&season=S&episode=E]
//        -> { src: "<host>/embed/<tv|movie>/<...>?vs=<token>" }
//   2. that landing page -> window.CFG.playerUrl = "/embed/player/...?vs=<token2>"
//   3. that player page  -> window.CONFIG.apiToken = "<JWT: {exp, ip, n}>"
// The token is IP-bound (the JWT carries our egress IP) and short-lived
// (~10 min), so it is fetched just-in-time per episode, here. Verified live
// for movie/tv, tmdb/imdb (Runner tt31349844, 2026-10). Returns '' on any
// failure so the caller can still try the token-less API (older deployments).
// One relay chain: vs_src.php -> landing page -> player page -> apiToken.
async function tokenChain(relay, ref) {
  const id = ref.imdb ? ref.imdb : ref.tmdb;
  if (!id) return '';
  const isTv = ref.type === 'tv';
  const params =
    `type=${isTv ? 'tv' : 'movie'}&id=${encodeURIComponent(id)}` +
    (isTv ? `&season=${encodeURIComponent(ref.season)}&episode=${encodeURIComponent(ref.episode)}` : '');
  // 10s per hop: a healthy host answers in <2s; the old 20s meant a slow host
  // ate a third of the whole discovery budget before the next one was tried.
  const r = await request(`${relay}/vs_src.php?${params}`, { Referer: relay + '/' }, 10000);
  if (r.status !== 200) return '';
  let j;
  try {
    j = JSON.parse(r.body.toString('utf8'));
  } catch (e) {
    return '';
  }
  if (!j || !j.src) return '';
  const base = String(j.src).match(/^https?:\/\/[^/]+/);
  if (!base) return '';
  const lr = await request(j.src, { Referer: relay + '/' }, 10000);
  if (lr.status !== 200) return '';
  const pm = lr.body.toString('utf8').match(/playerUrl":"([^"]+)"/);
  if (!pm) return '';
  const pr = await request(base[0] + pm[1], { Referer: j.src }, 10000);
  if (pr.status !== 200) return '';
  const tm = pr.body.toString('utf8').match(/apiToken":"([^"]+)"/);
  return tm ? tm[1] : '';
}

// Race a set of promises and resolve with { value, index } of the FIRST one
// to settle (success OR failure), so the caller can drop exactly that one and
// keep racing the rest. (A naive `attempts.indexOf(r)` cannot work: r is the
// resolved VALUE, not the promise, so indexOf is always -1 and splice(-1, 1)
// silently discards a still-pending winner. Promise.allSettled would not work
// either - it waits for the slow loser, which is exactly what we are racing.)
function firstSettled(promises) {
  return new Promise((resolve) => {
    promises.forEach((p, index) =>
      Promise.resolve(p).then(
        (value) => resolve({ value, index }),
        () => resolve({ value: null, index })
      )
    );
  });
}

async function acquireApiToken(ref) {
  // Race BOTH relay hosts in parallel. The old sequential loop waited out a
  // slow/dead first host (3 hops x up to 20s) before trying the healthy one.
  // Now the FIRST settled chain decides: a success returns immediately (the
  // loser dies on its own hop timeout and is ignored); a failure just means
  // the other chain still has a chance.
  const attempts = RELAY_HOSTS.map((relay) =>
    tokenChain(relay, ref).then((tok) => ({ ok: !!tok, tok }), () => ({ ok: false, tok: '' }))
  );
  while (attempts.length) {
    const { value: r, index } = await firstSettled(attempts);
    attempts.splice(index, 1);
    if (r && r.ok) return r.tok;
  }
  return '';
}

function parseToken(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t);
    if (typeof j === 'string') return j;
    if (j && typeof j === 'object') return j.token || j.data || j.string || j.result || '';
  } catch (e) {
    /* plain-text token */
  }
  return t;
}

// Decrypt the API's encrypted stream_urls (base64 ChaCha20 nonce||ciphertext).
async function decryptStreamUrls(encrypted, vs) {
  const wr = await request(vs.wasm_url, {}, 30000);
  const mod = await WebAssembly.compile(wr.body);
  const inst = await WebAssembly.instantiate(mod, {});
  const ex = inst.exports;
  const enc = Buffer.from(encrypted, 'base64');
  const ptr = ex.alloc(enc.length);
  new Uint8Array(ex.memory.buffer, ptr, enc.length).set(enc);
  const outLen = ex.decrypt(ptr, enc.length);
  const out = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr + 12, outLen));
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

// Circuit breaker. When Vidsrc blocks this IP (its relay and data API answer
// a plain nginx "403 Forbidden" page, not the API's JSON), every request only
// prolongs the block: each episode used to burn ~1 min of token retries, over
// and over. On a block page Vidsrc is paused for BLOCK_PAUSE_MS engine-wide;
// callers fall back to the other sources meanwhile.
const BLOCK_PAUSE_MS = 15 * 60 * 1000;
let blockedUntil = 0;
function isBlockPage(status, bodyText) {
  return status === 403 && /<html|nginx|forbidden/i.test(String(bodyText || '').slice(0, 400)) && !/^\s*\{/.test(String(bodyText || ''));
}
function markBlocked() {
  const first = Date.now() >= blockedUntil;
  blockedUntil = Date.now() + BLOCK_PAUSE_MS;
  return first;
}
function blockedError() {
  const mins = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
  return Object.assign(
    new Error(`Vidsrc is blocking this IP (HTTP 403 page); Vidsrc paused for ${mins} min - switching the Mullvad server clears it sooner`),
    { code: 'VIDSRC_BLOCKED' }
  );
}
function isBlocked() {
  return Date.now() < blockedUntil;
}

async function fetchStreamUrls(ref) {
  if (isBlocked()) throw blockedError();
  await throttleApi();
  let qs;
  if (ref.type === 'movie') {
    qs = 'type=movie&' + (ref.imdb ? 'imdb=' + ref.imdb : 'tmdb=' + ref.tmdb);
  } else {
    const idpart = ref.imdb ? 'imdb=' + ref.imdb : 'tmdb=' + ref.tmdb;
    qs = `type=tv&${idpart}&season=${ref.season}&episode=${ref.episode}`;
  }
  let url = `${API_BASE}?${qs}&stream_urls`;
  // The data API now requires the IP-bound api_token ("invalid api token" 403
  // otherwise). Acquire it through the player chain first; if that fails the
  // token-less call below may still work on older deployments.
  let apiToken = '';
  try {
    apiToken = await acquireApiToken(ref);
  } catch (e) {
    apiToken = '';
  }
  if (apiToken) url += '&api_token=' + encodeURIComponent(apiToken);
  // The Vidsrc API rate-limits (HTTP 429) and intermittently 403s bursts behind
  // a VPN. Retry a few times with backoff before giving up on the fast path; a
  // persistent 403 ("invalid api token") falls through to the browser relay path.
  // 429/5xx (rate-limited / transient) clear with time, so wait much longer on
  // those than on a hard 403. The browser relay's player calls this same API,
  // so letting the rate limit clear here also helps the fallback path.
  const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  // 403 ("invalid api token") is the token being stale or IP-mismatched, or a
  // rate-limit dressed up as a rejection - either way 1.5s retries just make
  // it worse. Use the longer scale.
  const RATE_LIMITED = new Set([403, 429, 503]);
  let lastErr = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const limited = RATE_LIMITED.has(lastStatus);
      const backoff =
        (limited ? 4000 : 1500) * attempt + Math.floor(Math.random() * (limited ? 2000 : 800));
      await new Promise((rs) => setTimeout(rs, backoff));
    }
    // A 403 is Vidsrc rejecting the token in hand (or no token at all). The
    // token is IP-bound and short-lived: it goes stale when the egress IP
    // rotates (VPN) or the relay was briefly down on the first pass. Re-acquire
    // a FRESH token every 403 - retrying with the stale one just burns the
    // whole budget on 403s and then dumps the episode on the slow browser path.
    if (lastStatus === 403) {
      try {
        apiToken = await acquireApiToken(ref);
        if (apiToken) url = API_BASE + '?' + qs + '&stream_urls&api_token=' + encodeURIComponent(apiToken);
      } catch (e) {
        /* keep retrying token-less */
      }
    }
    let r;
    try {
      r = await request(url, {}, 30000);
    } catch (netErr) {
      lastErr = netErr;
      lastStatus = 0;
      continue;
    }
    lastStatus = r.status;
    const bodyText = r.body.toString('utf8');
    if (isBlockPage(r.status, bodyText)) {
      markBlocked();
      throw blockedError();
    }
    let j;
    try {
      j = JSON.parse(bodyText);
    } catch (e) {
      lastErr = new Error('Vidsrc API did not return JSON (HTTP ' + r.status + '): ' + bodyText.slice(0, 120));
      if (RETRYABLE.has(r.status)) continue;
      throw lastErr;
    }
    if (String(j.status_code) !== '200') {
      lastErr = new Error('Vidsrc API status ' + j.status_code);
      if (RETRYABLE.has(r.status)) continue;
      throw lastErr;
    }
    let urls = j.data && j.data.stream_urls;
    const meta = {
      title: (j.data && j.data.title) || ref.title || '',
      season: (j.data && j.data.season != null ? j.data.season : ref.season != null ? ref.season : ''),
      episode: (j.data && j.data.episode) || ref.episode || '',
      // The release name (e.g. "... 1080p CR WEB-DL ...-Kitsune.mkv" = Chinese
      // release / Japanese audio; "... HULU ... English ..." = English dub).
      // Vidsrc serves ONE fixed file per episode with no dub/sub toggle, so
      // this is the only way to know which audio we are about to download.
      fileName: (j.data && j.data.file_name) || '',
    };
    if (typeof urls === 'string' && j.vs && j.vs.wasm_url) {
      urls = await decryptStreamUrls(urls, j.vs);
    }
    if (!Array.isArray(urls) || !urls.length) throw new Error('Vidsrc API returned no stream urls');
    return { urls, meta };
  }
  throw lastErr || new Error('Vidsrc API request failed after retries');
}

// Release name of one episode, without the stream list (no decrypt, no CDN
// calls): what the English-dub count needs. `session` carries the API token
// across a season ({ token }); a 403 re-acquires it once. Same data-API
// spacing as every other call. -> { fileName, status } (fileName '' when the
// episode is not on Vidsrc).
async function episodeRelease(ref, session = {}) {
  if (isBlocked()) return { fileName: '', status: 'unreachable' };
  if (!session.token) {
    try {
      session.token = await acquireApiToken(ref);
    } catch (e) {
      session.token = '';
    }
  }
  const idpart = ref.imdb ? 'imdb=' + ref.imdb : 'tmdb=' + ref.tmdb;
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttleApi();
    const url = `${API_BASE}?type=tv&${idpart}&season=${ref.season}&episode=${ref.episode}` +
      (session.token ? '&api_token=' + encodeURIComponent(session.token) : '');
    let res;
    try {
      res = await request(url, {}, 20000);
    } catch (e) {
      continue;
    }
    if (isBlockPage(res.status, res.body.toString('utf8'))) {
      markBlocked();
      return { fileName: '', status: 'unreachable' };
    }
    if (res.status === 403) {
      try {
        session.token = await acquireApiToken(ref);
      } catch (e) {
        /* keep going */
      }
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((rs) => setTimeout(rs, 2000 * (attempt + 1)));
      continue;
    }
    let j = null;
    try {
      j = JSON.parse(res.body.toString('utf8'));
    } catch (e) {
      return { fileName: '', status: 'bad-response' };
    }
    if (String(j.status_code) !== '200') return { fileName: '', status: 'not-found' };
    return { fileName: String((j.data && j.data.file_name) || ''), status: 'ok' };
  }
  return { fileName: '', status: 'unreachable' };
}

// Parse a master playlist into variants: [{ width, height, bandwidth, url }].
function parseMaster(masterText, baseOrigin) {
  const lines = masterText.split('\n').map((s) => s.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
    const bw = lines[i].match(/BANDWIDTH=(\d+)/);
    const next = lines[i + 1] || '';
    if (m && next && !next.startsWith('#')) {
      const u = next.startsWith('http') ? next : baseOrigin + (next.startsWith('/') ? '' : '/') + next;
      variants.push({ width: +m[1], height: +m[2], bandwidth: bw ? +bw[1] : 0, url: u });
    }
  }
  return variants;
}

// A "1080p" floor means the 1920x1080 master class. Scope-cropped widescreen
// films present that master at 1920x800 (Runner 2026's only 1080p copy is
// exactly this), so full master width + widescreen aspect also passes - the
// same rule as verify.meetsQualityFloor.
function meetsFloor(width, height, min) {
  if (!min) return true;
  if (height >= min) return true;
  const masterWidth = Math.round((min * 16) / 9);
  if (!width || width < masterWidth) return false;
  return height > 0 && width / height >= 1.85;
}

// Audio language tags of a media file ('' for an untagged track).
function probeAudioLangs(bufPath) {
  return new Promise((resolve) => {
    execFile(
      getFfprobe(),
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index:stream_tags=language', '-of', 'json', bufPath],
      { timeout: 20000 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const j = JSON.parse(String(stdout || '{}'));
          resolve((j.streams || []).map((st) => audiolang.normLang(st.tags && st.tags.language)));
        } catch (e) {
          resolve([]);
        }
      }
    );
  });
}

function probeResolution(bufPath) {
  return new Promise((resolve) => {
    execFile(
      getFfprobe(),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', bufPath],
      { timeout: 20000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false });
        const mm = String(stdout).split('\n')[0].match(/(\d+),(\d+)/);
        resolve(mm ? { ok: true, width: +mm[1], height: +mm[2] } : { ok: false });
      }
    );
  });
}

// One CDN token for a host. generate.php is rate-limited per IP: three
// requests at once get one 200 and two 429s, and after a few of those the
// host stops answering (the 10 s timeouts). The token covers every playlist
// and segment on that host, so ONE request per host is all a lookup needs.
// 429 / 5xx / timeouts are retried twice with a short backoff; a non-200
// body is never mistaken for a token.
async function fetchHostToken(origin) {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((rs) => setTimeout(rs, 1200 * attempt + Math.floor(Math.random() * 400)));
    let res;
    try {
      res = await request(origin + '/generate.php', {}, 10000);
    } catch (e) {
      last = e.message || 'network error';
      continue;
    }
    if (res.status === 200) {
      const token = parseToken(res.body.toString('utf8'));
      if (token) return token;
      last = 'empty token';
      continue;
    }
    last = 'HTTP ' + res.status;
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(last || 'no token');
}

// Return a verified variant playlist URL at or above `minH` (default 1080),
// or null if none found. Anime passes minH 0 to accept the source's own
// resolution (often 720p) instead of requiring 1080p.
// Verify ONE source: token -> master -> top floor-passing variant -> first
// segment -> real probe. Returns a passing detection or null. Each source is
// on its own CDN host (separate rate limits), so the sources can be raced in
// parallel by the caller.
async function verifySource(raw, i, meta, min, onLog, tokenFor = fetchHostToken) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  let token;
  try {
    token = await tokenFor(u.origin);
  } catch (e) {
    onLog && onLog(`Vidsrc: source[${i}] ${u.host} — generate.php failed (${e.message}).`);
    return { unreachable: true };
  }
  if (!token) {
    onLog && onLog(`Vidsrc: source[${i}] ${u.host} — empty token.`);
    return null;
  }
  let master;
  try {
    master = (await request(raw + '?token=' + encodeURIComponent(token), {}, 15000)).body.toString('utf8');
  } catch (e) {
    onLog && onLog(`Vidsrc: source[${i}] ${u.host} — master failed (${e.message}).`);
    return { unreachable: true };
  }
  const variants = parseMaster(master, u.origin).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  // Alternate audio / subtitle tracks the master lists (#EXT-X-MEDIA).
  const media = audiolang.parseHlsMedia(master, raw);
  for (const v of variants) {
    if (!meetsFloor(v.width, v.height, min)) break;
    try {
      const idx = (await request(v.url, {}, 15000)).body.toString('utf8');
      const segLine = idx
        .split('\n')
        .map((s) => s.trim())
        .find((l) => l && !l.startsWith('#'));
      if (!segLine) continue;
      const segUrl = segLine.startsWith('http') ? segLine : u.origin + (segLine.startsWith('/') ? '' : '/') + segLine;
      const segPath = path.join(os.tmpdir(), `vs_verify_${i}_${v.height}_${process.pid}.bin`);
      await new Promise((res, rej) => {
        const rq = (segUrl.startsWith('http:') ? http : https).get(
          segUrl,
          { headers: { 'User-Agent': UA } },
          (rs) => {
            const c = [];
            rs.on('data', (d) => c.push(d));
            rs.on('end', () => {
              fs.writeFileSync(segPath, Buffer.concat(c));
              res();
            });
          }
        );
        rq.on('error', rej);
        rq.setTimeout(15000, () => { rq.destroy(); rej(new Error('timeout')); });
      });
      const pr = await probeResolution(segPath);
      const streamLangs = await probeAudioLangs(segPath);
      try { fs.unlinkSync(segPath); } catch (e) { /* already gone */ }
      onLog && onLog(`Vidsrc: source[${i}] ${u.host} ${v.width}x${v.height} → real ${pr.width || '?'}x${pr.height || '?'}.`);
      if (pr.ok && meetsFloor(pr.width, pr.height, min)) {
        const audio = audiolang.audioVerdict({ streamLangs, media, fileName: meta && meta.fileName });
        return { url: v.url, host: u.host, width: v.width, height: v.height, realWidth: pr.width, realHeight: pr.height, meta, order: i, media, audio };
      }
    } catch (e) {
      onLog && onLog(`Vidsrc: source[${i}] ${u.host} ${v.width}x${v.height} verify failed (${e.message}).`);
    }
  }
  return null;
}

// Return a verified variant playlist URL at or above `minH` (default 1080),
// or null if none found. Anime passes minH 0 to accept the source's own
// resolution (often 720p) instead of requiring 1080p.
// opts.accept(source) -> { ok, reason }: the dub/sub check. A source that
// passes the quality floor but not this check is set aside (opts.rejected
// collects { host, reason }) and the race goes on; with opts.preferOnly the
// first set-aside source is still returned when no source passes.
async function pick1080(ref, onLog, minH = 1080, opts = {}) {
  const min = Math.max(0, Number(minH) || 0);
  const accept = typeof opts.accept === 'function' ? opts.accept : null;
  const rejected = Array.isArray(opts.rejected) ? opts.rejected : [];
  let fallback = null;
  const { urls, meta } = await fetchStreamUrls(ref);
  onLog && onLog(`Vidsrc: ${meta.title} — ${urls.length} source(s) available.`);
  // Verify sources in parallel; the FIRST one to pass the floor wins (the
  // original sequential code also stopped at the first passing source - same
  // semantics, but a slow/dead source[0] no longer delays source[1], and a
  // dead source never dictates the total wait). A source that FAILS first
  // does not stop the race - the remaining sources keep verifying and the
  // first passing one still wins. Losers keep running briefly in the
  // background (bounded: one segment + one ffprobe) and are ignored.
  // Sources usually share one CDN host: fetch its token once, for all of them.
  const tokens = new Map();
  const tokenFor = (origin) => {
    if (!tokens.has(origin)) tokens.set(origin, fetchHostToken(origin));
    return tokens.get(origin);
  };
  const attempts = urls.map((raw, i) =>
    verifySource(raw, i, meta, min, onLog, tokenFor).catch((e) => {
      onLog && onLog(`Vidsrc: source[${i}] verify failed (${(e && e.message) || e}).`);
      return null;
    })
  );
  let unreachable = 0;
  const total = attempts.length;
  while (attempts.length) {
    const { value: r, index } = await firstSettled(attempts);
    attempts.splice(index, 1);
    if (r && r.unreachable) {
      unreachable += 1;
      continue;
    }
    if (!r) continue;
    delete r.order;
    if (accept) {
      const v = accept(r);
      if (!v || !v.ok) {
        rejected.push({ host: r.host, reason: (v && v.reason) || 'not accepted' });
        onLog && onLog(`Vidsrc: ${r.host} skipped - ${(v && v.reason) || 'not accepted'}.`);
        if (!fallback) fallback = r;
        continue;
      }
    }
    return r;
  }
  // Every source failed on a token/network error (the CDN throttles this IP
  // for a while after bursts): that is "try again shortly", not "no copy at
  // this quality".
  if (!fallback && total && unreachable === total) opts.allUnreachable = true;
  return opts.preferOnly ? fallback : null;
}

function spawnFfmpeg(inputUrl, outPath, ua, opts) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-user_agent', ua,
      '-i', inputUrl,
      '-c', 'copy',
      '-movflags', '+faststart',
      outPath
    ];
    execFile(getFfmpeg(), args, { maxBuffer: 64 * 1024 * 1024 }, (err, so, se) => {
      if (opts && opts.signal && opts.signal.aborted) return reject(Object.assign(new Error('aborted'), { aborted: true }));
      if (err) return reject(new Error((se || so || err.message || 'ffmpeg failed').toString().trim().slice(-300)));
      resolve();
    });
  });
}

// Resolve + download a 1080p episode/movie to outPath. Returns probe info.
async function download(ref, outPath, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const min = Math.max(0, Number(opts.minHeight) || 1080);
  const best = await pick1080(ref, onLog, min);
  if (!best) throw new Error('No stream at/above ' + min + 'p found on Vidsrc for ' + (ref.title || ref.tmdb || ref.imdb));
  onLog(`Vidsrc: downloading ${best.realWidth}x${best.realHeight} from ${best.host} → ${outPath}`);
  const p = require('path');
  const base = p.basename(outPath).replace(/\.[^.]+$/, '');
  const tmp = p.join(p.dirname(outPath), `.${base}.vsdl.mp4`);
  fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
  await spawnFfmpeg(best.url, tmp, UA, opts);
  if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
  const pr = await probeResolution(tmp);
  if (!pr.ok || !meetsFloor(pr.width, pr.height, min)) {
    try { fs.unlinkSync(tmp); } catch (e) {}
    throw new Error(`Downloaded file is ${pr.width}x${pr.height}, not ${min}p`);
  }
  fs.renameSync(tmp, outPath);
  onLog(`Vidsrc: done → ${outPath} (${pr.width}x${pr.height})`);
  return { path: outPath, width: pr.width, height: pr.height, host: best.host, meta: best.meta };
}

module.exports = {
  pick1080, download, fetchStreamUrls, acquireApiToken, episodeRelease, UA, parseMaster, probeAudioLangs,
  isBlocked, isBlockPage,
  _setBlockedUntilForTests(t) { blockedUntil = t; }
};

// CLI: vidsrc_dl.js <tv|movie> <tmdb|imdb> [season] [episode] [outPath]
if (require.main === module) {
  const [type, id, season, episode, out] = process.argv.slice(2);
  const ref = { type, tmdb: /^tt\d/.test(id) ? undefined : id, imdb: /^tt\d/.test(id) ? id : undefined, season, episode };
  const outPath = out || path.join(os.tmpdir(), 'vidsrc_out.mp4');
  download(ref, outPath, { onLog: (m) => console.log('[vs]', m) })
    .then((r) => console.log('OK', JSON.stringify(r)))
    .catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}
