'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');

// Resolve the bundled ffprobe binary (works in dev and packaged/asar-unpacked).
function ffprobePath() {
  let p = require('ffprobe-static').path;
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

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
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: 'ffprobe failed: ' + err.message });
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

module.exports = { verifyFile, ffprobePath };
