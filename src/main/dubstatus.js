'use strict';

// Which episodes of an anime season are English-dubbed - on the source the
// engine downloads from (Vidsrc), judged by the same rule the DUB download
// uses (audiolang.isEnglishDub: a release must be marked as a dub). So the
// plugin's "EN DUB n/m" badge, the "send undubbed episodes to the waiting
// list" decision at queue time and the daily waiting-list pass all agree with
// what a DUB download would actually get.
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

module.exports = {
  peekSeason,
  checkSeason,
  isDubbed,
  TTL,
  _setLookupForTests(fn) {
    lookup = fn;
  },
  _resetForTests(reloadFromDisk = false) {
    cache = reloadFromDisk ? null : {};
    running.clear();
  }
};
