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

// Tiny bounded memo for the pure name-normalizers below. They are called in
// tight loops over EVERY folder of a category root (a big Anime category has
// 900+ folders) for every episode the matcher checks, so without the memo a
// single season scan of a large library costs millions of redundant NFKD/
// regex passes. Names are short and finite per session, so a capped Map is
// safe.
function memoize(fn, limit = 8192) {
  const m = new Map();
  return (name) => {
    const hit = m.get(name);
    if (hit !== undefined) return hit;
    const v = fn(name);
    if (m.size >= limit) m.clear();
    m.set(name, v);
    return v;
  };
}

const seriesKey = memoize(function seriesKey(name) {
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
});

// Fuzzy series matching - an ADDITIVE fallback used only when the exact
// seriesKey comparison misses, so nothing that matched before can stop
// matching.
//
// normSeries folds two names of the same series into the same string:
// lowercase, accents folded (Fiancé -> fiance), apostrophes dropped (I'm ->
// im), every remaining punctuation collapsed to single spaces, and the
// "(2013)" / "[tmdb-60761]" tokens the strict key already strips.
const normSeries = memoize(function normSeries(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/\s*\(\s*\[?\s*tmdbid[-\s]*\d+\s*\]?\s*\)/gi, ' ')
    .replace(/\s*\[\s*tmdbid[-\s]*\d+\s*\]/gi, ' ')
    .replace(/\s*\(\s*\[?\s*(?:tmdb|tvdb|imdb)[-\s]*[A-Za-z0-9]+\s*\]?\s*\)/gi, ' ')
    .replace(/\s*\(\d{4}\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
});

// Does a folder that does NOT exact-match the series still clearly refer to
// it? The shorter normalized name must be a substantial phrase (>= 12 chars)
// contained in the longer one, so short titles ("One Piece", 9 chars) can
// never claim a differently-named folder, and a title cannot claim "The
// Beginning Part 2" when it is "The Beginning". Combined with the
// episode-number match that must still succeed INSIDE the folder (or, for
// movies, the phrase being long and specific), a false positive is
// effectively impossible.
function fuzzySeriesMatch(folderName, seriesName) {
  const a = normSeries(folderName);
  const b = normSeries(seriesName);
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 12 && long.indexOf(short) >= 0;
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

// The series folder the library ALREADY uses inside this root, if any: an
// exact seriesKey folder first, else the first strong fuzzy variant. This is
// what makes a re-run ADD to the existing folder (keeping the user's naming)
// instead of starting a second, differently-named series folder next to it.
// Returns null when the root does not hold this series yet.
function existingSeriesFolder(outputRoot, meta) {
  const seriesName = meta && meta.series;
  if (!outputRoot || !seriesName) return null;
  const want = seriesKey(seriesName);
  let ents = [];
  try {
    ents = fs.readdirSync(outputRoot, { withFileTypes: true });
  } catch (e) {
    return null; // unreadable root: no existing folder
  }
  ents.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  let fuzzy = null;
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    if (want && seriesKey(ent.name) === want) return path.join(outputRoot, ent.name);
    if (!fuzzy && fuzzySeriesMatch(ent.name, seriesName)) fuzzy = path.join(outputRoot, ent.name);
  }
  return fuzzy;
}

// The series folder inside the chosen download root: <root>/<Series> - or the
// EXISTING series folder when the library already files this series under a
// slightly different name (accents, apostrophes, shortened title). Additive
// only: existing files are never touched, new ones land where the library
// already has them.
function seriesRoot(outputRoot, meta) {
  const found = existingSeriesFolder(outputRoot, meta);
  if (found) return found;
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
  //
  // Every subfolder of the series (depth-limited) is a candidate episode
  // directory. Real library layouts this must recognize - each one exists on
  // the NAS and each one was previously invisible to the matcher (those files
  // would have been re-downloaded):
  //   "Season 01/Season 01/...", "Season 01 - Season 1/Season 01/..."
  //       (a season folder wrapping the real season folder)
  //   "Bakuman - Season 2/Season 01/...", "Eng Subbed S01/Season 01/..."
  //       (a season-qualified series variant wrapping a season folder)
  //   "Show/Show/...", "American Horror Story Season 8/...", "... Volume 4/..."
  //       (a doubled or variant series folder holding the files directly)
  //   "Series 5/...", "Part 1/...", "Book 2/...", "Holiday Specials/..."
  //       (a season-style grouping folder holding the files directly)
  //
  // Adding every subfolder is safe because the episode matcher still only
  // honors a STRICT S/E marker in the file name for non-season folders, and a
  // bare episode number only in a season-anchored folder (matching season)
  // or a flat single-season series - so recognition only grows, it can never
  // attribute the wrong file to an episode.
  const addSeasonDirs = (dir, depth = 0) => {
    if (depth > 2) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const sub = path.join(dir, ent.name);
      addDir(sub);
      addSeasonDirs(sub, depth + 1);
    }
  };
  addDir(seriesDir(outputRoot, meta));
  addDir(seriesRoot(outputRoot, meta));
  addSeasonDirs(seriesRoot(outputRoot, meta));
  const want = seriesKey(meta && meta.series);
  const seriesName = meta && meta.series;
  if (want || seriesName) {
    try {
      for (const ent of fs.readdirSync(outputRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        // Exact key first (unchanged behavior); a strong fuzzy variant is an
        // additive extra, so recognition only ever grows.
        if (want && seriesKey(ent.name) === want) {
          const dir = path.join(outputRoot, ent.name);
          addDir(dir);
          addSeasonDirs(dir);
          continue;
        }
        if (!fuzzySeriesMatch(ent.name, seriesName)) continue;
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

// Every video file under the series' folders (any recognized video extension),
// deduped and sorted. Used by the dry-run report to show the user exactly what
// is on disk for a series - so they can eyeball what the engine will and will
// recognize before trusting a download.
function listSeriesVideoFiles(outputRoot, seriesName) {
  const out = [];
  const seen = new Set();
  if (!outputRoot || !seriesName) return out;
  const dirs = seriesDirs(outputRoot, { series: seriesName, season: null, episode: null });
  for (const dir of dirs) {
    let ents = [];
    try {
      ents = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const f of ents) {
      const full = path.join(dir, f);
      if (seen.has(full)) continue;
      let isFile = false;
      try {
        isFile = fs.statSync(full).isFile();
      } catch (e) {
        continue;
      }
      if (!isFile) continue;
      if (VIDEO_EXTS.includes(path.extname(f).toLowerCase())) {
        seen.add(full);
        out.push(full);
      }
    }
  }
  return out.sort();
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
  const seriesName = meta && meta.series;
  if (want || seriesName) {
    try {
      for (const ent of fs.readdirSync(outputRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if ((want && seriesKey(ent.name) === want) || fuzzySeriesMatch(ent.name, seriesName)) {
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

// Does a file name carry this episode's TITLE as a whole phrase? This is the
// fallback for hand-named files that have NO episode number at all (e.g.
// "Show - Pilot.mp4"). Rules keep it precise:
//   - the title is at least 4 chars (skips trivial "a"/"the" names);
//   - it must appear as a whole phrase (word-bounded), not a substring of a
//     longer word;
//   - it must NOT be immediately followed by a continuation marker, so
//     "The Beginning" does not swallow "The Beginning Part 2" (a different ep).
// Returns true/false; an empty/short title returns false (never blocks).
function titleMatches(fileName, episodeName) {
  if (!episodeName) return false;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const title = norm(episodeName);
  if (title.length < 4) return false;
  const file = ' ' + norm(fileName) + ' ';
  const idx = file.indexOf(title);
  if (idx < 0) return false;
  // Word-bounded: single spaces on both sides (norm collapses to one space).
  if (file[idx - 1] !== ' ' || file[idx + title.length] !== ' ') return false;
  const after = file.slice(idx + title.length + 1);
  if (/^(part|pt|2nd|second|continued|the rest)\b/i.test(after)) return false;
  return true;
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
// `episodeName` (optional) is the episode's real title (e.g. "Pilot"). When
// provided, a file named by that title alone - with no episode number at all -
// also counts as present. This is the last-resort match for hand-named files.
function existingEpisodeFile(outputRoot, meta, ext = null, episodeName = '') {
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
      if (loose) {
        if (looseRe.test(base)) return path.join(dir, f);
        const lm = base.match(looseRangeRe);
        if (lm) {
          let a = parseInt(lm[1], 10);
          let b = parseInt(lm[2], 10);
          if (a > b) [a, b] = [b, a];
          if (ep >= a && ep <= b) return path.join(dir, f);
        }
      }
      // Last resort: the file is named by the episode's own TITLE, with no
      // number at all ("Show - Pilot.mp4"). Scoped to the series folders, so a
      // title only counts for this show.
      if (episodeName && titleMatches(base, episodeName)) return path.join(dir, f);
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

// Extract an EPISODE number (the E## value) from a file name, using the same
// guards as existingEpisodeFile: it never reads a season token, a resolution
// ("1920x1080"), or the " (n)" collision suffix. Returns an int or null.
function episodeNumberFromName(name) {
  const base = String(name || '')
    .replace(/\s*\(\d+\)\s*\.[A-Za-z0-9]+$/, '') // " (n).ext"
    .replace(/\.[A-Za-z0-9]+$/, ''); // ".ext"
  let m = base.match(/s0*(\d{1,3})[eE](\d{1,3})(?!\d)/i);
  if (m) return parseInt(m[2], 10);
  m = base.match(/(?<!\d)(\d{1,3})[xX](\d{1,3})(?!\d)/i);
  if (m) return parseInt(m[2], 10);
  m = base.match(/(?:episode|ep)\b\.?\s*0*(\d{1,3})(?!\d)/i);
  if (m) return parseInt(m[1], 10);
  m = base.match(/(?<![\dxXsSeE])(\d{1,3})(?![\dxXpPeE])/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Characterize a series' on-disk episode layout by reading the EPISODE number
// off every video file (depth-limited walk). Returns:
//   totalFiles  number of video files
//   numbered    how many carried an extractable episode number
//   maxEpisode  the highest episode number present (null if none)
//   flat        TRUE only when the files form a single continuous 1..N axis
//               (N files, each uniquely numbered, exactly 1..N).
//
// "Flat" is the "Kingdom: S01E01..S01E142" shape - ONE global episode axis -
// and is the only layout for which a "you have up to N" floor is safe. Arc-based
// shows (One Piece: S00E406, S01E01, ...) repeat low episode numbers across
// arcs, so they are NOT flat and must be baselined per-title instead.
function seriesExtent(seriesDir) {
  const out = { totalFiles: 0, numbered: 0, maxEpisode: null, flat: false };
  if (!seriesDir) return out;
  const VIDEO = /\.(mp4|mkv|avi|m4v|ts)$/i;
  const numbers = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (VIDEO.test(ent.name)) {
        out.totalFiles++;
        const ep = episodeNumberFromName(ent.name);
        if (ep != null && ep > 0) { out.numbered++; numbers.push(ep); }
      }
    }
  };
  walk(seriesDir, 0);
  if (numbers.length) {
    out.maxEpisode = Math.max.apply(null, numbers);
    const min = Math.min.apply(null, numbers);
    out.flat = new Set(numbers).size === numbers.length
      && numbers.length === out.maxEpisode
      && min === 1;
  }
  return out;
}

// The GLOBAL no-duplicate guard. Classifies how SAFE the on-disk layout is for
// the "already have it / queue the rest" logic, so the watcher never queues an
// episode it cannot unambiguously place without re-downloading one that is
// already there.
//
// The recognition logic is SEASON-SCOPED: it counts a bare episode number only
// inside the matching season folder, and it honors a strict S#E# in any folder.
// So the one thing that breaks it is a (season, episode) COLLISION - the SAME
// number naming two DIFFERENT episodes (arc layouts, a season folder that is
// mislabeled, or a disk that holds more distinct episodes than the source
// claims). When that exists we cannot tell episodes apart by label, so the
// correct, non-destructive choice is to HOLD (queue nothing), NOT to guess.
//
// Returns one of:
//   { mode: 'flat',       floor: <maxEp>, reason } - a single continuous 1..N
//                                                    axis; recognizing by
//                                                    episode number is safe (the
//                                                    flat floor guard then
//                                                    decides what is new).
//   { mode: 'per-season', floor: null,     reason } - a clean per-season
//                                                    layout; the season-scoped
//                                                    matcher is safe to use.
//   { mode: 'hold',       floor: null,     reason } - ambiguous or the disk
//                                                    overflows the source model;
//                                                    queue NOTHING for it.
function seriesLayoutRisk(seriesDir, sourceTotal) {
  if (!seriesDir) return { mode: 'per-season', floor: null, reason: 'not-on-disk' };
  const VIDEO = /\.(mp4|mkv|avi|m4v|ts)$/i;
  let ext;
  try { ext = seriesExtent(seriesDir); } catch (e) { ext = { flat: false, maxEpisode: null }; }
  if (ext.flat && ext.maxEpisode) return { mode: 'flat', floor: ext.maxEpisode, reason: 'flat 1..N axis' };

  // Non-flat. Collect, per (season,episode) label, the set of DISTINCT folders
  // that carry it, plus each season folder (name says "Season N") with the
  // season token its own files carry.
  const labelFolders = new Map(); // "S:E" -> Set(folderName)
  const seasonFolders = [];       // { name, anchor, files: [name,...] }
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    const videoFiles = [];
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (VIDEO.test(ent.name)) videoFiles.push(ent.name);
    }
    if (!videoFiles.length) return;
    const name = path.basename(dir);
    const anchor = seasonFromName(name);
    if (anchor != null) seasonFolders.push({ name, anchor, files: videoFiles });
    for (const fn of videoFiles) {
      const m = String(fn).match(/s0*(\d{1,3})[eE]0*(\d{1,3})(?!\d)/i);
      if (!m) continue;
      const key = parseInt(m[1], 10) + ':' + parseInt(m[2], 10);
      if (!labelFolders.has(key)) labelFolders.set(key, new Set());
      labelFolders.get(key).add(name);
    }
  };
  walk(seriesDir, 0);

  // A label carried by more than one folder: the same S#E# names 2+ episodes.
  let ambiguous = 0;
  const ambiguousExamples = [];
  for (const [label, folders] of labelFolders.entries()) {
    if (folders.size > 1) {
      ambiguous += 1;
      if (ambiguousExamples.length < 3) {
        const [s, e] = String(label).split(':');
        ambiguousExamples.push(`S${s}E${e} in [${[...folders].join(', ')}]`);
      }
    }
  }
  if (ambiguous > 0) {
    return { mode: 'hold', floor: null, reason: ambiguous + ' episode number(s) appear in 2+ different folders (same number = different episodes) - e.g. ' + ambiguousExamples.join('; ') };
  }

  // A season folder whose files predominantly carry a DIFFERENT season token.
  let mislabeled = 0;
  for (const sf of seasonFolders) {
    let mismatch = 0;
    for (const fn of sf.files) {
      const m = String(fn).match(/s0*(\d{1,3})[eE]0*\d{1,3}(?!\d)/i);
      if (m && parseInt(m[1], 10) !== sf.anchor) mismatch += 1;
    }
    if (sf.files.length && mismatch >= Math.ceil(sf.files.length * 0.6)) mislabeled += 1;
  }
  if (mislabeled > 0) {
    return { mode: 'hold', floor: null, reason: mislabeled + ' season folder(s) are mislabeled (folder says one season, files carry another)' };
  }

  // The disk holds far MORE distinct episodes than the source claims, so the
  // source model does not describe this show (e.g. TMDB lists 40, disk has 142).
  const distinct = labelFolders.size;
  if (sourceTotal && distinct > sourceTotal * 1.5) {
    return { mode: 'hold', floor: null, reason: 'disk holds ' + distinct + ' distinct episodes but the source lists only ' + sourceTotal + ' (source model does not describe this show)' };
  }

  return { mode: 'per-season', floor: null, reason: 'clean' };
}

// Multi-root version: a title may live on more than one drive. Conservative -
// any root that is ambiguous/overflowing HOLDS the whole series, and a flat
// root contributes its floor (highest wins). A series not found on disk is
// safe to queue (there is nothing to collide with).
function seriesLayoutRiskFor(roots, series, sourceTotal) {
  let result = { mode: 'per-season', floor: null, reason: 'not-on-disk' };
  let found = false;
  for (const root of roots || []) {
    if (!root) continue;
    let dir = null;
    try { dir = seriesRoot(root, { series }); } catch (e) { dir = null; }
    if (!dir) continue;
    let exists = false;
    try { exists = fs.existsSync(dir) && fs.readdirSync(dir).length > 0; } catch (e) { exists = false; }
    if (!exists) continue;
    found = true;
    const r = seriesLayoutRisk(dir, sourceTotal);
    if (r.mode === 'hold') return { mode: 'hold', floor: null, reason: r.reason + '  [root: ' + root + ']' };
    if (r.mode === 'flat') {
      if (result.mode !== 'flat' || (r.floor != null && (result.floor == null || r.floor > result.floor))) result = r;
    }
  }
  return result;
}

module.exports = {
  sanitize,
  pad,
  parseSeasonFromUrl,
  seasonFromName,
  seriesHasSeasonFolders,
  normSeries,
  fuzzySeriesMatch,
  existingSeriesFolder,
  titleMatches,
  buildBaseName,
  seriesRoot,
  seriesDir,
  seriesDirs,
  seriesVideoFile,
  titleOnDisk,
  listSeriesVideoFiles,
  buildOutputPath,
  expectedPath,
  existingEpisodeFile,
  episodeNumberFromName,
  seriesExtent,
  seriesLayoutRisk,
  seriesLayoutRiskFor,
  ensureDir,
  cleanupCaptureJunk,
  VIDEO_EXTS
};
