'use strict';

// Cross-platform launcher for `npm start`.
//
// Two things regularly break `electron .` on Linux even when the same tree
// works on Windows:
//
// 1. node_modules/electron/path.txt is read *without trimming*. A trailing
//    newline (from `echo`, CRLF from a Windows checkout, etc.) makes spawn()
//    look for a file named "electron\n" and fail with ENOENT.
// 2. Cursor / VS Code (themselves Electron apps) export ELECTRON_RUN_AS_NODE=1
//    into integrated terminals. Child Electron processes inherit it and boot as
//    Node, so `require('electron').app` is undefined.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');

function trimPathFile() {
  if (!fs.existsSync(pathFile)) return;
  const raw = fs.readFileSync(pathFile, 'utf8');
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (trimmed !== raw) fs.writeFileSync(pathFile, trimmed);
}

trimPathFile();

let electronPath;
try {
  electronPath = require('electron');
} catch (e) {
  console.error('Electron is not installed. From this folder run: npm install');
  process.exit(1);
}

if (typeof electronPath !== 'string') {
  console.error('scripts/start.js must be run with Node, not Electron.');
  process.exit(1);
}

if (!fs.existsSync(electronPath)) {
  console.error('Electron binary not found at:', JSON.stringify(electronPath));
  console.error('Delete node_modules/electron and run: npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || String(args[0]).startsWith('-')) {
  args.unshift(path.join(__dirname, '..'));
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.platform === 'linux') {
  try {
    const st = fs.statfsSync('/dev/shm');
    const mb = Math.round((Number(st.bavail) * Number(st.bsize)) / 1024 / 1024);
    if (mb < 256) {
      console.warn(
        'Warning: /dev/shm is only ' +
          mb +
          ' MB. Chromium cannot decode video in this environment.\n' +
          'Start the app from a normal system terminal (not Cursor):\n' +
          '  cd ' +
          path.join(__dirname, '..') +
          ' && npm start'
      );
    }
  } catch (e) {
    // ignore
  }
}

const child = spawn(electronPath, args, { stdio: 'inherit', windowsHide: false, env });
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
child.on('close', (code, signal) => {
  if (code === null) {
    console.error(electronPath, 'exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
