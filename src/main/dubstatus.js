'use strict';

// Which episodes of a season are English-dubbed on the sources the engine
// downloads from, so the plugin's "EN DUB n/m" badge, the "send undubbed
// episodes to the waiting list" decision at queue time and the daily
// waiting-list pass all agree with what a DUB download would actually get.
//   anime     - Aniwave's per-episode dub flags and Anime Village's separate
//               dub files (the anime sources; Vidsrc is not used for anime)
//   TV/movies - Vidsrc's release name (audiolang.isEnglishDub)
//
// Results are cached on disk (<userData>/dubstatus.json):
//   dubbed      kept 7 days  (a dub does not go away)
//   not dubbed  kept 12 h    (the daily waiting-list pass re-checks it)
//   unknown     kept 1 h     (episode missing on the source / network)
// Season checks run in the background, one at a time per season, and are
// paced by the Vidsrc data-API throttle (~1.2 s per episode).

const path = require('path');
const { app } = require('electron');
const { writeJsonAtomic, readJson } = require('./jsonfile');
const audiolang = require('./audiolang');

const TTL = { dubbed: 7 * 24 * 3600 * 1000, notDubbed: 12 * 3600 * 1000, unknown: 3600 * 1000 };
// Bumped whenever the "is this release a dub" rule changes, so answers made
// by an older rule are looked up again (v2: a "DUAL" release is not a dub -
// the stream keeps only its Japanese track).
const RULE_VERSION = 2;

let cache = null; // key "tmdb|season|episode" -> { dubbed: true|false|null, file, at }
let saveTimer = null;
const running = new Map(); // "tmdb|season" -> promise

// Injectable for tests: (ref, session) -> { fileName, status }.
let lookup = (ref, session) => require('./sites/vidsrc_dl').episodeRelease(ref, session);

function file() {
  return path.join(app.getPath('userData'), 'dubstatus.json');
}
function load() {
  if (!cache) {
    const raw = readJson(file(), {});
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }
  return cache;
}
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeJsonAtomic(file(), cache || {});
    } catch (e) {
      // non-fatal: the in-memory copy still answers this session
    }
  }, 500);
  if (saveTimer.unref) saveTimer.unref();
}

const key = (tmdb, season, ep) => `${tmdb}|${season}|${ep}`;

function fresh(hit, now = Date.now()) {
  if (!hit || hit.v !== RULE_VERSION) return false;
  const ttl = hit.dubbed === true ? TTL.dubbed : hit.dubbed === false ? TTL.notDubbed : TTL.unknown;
  return now - (hit.at || 0) < ttl;
}

// Cached answers only (never touches the network).
//   -> { tmdb, season, total, checked, dubbed, notDubbed, unknown, pending,
//        episodes: [{ episode, dubbed, file, at }] }
function peekSeason(tmdb, season, episodes) {
  const c = load();
  const out = { tmdb: String(tmdb), season: Number(season), total: episodes.length, checked: 0, dubbed: 0, notDubbed: 0, unknown: 0, pending: running.has(`${tmdb}|${season}`), episodes: [] };
  for (const ep of episodes) {
    const hit = c[key(tmdb, season, ep)];
    const row = { episode: ep, dubbed: hit ? hit.dubbed : null, file: hit ? hit.file : '', at: hit ? hit.at : 0, stale: !fresh(hit) };
    if (hit) out.checked += 1;
    if (row.dubbed === true) out.dubbed += 1;
    else if (row.dubbed === false) out.notDubbed += 1;
    else out.unknown += 1;
    out.episodes.push(row);
  }
  return out;
}

// Look up every episode whose cached answer is missing or stale (all of them
// with force). One run per season at a time; a second call joins it.
function checkSeason(tmdb, season, episodes, { force = false, onLog = () => {} } = {}) {
  const k = `${tmdb}|${season}`;
  if (running.has(k)) return running.get(k);
  const p = (async () => {
    const c = load();
    const session = {};
    let looked = 0;
    for (const ep of episodes) {
      const hit = c[key(tmdb, season, ep)];
      if (!force && fresh(hit)) continue;
      let r;
      try {
        r = await lookup({ type: 'tv', tmdb: String(tmdb), season: Number(season), episode: Number(ep) }, session);
      } catch (e) {
        r = { fileName: '', status: 'unreachable' };
      }
      looked += 1;
      const dubbed = r.status === 'ok' ? audiolang.isEnglishDub(r.fileName) : null;
      // A network failure must not overwrite a good answer we already have.
      if (dubbed === null && hit && hit.dubbed !== null && r.status === 'unreachable') continue;
      c[key(tmdb, season, ep)] = { dubbed, file: r.fileName || '', at: Date.now(), v: RULE_VERSION };
      saveSoon();
    }
    if (looked) onLog(`English-dub check: TMDB ${tmdb} season ${season} - ${looked} episode(s) looked up.`);
    return peekSeason(tmdb, season, episodes);
  })().finally(() => running.delete(k));
  running.set(k, p);
  return p;
}

// One episode: true / false / null. Uses the cache when fresh (maxAgeMs
// narrows it; 0 forces a lookup).
async function isDubbed(tmdb, season, episode, { maxAgeMs = null } = {}) {
  const c = load();
  const hit = c[key(tmdb, season, episode)];
  const okAge = hit && (maxAgeMs == null ? fresh(hit) : Date.now() - (hit.at || 0) < maxAgeMs);
  if (okAge && hit.v === RULE_VERSION) return hit.dubbed;
  // A season check already running may cover other episodes: wait for it,
  // then look this episode up if it still has no fresh answer.
  const k = `${tmdb}|${season}`;
  if (running.has(k)) await running.get(k).catch(() => {});
  const again = load()[key(tmdb, season, episode)];
  if (again && Date.now() - (again.at || 0) < (maxAgeMs == null ? Infinity : maxAgeMs) && fresh(again)) return again.dubbed;
  await checkSeason(tmdb, season, [episode], { force: true });
  const row = peekSeason(tmdb, season, [episode]).episodes[0];
  return row ? row.dubbed : null;
}

// ---- Anime Village: a separate dub file per episode ----------------------
// Looked up by title + the job's own season/episode numbering, cached on disk
// with the same TTLs as above (a "not dubbed" is re-checked after 12 h, so
// the daily waiting-list pass always asks again).

// Injectable for tests: (title, season, episodes) -> Map(episode -> bool) | null
let animevillageLookup = (title, season, episodes) =>
  require('./sites/animevillage_api').dubMap(title, season, { only: episodes });

const avKey = (title, season, ep) =>
  `av|${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${Number(season) || 1}|${ep}`;
const avRunning = new Map(); // "title|season" -> promise

// Cached answers only: { map: Map(episode -> true/false), stale, pending }
function peekAnimevillage(title, season, episodes) {
  const c = load();
  const map = new Map();
  let stale = false;
  for (const ep of episodes) {
    const hit = c[avKey(title, season, ep)];
    if (hit && hit.dubbed != null) map.set(Number(ep), hit.dubbed);
    if (!fresh(hit)) stale = true;
  }
  return { map, stale, pending: avRunning.has(avKey(title, season, '')) };
}

// Episode -> dubbed for the episodes asked; stale ones are looked up (one
// run per title + season at a time). null when Anime Village answered nothing.
function animevillageDubMap(title, season, episodes, { force = false } = {}) {
  if (!title || !episodes || !episodes.length) return Promise.resolve(null);
  const rk = avKey(title, season, '');
  const run = async () => {
    const c = load();
    const need = episodes.filter((ep) => force || !fresh(c[avKey(title, season, ep)]));
    if (need.length) {
      let m = null;
      try {
        m = await animevillageLookup(title, Number(season) || 1, need.map(Number));
      } catch (e) {
        m = null;
      }
      if (m) {
        for (const ep of need) {
          if (!m.has(Number(ep))) continue;
          c[avKey(title, season, ep)] = { dubbed: m.get(Number(ep)), at: Date.now(), v: RULE_VERSION };
        }
        saveSoon();
      }
    }
    const { map } = peekAnimevillage(title, season, episodes);
    return map.size ? map : null;
  };
  const p = (avRunning.get(rk) || Promise.resolve()).catch(() => {}).then(run);
  const tracked = p.finally(() => {
    if (avRunning.get(rk) === tracked) avRunning.delete(rk);
  });
  avRunning.set(rk, tracked);
  return p;
}

// ---- Aniwave: the per-episode dub flags of its catalog -------------------
// Vidsrc often streams only the Japanese track of a dual release, while
// Aniwave serves the English dub as its own stream (and flags data-dub per
// episode). Looked up by title + the job's own season/episode numbering
// (Aniwave's layout), cached 6 h in the catalog client.

// Injectable for tests: (title, season) -> { show, episodes:[{episode,dub}] } | null
let aniwaveSeason = (title, season) => require('./sites/aniwave_api').seasonInfo(title, season);

async function aniwaveDubMap(title, season) {
  if (!title) return null;
  try {
    const info = await aniwaveSeason(title, Number(season) || 1);
    if (!info) return null;
    return new Map(info.episodes.map((e) => [e.episode, !!e.dub]));
  } catch (e) {
    return null;
  }
}

// One ANIME episode of a job: dubbed on an anime source the engine
// downloads from (Vidsrc is not used for anime).
//   true  - Aniwave flags it dubbed, or Anime Village has its dub file
//   false - Anime Village answered "no dub" (no dub file / not listed) and
//           Aniwave does not flag it either
//   null  - Anime Village could not be checked: Aniwave's "no" alone is not
//           enough (Smoking Behind: 0 dubs on Aniwave, all 12 on Anime
//           Village) - the episode is queued and the download decides
// { title, season, episode } = the job's own numbering (the anime sites'
// layout). tmdb/srcSeason/srcEpisode are accepted for older callers.
async function isDubbedForJob({ title, season, episode, tmdb, numbering }) {
  // { season, episode } are TMDB's (Jellyfin's) numbers: ask the anime
  // sources about the episode they actually list (Link Click TMDB S4E7 =
  // "Link Click Season 3" E7; TMDB S3 = the "Bridon Arc" entry).
  // An AniDB-numbered library already uses the anime sites' seasons.
  const src = numbering === 'anime'
    ? await animeNumberingSource({ tmdb, title, season, episode })
    : await sourceEpisode({ tmdb, title, season, episode });
  if (src.entry) {
    let eps = null;
    try { eps = await require('./sites/aniwave_api').episodes(src.entry.id); } catch (e) { eps = null; }
    const row = eps ? eps.find((x) => x.episode === src.episode) : null;
    // Aniwave's "no" alone is not proof (see below): unknown, not false.
    return row && row.dub ? true : null;
  }
  const aw = await aniwaveDubMap(title, src.season);
  const a = aw ? aw.get(Number(src.episode)) : undefined;
  if (a === true) return true;
  const av = await animevillageDubMap(title, src.season, [Number(src.episode)]);
  const v = av ? av.get(Number(src.episode)) : undefined;
  if (v === true) return true;
  if (v === false) return false;
  return null;
}

// TMDB numbers -> the anime sources' (season, episode) or arc entry.
// Injectable for tests.
let sourceEpisode = (q) => require('./anime-layout').animeSourceEpisode(q);
// AniDB-numbered jobs: unchanged for "<Title> Season N" seasons; a sequel
// the sites name differently goes through TMDB's numbers.
let animeNumberingSource = (q) => require('./tmdb').animeSourceForAnimeNumbering(q);

module.exports = {
  _setSourceEpisodeForTests(fn) {
    sourceEpisode = fn;
  },
  peekSeason,
  checkSeason,
  isDubbed,
  isDubbedForJob,
  aniwaveDubMap,
  animevillageDubMap,
  peekAnimevillage,
  _setAniwaveForTests(fn) {
    aniwaveSeason = fn;
  },
  _setAnimevillageForTests(fn) {
    animevillageLookup = fn;
  },
  TTL,
  _setLookupForTests(fn) {
    lookup = fn;
  },
  _resetForTests(reloadFromDisk = false) {
    cache = reloadFromDisk ? null : {};
    running.clear();
    avRunning.clear();
  }
};
