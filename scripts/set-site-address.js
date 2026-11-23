#!/usr/bin/env node
'use strict';
/**
 * Point the engine at a source site's current address (they move now and then).
 *
 *   node scripts/set-site-address.js aniwave https://aniwaves.tv
 *   node scripts/set-site-address.js animevillage https://www.animevillage.org
 *   node scripts/set-site-address.js nontongo https://sv2.nontongo.day
 *   node scripts/set-site-address.js aniwave --default        back to the built-in one
 *
 * Saved in the engine's settings (engine.json, siteAddresses); the running
 * engine uses it at once. Usually not needed: the engine follows a site's
 * redirect to a new address by itself, and the Sources check tries the other
 * known addresses when one stops answering.
 */
const path = require('path');
const http = require('http');
const SRC = path.join(__dirname, '..', 'src', 'main');
const SITES = ['aniwave', 'animevillage', 'nontongo'];

const site = (process.argv[2] || '').trim().toLowerCase();
const arg = (process.argv[3] || '').trim();
if (!SITES.includes(site) || !arg) {
  console.error(`Usage: node scripts/set-site-address.js <${SITES.join('|')}> https://ADDRESS   (or --default)`);
  process.exit(2);
}
let value = '';
if (arg !== '--default') {
  try {
    value = new URL(/^https?:\/\//i.test(arg) ? arg : 'https://' + arg).origin;
  } catch (e) {
    console.error('Not an address: ' + arg);
    process.exit(2);
  }
}
const ec = require(path.join(SRC, 'engineconfig.js')).get() || {};
const port = Number(ec.port) || 7878;
const data = JSON.stringify({ siteAddresses: { [site]: value } });
const req = http.request({ host: '127.0.0.1', port, path: '/api/settings', method: 'PUT', headers: { Authorization: 'Bearer ' + ec.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
  let d = '';
  res.on('data', (c) => { d += c; });
  res.on('end', () => {
    if (res.statusCode >= 400) {
      console.error(`Engine answered ${res.statusCode}: ${d.slice(0, 200)}`);
      process.exit(1);
    }
    console.log(value ? `${site} address set to ${value} (used at once).` : `${site} address back to the built-in default.`);
  });
});
req.on('error', (e) => {
  require(path.join(SRC, 'siteaddress.js')).adopt(site, value, 'set by hand');
  console.log(`Engine not running (${e.message}) - saved; used when the engine starts.`);
});
req.end(data);
