'use strict';

// electron-builder afterPack hook.
//
// Guarantees the bundled ffmpeg/ffprobe binaries are executable INSIDE the
// packaged output (AppImage / pacman). npm's postinstall already sets +x in
// node_modules, but packaged Linux installs land in a read-only location, so the
// app's runtime best-effort chmod cannot fix a missing bit there. Setting it at
// build time - after files are copied into app.asar.unpacked - makes the shipped
// binaries executable no matter how electron-builder handled file modes.
//
// Without this, every download on Linux fails with EACCES ("Permission denied"),
// which localized desktops often surface as the video being "protected".

const fs = require('fs');
const path = require('path');

const BINARY_NAMES = new Set(['ffmpeg', 'ffprobe']);

function chmodBinariesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodBinariesIn(full);
    } else if (entry.isFile() && BINARY_NAMES.has(entry.name)) {
      try {
        fs.chmodSync(full, 0o755);
        console.log(`[afterPack] chmod +x ${full}`);
      } catch (e) {
        console.warn(`[afterPack] could not chmod ${full}: ${e.message}`);
      }
    }
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return;

  const unpacked = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules'
  );
  for (const pkg of ['ffmpeg-static', 'ffprobe-static']) {
    chmodBinariesIn(path.join(unpacked, pkg));
  }
};
