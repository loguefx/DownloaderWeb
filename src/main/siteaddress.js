'use strict';
// Where each source site lives right now. They move (Aniwave went from
// aniwaves.ru to aniwaves.tv and every anime's dub check went "unknown"
// until it was found). Three ways an address is kept current:
//   1. a redirect to another address for the same page is followed and
//      remembered (adopt) - the sites' own clients do this on every request;
//   2. when the current address gives no answer, the other known addresses
//      are tried and the first that works is used (heal - run by the
//      Sources health check);
//   3. by hand: node scripts/set-site-address.js <site> https://ADDRESS
// Kept in engine.json under siteAddresses (Aniwave also as aniwaveBase, the
// setting earlier builds used).

const KNOWN = {
  aniwave: ['https://aniwaves.tv', 'https://aniwaves.ru'],
  animevillage: ['https://www.animevillage.org', 'https://animevillage.org'],
  nontongo: ['https://sv2.nontongo.day', 'https://sv2.nontongo.stream']
};

let cfgOverride = null; // tests: { get, set }
function cfg() {
  if (cfgOverride) return cfgOverride;
  try {
    return require('./engineconfig');
  } catch (e) {
    return { get: () => ({}), set: () => ({}) };
  }
}

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
const valid = (u) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(clean(u));

function current(site) {
  let c = {};
  try { c = cfg().get() || {}; } catch (e) { c = {}; }
  const set = c.siteAddresses && c.siteAddresses[site];
  if (set && valid(set)) return clean(set);
  if (site === 'aniwave' && c.aniwaveBase && valid(c.aniwaveBase)) return clean(c.aniwaveBase);
  return (KNOWN[site] || [])[0] || '';
}

// Use this address from now on (a followed redirect, a healed address, or
// the user's choice). '' goes back to the built-in one.
function adopt(site, origin, why = '') {
  const o = clean(origin);
  if (o && !valid(o)) return false;
  let c = {};
  try { c = cfg().get() || {}; } catch (e) { c = {}; }
  const was = current(site);
  const siteAddresses = Object.assign({}, c.siteAddresses || {}, { [site]: o });
  if (!o) delete siteAddresses[site];
  const patch = { siteAddresses };
  if (site === 'aniwave') patch.aniwaveBase = o;
  try { cfg().set(patch); } catch (e) { return false; }
  if (o && o !== was) console.log(`[sites] ${site} now at ${o}${why ? ' (' + why + ')' : ''}`);
  return true;
}

// Every address to try for a site: the current one first, then the known ones.
function candidates(site) {
  return [...new Set([current(site), ...(KNOWN[site] || [])].filter(Boolean))];
}

// The current address gives no answer: try the others with test(base) ->
// truthy, and use the first that works. -> { ok, base, tried }
async function heal(site, test) {
  const tried = [];
  for (const base of candidates(site)) {
    let ok = false;
    try { ok = !!(await test(base)); } catch (e) { ok = false; }
    tried.push({ base, ok });
    if (ok) {
      if (base !== current(site)) adopt(site, base, 'the old address stopped answering');
      return { ok: true, base, tried };
    }
  }
  return { ok: false, base: current(site), tried };
}

module.exports = {
  current,
  adopt,
  candidates,
  heal,
  KNOWN,
  _setConfigForTests(c) {
    cfgOverride = c;
  }
};
