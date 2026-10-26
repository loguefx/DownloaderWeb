'use strict';

// Library safety layer (Jellyfin build plan, Part 11).
//
// Rules this module enforces:
//   1. Nothing is deleted. Files the engine replaces move to
//      <drive>/.mediadownloader-trash/<YYYY-MM-DD>/ and are kept for 30 days.
//   2. Only files the engine itself placed (the ledger) are ever replaced.
//      A file that is not in the ledger is never touched automatically.
//   3. Every write, move and refusal is appended to the audit log, so
//      "what touched this show?" always has an answer.
//   4. Read-only mode: the engine may read the library drives but never
//      write to them (first week of running, first quality checks).
//
// Deliberately free of Electron so it runs under plain Node in tests
// (scripts/test-library.js). State lives in the app's userData folder:
//   <userData>/ledger.json    files the engine placed (path, size, hash1mb, date)
//   <userData>/library.json   { readOnly: boolean }
//   <userData>/audit.log      JSON lines: { ts, action, path, reason, ... }

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TRASH_DIRNAME = '.mediadownloader-trash';
const TRASH_KEEP_DAYS = 30;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // a lock older than this is considered stale
// Hard cap for the library-drive move (run in a child process so it can be
// killed). A hung NAS share is the realistic case this protects against: the
// kill leaves the file in staging and the job retries, instead of freezing
// the engine forever. 90 min is far beyond any legitimate copy of a
// feature-length file, even on a slow link.
const PLACE_TIMEOUT_MS = 90 * 60 * 1000;

function defaultDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'webvideodownloader');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'webvideodownloader');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'webvideodownloader');
}

// Path comparison key. Windows paths are case-insensitive; POSIX are not.
function normKey(p) {
  const s = path.resolve(String(p || ''));
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

class Library {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || defaultDataDir();
    this.readOnly = false;
    this._loaded = false;
    this._locks = new Map(); // finalPath key -> { at: number }
  }

  // ---- settings (read-only mode) ----

  _settingsFile() {
    return path.join(this.dataDir, 'library.json');
  }

  _loadSettings() {
    if (this._loaded) return;
    try {
      const s = JSON.parse(fs.readFileSync(this._settingsFile(), 'utf8'));
      this.readOnly = !!(s && s.readOnly);
    } catch (e) {
      this.readOnly = false;
    }
    this._loaded = true;
  }

  isReadOnly() {
    this._loadSettings();
    return this.readOnly;
  }

  setReadOnly(v) {
    this._loadSettings();
    this.readOnly = !!v;
    fs.mkdirSync(this.dataDir, { recursive: true });
    let cur = {};
    try {
      cur = JSON.parse(fs.readFileSync(this._settingsFile(), 'utf8')) || {};
    } catch (e) {
      cur = {};
    }
    cur.readOnly = this.readOnly;
    fs.writeFileSync(this._settingsFile(), JSON.stringify(cur, null, 2));
    this.audit(this.readOnly ? 'read-only-enabled' : 'read-only-disabled', null, null);
  }

  // ---- ledger (which files the engine placed) ----

  _ledgerFile() {
    return path.join(this.dataDir, 'ledger.json');
  }

  _loadLedger() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._ledgerFile(), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    } catch (e) {
      // no ledger yet
    }
    return {};
  }

  _saveLedger(map) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = this._ledgerFile();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, file);
  }

  _hashFirstMb(file) {
    let h = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = Math.max(0, fs.fstatSync(fd).size);
        const buf = Buffer.alloc(Math.min(1024 * 1024, size));
        const n = size > 0 ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
        h = crypto.createHash('sha256').update(buf.slice(0, n)).digest('hex');
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      h = '';
    }
    return h;
  }

  // Records a file the engine placed: size, hash of the first 1 MB, date.
  recordPlaced(file, size, source) {
    const map = this._loadLedger();
    map[normKey(file)] = {
      size: size != null ? size : 0,
      hash1mb: this._hashFirstMb(file),
      at: new Date().toISOString(),
      source: source || 'engine'
    };
    this._saveLedger(map);
  }

  // True when the engine placed this file (and therefore may replace it).
  isOurs(file) {
    return Object.prototype.hasOwnProperty.call(this._loadLedger(), normKey(file));
  }

  forget(file) {
    const map = this._loadLedger();
    if (delete map[normKey(file)]) this._saveLedger(map);
  }

  ledgerSnapshot() {
    return this._loadLedger();
  }

  // ---- audit log ----

  _auditFile() {
    return path.join(this.dataDir, 'audit.log');
  }

  audit(action, filePath, reason, extra) {
    const entry = { ts: new Date().toISOString(), action: String(action || 'unknown') };
    if (filePath) entry.path = String(filePath);
    if (reason) entry.reason = String(reason);
    if (extra) Object.assign(entry, extra);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(this._auditFile(), JSON.stringify(entry) + '\n');
    } catch (e) {
      // The audit trail must never take the pipeline down with it.
    }
  }

  // ---- per-target write locks ----
  // Two jobs for the same episode must never write the same file. The engine
  // is a single process, so an in-process lock is authoritative; the on-disk
  // timestamp is only there to notice a stale lock after a crash.

  _lockFile() {
    return path.join(this.dataDir, 'locks.json');
  }

  _loadLocks() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._lockFile(), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    } catch (e) {
      // no locks file
    }
    return {};
  }

  _saveLocks(map) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = this._lockFile();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, file);
  }

  lockTarget(file) {
    const key = normKey(file);
    const now = Date.now();
    // Drop locks that outlived their owner (crash recovery).
    if (this._locks.has(key) && now - this._locks.get(key).at > LOCK_TIMEOUT_MS) {
      this._locks.delete(key);
    }
    if (this._locks.has(key)) {
      const err = new Error(`Target already locked by another job: ${file}`);
      err.code = 'ELOCKED';
      throw err;
    }
    this._locks.set(key, { at: now });
    const disk = this._loadLocks();
    disk[key] = { at: now };
    try {
      this._saveLocks(disk);
    } catch (e) {
      // in-memory lock still stands
    }
    return key;
  }

  releaseTarget(key) {
    if (!key) return;
    this._locks.delete(key);
    const disk = this._loadLocks();
    if (delete disk[key]) {
      try {
        this._saveLocks(disk);
      } catch (e) {
        // ignore
      }
    }
  }

  // ---- trash (replaced files are never deleted) ----

  trashFile(file, reason) {
    if (!file || !fs.existsSync(file)) return null;
    // A replacement moves the old file aside as <name>.old-<ts> first; the
    // trash copy gets the clean original name back.
    let name = path.basename(file);
    const m = name.match(/^(.*)\.old-\d+$/);
    if (m) name = m[1];
    const day = new Date().toISOString().slice(0, 10);
    const root = path.join(path.dirname(file), TRASH_DIRNAME, day);
    fs.mkdirSync(root, { recursive: true });
    let target = path.join(root, name);
    let i = 1;
    while (fs.existsSync(target)) target = path.join(root, `${name} (${i++})`);
    fs.renameSync(file, target);
    this.audit('trashed', file, reason || null, { to: target });
    return target;
  }

  // Removes trash older than `days` from each of the given library roots.
  // Returns the number of day-folders purged.
  purgeTrash(roots, days = TRASH_KEEP_DAYS) {
    let purged = 0;
    const cutoff = Date.now() - days * 86400000;
    for (const root of roots || []) {
      if (!root) continue;
      let tr = null;
      try {
        tr = path.join(root, TRASH_DIRNAME);
        if (!fs.statSync(tr).isDirectory()) continue;
      } catch (e) {
        continue;
      }
      let dayDirs = [];
      try {
        dayDirs = fs
          .readdirSync(tr, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name));
      } catch (e) {
        continue;
      }
      for (const d of dayDirs) {
        const t = Date.parse(`${d.name}T00:00:00Z`);
        if (Number.isNaN(t) || t >= cutoff) continue;
        const dir = path.join(tr, d.name);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          purged += 1;
          this.audit('trash-purged', dir, `${d.name} older than ${days} days`);
        } catch (e) {
          // keep going
        }
      }
      try {
        if (fs.existsSync(tr) && fs.readdirSync(tr).length === 0) fs.rmdirSync(tr);
      } catch (e) {
        // ignore
      }
    }
    return purged;
  }

  // ---- placing a finished file ----

  // Same volume? A rename is atomic within one drive; across drives (staging
  // on the local disk, final on the NAS) we copy then rename on the target.
  _sameVolume(a, b) {
    try {
      if (process.platform === 'win32') {
        const ra = (path.parse(path.resolve(a)).root || '').toLowerCase();
        const rb = (path.parse(path.resolve(b)).root || '').toLowerCase();
        if (ra && rb) return ra === rb;
      }
      return fs.statSync(a).dev === fs.statSync(b).dev;
    } catch (e) {
      return false;
    }
  }

  // Runs the library-drive move (src/main/movefile.js) in a CHILD process
  // with a hard timeout. Why a child and not a worker_thread: on Windows a
  // thread blocked in a syscall (hung SMB) cannot be force-terminated, but a
  // child process can (TerminateProcess). On timeout the child is killed, the
  // half-written .partial is cleaned up best-effort, and the error flows back
  // to the queue as a retryable failure - the staged file is untouched, so a
  // later pass re-places it.
  async runMove(params, timeoutMs) {
    const bin = process.versions.electron
      ? { cmd: process.execPath, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) }
      : { cmd: process.execPath, env: process.env };
    return new Promise((resolve, reject) => {
      let settled = false;
      let out = '';
      let errOut = '';
      let child;
      try {
        child = spawn(bin.cmd, [path.join(__dirname, 'movefile-child.js'), JSON.stringify(params)], {
          env: bin.env,
          windowsHide: true
        });
      } catch (e) {
        return reject(e);
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch (e) {
          /* already dead */
        }
        try {
          fs.unlinkSync(params.finalPath + '.partial');
        } catch (e) {
          /* drive may be the hung thing */
        }
        reject(
          Object.assign(
            new Error(
              `Placement timed out after ${Math.round(timeoutMs / 60000)} min - the library drive may be hung. ` +
                'The file is safe in staging; the job will retry.'
            ),
            { code: 'PLACE_TIMEOUT' }
          )
        );
      }, timeoutMs);
      child.stdout.on('data', (d) => {
        out += d.toString();
      });
      child.stderr.on('data', (d) => {
        errOut += d.toString();
      });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let result = null;
        try {
          const lines = out.trim().split('\n');
          result = JSON.parse(lines[lines.length - 1] || '{}');
        } catch (e) {
          result = null;
        }
        if (code === 0 && result && result.ok) return resolve(result);
        const msg =
          (result && result.error) || errOut.trim().slice(-300) || `placement child exited ${code}`;
        reject(new Error(msg));
      });
    });
  }

  // Moves a verified file into its final position without ever losing a file.
  //
  //   partPath     the verified file (staging or already on the target drive)
  //   finalPath    where the finished file must end up
  //   replacePath  the existing file being replaced, or null for a new file
  //
  // Guarantees:
  //   - a file at finalPath that is not `replacePath` is never overwritten;
  //   - a replacement target the engine did not place is never replaced;
  //   - on replace, the old file is moved aside first (same drive), the new
  //     one renamed in, and only then the old one goes to the trash - at no
  //     point are both files gone;
  //   - cross-drive moves copy to <final>.partial, verify the size, then
  //     rename within the target drive.
  async safePlace({ partPath, finalPath, replacePath = null }) {
    if (this.isReadOnly()) {
      this.audit('refused-read-only', finalPath, 'library is in read-only mode');
      throw new Error('Library is in read-only mode; refusing to write.');
    }
    if (!partPath || !fs.existsSync(partPath)) {
      throw new Error('safePlace: part file missing: ' + partPath);
    }
    const partStat = fs.statSync(partPath);
    const replacingSameName =
      !!replacePath && path.resolve(replacePath) === path.resolve(finalPath);

    const lockKey = this.lockTarget(finalPath);
    try {
      if (fs.existsSync(finalPath)) {
        if (!replacePath) {
          this.audit('refused-overwrite', finalPath, 'file already exists and is not a replacement target');
          throw new Error(`Refusing to overwrite an existing file: ${finalPath}`);
        }
        if (!this.isOurs(finalPath)) {
          this.audit('refused-replace', finalPath, 'existing file is not in the engine ledger');
          throw new Error(`Refusing to replace a file the engine did not place: ${finalPath}`);
        }
      }

      // The actual move runs in a child process with a hard timeout: a hung
      // network share blocks fs calls, and only killing a child (safe on
      // Windows) frees the engine. The child re-checks the overwrite refusal
      // itself (last line of defence) and consumes the staged source.
      const moveResult = await this.runMove(
        {
          partPath,
          finalPath,
          replacePath: replacePath || null,
          expectExisting: !!replacePath,
          sameVolume: this._sameVolume(partPath, path.dirname(finalPath)),
          trashDirname: TRASH_DIRNAME
        },
        this.placeTimeoutMs != null ? this.placeTimeoutMs : PLACE_TIMEOUT_MS
      );

      this.recordPlaced(finalPath, partStat.size);
      if (replacePath && moveResult && moveResult.trashedTo) {
        // The child performed the trash; the parent owns the audit trail.
        this.audit('trashed', replacePath, `replaced by ${path.basename(finalPath)}`, { to: moveResult.trashedTo });
      }
      this.audit(
        replacePath ? 'replaced' : 'placed',
        finalPath,
        replacePath ? `replaced ${path.basename(replacePath)}` : 'new file',
        { bytes: partStat.size }
      );
      return finalPath;
    } finally {
      this.releaseTarget(lockKey);
    }
  }

  // (The actual move helpers moved to src/main/movefile.js so they can run
  //  in a child process; trashFile above is still used by purgeTrash's
  //  bookkeeping and kept as-is.)
}

// Shared instance for the running app (queue.js, bulk.js, service.js).
const library = new Library();

module.exports = library;
module.exports.Library = Library;
module.exports.TRASH_DIRNAME = TRASH_DIRNAME;
module.exports.TRASH_KEEP_DAYS = TRASH_KEEP_DAYS;
module.exports.PLACE_TIMEOUT_MS = PLACE_TIMEOUT_MS;
module.exports.defaultDataDir = defaultDataDir;
module.exports.createLibrary = (opts) => new Library(opts);
