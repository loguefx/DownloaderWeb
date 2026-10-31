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
const engineconfig = require('./engineconfig');
const jellyfin = require('./jellyfin');
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

// Engine path -> the path JELLYFIN sees (the reverse of toEnginePath), using
// the longest matching engine-side prefix. The result uses the Jellyfin side's
// separator style ("/mnt/disk1/anime/Show" for a Linux server even when the
// engine runs on Windows). Unmapped paths come back unchanged.
function toJellyfinPath(p, mappings) {
  const list = (mappings || engineconfig.get().pathMappings || []).filter(
    (m) => m && m.jellyfin && m.engine
  );
  const s = normSep(p);
  const sorted = list
    .map((m) => ({ j: String(m.jellyfin), e: normSep(m.engine) }))
    .sort((a, b) => b.e.length - a.e.length);
  for (const m of sorted) {
    const e = m.e.endsWith(path.sep) && m.e.length > 1 ? m.e.slice(0, -1) : m.e;
    let rest = null;
    if (s === e) rest = '';
    else if (s.startsWith(e + path.sep)) rest = s.slice(e.length + 1);
    if (rest == null) continue;
    const jsep = m.j.includes('\\') && !m.j.includes('/') ? '\\' : '/';
    const j = m.j.replace(/[\\/]+$/, '');
    return rest ? j + jsep + rest.split(path.sep).join(jsep) : j;
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
      // existingSeriesFolder also finds "Show (2019)" / accent variants, so
      // a show is not split across drives over a folder-name difference.
      return (
        organizer.existingEpisodeFile(f.folder, meta) != null ||
        organizer.existingSeriesFolder(f.folder, meta) != null
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
    let ready = folderReady(enginePath);
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

    // If the folder exists and is writable but the marker is missing,
    // create it now (this is what "Verify" is for — prepare the drive).
    if (entry.exists && entry.isDir && !entry.marker && ready.reason === 'missing .mediadownloader marker file') {
      try {
        fs.accessSync(enginePath, fs.constants.W_OK);
        const markerPath = path.join(enginePath, MARKER);
        if (!fs.existsSync(markerPath)) {
          fs.writeFileSync(markerPath, JSON.stringify({ created: new Date().toISOString(), app: 'webvideodownloader' }));
        }
        // Re-check: the marker should now be present.
        ready = folderReady(enginePath);
        entry.reason = ready.reason || null;
      } catch (e) {
        // Folder is not writable; leave as-is.
      }
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

  // Already on the target drive? (episode name lets a hand-named file count)
  const already = organizer.existingEpisodeFile(pick.folder, meta, null, item.episodeName || '');
  let replacePath = null;
  if (already) {
    const probed = await require('./verify').verifyFile(already);
    const floor = item.minHeight || 0;
    if (probed.probeOk && (!floor || probed.height >= floor)) {
      // Already in the library at good quality (same path or different path):
      // drop the staging copy and report done.
      try {
        fs.unlinkSync(staged);
      } catch (e) {
        // ignore
      }
      library.audit('already-in-library', finalPath, staged);
      return { placed: true, finalPath: already, existing: true, folder: pick.folder };
    }
    // Low quality or unreadable: only replace if the engine placed it.
    if (library.isOurs(already)) replacePath = already;
  }

  await library.safePlace({ partPath: staged, finalPath, replacePath });
  library.audit('placed-on-library', finalPath, `library=${job.name || ''}`, { folder: pick.folder });

  // Tell Jellyfin to scan just this folder (Part 2: library refresh).
  await refreshJellyfin(cfg, finalPath);
  return { placed: true, finalPath, folder: pick.folder };
}

// Tell Jellyfin to scan just the new file's folder (POST
// /Library/Media/Updated). The folder is translated to the path Jellyfin
// sees. Failures are reported, never fatal: the file is safely on disk and
// Jellyfin's own scheduled scan still finds it.
async function refreshJellyfin(cfg, finalPath) {
  const { base, key } = jellyfin.settings();
  if (!base || !key) return false;
  const folder = toJellyfinPath(path.dirname(finalPath), cfg && cfg.pathMappings);
  const r = await jellyfin.notifyCreated(folder);
  if (!r.ok) {
    library.audit('jellyfin-refresh-failed', finalPath, r.reason || 'error', { folder });
  }
  return r.ok;
}

module.exports = {
  MARKER,
  toEnginePath,
  toJellyfinPath,
  freeBytes,
  totalBytes,
  folderReady,
  ensureMarkers,
  pickFolder,
  placeItem,
  verifyLibrary,
  refreshJellyfin
};
