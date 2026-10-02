'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');
const { ffprobePath } = require('./downloader');

// Validates a finished media file: must exist, exceed a minimum size, and have
// a probe-able video stream with a positive duration.
function verifyFile(filePath, opts = {}) {
  return new Promise((resolve) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return resolve({ ok: false, reason: 'File does not exist' });
    }
    if (stat.size < config.download.minFileBytes) {
      return resolve({ ok: false, reason: `File too small (${stat.size} bytes)` });
    }

    execFile(
      ffprobePath(),
      [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type,width,height',
        '-of', 'json',
        filePath
      ],
      { timeout: 30000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: describeProbeError(err) });
        try {
          const info = JSON.parse(stdout || '{}');
          const duration = parseFloat(info.format && info.format.duration);
          const fmt = String((info.format && info.format.format_name) || '');
          let height = 0;
          let width = 0;
          let hasVideo = false;
          for (const s of info.streams || []) {
            if (s.codec_type !== 'video') continue;
            hasVideo = true;
            const h = parseInt(s.height, 10) || 0;
            if (h > height) {
              height = h;
              width = parseInt(s.width, 10) || 0;
            }
          }
          if (!/mp4|isom|iso2|avc1|mp41|mp42/i.test(fmt)) {
            return resolve({ ok: false, reason: `Not an MP4 (${fmt || 'unknown'})` });
          }
          if (!hasVideo) return resolve({ ok: false, reason: 'No video stream' });
          const need = opts.minDuration > 20 ? opts.minDuration * 0.9 : 20;
          if (!(duration > need)) {
            return resolve({
              ok: false,
              reason: `Duration too short (${duration.toFixed(1)}s, need ${Math.round(need)}s)`
            });
          }
          return resolve({ ok: true, duration, bytes: stat.size, height, width });
        } catch (e) {
          return resolve({ ok: false, reason: 'Could not parse ffprobe output' });
        }
      }
    );
  });
}

// Cryptic ffprobe spawn errors (esp. EACCES) are easily mistaken for the video
// being "protected"; make the real cause explicit instead.
function describeProbeError(err) {
  if (err && err.code === 'EACCES') {
    return `Cannot run bundled ffprobe (permission denied): ${ffprobePath()}. The binary is missing its executable bit - run "chmod +x" on it or reinstall dependencies.`;
  }
  if (err && err.code === 'ENOENT') {
    return `Bundled ffprobe not found at: ${ffprobePath()}. Reinstall dependencies on this machine (do not copy node_modules across OSes).`;
  }
  return 'ffprobe failed: ' + err.message;
}

// True when a finished file has a measured picture shorter than the site's floor.
// An unreadable height is not treated as the wrong resolution.
function belowMinHeight(probed, minHeight) {
  const min = Number(minHeight) || 0;
  if (!min || !probed || !(probed.height > 0)) return false;
  return probed.height < min;
}

module.exports = { verifyFile, ffprobePath, belowMinHeight };
