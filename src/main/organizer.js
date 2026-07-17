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

// Best-effort season number from a slug like "golden-kamuy-3rd-season".
function parseSeasonFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/(\d+)(?:st|nd|rd|th)?[-_\s]*season/i);
  if (m) return parseInt(m[1], 10);
  const s = String(url).match(/season[-_\s]*(\d+)/i);
  if (s) return parseInt(s[1], 10);
  return null;
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
  ensureDir
};
