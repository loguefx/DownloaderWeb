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

// Builds the base filename (no extension): "<Series> Season N - Episode NN".
function buildBaseName({ series, season, episode }) {
  const seriesPart = sanitize(series) || 'Video';
  const seasonPart = season != null && season !== '' ? ` Season ${season}` : '';
  const epPart = episode != null && episode !== '' ? ` - Episode ${pad(episode)}` : '';
  return `${seriesPart}${seasonPart}${epPart}`;
}

// The series folder inside the chosen download root: <root>/<Series>.
function seriesDir(outputRoot, meta) {
  return path.join(outputRoot, sanitize(meta.series) || 'Video');
}

// Output path: <root>/<Series>/<Series> Season N - Episode NN.mp4
// Creates the series folder and adds " (n)" on collision.
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

// True when this episode is already on disk. Exact path first (Aniwave-style
// "<Series> Season N - Episode NN.mp4"), then collision suffixes, then any
// file in a same-series folder that names the same season + episode. SFlix
// titles often bake "Season 3" / the episode slug into the series name, so
// a later batch with a cleaner name would otherwise re-queue finished files.
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
  const seasonBit = season != null ? `season\\s*${season}\\s*-\\s*` : '';
  const epRe = new RegExp(`${seasonBit}episode\\s*0*${ep}(?:\\s*\\(\\d+\\))?${extRe}$`, 'i');
  const dirs = [];
  const addDir = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  addDir(seriesDir(outputRoot, meta));
  const want = seriesKey(meta && meta.series);
  if (want) {
    try {
      for (const ent of fs.readdirSync(outputRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (seriesKey(ent.name) === want) addDir(path.join(outputRoot, ent.name));
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

module.exports = {
  sanitize,
  pad,
  parseSeasonFromUrl,
  buildBaseName,
  seriesDir,
  buildOutputPath,
  expectedPath,
  existingEpisodeFile,
  ensureDir
};
