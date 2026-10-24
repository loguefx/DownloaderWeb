'use strict';

const fs = require('fs');
const path = require('path');

// Strips characters that are illegal in Windows filenames and trims noise.
function sanitize(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, ''); // no trailing dots/spaces on Windows
}

function pad(num, width = 2) {
  const s = String(num);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

// Season/episode arrive as numbers or as strings from the form, sometimes
// already zero-padded. Normalize so "01" does not become S01E01.
function toNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

// Best-effort season number from a slug like "golden-kamuy-3rd-season"
// or Romanian "dark-sezonul-2".
function parseSeasonFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/(\d+)(?:st|nd|rd|th)?[-_\s]*season/i);
  if (m) return parseInt(m[1], 10);
  const s = String(url).match(/season[-_\s]*(\d+)/i);
  if (s) return parseInt(s[1], 10);
  const ro = String(url).match(/sezonul[-_\s]*(\d+)/i);
  if (ro) return parseInt(ro[1], 10);
  const sxe = String(url).match(/[sS](\d{1,2})[eE]\d{1,3}/);
  if (sxe) return parseInt(sxe[1], 10);
  return null;
}

function seriesKey(name) {
  return sanitize(name)
    // Jellyfin layouts: "Show (2019)" and "[tmdbid-123456] Show" are the same
    // series as "Show", so those tokens never take part in the match.
    .replace(/\s*\(\s*\[?\s*tmdbid[-\s]*\d+\s*\]?\s*\)/gi, ' ')
    .replace(/\s*\[\s*tmdbid[-\s]*\d+\s*\]/gi, ' ')
    .replace(/\s*\(\s*\[?\s*(?:tmdb|tvdb|imdb)[-\s]*[A-Za-z0-9]+\s*\]?\s*\)/gi, ' ')
    .replace(/\s*\(\d{4}\)/g, ' ')
    .toLowerCase()
    .replace(/\s+season\s*\d+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Containers the engine recognizes as video in a library. The engine still
// WRITES .mp4; it must also SEE .mkv/.avi/.m4v/.ts so a Jellyfin-style
// library counts as "in library".
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.m4v', '.ts'];

function extAlternation(ext) {
  const list = ext == null ? VIDEO_EXTS : Array.isArray(ext) ? ext : [ext];
  return list
    .map((e) => String(e || '').replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean)
    .join('|');
}

// Builds the base filename (no extension): "<Series> S1E1".
//
// Media servers (Jellyfin, Plex, Emby) key episode order off an SxEy marker.
// The older "<Series> Season 1 - Episode 01" form is not one of the patterns
// they match, so every episode landed unordered.
function buildBaseName({ series, season, episode }) {
  const seriesPart = sanitize(series) || 'Video';
  const ep = toNumber(episode);
  const se = toNumber(season);
  if (ep == null) return se != null ? `${seriesPart} S${se}` : seriesPart;
  // A file with no season marker is ambiguous to a media server, and these
  // sites scope a batch to one season, so treat an absent season as the first.
  return `${seriesPart} S${se != null ? se : 1}E${ep}`;
}

// The series folder inside the chosen download root: <root>/<Series>.
function seriesRoot(outputRoot, meta) {
  return path.join(outputRoot, sanitize(meta.series) || 'Video');
}

// Where an episode is filed: <root>/<Series>/Season N. Media servers expect a
// season folder per season, and it keeps a 200-episode show browsable. A movie
// has no episode number, so it stays directly in <root>/<Title>.
function seriesDir(outputRoot, meta) {
  const base = seriesRoot(outputRoot, meta);
  if (toNumber(meta && meta.episode) == null) return base;
  const se = toNumber(meta && meta.season);
  return path.join(base, `Season ${se != null ? se : 1}`);
}

// Output path: <root>/<Series>/Season N/<Series> S1E1.mp4
// Creates the season folder and adds " (n)" on collision.
function buildOutputPath(outputRoot, meta, ext = '.mp4') {
  const dir = seriesDir(outputRoot, meta);
  ensureDir(dir);
  const base = buildBaseName(meta);
  let candidate = path.join(dir, base + ext);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

// The path we'd expect for an episode ignoring collision suffixes - used to
// detect "already downloaded" so re-running a batch skips finished files.
function expectedPath(outputRoot, meta, ext = '.mp4') {
  return path.join(seriesDir(outputRoot, meta), buildBaseName(meta) + ext);
}

// Every directory that may hold this series' files: the expected season
// folder, the series folder itself, its "Season N" subfolders, and any
// sibling under the root whose name matches the series key ("(year)" /
// "[tmdb-…]" variants included). Shared by the episode matcher, the movie
// matcher, and the on-disk presence check.
function seriesDirs(outputRoot, meta) {
  const dirs = [];
  const addDir = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  // Season folder first, then the series folder itself: libraries downloaded
  // before season folders existed keep their episodes directly in there, and
  // those files must still count as present.
  const addSeasonDirs = (dir) => {
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory() && /^season\b/i.test(ent.name)) addDir(path.join(dir, ent.name));
      }
    } catch (e) {
      // ignore
    }
  };
  addDir(seriesDir(outputRoot, meta));
  addDir(seriesRoot(outputRoot, meta));
  addSeasonDirs(seriesRoot(outputRoot, meta));
  const want = seriesKey(meta && meta.series);
  if (want) {
    try {
      for (const ent of fs.readdirSync(outputRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (seriesKey(ent.name) !== want) continue;
        const dir = path.join(outputRoot, ent.name);
        addDir(dir);
        addSeasonDirs(dir);
      }
    } catch (e) {
      // ignore
    }
  }
  return dirs;
}

// First video file inside a folder that matches the series (any video
// extension, optional " (n)" collision suffix). A movie's file name usually
// carries quality tags ("Movie.1080p.10bit.mp4"), so the exact <Title>/
// <Title>.mp4 path misses it - any video in the series folder counts.
function seriesVideoFile(outputRoot, seriesName) {
  if (!outputRoot || !seriesName) return null;
  const extRe = new RegExp(`(?:\\s*\\(\\d+\\))?\\.(?:${extAlternation(null)})$`, 'i');
  for (const dir of seriesDirs(outputRoot, { series: seriesName, season: null, episode: null })) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const f of files.sort()) {
      if (extRe.test(f)) return path.join(dir, f);
    }
  }
  return null;
}

// Is ANY file of this title on disk in this root (an episode of the series,
// or the movie itself)? Drives the "already in your library -> watch it
// automatically" rule and the presence hints.
function titleOnDisk(outputRoot, seriesName) {
  return !!seriesVideoFile(outputRoot, seriesName);
}

// True when this episode is already on disk. Exact path first, then collision
// suffixes, then any file in a same-series folder that names the same season +
// episode. SFlix titles often bake "Season 3" / the episode slug into the
// series name, so a later batch with a cleaner name would otherwise re-queue
// finished files. Both the current "S1E1" and the legacy
// "Season 1 - Episode 01" spellings count, so renaming does not re-download a
// library that was built before the switch.
//
// Parse a season number out of a folder name: "Season 2", "Season 02", "S2",
// "2nd Season", "Cour 2", "sezonul 2", "Staffel 3". Returns null when the
// folder does not name a season. This is what lets an episode-only file name
// ("Show - EP18.mp4") be tied to the season of the folder it sits in, so we
// recognize "we already have this episode" across the many naming styles a
// real library uses - without ever confusing one season's files for another's.
// True when the series already uses REAL per-season subfolders on disk (i.e.
// it is NOT a flat single-season layout). A bare episode number at the series
// root is only safe to trust when this is false, because with season folders
// present a bare number at the root is ambiguous about which season it is.
// This scans the actual filesystem - not the synthetic "expected" season dir
// that seriesDirs() always lists - so a flat anime with no subfolders reads as
// flat.
function seriesHasSeasonFolders(outputRoot, meta) {
  const roots = new Set();
  roots.add(seriesRoot(outputRoot, meta));
  const want = seriesKey(meta && meta.series);
  if (want) {
    try {
      for (const ent of fs.readdirSync(outputRoot, { withFileTypes: true })) {
        if (ent.isDirectory() && seriesKey(ent.name) === want) {
          roots.add(path.join(outputRoot, ent.name));
        }
      }
    } catch (e) {
      /* unreadable root */
    }
  }
  for (const r of roots) {
    let ents = [];
    try {
      ents = fs.readdirSync(r, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of ents) {
      if (ent.isDirectory() && seasonFromName(ent.name) != null) return true;
    }
  }
  return false;
}

function seasonFromName(name) {
  const s = String(name || '');
  let m = s.match(/season\s*0*(\d{1,3})/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/(\d{1,3})\s*(?:st|nd|rd|th)\s+season/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/\bS0*(\d{1,3})\b/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/\bcour\s*0*(\d{1,3})/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/sezonul\s*0*(\d{1,3})/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/\bstaffel\s*0*(\d{1,3})/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Jellyfin build plan Part 11: match .mkv/.avi/.m4v/.ts as well as .mp4, find
// SxxEyy anywhere in the file name, ignore "(year)" / "[tmdbid-…]" in folder
// names, and treat "S01E01-E02" two-part files as BOTH episodes.
function existingEpisodeFile(outputRoot, meta, ext = null) {
  if (!outputRoot) return null;
  const exact = expectedPath(outputRoot, meta, '.mp4');
  if (fs.existsSync(exact)) return exact;
  const ep = parseInt(meta && meta.episode, 10);
  if (!(ep > 0)) {
    // A movie (or any episode-less title): fall back to "any video file in a
    // folder that matches the series" so hand-named files still count as
    // present instead of being re-downloaded over their own library.
    return seriesVideoFile(outputRoot, meta && meta.series);
  }
  const seasonRaw = meta && meta.season;
  const season =
    seasonRaw != null && String(seasonRaw).trim() !== '' && !isNaN(parseInt(seasonRaw, 10))
      ? parseInt(seasonRaw, 10)
      : null;
  const extAlt = extAlternation(ext);
  // The file must end in a video extension, optionally with a " (n)" collision
  // suffix. The S/E marker itself may appear ANYWHERE in the name (Jellyfin's
  // "Show - S02E05 - Title" layout).
  const extRe = new RegExp(`(?:\\s*\\(\\d+\\))?\\.(?:${extAlt})$`, 'i');

  // STRICT: the season AND the episode are both named in the file itself.
  // These are unambiguous, so they are honored in ANY folder of the series.
  const strictPatterns = [];
  if (season != null) strictPatterns.push(`season\\s*0*${season}\\s*-\\s*episode\\s*0*${ep}(?!\\d)`);
  strictPatterns.push(`s0*${season != null ? season : '\\d{1,2}'}e0*${ep}(?!\\d)`);
  // "1x01" style (common in hand-named libraries). The lookbehind keeps
  // resolution strings ("1920x1080") from reading as an S/E marker.
  strictPatterns.push(`(?<!\\d)0*${season != null ? season : '\\d{1,2}'}[xX]0*${ep}(?!\\d)`);
  const strictRe = new RegExp(strictPatterns.join('|'), 'i');
  // "S01E01-E02" (or "S1E1 - E2"): one file covering a range of episodes.
  // Captured and compared numerically so EVERY episode of the range counts.
  const strictRangeRe = new RegExp(
    `s0*${season != null ? season : '\\d{1,2}'}e(\\d{1,3})(?!\\d)\\s*-\\s*e(\\d{1,3})(?!\\d)`,
    'i'
  );

  // LOOSE: the episode is named on its own and the SEASON is proven by the
  // folder it lives in ("Season 2/Show - EP18.mp4"), or by the whole series
  // being a flat single-season anime ("Show/Show 18.mp4", no season folders).
  // This is what makes "we already have this episode" true across the many
  // naming styles a real library uses, while a bare number is NEVER trusted at
  // a series root when season folders exist (it would be ambiguous which
  // season it belongs to).
  const loosePatterns = [
    `(?<![a-z0-9])ep\\.?\\s*0*${ep}(?!\\d)`, // "EP18", "EP 18", "ep.18"
    `(?<![a-z0-9sx])e\\.?\\s*0*${ep}(?!\\d)`, // "E18", "E 18" (not "S1E18"/"1x18")
    `(?<![a-z0-9])episode\\s*0*${ep}(?!\\d)`, // "Episode 18"
    // bare number, guarded so it is a STANDALONE episode token: not part of a
    // longer number (digit), not a season ("S1"/"1E"/"1x"), not a resolution
    // ("720p"), not a dimension ("1920x1080"). Dot-separated ("Show.18") still
    // counts - common in anime/scene naming.
    `(?<![\\dxXsS])0*${ep}(?![\\dxXpPeE])`
  ];
  const looseRe = new RegExp(loosePatterns.join('|'), 'i');
  // flat episode range "01-02" / "1-3" (two-part episodes), same digit guards.
  const looseRangeRe = new RegExp(
    `(?<![\\dxXsS])0*(\\d{1,3})(?![\\dxXpPeE])\\s*[-–]\\s*0*(\\d{1,3})(?![\\dxXpPeE])`,
    'i'
  );

  const dirs = seriesDirs(outputRoot, meta);
  // True when the series already has REAL season subfolders - i.e. it is NOT a
  // flat single-season layout, so a bare number at the root is ambiguous.
  const anySeasonFolder = seriesHasSeasonFolders(outputRoot, meta);
  const looseAllowed = (dir) => {
    const anchor = seasonFromName(path.basename(dir));
    if (anchor != null) {
      // The folder names a season. If the job names a season too, it must be
      // the same one; an unknown-season job accepts any season folder.
      return season == null || anchor === season;
    }
    // Non-season folder (series root / sibling): trust episode-only tokens
    // only when the whole series is flat and we want season 1 or unknown.
    return !anySeasonFolder && (season == null || season === 1);
  };

  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    const loose = looseAllowed(dir);
    for (const f of files) {
      if (!extRe.test(f)) continue;
      // The episode number must never be read from the file EXTENSION ("mp4"
      // contains a 4, "m4v" a 4) or the " (n)" collision suffix - strip both
      // before any number-based test.
      const base = f
        .replace(/\s*\(\d+\)\s*\.[A-Za-z0-9]+$/, '') // " (n).ext"
        .replace(/\.[A-Za-z0-9]+$/, ''); // ".ext"
      if (strictRe.test(base)) return path.join(dir, f);
      const rm = base.match(strictRangeRe);
      if (rm) {
        let a = parseInt(rm[1], 10);
        let b = parseInt(rm[2], 10);
        if (a > b) [a, b] = [b, a];
        if (ep >= a && ep <= b) return path.join(dir, f);
      }
      if (!loose) continue;
      if (looseRe.test(base)) return path.join(dir, f);
      const lm = base.match(looseRangeRe);
      if (lm) {
        let a = parseInt(lm[1], 10);
        let b = parseInt(lm[2], 10);
        if (a > b) [a, b] = [b, a];
        if (ep >= a && ep <= b) return path.join(dir, f);
      }
    }
  }
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isCaptureJunk(name) {
  const n = String(name || '');
  return /\.part\.hls$/i.test(n) || /\.hls$/i.test(n) || /\.part\.m3u8$/i.test(n);
}

function cleanupCaptureJunk(dir) {
  if (!dir) return 0;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  let n = 0;
  for (const ent of ents) {
    if (!isCaptureJunk(ent.name)) continue;
    try {
      fs.rmSync(path.join(dir, ent.name), { recursive: true, force: true });
      n += 1;
    } catch (e) {
      // ignore
    }
  }
  return n;
}

module.exports = {
  sanitize,
  pad,
  parseSeasonFromUrl,
  seasonFromName,
  seriesHasSeasonFolders,
  buildBaseName,
  seriesRoot,
  seriesDir,
  seriesDirs,
  seriesVideoFile,
  titleOnDisk,
  buildOutputPath,
  expectedPath,
  existingEpisodeFile,
  ensureDir,
  cleanupCaptureJunk,
  VIDEO_EXTS
};
