'use strict';

// Library-aware storage (Jellyfin build plan, Part 5).
//
// The user picks a LIBRARY, not a drive. Each job carries the library's
// current folder list from Jellyfin; when a drive fills up, a new folder is
// added to that library in Jellyfin and nothing else changes.
//
// Flow: the engine downloads + verifies into its local staging folder, then
// placeItem() picks a drive and moves the file there:
//   1. drop folders that are not mounted / not writable / not marker-signed
//      (a dropped NAS share leaves an empty local folder at the mount point -
//      the marker file stops files silently landing there);
//   2. a folder "has room" when free space >= file size + the reserve;
//   3. existing series: the folder that already holds the show wins (a series
//      stays on one drive while it has room);
//   4. new series/movie: first folder with room in library order ("fill in
//      order") or the one with the most free space ("spread out");
//   5. nothing fits -> NO_SPACE: the file stays in staging, the queue retries.
//
// After a successful placement the Jellyfin per-folder refresh is called
// (POST /Library/Media/Updated) so only that folder is scanned.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const engineconfig = require('./engineconfig');
const organizer = require('./organizer');
const library = require('./library');

const MARKER = '.mediadownloader';

function normSep(p) {
  return String(p || '').replace(/\//g, path.sep).replace(/\\+/g, path.sep);
}

// Jellyfin path -> engine path via the longest matching prefix mapping.
function toEnginePath(p, mappings) {
  const list = (mappings || engineconfig.get().pathMappings || []).filter(
    (m) => m && m.jellyfin && m.engine
  );
  const s = normSep(p);
  const sorted = list
    .map((m) => ({ j: normSep(m.jellyfin), e: normSep(m.engine) }))
    .sort((a, b) => b.j.length - a.j.length);
  for (const m of sorted) {
    const j = m.j;
    if (s === j) return m.e;
    const withSep = j.endsWith(path.sep) ? j : j + path.sep;
    if (s.startsWith(withSep)) return m.e + s.slice(j.length);
  }
  return p;
}

function freeBytes(folder) {
  try {
    const st = fs.statfsSync(folder);
    return Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    return 0;
  }
}

function totalBytes(folder) {
  try {
    const st = fs.statfsSync(folder);
    return Number(st.blocks) * Number(st.bsize);
  } catch (e) {
    return 0;
  }
}

// A folder is usable when it exists, is writable, and carries the marker file
// that was created once in each library folder.
function folderReady(folder) {
  try {
    if (!fs.statSync(folder).isDirectory()) return { ready: false, reason: 'not a directory' };
    fs.accessSync(folder, fs.constants.W_OK);
    if (!fs.existsSync(path.join(folder, MARKER))) return { ready: false, reason: 'missing .mediadownloader marker file' };
    return { ready: true, free: freeBytes(folder) };
  } catch (e) {
    return { ready: false, reason: e.code === 'ENOENT' ? 'not mounted' : e.code || 'not writable' };
  }
}

// Creates the marker file in every given folder (run once per library folder).
function ensureMarkers(folders) {
  const out = [];
  for (const f of folders || []) {
    try {
      fs.mkdirSync(f, { recursive: true });
      const marker = path.join(f, MARKER);
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, JSON.stringify({ created: new Date().toISOString(), app: 'webvideodownloader' }));
      }
      out.push({ folder: f, ok: true });
    } catch (e) {
      out.push({ folder: f, ok: false, reason: e.message });
    }
  }
  return out;
}

// Picks the drive folder for one finished file. `lib` is the job's library
// object ({ name, locations }). Returns { folder, free } or null when nothing
// fits (caller raises NO_SPACE).
function pickFolder(lib, meta, sizeBytes, opts = {}) {
  const cfg = engineconfig.get();
  const reserve = opts.reserveBytes != null ? opts.reserveBytes : cfg.reserveBytes || 0;
  const locations = (lib && lib.locations) || [];
  if (!locations.length) return null;

  const folders = [];
  for (const loc of locations) {
    const enginePath = toEnginePath(loc, cfg.pathMappings);
    const ready = folderReady(enginePath);
    folders.push({ jellyfin: loc, folder: enginePath, ready: ready.ready, reason: ready.reason, free: ready.free || 0 });
  }

  const usable = folders.filter((f) => f.ready);
  // Existing series: the folder that already holds the show keeps it (Part 5.3).
  const existing = usable.find((f) => {
    try {
      return (
        organizer.existingEpisodeFile(f.folder, meta) != null ||
        fs.existsSync(path.join(f.folder, organizer.sanitize(meta.series) || 'Video'))
      );
    } catch (e) {
      return false;
    }
  });
  if (existing && existing.free >= sizeBytes + reserve) {
    return { folder: existing.folder, free: existing.free };
  }

  const withRoom = usable.filter((f) => f.free >= sizeBytes + reserve);
  if (!withRoom.length) return null;
  if (cfg.fillMode === 'spread') {
    withRoom.sort((a, b) => b.free - a.free);
    return { folder: withRoom[0].folder, free: withRoom[0].free };
  }
  return { folder: withRoom[0].folder, free: withRoom[0].free }; // library order
}

// Verify a library's drive folders without downloading anything.
//
// For every location this reports: the engine path it resolves to, whether it
// is a mounted, writable directory carrying the marker, and a real
// write + read-back round-trip of a tiny file. That round-trip is the proof a
// finished file will actually land here (it catches a dropped/mismatched share
// that a plain "is it mounted" check would miss).
//
// Returns { name, ok, folders: [...] }; `ok` is true when at least one folder
// is writable AND the round-trip succeeded.
async function verifyLibrary(lib, opts = {}) {
  const cfg = engineconfig.get();
  const doRoundTrip = opts.roundTrip !== false;
  const probeName = '.mediadownloader-verify-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const locations = (lib && lib.locations) || [];
  const folders = [];
  let anyOk = false;

  for (const loc of locations) {
    const enginePath = toEnginePath(loc, cfg.pathMappings);
    const ready = folderReady(enginePath);
    const entry = {
      jellyfin: loc,
      engine: enginePath,
      exists: false,
      isDir: false,
      writable: false,
      marker: false,
      freeBytes: 0,
      totalBytes: 0,
      roundTrip: { ok: false, path: null, error: doRoundTrip ? null : 'skipped' },
      reason: ready.reason || null
    };
    try {
      const st = fs.statSync(enginePath);
      entry.exists = true;
      entry.isDir = st.isDirectory();
    } catch (e) {
      // not mounted / not present: leave exists=false
    }
    entry.writable = ready.ready;
    try {
      entry.marker = fs.existsSync(path.join(enginePath, MARKER));
    } catch (e) {
      // ignore
    }
    entry.freeBytes = freeBytes(enginePath);
    entry.totalBytes = totalBytes(enginePath);

    if (doRoundTrip && ready.ready) {
      const probe = path.join(enginePath, probeName);
      let ok = false;
      let err = null;
      try {
        fs.writeFileSync(probe, 'webvideodownloader-verify');
        const back = fs.readFileSync(probe, 'utf8');
        ok = back === 'webvideodownloader-verify';
      } catch (e) {
        err = e.code || e.message;
      } finally {
        try { fs.unlinkSync(probe); } catch (e) { /* already gone */ }
      }
      entry.roundTrip = { ok, path: probe, error: ok ? null : err };
      if (ok) anyOk = true;
    }
    folders.push(entry);
  }

  return { name: (lib && lib.name) || '', ok: anyOk, folders };
}

function noSpaceError(lib) {
  const err = new Error(
    `${(lib && lib.name) || 'Library'} is full - add a drive in Jellyfin`
  );
  err.code = 'NO_SPACE';
  return err;
}

// Places item.finalPath (finished + verified in staging) onto a library drive.
// Throws NO_SPACE when nothing fits; the file stays in staging.
async function placeItem(item, stagedPath) {
  const job = item && item.library;
  if (!job || !Array.isArray(job.locations) || !job.locations.length) {
    // No library on this job: the file already sits where the job asked.
    return { placed: false, reason: 'no-library' };
  }
  const staged = stagedPath || item.finalPath;
  if (!staged || !fs.existsSync(staged)) {
    throw new Error('placer: staged file missing: ' + staged);
  }
  const size = fs.statSync(staged).size;
  const meta = { series: item.series, season: item.season, episode: item.episode };
  const pick = pickFolder(job, meta, size);
  if (!pick) {
    library.audit('no-space', staged, job.name || 'library', { bytes: size });
    throw noSpaceError(job);
  }
  const finalPath = organizer.expectedPath(pick.folder, meta, '.mp4');
  const cfg = engineconfig.get();

  // Already on the target drive?
  const already = organizer.existingEpisodeFile(pick.folder, meta);
  let replacePath = null;
  if (already && path.resolve(already) !== path.resolve(finalPath)) {
    const probed = await require('./verify').verifyFile(already);
    const floor = item.minHeight || 0;
    if (probed.probeOk && (!floor || probed.height >= floor)) {
      // Already in the library at good quality: just drop the staging copy.
      try {
        fs.unlinkSync(staged);
      } catch (e) {
        // ignore
      }
      library.audit('already-in-library', finalPath, staged);
      return { placed: true, finalPath: already, existing: true, folder: pick.folder };
    }
    if (library.isOurs(already)) replacePath = already;
  }

  await library.safePlace({ partPath: staged, finalPath, replacePath });
  library.audit('placed-on-library', finalPath, `library=${job.name || ''}`, { folder: pick.folder });

  // Tell Jellyfin to scan just this folder (Part 2: library refresh).
  await refreshJellyfin(cfg, finalPath);
  return { placed: true, finalPath, folder: pick.folder };
}

// POST {jellyfin.baseUrl}/Library/Media/Updated with the file's folder path.
// Jellyfin then scans that folder instead of the whole library. Failures are
// logged, never fatal: the file is safely on disk either way.
function refreshJellyfin(cfg, finalPath) {
  const base = String((cfg && cfg.jellyfin && cfg.jellyfin.baseUrl) || '').trim();
  const key = String((cfg && cfg.jellyfin && cfg.jellyfin.apiKey) || '').trim();
  if (!base || !key) return Promise.resolve(false);
  const folder = path.dirname(finalPath);
  let u;
  try {
    u = new URL(base.replace(/\/+$/, '') + '/Library/Media/Updated');
  } catch (e) {
    return Promise.resolve(false);
  }
  const mod = u.protocol === 'https:' ? https : http;
  const body = JSON.stringify(folder);
  return new Promise((resolve) => {
    let req;
    try {
      req = mod.request(
        u,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Emby-Authorization': `MediaBrowser client="WebVideoDownloader", device="engine", token="${key}"`,
            'X-EmbyClient': 'WebVideoDownloader',
            'X-EmbyDeviceName': 'engine'
          },
          timeout: 15000
        },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
    } catch (e) {
      return resolve(false);
    }
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  MARKER,
  toEnginePath,
  freeBytes,
  totalBytes,
  folderReady,
  ensureMarkers,
  pickFolder,
  placeItem,
  verifyLibrary,
  refreshJellyfin
};
