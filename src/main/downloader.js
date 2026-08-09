'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
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

function ffmpegPath() {
  // Prefer a system ffmpeg when present. The ffmpeg-static binary SIGSEGVs on
  // some newer distros (e.g. CachyOS), and system builds understand current HLS
  // demuxer flags we need for extensionless CDN segments.
  try {
    const which = require('child_process').execFileSync('which', ['ffmpeg'], {
      encoding: 'utf8',
      timeout: 2000
    }).trim();
    if (which) return which;
  } catch (e) {
    // fall through to bundled
  }
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return ensureExecutable(p);
}

function ffprobePath() {
  try {
    const which = require('child_process').execFileSync('which', ['ffprobe'], {
      encoding: 'utf8',
      timeout: 2000
    }).trim();
    if (which) return which;
  } catch (e) {
    // fall through
  }
  try {
    const ffprobeStatic = require('ffprobe-static');
    let p = ffprobeStatic && ffprobeStatic.path;
    if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
    return ensureExecutable(p);
  } catch (e) {
    return null;
  }
}

// HLS demuxer flags so extensionless CDN segment URLs (common on aniwave /
// echovideo mirrors) are accepted. FFmpeg 7+ defaults to extension_picky=1 and
// rejects /cdn/<hash> segment paths without these.
//
// Do NOT probe via `ffmpeg -h` — that writes help to stderr (leaks into the app
// log as a fake "ffmpeg failed" banner) and we previously read only stdout, so
// the flags were often missing and downloads failed.
function hlsRelaxArgs() {
  return ['-extension_picky', '0', '-allowed_extensions', 'ALL', '-allowed_segment_extensions', 'ALL'];
}

function headerLines(headers, ua) {
  const lines = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === 'user-agent') continue; // passed via -user_agent
    if (v) lines.push(`${k}: ${v}`);
  }
  return lines;
}

// Direct .mp4 download with HTTP Range resume into a .part file.
function downloadMp4(detection, partPath, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = detection.url.startsWith('https:');
    const lib = isHttps ? https : http;

    let startByte = 0;
    try {
      startByte = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    } catch (e) {
      startByte = 0;
    }

    const headers = Object.assign({}, detection.headers || {});
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = config.download.userAgent;
    }
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;

    const req = lib.get(detection.url, { headers }, (res) => {
      if (res.statusCode === 416) {
        // Already fully downloaded.
        res.resume();
        return resolve({ bytes: startByte });
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${detection.url}`));
      }

      const resuming = res.statusCode === 206 && startByte > 0;
      if (!resuming) startByte = 0; // server ignored Range -> restart

      const total =
        (parseInt(res.headers['content-length'] || '0', 10) || 0) + (resuming ? startByte : 0);
      let received = startByte;

      const out = fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' });
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) {
          onProgress({ received, total, percent: total ? received / total : null });
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ bytes: received })));
      out.on('error', reject);
      res.on('error', reject);
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
    // Must come before -i (hls demuxer options).
    args.push(...hlsRelaxArgs());
    args.push('-i', detection.url);

    const hasExternalSub = detection.embedSubs && detection.subtitleUrl;
    if (hasExternalSub) args.push('-i', detection.subtitleUrl);

    if (detection.embedSubs) {
      // Map video + audio from the stream; subtitles from the external file if
      // present, else from the stream (optional with "?").
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      args.push('-map', hasExternalSub ? '1:0' : '0:s:0?');
      args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text');
      args.push('-bsf:a', 'aac_adtstoasc');
      args.push('-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default');
    } else {
      // Copy every video + audio track, but explicitly drop data/timed-metadata
      // (-dn) and subtitle (-sn) tracks. Some HLS CDNs (e.g. nekostream) include
      // an id3/timed-metadata stream that the mp4 muxer rejects with "Invalid
      // argument" when a bare "-c copy" tries to remux it. "?" keeps the maps
      // optional so audio-only / video-only streams still work.
      args.push('-map', '0:v?', '-map', '0:a?');
      args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-dn', '-sn');
    }
    args.push('-f', 'mp4', partPath);

    const proc = spawn(ffmpegPath(), args);
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
      if (code === 0) return resolve({ bytes: safeSize(partPath) });
      reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail.split('\n').slice(-3).join(' ')}`));
    });
  });
}

// Turns cryptic spawn errors for the bundled binaries into an actionable
// message (these are commonly mistaken for "video is protected/DRM" errors).
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
  if (detection.type === 'mp4') return downloadMp4(detection, partPath, opts);
  return downloadHls(detection, partPath, opts); // hls / dash / content-type-detected
}

module.exports = { download, downloadMp4, downloadHls, AbortError, ffmpegPath };
