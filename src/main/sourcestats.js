'use strict';
// How each fallback site has done lately, per kind of title (tv / movie /
// anime), so the cross-site search stops spending minutes on sites that never
// produce a download (TV logs: NontonGo waits ~35 s for a stream that never
// comes, SolarMovie finds nothing, the Cloudflare-gated sites never clear).
//
//   record(site, kind, ok)   one search on that site ended (ok = it resolved a stream)
//   skip(site, kind)         -> '' | the reason to leave it out of this search
//   order(cands, kind)       cold sites (several misses in a row) moved last
//   summary()                for the Overview's Sources row
//
// A skipped site is still tried once a day (PROBE_MS), so one that recovers
// comes back by itself; any hit clears its record. Kept on disk
// (<userData>/source-stats.json).

const fs = require('fs');
const os = require('os');
const path = require('path');

const COLD_STREAK = 3; // misses in a row: tried after the others
const SKIP_STREAK = 6; // misses in a row with no recent hit: left out
const HIT_FRESH_MS = 7 * 24 * 3600 * 1000; // a hit within this keeps a site in
const PROBE_MS = 24 * 3600 * 1000; // a left-out site is still tried this often

let dirOverride = null;
let state = null; // { "<site>|<kind>": { hits, misses, streak, lastHit, lastTry } }
let saveTimer = null;

function dataDir() {
  if (dirOverride) return dirOverride;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) {
    /* plain Node */
  }
  return path.join(os.tmpdir(), 'wvd-sourcestats');
}
const file = () => path.join(dataDir(), 'source-stats.json');

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
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state || {}));
      fs.renameSync(tmp, file());
    } catch (e) {
      /* the in-memory copy still answers */
    }
  }, 1000);
  if (saveTimer.unref) saveTimer.unref();
}

const kindOf = (k) => (k === 'anime' || k === 'movie' ? k : 'tv');
const key = (site, kind) => `${String(site || '')}|${kindOf(kind)}`;

function record(site, kind, ok, now = Date.now()) {
  if (!site) return;
  const s = load();
  const k = key(site, kind);
  const r = s[k] || { hits: 0, misses: 0, streak: 0, lastHit: 0, lastTry: 0 };
  r.lastTry = now;
  if (ok) {
    r.hits += 1;
    r.streak = 0;
    r.lastHit = now;
  } else {
    r.misses += 1;
    r.streak += 1;
  }
  s[k] = r;
  saveSoon();
}

function rec(site, kind) {
  return load()[key(site, kind)] || null;
}

// '' = try it; otherwise why it is left out of this search.
function skip(site, kind, now = Date.now()) {
  const r = rec(site, kind);
  if (!r || r.streak < SKIP_STREAK) return '';
  if (r.lastHit && now - r.lastHit < HIT_FRESH_MS) return '';
  if (now - (r.lastTry || 0) >= PROBE_MS) return ''; // the daily re-check
  return `no download from it in its last ${r.streak} searches` + (r.lastHit ? '' : ' (never one)');
}

// Stable: the sites' own order, with cold ones (a miss streak) after the rest.
function order(cands, kind) {
  const cold = (c) => {
    const r = rec(c.id, kind);
    return r && r.streak >= COLD_STREAK ? 1 : 0;
  };
  return cands.map((c, i) => ({ c, i })).sort((a, b) => cold(a.c) - cold(b.c) || a.i - b.i).map((x) => x.c);
}

function summary(now = Date.now()) {
  const out = [];
  for (const [k, r] of Object.entries(load())) {
    const [site, kind] = k.split('|');
    out.push({ site, kind, hits: r.hits, misses: r.misses, streak: r.streak, lastHit: r.lastHit || 0, lastTry: r.lastTry || 0, skipped: !!skip(site, kind, now) });
  }
  return out;
}

module.exports = {
  record,
  skip,
  order,
  summary,
  COLD_STREAK,
  SKIP_STREAK,
  PROBE_MS,
  _setDirForTests(dir) {
    dirOverride = dir;
    state = null;
  }
};
