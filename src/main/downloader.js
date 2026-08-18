'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { session } = require('electron');
const config = require('./config');

class AbortError extends Error {
  constructor(msg = 'Aborted') {
    super(msg);
    this.name = 'AbortError';
  }
}

// On Linux/macOS a bundled static binary is useless without the executable bit.
// ffprobe-static in particular often ships without it, so downloads fail with
// EACCES ("Permission denied") even though the identical setup works on Windows
// (where the exec bit is irrelevant). Best-effort chmod fixes writable installs
// (npm start / AppImage); read-only installs (pacman) rely on the postinstall
// chmod instead, so a failure here is non-fatal.
function ensureExecutable(p) {
  if (!p || process.platform === 'win32') return p;
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch (e) {
    try {
      fs.chmodSync(p, 0o755);
    } catch (e2) {
      // read-only location or not owner; leave as-is and let spawn surface it
    }
  }
  return p;
}

function findOnPath(name) {
  // `which` is Unix-only; Windows needs `where`. execFile bypasses the shell so
  // PowerShell's `where` alias is not a problem.
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    });
    const first = String(out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    return first || null;
  } catch (e) {
    return null;
  }
}

function unpackAsar(p) {
  if (p && p.includes('app.asar')) return p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function ffmpegPath() {
  // Prefer a system ffmpeg when present. The ffmpeg-static binary SIGSEGVs on
  // some newer distros (e.g. CachyOS), and system builds understand current HLS
  // demuxer flags we need for extensionless CDN segments.
  const fromPath = findOnPath('ffmpeg');
  if (fromPath) return fromPath;
  let p = require('ffmpeg-static');
  return ensureExecutable(unpackAsar(p));
}

function ffprobePath() {
  const fromPath = findOnPath('ffprobe');
  if (fromPath) return fromPath;
  try {
    const ffprobeStatic = require('ffprobe-static');
    let p = ffprobeStatic && ffprobeStatic.path;
    return ensureExecutable(unpackAsar(p));
  } catch (e) {
    return null;
  }
}

// ffmpeg-static on Windows is 6.1.1 (no -extension_picky / -allowed_segment_extensions).
// Linux distro ffmpeg is often 7+, which defaults extension_picky=1 and *needs* those
// flags for extensionless CDN segments. Always passing the FFmpeg 7 flags makes every
// Windows download die at argument parsing: "Unrecognized option 'extension_picky'".
// Probe once, silently (do not attach this to a download's stderr log).
let cachedHlsRelaxArgs = null;
function hlsRelaxArgs() {
  if (cachedHlsRelaxArgs) return cachedHlsRelaxArgs;
  const probed = spawnSync(ffmpegPath(), ['-hide_banner', '-h', 'demuxer=hls'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  const help = `${probed.stdout || ''}${probed.stderr || ''}${probed.error ? probed.error.message : ''}`;
  const args = [];
  if (/extension_picky/i.test(help)) args.push('-extension_picky', '0');
  if (/allowed_extensions/i.test(help)) args.push('-allowed_extensions', 'ALL');
  if (/allowed_segment_extensions/i.test(help)) args.push('-allowed_segment_extensions', 'ALL');
  // Without this the demuxer skips a segment the CDN failed on and exits 0,
  // leaving a file minutes short of the episode.
  if (/seg_max_retry/i.test(help)) args.push('-seg_max_retry', '8');
  cachedHlsRelaxArgs = args;
  return args;
}

let cachedHttpReconnectArgs = null;
function httpReconnectArgs() {
  if (cachedHttpReconnectArgs) return cachedHttpReconnectArgs;
  const probed = spawnSync(ffmpegPath(), ['-hide_banner', '-h', 'protocol=https'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  const help = `${probed.stdout || ''}${probed.stderr || ''}${probed.error ? probed.error.message : ''}`;
  const args = [];
  if (/-reconnect\s/m.test(help)) args.push('-reconnect', '1');
  if (/reconnect_streamed/i.test(help)) args.push('-reconnect_streamed', '1');
  if (/reconnect_on_network_error/i.test(help)) args.push('-reconnect_on_network_error', '1');
  // Do NOT reconnect on 429: immediate retries deepen the rate limit. Queue +
  // cooldown below wait it out instead.
  if (/reconnect_on_http_error/i.test(help)) args.push('-reconnect_on_http_error', '500,502,503,504');
  if (/reconnect_delay_max/i.test(help)) args.push('-reconnect_delay_max', '15');
  if (/reconnect_max_retries/i.test(help)) args.push('-reconnect_max_retries', '4');
  // Windows errno 138 is ETIMEDOUT. ffmpeg's default socket wait is short enough
  // that Mullvad + a slow token CDN fails to open the input at all.
  if (/\brw_timeout\b/i.test(help)) args.push('-rw_timeout', '60000000');
  if (/\b-timeout\b/m.test(help) || /timeout\s+timeout/i.test(help)) {
    args.push('-timeout', '60000000');
  }
  cachedHttpReconnectArgs = args;
  return args;
}

function isRateLimited(err) {
  return /429|too many requests/i.test(String((err && err.message) || err || ''));
}

const hlsGate = { active: 0, waiters: [], cooldownUntil: 0, cooldownTimer: null };

function wakeHlsWaiters() {
  const w = hlsGate.waiters;
  hlsGate.waiters = [];
  w.forEach((fn) => fn());
}

function tripRateLimit() {
  const ms = Math.max(5000, config.download.rateLimitCooldownMs || 30000);
  hlsGate.cooldownUntil = Date.now() + ms;
  if (hlsGate.cooldownTimer) clearTimeout(hlsGate.cooldownTimer);
  hlsGate.cooldownTimer = setTimeout(() => {
    hlsGate.cooldownTimer = null;
    wakeHlsWaiters();
  }, ms);
}

async function withHlsGate(fn) {
  const limit = Math.max(1, config.download.hlsConcurrency || 1);
  while (hlsGate.active >= limit || Date.now() < hlsGate.cooldownUntil) {
    const wait = Math.max(50, hlsGate.cooldownUntil - Date.now());
    await new Promise((r) => {
      hlsGate.waiters.push(r);
      if (Date.now() < hlsGate.cooldownUntil) setTimeout(r, Math.min(wait, 5000));
    });
  }
  hlsGate.active += 1;
  try {
    return await fn();
  } catch (err) {
    if (isRateLimited(err)) tripRateLimit();
    throw err;
  } finally {
    hlsGate.active -= 1;
    wakeHlsWaiters();
  }
}

function headerLines(headers, ua) {
  const lines = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === 'user-agent') continue; // passed via -user_agent
    if (v) lines.push(`${k}: ${v}`);
  }
  return lines;
}

function unlinkPart(partPath) {
  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch (e) {
    // ignore
  }
}

function mp4Headers(detection) {
  const headers = Object.assign({}, detection.headers || {});
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = config.download.userAgent;
  }
  return headers;
}

function writeStreamWithProgress(readable, partPath, total, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partPath);
    let received = 0;
    const onAbort = () => {
      try {
        readable.destroy();
      } catch (e) {
        /* ignore */
      }
      try {
        out.destroy();
      } catch (e) {
        /* ignore */
      }
      reject(new AbortError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    readable.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress({ received, total, percent: total ? received / total : null });
    });
    readable.pipe(out);
    out.on('finish', () => out.close(() => resolve({ bytes: received })));
    out.on('error', reject);
    readable.on('error', reject);
  });
}

// Token CDNs (cloudatacdn) hang or 403 Node's https client, and a leftover .part
// from a previous HLS attempt cannot be Range-resumed onto a new MP4 URL.
async function downloadMp4(detection, partPath, opts = {}) {
  unlinkPart(partPath);
  const headers = mp4Headers(detection);
  try {
    const sess = session.fromPartition(config.sessionPartition);
    if (sess && typeof sess.fetch === 'function') {
      const res = await sess.fetch(detection.url, { headers, signal: opts.signal });
      const code = res.status || 0;
      if (code >= 400) throw new Error(`HTTP ${code} for ${detection.url}`);
      const total =
        parseInt(
          (typeof res.headers.get === 'function'
            ? res.headers.get('content-length')
            : res.headers['content-length']) || '0',
          10
        ) || 0;
      const webBody = res.body;
      const readable =
        webBody && typeof webBody.getReader === 'function'
          ? Readable.fromWeb(webBody)
          : webBody;
      if (!readable) throw new Error('empty MP4 body');
      return await writeStreamWithProgress(readable, partPath, total, opts);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    unlinkPart(partPath);
    try {
      return await downloadMp4Node(detection, partPath, opts, 5, headers);
    } catch (err2) {
      if (err2 && err2.name === 'AbortError') throw err2;
      unlinkPart(partPath);
      return withHlsGate(() => downloadHls({ ...detection, type: 'mp4' }, partPath, opts));
    }
  }
  return downloadMp4Node(detection, partPath, opts, 5, headers);
}

function downloadMp4Node(detection, partPath, { signal, onProgress } = {}, redirectsLeft = 5, headers) {
  return new Promise((resolve, reject) => {
    const lib = detection.url.startsWith('https:') ? https : http;
    const h = headers || mp4Headers(detection);
    const left = redirectsLeft == null ? 5 : redirectsLeft;

    const req = lib.get(detection.url, { headers: h, timeout: 60000 }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && left > 0) {
        res.resume();
        const next = new URL(res.headers.location, detection.url).toString();
        return downloadMp4Node({ ...detection, url: next }, partPath, { signal, onProgress }, left - 1, h).then(
          resolve,
          reject
        );
      }
      if (code === 429) {
        res.resume();
        return reject(new Error(`HTTP 429 Too Many Requests for ${detection.url}`));
      }
      if (code >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${code} for ${detection.url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      return writeStreamWithProgress(res, partPath, total, { signal, onProgress }).then(resolve, reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CDN connection timed out; will retry with a fresh stream URL'));
    });
    req.on('error', (err) => {
      if (signal && signal.aborted) return reject(new AbortError());
      reject(err);
    });

    if (signal) {
      const onAbort = () => {
        req.destroy();
        reject(new AbortError());
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// HLS (or DASH/mp4) -> mp4 using ffmpeg with -c copy (lossless remux).
// In Sub mode (detection.embedSubs) subtitles are embedded as a soft mov_text
// track: from a separate sniffed subtitle file when available, otherwise from a
// subtitle stream inside the HLS master playlist.
function downloadHls(detection, partPath, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, detection.headers || {});
    const ua =
      Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1] ||
      config.download.userAgent;

    const args = ['-y', '-hide_banner', '-loglevel', 'info'];
    const hLines = headerLines(headers, ua);
    if (hLines.length) args.push('-headers', hLines.join('\r\n') + '\r\n');
    args.push('-user_agent', ua);
    args.push(...httpReconnectArgs());
    const playlist =
      detection.type === 'hls' || /\.m3u8|\/hls\d*\//i.test(detection.url || '');
    if (playlist) {
      args.push(...hlsRelaxArgs());
      if (/\.m3u8/i.test(detection.url || '')) args.push('-f', 'hls');
    }
    args.push('-i', detection.url);

    const hasExternalSub = detection.embedSubs && detection.subtitleUrl;
    if (hasExternalSub) args.push('-i', detection.subtitleUrl);

    if (detection.embedSubs) {
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      args.push('-map', hasExternalSub ? '1:0' : '0:s:0?');
      args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text');
      args.push('-bsf:a', 'aac_adtstoasc');
      args.push('-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default');
    } else if (detection.type === 'mp4') {
      args.push('-c', 'copy', '-dn', '-sn');
    } else {
      args.push('-map', '0:v?', '-map', '0:a?');
      args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-dn', '-sn');
    }
    args.push('-f', 'mp4', partPath);

    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let durationSec = 0;
    let writtenSec = 0;
    let stderrTail = '';

    proc.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderrTail = (stderrTail + text).slice(-4000);

      if (!durationSec) {
        const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (d) durationSec = +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]);
      }
      const t = text.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) {
        writtenSec = Math.max(writtenSec, +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]));
      }
      if (t && onProgress) {
        const cur = +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]);
        onProgress({
          received: cur,
          total: durationSec,
          percent: durationSec ? Math.min(cur / durationSec, 0.999) : null
        });
      }
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        // ignore
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('error', (err) => reject(describeBinaryError(err, ffmpegPath())));
    proc.on('close', (code) => {
      if (aborted) return reject(new AbortError());
      if (code === 0) {
        // Some CDNs serve the episode body as one huge segment and 502 on it. The
        // HLS demuxer moves on to the next segment and still exits 0, so without
        // this check a 45-second file would pass as a finished episode.
        const shortfall = durationSec > 60 && writtenSec > 0 && writtenSec < durationSec * 0.9;
        if (shortfall) {
          const mins = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
          return reject(
            new Error(
              `stream truncated: wrote ${mins(writtenSec)} of ${mins(durationSec)} ` +
                `(${stderrTail.split('\n').slice(-2).join(' ').trim()})`
            )
          );
        }
        return resolve({ bytes: safeSize(partPath) });
      }
      reject(new Error(describeFfmpegExit(code, stderrTail)));
    });
  });
}

// Turns cryptic spawn errors for the bundled binaries into an actionable
// message (these are commonly mistaken for "video is protected/DRM" errors).
function describeFfmpegExit(code, stderrTail) {
  const tail = (stderrTail || '').split('\n').slice(-4).join(' ').trim();
  // Windows maps ETIMEDOUT to errno 138; unsigned that is 4294967158.
  if (
    code === 4294967158 ||
    code === -138 ||
    /-138\b/.test(tail) ||
    /ETIMEDOUT|connection timed out|Error number -138/i.test(tail)
  ) {
    return 'CDN connection timed out; will retry with a fresh stream URL';
  }
  if (/403|forbidden|401|unauthorized/i.test(tail)) {
    return 'CDN rejected the stream (expired token or missing headers); will retry';
  }
  return `ffmpeg exited with code ${code}: ${tail}`;
}

function describeBinaryError(err, binPath) {
  if (err && err.code === 'EACCES') {
    return new Error(
      `Cannot run bundled ffmpeg (permission denied): ${binPath}. ` +
        'The binary is missing its executable bit - run "chmod +x" on it or reinstall dependencies.'
    );
  }
  if (err && err.code === 'ENOENT') {
    return new Error(
      `Bundled ffmpeg not found at: ${binPath}. ` +
        'Reinstall dependencies on this machine (do not copy node_modules across OSes).'
    );
  }
  return err;
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

// Dispatches based on detection type.
function download(detection, partPath, opts) {
  const u = detection.url || '';
  const progressive =
    detection.type === 'mp4' ||
    (/cloudatacdn\.com/i.test(u) && !/\.m3u8/i.test(u));
  if (progressive) return downloadMp4(detection, partPath, opts);
  return withHlsGate(() => downloadHls(detection, partPath, opts));
}

module.exports = { download, downloadMp4, downloadHls, AbortError, ffmpegPath, ffprobePath };
