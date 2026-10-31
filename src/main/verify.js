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
        // Two distinct results:
        //   probeOk - ffprobe saw a video stream with a positive duration,
        //             regardless of container. That is "readable", which is all
        //             that matters for an EXISTING library file (Jellyfin
        //             libraries are full of .mkv).
        //   ok      - probeOk AND an MP4 container AND a sane duration. That is
        //             what the engine's own downloads must pass.
        const fail = (reason) => resolve({ ok: false, probeOk: false, height: 0, width: 0, duration: 0, bytes: stat.size, reason });
        if (err) return fail(describeProbeError(err));
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
          if (!hasVideo) return fail('No video stream');
          if (!(duration > 0)) return fail('Duration is not positive');
          const isMp4 = /mp4|isom|iso2|avc1|mp41|mp42/i.test(fmt);
          const need = opts.minDuration > 20 ? opts.minDuration * 0.9 : 20;
          if (!(duration > need)) {
            // Probe-able but too short: readable, yet not a complete file.
            return resolve({ ok: false, probeOk: true, height, width, duration, bytes: stat.size, reason: `Duration too short (${duration.toFixed(1)}s, need ${Math.round(need)}s)` });
          }
          return resolve({
            ok: isMp4,
            probeOk: true,
            duration,
            bytes: stat.size,
            height,
            width,
            reason: isMp4 ? '' : `Container is not MP4 (${fmt || 'unknown'}); readable, but not engine output`
          });
        } catch (e) {
          return fail('Could not parse ffprobe output');
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
  return !meetsQualityFloor(probed.width || 0, probed.height, min);
}

// A "1080p" floor means the 1920x1080 master class. Scope-cropped 2.00:1 /
// 2.39:1 films present that master at 1920x800 (a 720p class at 1280x534):
// full master width, short height. A height-only floor rejects every
// widescreen 1080p film (Runner 2026 is exactly this - its only 1080p copy
// measures 1920x800), so a width that reaches the class's master width with a
// widescreen aspect ratio also satisfies the floor.
function meetsQualityFloor(width, height, min) {
  if (!min) return true;
  if (height >= min) return true;
  const masterWidth = Math.round((min * 16) / 9);
  if (!width || width < masterWidth) return false;
  return height > 0 && width / height >= 1.85;
}

// Audio language tags of a file ('' for an untagged track); [] when unreadable.
function audioLanguages(filePath) {
  const { normLang } = require('./audiolang');
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index:stream_tags=language', '-of', 'json', filePath],
      { timeout: 30000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const j = JSON.parse(stdout || '{}');
          resolve((j.streams || []).map((s) => normLang(s.tags && s.tags.language)));
        } catch (e) {
          resolve([]);
        }
      }
    );
  });
}

module.exports = { verifyFile, ffprobePath, belowMinHeight, meetsQualityFloor, audioLanguages };
