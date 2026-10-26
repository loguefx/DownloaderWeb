'use strict';

// The file move that places a finished download into its library folder.
//
// This runs in a CHILD PROCESS (movefile-child.js, spawned by
// Library.runMove) because the target may sit on a network share: a hung
// share blocks fs calls, and a blocked call in a child process can be KILLED
// (TerminateProcess works even on a blocked SMB syscall, on Windows too)
// while a blocked call in the engine's own thread freezes the whole app -
// API, watchdogs, everything.
//
// Plain Node fs only (no Electron, no app state) so the child stays small
// and fast to start. The parent keeps the ledger / audit / locks and decides
// what is allowed; this module only moves bytes.

const fs = require('fs');
const path = require('path');

const TRASH_DIRNAME = '.mediadownloader-trash';

// Replaced files are never deleted: they go to
// <drive>/.mediadownloader-trash/<YYYY-MM-DD>/<name>.
function trashFile(file, trashDirname, day) {
  if (!file || !fs.existsSync(file)) return null;
  let name = path.basename(file);
  const m = name.match(/^(.*)\.old-\d+$/);
  if (m) name = m[1];
  day = day || new Date().toISOString().slice(0, 10);
  const root = path.join(path.dirname(file), trashDirname, day);
  fs.mkdirSync(root, { recursive: true });
  let target = path.join(root, name);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(root, `${name} (${i++})`);
  fs.renameSync(file, target);
  return target;
}

function copyFile(src, dest) {
  const CHUNK = 16 * 1024 * 1024;
  const srcFd = fs.openSync(src, 'r');
  const dstFd = fs.openSync(dest, 'w');
  try {
    const size = fs.fstatSync(srcFd).size;
    const buf = Buffer.alloc(CHUNK);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(srcFd, buf, 0, Math.min(CHUNK, size - off), off);
      if (n <= 0) break;
      fs.writeSync(dstFd, buf, 0, n);
      off += n;
    }
    fs.fsyncSync(dstFd);
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(dstFd);
  }
}

// Moves partPath to finalPath with the add-only guarantees:
//   - a file at finalPath is NEVER overwritten unless expectExisting (the
//     parent checked the ledger before asking);
//   - a replaced file is trashed, never deleted;
//   - cross-volume moves copy to <final>.partial, size-check, then rename
//     within the target drive - at no point are both copies gone;
//   - the staged source is consumed only after the new file is in place.
//
// params: { partPath, finalPath, replacePath, expectExisting, sameVolume,
//           trashDirname }
function moveIntoPlace(params) {
  const partPath = params.partPath;
  const finalPath = params.finalPath;
  const replacePath = params.replacePath || null;
  const expectExisting = !!params.expectExisting;
  const trashDirname = params.trashDirname || TRASH_DIRNAME;

  if (!partPath || !fs.existsSync(partPath)) {
    throw new Error('movefile: staged file missing: ' + partPath);
  }
  // The last line of defence, even if the parent's checks raced or were
  // bypassed: never clobber a file we were not asked to replace.
  if (fs.existsSync(finalPath) && !expectExisting) {
    throw new Error(`Refusing to overwrite an existing file: ${finalPath}`);
  }
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  let trashedTo = null;
  const placeNew = (src) => {
    // src = the file that becomes finalPath (partPath or .partial)
    if (fs.existsSync(finalPath)) {
      // Same-name replacement: old file safe on the same drive first.
      const aside = `${finalPath}.old-${Date.now()}`;
      fs.renameSync(finalPath, aside);
      fs.renameSync(src, finalPath);
      trashedTo = trashFile(aside, trashDirname);
    } else {
      fs.renameSync(src, finalPath);
      // Different-name replacement: the old (hand-named) file is trashed,
      // the canonical path gets the new file.
      if (replacePath) trashedTo = trashFile(replacePath, trashDirname);
    }
  };

  if (params.sameVolume) {
    placeNew(partPath);
  } else {
    const partial = `${finalPath}.partial`;
    const expectBytes = fs.statSync(partPath).size;
    copyFile(partPath, partial);
    const st = fs.statSync(partial);
    if (st.size !== expectBytes) {
      try {
        fs.unlinkSync(partial);
      } catch (e) {
        /* ignore */
      }
      throw new Error(`Size mismatch after copy: got ${st.size}, expected ${expectBytes}`);
    }
    placeNew(partial);
    // Staging source is consumed by the move (new file verified in place).
    try {
      fs.unlinkSync(partPath);
    } catch (e) {
      /* ignore */
    }
  }
  return { finalPath, trashedTo };
}

module.exports = { moveIntoPlace, trashFile, copyFile, TRASH_DIRNAME };
