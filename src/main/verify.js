'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');
const { ffprobePath } = require('./downloader');

// Validates a finished media file: must exist, exceed a minimum size, and have
// a probe-able video stream with a positive duration.
function verifyFile(filePath) {
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
        '-show_entries', 'format=duration:stream=codec_type',
        '-of', 'json',
        filePath
      ],
      { timeout: 30000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: describeProbeError(err) });
        try {
          const info = JSON.parse(stdout || '{}');
          const duration = parseFloat(info.format && info.format.duration);
          const hasVideo = (info.streams || []).some((s) => s.codec_type === 'video');
          if (!hasVideo) return resolve({ ok: false, reason: 'No video stream' });
          if (!(duration > 0)) return resolve({ ok: false, reason: 'Zero/unknown duration' });
          return resolve({ ok: true, duration, bytes: stat.size });
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

module.exports = { verifyFile, ffprobePath };
