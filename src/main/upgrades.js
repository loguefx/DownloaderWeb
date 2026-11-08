'use strict';
// Episodes and films saved BELOW their quality floor (the 720p fallback:
// Vidsrc offered only 720p and no other site had better). Once a week each
// one is checked on Vidsrc - headless, no download - and when a copy at the
// floor exists now, it is queued again at that floor. The queue's own rules
// do the rest: the library copy is below the floor and the engine placed it,
// so the new copy replaces it (the old file goes to the trash folder only
// after the new one passed its checks).
//
//   add(item, finalPath)  after a below-floor copy was placed (queue._settle)
//   remove(finalPath)     a copy at the floor replaced it
//   runDue()              the weekly checks that are due (a few per run)
//   list()                for the API / plugin
// Kept on disk: <userData>/upgrades.json.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RECHECK_MS = 7 * 24 * 3600 * 1000;
const RUN_EVERY_MS = 6 * 3600 * 1000;
const PER_RUN = 15;
const GIVE_UP_MS = 180 * 24 * 3600 * 1000; // stop asking after ~6 months

let dirOverride = null;
let state = null; // { "<normalized path>": entry }
let timer = null;
let running = null;

function dataDir() {
  if (dirOverride) return dirOverride;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) {
    /* plain Node */
  }
  return path.join(os.tmpdir(), 'wvd-upgrades');
}
const file = () => path.join(dataDir(), 'upgrades.json');
const norm = (p) => path.resolve(String(p || '')).toLowerCase();

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    state = {};
  }
  return state;
}
function save() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state || {}, null, 1));
    fs.renameSync(tmp, file());
  } catch (e) {
    /* the in-memory copy still answers */
  }
}

// A below-floor copy was placed. Anime has no floor; only TV/movies.
function add(item, finalPath, now = Date.now()) {
  if (!item || item.anime || !finalPath) return false;
  const floor = Number(item._floorFallback) || 0;
  if (!(floor > 0)) return false;
  const s = load();
  s[norm(finalPath)] = {
    path: finalPath,
    label: item.label || '',
    series: item.series || '',
    season: item.season != null ? item.season : null,
    episode: item.episode != null ? item.episode : null,
    tmdb: item.tmdb || null,
    url: item.url || item.baseUrl || '',
    mode: item.mode || 'dub',
    outputRoot: item.outputRoot || '',
    library: item.library || null,
    numbering: item.numbering || 'tmdb',
    episodeName: item.episodeName || '',
    floor,
    placedHeight: Number(item.minHeight) || 0,
    source: 'fallback',
    kind: item.episode == null ? 'movie' : 'tv',
    addedAt: now,
    lastCheck: now,
    lastResult: ''
  };
  save();
  return true;
}

function remove(finalPath) {
  const s = load();
  if (delete s[norm(finalPath)]) save();
}

// Stop tracking (Upgrade resolution tab "Stop"): also kept out of later
// library scans.
function ignore(finalPath) {
  const s = load();
  delete s[norm(finalPath)];
  const ig = meta().ignored;
  if (!ig.includes(norm(finalPath))) ig.push(norm(finalPath));
  save();
}

// Bookkeeping that is not an entry: ignored paths, the probe cache.
function meta() {
  const s = load();
  if (!s.__meta || typeof s.__meta !== 'object') s.__meta = { ignored: [], probes: {} };
  if (!Array.isArray(s.__meta.ignored)) s.__meta.ignored = [];
  if (!s.__meta.probes || typeof s.__meta.probes !== 'object') s.__meta.probes = {};
  return s.__meta;
}
const entries = () => Object.entries(load()).filter(([k]) => k !== '__meta');

function list() {
  return entries().map(([, e]) => e).sort((a, b) => String(a.series).localeCompare(String(b.series)) || (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
}

// Injectable for tests: does Vidsrc have this one at `floor` now? -> true/false/null
let checkAt = async (e) => {
  const vs = require('./sites/vidsrc_dl');
  if (vs.isBlocked()) return null;
  const isMovie = e.episode == null;
  const ref = isMovie ? { type: 'movie', tmdb: String(e.tmdb) } : { type: 'tv', tmdb: String(e.tmdb), season: e.season, episode: e.episode };
  try {
    const best = await vs.pick1080(ref, () => {}, e.floor, {});
    return !!best;
  } catch (err) {
    return err && err.code === 'VIDSRC_NOT_FOUND' ? false : null;
  }
};
// Injectable for tests: queue it again at the floor.
let requeue = async (e) => {
  const bulk = require('./bulk');
  // A file from the library scan was not placed by the engine. Asking for
  // its upgrade (the scan in the Upgrade resolution tab) is the go-ahead to
  // replace it: it is recorded as the engine's, so the 1080p copy can take
  // its place (the old file goes to the trash folder, never deleted).
  if (e.source === 'library') {
    try {
      const library = require('./library');
      if (!library.isOurs(e.path)) library.recordPlaced(e.path, fs.statSync(e.path).size, 'upgrade-adopted');
    } catch (err) { /* placement will then keep the old file: no harm */ }
  }
  return bulk.queueOne({
    url: e.url, series: e.series, season: e.season, episode: e.episode, mode: e.mode,
    outputRoot: e.outputRoot, library: e.library, minHeight: e.floor, anime: false,
    tmdb: e.tmdb, numbering: e.numbering, episodeName: e.episodeName, upgrade: true
  });
};

async function runDue({ onLog = () => {}, now = Date.now(), perRun = PER_RUN, force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const s = load();
    let checked = 0;
    let queued = 0;
    for (const [k, e] of entries()) {
      if (checked >= perRun) break;
      if (!force && now - (e.lastCheck || 0) < RECHECK_MS) continue;
      // The file is gone (deleted, renamed, replaced by hand): nothing to upgrade.
      if (!fs.existsSync(e.path)) {
        delete s[k];
        continue;
      }
      if (now - (e.addedAt || now) > GIVE_UP_MS) {
        delete s[k];
        onLog(`Upgrade check: "${e.label}" has had no ${e.floor}p copy for 6 months - no longer checked.`);
        continue;
      }
      if (e.problem || !/^\d+$/.test(String(e.tmdb || ''))) {
        e.lastCheck = now;
        continue;
      }
      checked += 1;
      let has = null;
      try { has = await checkAt(e); } catch (err) { has = null; }
      if (has === null) break; // Vidsrc paused / unreachable: the next run tries again
      e.lastCheck = now;
      e.lastResult = has ? 'found' : 'not yet';
      if (has) {
        try {
          await requeue(e);
          queued += 1;
          onLog(`Upgrade: a ${e.floor}p copy of "${e.label}" is out now - queued to replace the ${e.placedHeight}p one.`);
        } catch (err) {
          onLog(`Upgrade: could not queue "${e.label}" (${(err && err.message) || err}).`);
        }
      }
    }
    save();
    if (checked) onLog(`Upgrade check: ${checked} below-floor cop${checked === 1 ? 'y' : 'ies'} checked, ${queued} queued for a better copy.`);
    return { checked, queued };
  })().finally(() => {
    running = null;
  });
  return running;
}

// One entry, now (the tab's "Check now").
async function checkNow(p, { onLog = () => {} } = {}) {
  const e = load()[norm(p)];
  if (!e || !e.tmdb) return { ok: false, reason: 'not tracked' };
  let has = null;
  try { has = await checkAt(e); } catch (err) { has = null; }
  e.lastCheck = Date.now();
  e.lastResult = has === null ? 'Vidsrc not answering' : has ? 'found' : 'not yet';
  save();
  if (has) {
    await requeue(e);
    onLog(`Upgrade: a ${e.floor}p copy of "${e.label}" is out - queued to replace the ${e.placedHeight}p one.`);
  }
  return { ok: true, found: has, entry: e };
}

// ---- library scan (TV / movie libraries; never anime) ---------------------

const scanState = { running: false, phase: '', done: 0, total: 0, found: 0, unmatched: 0, at: 0, error: '' };
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm)$/i;

function folderTitle(base) {
  let s = String(base || '');
  let id = '';
  const m = s.match(/[[{(]\s*tmdb(?:id)?[-=\s]*(\d+)\s*[\]})]/i);
  if (m) id = m[1];
  s = s.replace(/\s*[[{(]\s*(?:tmdb|tvdb|imdb|anidb|anilist)(?:id)?[-=\s]*[A-Za-z0-9]+\s*[\]})]/gi, ' ');
  let year = 0;
  const y = s.match(/\s*\((\d{4})\)\s*$/);
  if (y) { year = Number(y[1]); s = s.slice(0, y.index); }
  return { name: s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim(), year, tmdb: id };
}

// Injectable for tests: file -> { width, height } | null
let probe = (f) => new Promise((resolve) => {
  let ffprobe = '';
  try { ffprobe = require('./downloader').ffprobePath(); } catch (e) { ffprobe = 'ffprobe'; }
  require('child_process').execFile(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { timeout: 20000, windowsHide: true }, (err, out) => {
    const m = !err && String(out || '').match(/(\d+),(\d+)/);
    resolve(m ? { width: Number(m[1]), height: Number(m[2]) } : null);
  });
});
// Injectable for tests: (kind, name, year) -> tmdb id | ''
let findTmdb = async (kind, name, year) => {
  const tmdb = require('./tmdb');
  const key = tmdb.getTmdbKey();
  if (!key || !name) return '';
  const t = kind === 'movie' ? 'movie' : 'tv';
  const yq = year ? (t === 'movie' ? `&year=${year}` : `&first_air_date_year=${year}`) : '';
  const body = await tmdb.tmdbFetch(`/search/${t}?query=${encodeURIComponent(name)}${yq}&include_adult=false&language=en-US`, key);
  const r = body && Array.isArray(body.results) ? body.results[0] : null;
  return r && r.id ? String(r.id) : '';
};

function walkVideos(dir, depth = 0, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || /^\$|^System Volume|trash|backup/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3) walkVideos(full, depth + 1, out); }
    else if (VIDEO.test(e.name) && !/sample|trailer/i.test(e.name)) out.push(full);
  }
  return out;
}

const pause = () => new Promise((r) => setImmediate(r));

// libs: [{ name, kind: 'tv'|'movie', locations: [engine-side paths] }]
async function scanLibraries(libs, { floor = 1080, onLog = () => {} } = {}) {
  if (scanState.running) return scanState;
  Object.assign(scanState, { running: true, phase: 'listing', done: 0, total: 0, found: 0, unmatched: 0, at: Date.now(), error: '' });
  (async () => {
    const organizer = require('./organizer');
    const { meetsQualityFloor } = require('./verify');
    const m = meta();
    const ignored = new Set(m.ignored);
    const work = []; // { lib, root, dir, title, kind, file }
    for (const lib of libs || []) {
      const kind = lib.kind === 'movie' ? 'movie' : 'tv';
      for (const root of lib.locations || []) {
        let ents = [];
        try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
        for (const d of ents) {
          if (!d.isDirectory() || d.name.startsWith('.') || /^\$|^System Volume/i.test(d.name)) continue;
          const dir = path.join(root, d.name);
          const title = folderTitle(d.name);
          for (const file of walkVideos(dir)) work.push({ lib, root, dir, title, kind, file });
          await pause();
        }
      }
    }
    scanState.total = work.length;
    scanState.phase = 'measuring';
    const idCache = new Map();
    for (const w of work) {
      scanState.done += 1;
      if (scanState.done % 25 === 0) await pause();
      const k = norm(w.file);
      if (ignored.has(k) || load()[k]) continue;
      let st;
      try { st = fs.statSync(w.file); } catch (e) { continue; }
      const pk = `${k}|${st.size}|${Math.round(st.mtimeMs)}`;
      let dim = m.probes[pk];
      if (dim === undefined) {
        dim = await probe(w.file);
        m.probes[pk] = dim || null;
      }
      if (!dim || meetsQualityFloor(dim.width, dim.height, floor)) continue;
      // Which episode / film is it? It must be the one the engine would
      // replace (the same match placement uses), never a guess.
      let season = null;
      let episode = null;
      if (w.kind === 'tv') {
        const base = path.basename(w.file);
        const se = base.match(/[Ss](\d{1,2})\s*[Ee](\d{1,3})/) || base.match(/(\d{1,2})x(\d{1,3})/);
        if (se) { season = Number(se[1]); episode = Number(se[2]); }
        else {
          const sd = path.basename(path.dirname(w.file));
          const sn = organizer.seasonFromName(sd);
          const ep = organizer.episodeNumberFromName(base);
          if (sn != null && ep) { season = sn; episode = ep; }
        }
      }
      const series = w.title.name;
      const metaE = { series, season, episode };
      let matched = null;
      if (w.kind === 'movie' || (season != null && episode != null)) {
        try { matched = organizer.existingEpisodeFile(w.root, metaE); } catch (e) { matched = null; }
      }
      const ok = matched && norm(matched) === k;
      const idKey = `${w.kind}|${series}|${w.title.year}`;
      let tmdb = w.title.tmdb;
      if (!tmdb) {
        if (!idCache.has(idKey)) {
          let id = '';
          try { id = await findTmdb(w.kind, series, w.title.year); } catch (e) { id = ''; }
          idCache.set(idKey, id);
        }
        tmdb = idCache.get(idKey);
      }
      const label = w.kind === 'movie' ? series : `${series} S${season != null ? season : '?'}E${episode != null ? episode : '?'}`;
      const entry = {
        path: w.file,
        label,
        series,
        season,
        episode,
        tmdb: tmdb || null,
        url: tmdb ? (w.kind === 'movie' ? `https://vidsrc.sh/embed/movie/${tmdb}` : `https://vidsrc.sh/embed/tv/${tmdb}-${season}-${episode}`) : '',
        mode: 'dub',
        outputRoot: (() => { try { return require('./engineconfig').stagingPath(); } catch (e) { return ''; } })(),
        library: { name: w.lib.name, locations: w.lib.jellyfinLocations || w.lib.locations },
        numbering: 'tmdb',
        episodeName: '',
        floor,
        placedHeight: dim.height,
        placedWidth: dim.width,
        source: 'library',
        kind: w.kind,
        addedAt: Date.now(),
        lastCheck: 0, // checked on the next pass
        lastResult: '',
        // Only an exact match is upgraded; the rest is listed with why not.
        problem: !ok ? 'file name not matched to an episode/film - rename it like the others to include it' : !tmdb ? 'no TMDB id found for the folder name' : ''
      };
      if (entry.problem) scanState.unmatched += 1;
      else scanState.found += 1;
      load()[k] = entry;
    }
    save();
    onLog(`Upgrade resolution: library scan done - ${scanState.found} below ${floor}p to upgrade, ${scanState.unmatched} below ${floor}p that cannot be matched automatically (of ${scanState.total} files).`);
  })().catch((e) => {
    scanState.error = (e && e.message) || String(e);
  }).finally(() => {
    scanState.running = false;
    scanState.phase = 'done';
    scanState.at = Date.now();
    save();
  });
  return scanState;
}

function status() {
  return Object.assign({}, scanState);
}

function start(onLog) {
  if (timer) return;
  const first = setTimeout(() => runDue({ onLog }).catch(() => {}), 10 * 60 * 1000);
  if (first.unref) first.unref();
  timer = setInterval(() => runDue({ onLog }).catch(() => {}), RUN_EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  add,
  remove,
  ignore,
  list,
  runDue,
  checkNow,
  scanLibraries,
  status,
  start,
  RECHECK_MS,
  _setForTests({ dir, check, queue, probeFn, tmdbFn } = {}) {
    dirOverride = dir || null;
    state = null;
    if (check) checkAt = check;
    if (queue) requeue = queue;
    if (probeFn) probe = probeFn;
    if (tmdbFn) findTmdb = tmdbFn;
  }
};
