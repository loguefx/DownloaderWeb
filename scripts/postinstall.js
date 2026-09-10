'use strict';

// Post-npm-install housekeeping that must work on Windows and Linux/macOS.
//
// - Electron's installer writes node_modules/electron/path.txt, which the
//   electron wrapper reads *without trimming*. A trailing newline/CRLF makes
//   `npm start` fail with ENOENT (spawn ".../electron\n").
// - npm 10+ blocks dependency install scripts unless allowScripts lists them,
//   so electron/ffmpeg-static may not download their binaries. We try again.
// - On Unix, ffmpeg-static / ffprobe-static often land without the executable
//   bit. Windows ignores that bit; Linux then fails downloads with EACCES.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function expectedElectronRel() {
  if (process.platform === 'win32') return 'electron.exe';
  if (process.platform === 'darwin') {
    return path.join('Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return 'electron';
}

function electronPaths() {
  const dir = path.join(__dirname, '..', 'node_modules', 'electron');
  return {
    dir,
    pathFile: path.join(dir, 'path.txt'),
    dist: path.join(dir, 'dist'),
    installJs: path.join(dir, 'install.js')
  };
}

function trimElectronPathTxt() {
  const { pathFile } = electronPaths();
  const expected = expectedElectronRel();
  try {
    if (fs.existsSync(pathFile)) {
      const raw = fs.readFileSync(pathFile, 'utf8');
      const trimmed = raw.replace(/^\uFEFF/, '').trim() || expected;
      if (trimmed !== raw) fs.writeFileSync(pathFile, trimmed);
    } else if (fs.existsSync(electronPaths().dir)) {
      fs.writeFileSync(pathFile, expected);
    }
  } catch (e) {
    console.warn(`[postinstall] could not fix electron path.txt: ${e.message}`);
  }
}

function electronBinaryExists() {
  const { dist, pathFile } = electronPaths();
  let rel = expectedElectronRel();
  try {
    if (fs.existsSync(pathFile)) {
      rel = fs.readFileSync(pathFile, 'utf8').replace(/^\uFEFF/, '').trim() || rel;
    }
  } catch (e) {
    // use default
  }
  return fs.existsSync(path.join(dist, rel));
}

function ensureElectron() {
  trimElectronPathTxt();
  if (electronBinaryExists()) return;

  const { installJs } = electronPaths();
  if (!fs.existsSync(installJs)) return;

  console.log('[postinstall] Electron binary missing; running electron/install.js');
  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(process.execPath, [installJs], { stdio: 'inherit', env });
  trimElectronPathTxt();

  if (!electronBinaryExists()) {
    console.warn(
      '[postinstall] Electron binary still missing. npm 10+ blocks dependency install scripts by default.'
    );
    console.warn(
      '[postinstall] Fix: npm install-scripts approve electron ffmpeg-static && npm install'
    );
  }
}

function resolveFfmpegBinaries() {
  const paths = [];
  try {
    paths.push(require('ffmpeg-static'));
  } catch (e) {
    // package not installed yet
  }
  try {
    paths.push(require('ffprobe-static').path);
  } catch (e) {
    // package not installed yet
  }
  return paths.filter(Boolean);
}

ensureElectron();

if (process.platform !== 'win32') {
  for (const p of resolveFfmpegBinaries()) {
    try {
      fs.chmodSync(p, 0o755);
      console.log(`[postinstall] chmod +x ${p}`);
    } catch (e) {
      console.warn(`[postinstall] could not chmod ${p}: ${e.message}`);
    }
  }
}
