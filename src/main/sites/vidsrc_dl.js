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

function request(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(
      url,
      { headers: Object.assign({ 'User-Agent': UA }, headers || {}), timeout: timeoutMs || 30000 },
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

async function fetchStreamUrls(ref) {
  let qs;
  if (ref.type === 'movie') {
    qs = 'type=movie&' + (ref.imdb ? 'imdb=' + ref.imdb : 'tmdb=' + ref.tmdb);
  } else {
    const idpart = ref.imdb ? 'imdb=' + ref.imdb : 'tmdb=' + ref.tmdb;
    qs = `type=tv&${idpart}&season=${ref.season}&episode=${ref.episode}`;
  }
  const url = `${API_BASE}?${qs}&stream_urls`;
  const r = await request(url, {}, 30000);
  let j;
  try {
    j = JSON.parse(r.body.toString('utf8'));
  } catch (e) {
    throw new Error('Vidsrc API did not return JSON (HTTP ' + r.status + '): ' + r.body.toString('utf8').slice(0, 120));
  }
  if (String(j.status_code) !== '200') throw new Error('Vidsrc API status ' + j.status_code);
  let urls = j.data && j.data.stream_urls;
  const meta = {
    title: (j.data && j.data.title) || ref.title || '',
    season: (j.data && j.data.season) || ref.season || '',
    episode: (j.data && j.data.episode) || ref.episode || '',
  };
  if (typeof urls === 'string' && j.vs && j.vs.wasm_url) {
    urls = await decryptStreamUrls(urls, j.vs);
  }
  if (!Array.isArray(urls) || !urls.length) throw new Error('Vidsrc API returned no stream urls');
  return { urls, meta };
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

// Return a verified >=1080p variant playlist URL, or null if none found.
async function pick1080(ref, onLog) {
  const { urls, meta } = await fetchStreamUrls(ref);
  onLog && onLog(`Vidsrc: ${meta.title} — ${urls.length} source(s) available.`);
  let best = null;
  for (let i = 0; i < urls.length; i++) {
    let u;
    try {
      u = new URL(urls[i]);
    } catch (e) {
      continue;
    }
    let token;
    try {
      token = parseToken((await request(u.origin + '/generate.php', {}, 20000)).body.toString('utf8'));
    } catch (e) {
      onLog && onLog(`Vidsrc: source[${i}] ${u.host} — generate.php failed (${e.message}).`);
      continue;
    }
    if (!token) {
      onLog && onLog(`Vidsrc: source[${i}] ${u.host} — empty token.`);
      continue;
    }
    let master;
    try {
      master = (await request(urls[i] + '?token=' + encodeURIComponent(token), {}, 25000)).body.toString('utf8');
    } catch (e) {
      onLog && onLog(`Vidsrc: source[${i}] ${u.host} — master failed (${e.message}).`);
      continue;
    }
    const variants = parseMaster(master, u.origin).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    if (!variants.length) continue;
    for (const v of variants) {
      if (v.height < 1080) break;
      try {
        const idx = (await request(v.url, {}, 20000)).body.toString('utf8');
        const segLine = idx
          .split('\n')
          .map((s) => s.trim())
          .find((l) => l && !l.startsWith('#'));
        if (!segLine) continue;
        const segUrl = segLine.startsWith('http') ? segLine : u.origin + (segLine.startsWith('/') ? '' : '/') + segLine;
        const segPath = path.join(os.tmpdir(), `vs_verify_${i}_${v.height}.bin`);
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
          rq.setTimeout(20000, () => { rq.destroy(); rej(new Error('timeout')); });
        });
        const pr = await probeResolution(segPath);
        onLog && onLog(`Vidsrc: source[${i}] ${u.host} ${v.width}x${v.height} → real ${pr.width || '?'}x${pr.height || '?'}.`);
        if (pr.ok && pr.height >= 1080) {
          best = { url: v.url, host: u.host, width: v.width, height: v.height, realWidth: pr.width, realHeight: pr.height, meta };
          break;
        }
      } catch (e) {
        onLog && onLog(`Vidsrc: source[${i}] ${u.host} ${v.width}x${v.height} verify failed (${e.message}).`);
      }
    }
    if (best) break;
  }
  return best;
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
  const best = await pick1080(ref, onLog);
  if (!best) throw new Error('No 1080p stream found on Vidsrc for ' + (ref.title || ref.tmdb || ref.imdb));
  onLog(`Vidsrc: downloading ${best.realWidth}x${best.realHeight} from ${best.host} → ${outPath}`);
  const p = require('path');
  const base = p.basename(outPath).replace(/\.[^.]+$/, '');
  const tmp = p.join(p.dirname(outPath), `.${base}.vsdl.mp4`);
  fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
  await spawnFfmpeg(best.url, tmp, UA, opts);
  if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
  const pr = await probeResolution(tmp);
  if (!pr.ok || pr.height < 1080) {
    try { fs.unlinkSync(tmp); } catch (e) {}
    throw new Error(`Downloaded file is ${pr.width}x${pr.height}, not 1080p`);
  }
  fs.renameSync(tmp, outPath);
  onLog(`Vidsrc: done → ${outPath} (${pr.width}x${pr.height})`);
  return { path: outPath, width: pr.width, height: pr.height, host: best.host, meta: best.meta };
}

module.exports = { pick1080, download, fetchStreamUrls, UA };

// CLI: vidsrc_dl.js <tv|movie> <tmdb|imdb> [season] [episode] [outPath]
if (require.main === module) {
  const [type, id, season, episode, out] = process.argv.slice(2);
  const ref = { type, tmdb: /^tt\d/.test(id) ? undefined : id, imdb: /^tt\d/.test(id) ? id : undefined, season, episode };
  const outPath = out || path.join(os.tmpdir(), 'vidsrc_out.mp4');
  download(ref, outPath, { onLog: (m) => console.log('[vs]', m) })
    .then((r) => console.log('OK', JSON.stringify(r)))
    .catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}
