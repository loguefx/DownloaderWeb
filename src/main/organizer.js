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
    .toLowerCase()
    .replace(/\s+season\s*\d+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
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

// True when this episode is already on disk. Exact path first, then collision
// suffixes, then any file in a same-series folder that names the same season +
// episode. SFlix titles often bake "Season 3" / the episode slug into the
// series name, so a later batch with a cleaner name would otherwise re-queue
// finished files. Both the current "S1E1" and the legacy
// "Season 1 - Episode 01" spellings count, so renaming does not re-download a
// library that was built before the switch.
function existingEpisodeFile(outputRoot, meta, ext = '.mp4') {
  if (!outputRoot) return null;
  const exact = expectedPath(outputRoot, meta, ext);
  if (fs.existsSync(exact)) return exact;
  const ep = parseInt(meta && meta.episode, 10);
  if (!(ep > 0)) return null;
  const seasonRaw = meta && meta.season;
  const season =
    seasonRaw != null && String(seasonRaw).trim() !== '' && !isNaN(parseInt(seasonRaw, 10))
      ? parseInt(seasonRaw, 10)
      : null;
  const extRe = String(ext || '.mp4').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = `(?:\\s*\\(\\d+\\))?${extRe}$`;
  const legacy = `${season != null ? `season\\s*0*${season}\\s*-\\s*` : ''}episode\\s*0*${ep}`;
  const sxe = `s0*${season != null ? season : '\\d{1,2}'}e0*${ep}`;
  const epRe = new RegExp(`(?:${legacy}|${sxe})${tail}`, 'i');
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
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const f of files) {
      if (epRe.test(f)) return path.join(dir, f);
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
  buildBaseName,
  seriesRoot,
  seriesDir,
  buildOutputPath,
  expectedPath,
  existingEpisodeFile,
  ensureDir,
  cleanupCaptureJunk
};
