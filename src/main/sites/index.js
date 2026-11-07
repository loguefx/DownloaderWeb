'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const generic = require('./generic');

// Registry of site adapters. Code-based profiles live in this folder; users can
// also drop JSON profiles into <userData>/sites/*.json to add sites without
// touching the source. Site-specific profiles are matched first; `generic` is
// always the last-resort fallback.
const builtIn = [];

// Auto-load any other *.js profile in this directory (besides index/generic).
function loadBuiltIn() {
  let files = [];
  try {
    files = fs.readdirSync(__dirname);
  } catch (e) {
    files = [];
  }
  for (const f of files) {
    if (!f.endsWith('.js') || f === 'index.js' || f === 'generic.js') continue;
    try {
      const mod = require(path.join(__dirname, f));
      if (mod && mod.id) builtIn.push(normalize(mod));
    } catch (e) {
      // ignore malformed profile
    }
  }
}

// Load user JSON profiles. `match` entries are strings turned into RegExp.
function loadUserProfiles(userDataDir) {
  const dir = path.join(userDataDir || '', 'sites');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (json && json.id) builtIn.push(normalize(json));
    } catch (e) {
      // ignore malformed profile
    }
  }
}

// A JSON profile can describe a TMDB-id embed player (the kind Vidsrc is):
//   { "id": "example", "name": "Example", "tmdbEmbed": {
//       "tv":    "https://player.example/embed/tv/{tmdb}/{season}/{episode}",
//       "movie": "https://player.example/embed/movie/{tmdb}" } }
// It becomes a fallback source for TV/movies (never anime): the URL is built
// from the job's TMDB id and loaded like any player page. A site that never
// yields a download is moved last / left out by sourcestats.
function embedProfile(p) {
  const e = p.tmdbEmbed || {};
  const fill = (tpl, ref) => String(tpl)
    .replace(/\{tmdb\}/g, encodeURIComponent(String(ref.tmdb)))
    .replace(/\{season\}/g, encodeURIComponent(String(ref.season)))
    .replace(/\{episode\}/g, encodeURIComponent(String(ref.episode)));
  const hosts = [e.tv, e.movie].filter(Boolean).map((u) => {
    try { return new URL(String(u).replace(/\{[a-z]+\}/g, '1')).host; } catch (x) { return ''; }
  }).filter(Boolean);
  const esc = (h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    name: p.name || p.id,
    match: p.match && p.match.length ? p.match : hosts.map((h) => esc(h)),
    minHeight: p.minHeight != null ? p.minHeight : 1080,
    fallbackRank: p.fallbackRank != null ? p.fallbackRank : 3,
    animeOnly: false,
    dub: Object.assign({ sourceWaitMs: 30000 }, p.dub || {}),
    async findTitle(ref, hooks, onLog = () => {}) {
      if (!ref || ref.anime || !/^\d+$/.test(String(ref.tmdb || ''))) return null;
      const isTv = ref.season != null && ref.season !== '' && ref.episode != null && ref.episode !== '';
      const tpl = isTv ? e.tv : e.movie;
      if (!tpl) return null;
      const url = fill(tpl, ref);
      onLog(`trying ${url}`);
      return url;
    }
  };
}

function normalize(p) {
  const base = p && p.tmdbEmbed ? Object.assign({}, embedProfile(p), p) : p;
  if (p && p.tmdbEmbed) base.findTitle = embedProfile(p).findTitle;
  const match = (base.match || []).map((m) => (m instanceof RegExp ? m : new RegExp(m, 'i')));
  return Object.assign({}, base, { match: match.length ? match : [/.*/] });
}

// Returns the most specific matching profile for a URL (generic last).
function resolve(url) {
  for (const p of builtIn) {
    if (p.id === 'generic') continue;
    if (p.match.some((re) => re.test(url))) return p;
  }
  return generic;
}

// Effective dub config = global defaults overlaid with the profile's overrides.
function dubConfig(profile) {
  return Object.assign({}, config.dub, (profile && profile.dub) || {});
}

function init(userDataDir) {
  builtIn.length = 0;
  loadBuiltIn();
  loadUserProfiles(userDataDir);
}

module.exports = { init, resolve, dubConfig, profiles: builtIn };
