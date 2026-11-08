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
    addedAt: now,
    lastCheck: now
  };
  save();
  return true;
}

function remove(finalPath) {
  const s = load();
  if (delete s[norm(finalPath)]) save();
}

function list() {
  return Object.values(load()).sort((a, b) => a.addedAt - b.addedAt);
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
  return bulk.queueOne({
    url: e.url, series: e.series, season: e.season, episode: e.episode, mode: e.mode,
    outputRoot: e.outputRoot, library: e.library, minHeight: e.floor, anime: false,
    tmdb: e.tmdb, numbering: e.numbering, episodeName: e.episodeName, upgrade: true
  });
};

async function runDue({ onLog = () => {}, now = Date.now() } = {}) {
  if (running) return running;
  running = (async () => {
    const s = load();
    let checked = 0;
    let queued = 0;
    for (const [k, e] of Object.entries(s)) {
      if (checked >= PER_RUN) break;
      if (now - (e.lastCheck || 0) < RECHECK_MS) continue;
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
      if (!/^\d+$/.test(String(e.tmdb || ''))) {
        e.lastCheck = now;
        continue;
      }
      checked += 1;
      let has = null;
      try { has = await checkAt(e); } catch (err) { has = null; }
      if (has === null) break; // Vidsrc paused / unreachable: the next run tries again
      e.lastCheck = now;
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
  list,
  runDue,
  start,
  RECHECK_MS,
  _setForTests({ dir, check, queue } = {}) {
    dirOverride = dir || null;
    state = null;
    if (check) checkAt = check;
    if (queue) requeue = queue;
  }
};
