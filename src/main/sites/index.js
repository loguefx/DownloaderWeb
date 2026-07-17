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

function normalize(p) {
  const match = (p.match || []).map((m) => (m instanceof RegExp ? m : new RegExp(m, 'i')));
  return Object.assign({}, p, { match: match.length ? match : [/.*/] });
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
