'use strict';

// Ensure the bundled ffmpeg/ffprobe binaries are executable after `npm install`.
//
// ffprobe-static (and sometimes ffmpeg-static) can land on disk without the
// Unix executable bit. On Windows that is irrelevant, but on Linux/macOS it
// makes every download fail at the ffprobe verification step with EACCES
// ("Permission denied") - which localized desktops often surface as the video
// being "protected". Setting the bit here also means the packaged pacman /
// AppImage build (which copies these files read-only) ships them executable.

const fs = require('fs');

if (process.platform === 'win32') {
  process.exit(0);
}

function resolveBinaries() {
  const paths = [];
  try {
    paths.push(require('ffmpeg-static'));
  } catch (e) {
    // package not installed yet; nothing to do
  }
  try {
    paths.push(require('ffprobe-static').path);
  } catch (e) {
    // package not installed yet; nothing to do
  }
  return paths.filter(Boolean);
}

for (const p of resolveBinaries()) {
  try {
    fs.chmodSync(p, 0o755);
    console.log(`[postinstall] chmod +x ${p}`);
  } catch (e) {
    console.warn(`[postinstall] could not chmod ${p}: ${e.message}`);
  }
}
