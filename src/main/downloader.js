'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { session, webContents } = require('electron');
const config = require('./config');
const hlscheck = require('./hlscheck');

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

function headerKey(headers, name) {
  return Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
}

async function cookieHeaderFor(urls) {
  let ses;
  try {
    ses = session.fromPartition(config.sessionPartition);
    if (!ses || !ses.cookies) return '';
  } catch (e) {
    return '';
  }
  const parts = [];
  const seen = new Set();
  const hosts = [];
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    let href = raw;
    try {
      const u = new URL(raw);
      hosts.push(u.hostname);
      href = u.href;
    } catch (e) {
      continue;
    }
    try {
      const list = await ses.cookies.get({ url: href });
      for (const c of list) {
        const k = `${c.name}=${c.value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        parts.push(k);
      }
    } catch (e) {
      // ignore
    }
  }
  if (!parts.length) {
    try {
      const all = await ses.cookies.get({});
      for (const c of all) {
        const domain = String(c.domain || '').replace(/^\./, '');
        if (!domain || !hosts.some((h) => h === domain || h.endsWith('.' + domain))) continue;
        const k = `${c.name}=${c.value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        parts.push(k);
      }
    } catch (e) {
      // ignore
    }
  }
  return parts.join('; ');
}

// Headers Chromium already used when the sniffer saw the playlist. Do not inject
// extra Cookie values from the jar: session.fetch sends those itself, and a
// duplicate Cookie header makes some token CDNs return garbage.
function browserHeaders(detection) {
  const headers = Object.assign({}, detection.headers || {});
  if (!headerKey(headers, 'user-agent')) {
    headers['User-Agent'] = config.download.userAgent;
  }
  // Never overwrite a sniffed Referer/Origin. Vidfast redirects .pro -> .vc and
  // the CDN 502s if we send the pre-redirect host.
  if (!headerKey(headers, 'referer') && detection.embedUrl) {
    try {
      headers['Referer'] = new URL(detection.embedUrl).origin + '/';
    } catch (e) {
      // ignore
    }
  }
  const refererKey = headerKey(headers, 'referer');
  const referer = refererKey ? headers[refererKey] : '';
  if (!headerKey(headers, 'origin') && referer) {
    try {
      headers['Origin'] = new URL(referer).origin;
    } catch (e) {
      // ignore
    }
  }
  return headers;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}

// Segment cache used while ffmpeg remuxes to MP4. Keep it out of Downloads.
// Delete it after a successful remux; keep it on failure so the next try
// does not re-download hundreds of parts from scratch.
function hlsWorkDir(partPath) {
  const id = crypto.createHash('sha1').update(String(partPath || '')).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `wvd-hls-${id}`);
}

function ffmpegFileArg(p) {
  const norm = String(p).replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(norm)) return `file:${norm}`;
  return norm;
}

async function prepareDownloadHeaders(detection) {
  const headers = Object.assign({}, browserHeaders(detection));
  if (!headerKey(headers, 'cookie')) {
    const refererKey = headerKey(headers, 'referer');
    const referer = refererKey ? headers[refererKey] : '';
    const cookie = await cookieHeaderFor([detection.url, detection.embedUrl, referer]);
    if (cookie) headers['Cookie'] = cookie;
  }
  return headers;
}

function unlinkPart(partPath) {
  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch (e) {
    // ignore
  }
  rmrf(`${partPath}.hls`);
  try {
    fs.unlinkSync(`${partPath}.m3u8`);
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
    const sess = session.fromPartition(detection.sessionPartition || config.sessionPartition);
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
async function downloadHls(detection, partPath, opts = {}) {
  const { signal, onProgress, onLog } = opts;
  const headers = browserHeaders(detection);
  const ffmpegHeaders = await prepareDownloadHeaders(detection);
  const ua =
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1] ||
    config.download.userAgent;

  const treatAsHls =
    detection.type !== 'mp4' &&
    (detection.type === 'hls' || /\.m3u8|\/hls\d*\//i.test(detection.url || ''));
  if (!treatAsHls || !/\.m3u8/i.test(detection.url || '')) {
    return spawnFfmpegHls(detection.url, ffmpegHeaders, ua, detection, partPath, opts, false);
  }

  const dir = hlsWorkDir(partPath);
  let localPlaylist = null;
  let allLocal = false;
  let keepCache = false;
  try {
    let loaded = null;
    const boundPlayer =
      hlscheck.isPlayerBoundCdn(detection.url, detection.embedUrl) &&
      detection.playerWebContentsId != null;
    if (boundPlayer) {
      const wc =
        detection.playerWebContentsId != null
          ? webContents.fromId(detection.playerWebContentsId)
          : null;
      const nPl = wc && wc._cdpPlaylists ? wc._cdpPlaylists.size : 0;
      const nParts = wc && wc._cdpParts ? wc._cdpParts.size : 0;
      if (onLog) {
        onLog(
          `Player debugger has ${nPl} playlist body(ies), ${nParts} part(s), ${
            (wc && wc._cdpMsgs) || 0
          } CDP events.`
        );
      }
    }
    const startUrl = detection.url;
    const startText =
      detection.playlistText && !hlscheck.isMasterPlaylist(detection.playlistText)
        ? { text: detection.playlistText, base: detection.playlistBase || detection.url }
        : null;
    if (startText) loaded = startText;
    if (!loaded || hlscheck.isMasterPlaylist(loaded.text)) {
      try {
        loaded = await hlscheck.loadMediaPlaylist(
          startUrl,
          headers,
          signal,
          detection.playerWebContentsId
        );
        if (onLog) {
          onLog(
            'Using media playlist: ' + hlscheck.describeMediaPlaylist(loaded.base, loaded.text)
          );
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (onLog) onLog(`Player playlist fetch failed (${e.message || e}); will retry.`);
        throw e;
      }
    }
    const firstSeg = hlscheck.firstUri(loaded.text);
    if (loaded.text) {
      detection.playlistDuration = hlscheck.playlistMediaDuration(loaded.text);
    }
    let disguised = hlscheck.isTokenCdn(detection.url, detection.embedUrl);
    let pngSeen = false;
    if (loaded.mseOnly || !firstSeg) {
      if (hlscheck.isPlayerBoundCdn(detection.url, detection.embedUrl)) {
        throw new Error('Player did not yield a complete HLS playlist; not capturing MSE/WebM');
      }
      const wc =
        detection.playerWebContentsId != null ? webContents.fromId(detection.playerWebContentsId) : null;
      if (!wc || wc.isDestroyed()) {
        throw new Error('CDN playlist unavailable and the player window is gone');
      }
      allLocal = true;
      if (onLog) onLog('Capturing the live player buffer (no CDN playlist).');
      fs.mkdirSync(dir, { recursive: true });
      localPlaylist = await hlscheck.captureLivePlayer(wc, dir, { signal, onProgress, onLog });
    } else {
      if (firstSeg && !detection.playerWebContentsId) {
        try {
          const buf = await hlscheck.fetchBuffer(firstSeg, headers, {
            timeoutMs: 20000,
            signal,
            playerWebContentsId: detection.playerWebContentsId
          });
          pngSeen = hlscheck.isPng(buf);
          if (pngSeen) disguised = true;
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          if (onLog) onLog(`Could not peek the first segment (${e.message || e}); will still pull parts via the browser session.`);
        }
      }
      if (disguised) {
        allLocal = true;
        if (onLog) {
          const viaPlayer = detection.playerWebContentsId != null;
          onLog(
            pngSeen
              ? 'Stream segments are disguised (PNG-wrapped); downloading them through Chromium, then remuxing.'
              : 'Token CDN stream; downloading segments through Chromium, then remuxing.'
          );
          if (viaPlayer) onLog('Using the live player page to fetch segments (same origin as playback).');
        }
        fs.mkdirSync(dir, { recursive: true });
        localPlaylist = await hlscheck.localizePlaylist(loaded.text, loaded.base, dir, headers, {
          signal,
          onProgress,
          onLog,
          playerWebContentsId: detection.playerWebContentsId
        });
      } else {
        fs.mkdirSync(dir, { recursive: true });
        localPlaylist = path.join(dir, 'playlist.m3u8');
        fs.writeFileSync(localPlaylist, loaded.text, 'utf8');
      }
    }
    const inputUrl = ffmpegFileArg(localPlaylist);
    return await spawnFfmpegHls(
      inputUrl,
      ffmpegHeaders,
      ua,
      detection,
      partPath,
      opts,
      true,
      allLocal
    );
  } catch (err) {
    keepCache = !!(err && err.name !== 'AbortError');
    if (err && err.name === 'AbortError') throw err;
    if (err && (err.kind === 'html' || err.kind === 'json')) throw err;
    if (allLocal || hlscheck.isTokenCdn(detection.url, detection.embedUrl)) throw err;
    keepCache = false;
    return spawnFfmpegHls(detection.url, ffmpegHeaders, ua, detection, partPath, opts, false);
  } finally {
    if (!keepCache) rmrf(dir);
    rmrf(`${partPath}.hls`);
    try {
      fs.unlinkSync(`${partPath}.m3u8`);
    } catch (e) {
      // ignore
    }
  }
}

function spawnFfmpegCopy(inputPath, partPath, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      inputPath,
      '-map',
      '0:v?',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-dn',
      '-sn',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      partPath
    ];
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let durationSec = 0;
    let stderrTail = '';
    proc.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      if (!durationSec) {
        const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (d) durationSec = +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]);
      }
      const t = text.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
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
      if (code === 0) return resolve(partPath);
      reject(new Error((stderrTail || `ffmpeg exited ${code}`).trim().slice(-500)));
    });
  });
}

function spawnFfmpegHls(inputUrl, headers, ua, detection, partPath, { signal, onProgress } = {}, localPlaylist, allLocal) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'info'];
    if (!allLocal) {
      const hLines = headerLines(headers, ua);
      if (hLines.length) args.push('-headers', hLines.join('\r\n') + '\r\n');
      args.push('-user_agent', ua);
      args.push(...httpReconnectArgs());
    }
    const playlist =
      localPlaylist ||
      detection.type === 'hls' ||
      /\.m3u8|\/hls\d*\//i.test(detection.url || '');
    if (playlist) {
      args.push(...hlsRelaxArgs());
      if (localPlaylist || allLocal) {
        args.push('-protocol_whitelist', allLocal ? 'file,crypto,data' : 'file,http,https,tcp,tls,crypto,data');
      }
      if (localPlaylist || allLocal || /\.m3u8/i.test(detection.url || '')) args.push('-f', 'hls');
    }
    args.push('-fflags', '+genpts', '-avoid_negative_ts', 'make_zero');
    args.push('-i', ffmpegFileArg(inputUrl));

    const audioPl = /mse-video\.m3u8$/i.test(String(inputUrl || ''))
      ? String(inputUrl).replace(/mse-video\.m3u8$/i, 'mse-audio.m3u8')
      : '';
    const hasMseAudio = !!(audioPl && fs.existsSync(audioPl));
    if (hasMseAudio) {
      args.push('-f', 'hls', '-i', ffmpegFileArg(audioPl));
    }

    const hasExternalSub = detection.embedSubs && detection.subtitleUrl;
    if (hasExternalSub) args.push('-i', detection.subtitleUrl);
    const fmp4Hls = /mse-(index|video)\.m3u8$/i.test(String(inputUrl || ''));

    if (hasMseAudio) {
      args.push('-map', '0:v?', '-map', '1:a?', '-c', 'copy', '-dn', '-sn');
    } else if (detection.embedSubs) {
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      args.push('-map', hasExternalSub ? '1:0' : '0:s:0?');
      args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text');
      if (!fmp4Hls) args.push('-bsf:a', 'aac_adtstoasc');
      args.push('-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default');
    } else if (detection.type === 'mp4') {
      args.push('-c', 'copy', '-dn', '-sn');
    } else {
      args.push('-map', '0:v?', '-map', '0:a?');
      args.push('-c', 'copy', '-dn', '-sn');
      if (!fmp4Hls) args.push('-bsf:a', 'aac_adtstoasc');
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
        // MSE playlists invent EXTINF from player duration / fragment count, so
        // ffmpeg's Duration line is not the real media length — don't reject a
        // complete remux just because that estimate was high.
        const shortfall =
          !fmp4Hls && durationSec > 60 && writtenSec > 0 && writtenSec < durationSec * 0.9;
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
  if (/Video: png/i.test(tail)) {
    return 'CDN disguised the video as PNG images; will retry with a fresh stream';
  }
  if (/Invalid data found when processing input/i.test(tail)) {
    return 'Captured video parts could not be remuxed; will retry with a fresh stream';
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
