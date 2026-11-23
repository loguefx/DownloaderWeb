#!/usr/bin/env node
'use strict';
/**
 * Point the engine at Aniwave's current address (it moves now and then).
 *
 *   node scripts/set-aniwave.js https://aniwave.example     use this address
 *   node scripts/set-aniwave.js --default                    back to the built-in one
 *
 * Saved in the engine's settings (engine.json, "aniwaveBase"); the running
 * engine uses it at once. Then check: node scripts/dub-check.js "<title>" 1 1
 */
const path = require('path');
const http = require('http');
const SRC = path.join(__dirname, '..', 'src', 'main');

const arg = (process.argv[2] || '').trim();
if (!arg) {
  console.error('Usage: node scripts/set-aniwave.js https://ADDRESS   (or --default)');
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
const data = JSON.stringify({ aniwaveBase: value });
const req = http.request({ host: '127.0.0.1', port, path: '/api/settings', method: 'PUT', headers: { Authorization: 'Bearer ' + ec.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
  let d = '';
  res.on('data', (c) => { d += c; });
  res.on('end', () => {
    if (res.statusCode >= 400) {
      console.error(`Engine answered ${res.statusCode}: ${d.slice(0, 200)}`);
      process.exit(1);
    }
    console.log(value ? `Aniwave address set to ${value} (used at once).` : 'Aniwave address back to the built-in default.');
  });
});
req.on('error', (e) => {
  // Engine not running: write the setting directly; it is read at the next start.
  require(path.join(SRC, 'engineconfig.js')).set({ aniwaveBase: value });
  console.log(`Engine not running (${e.message}) - saved; it is used when the engine starts.`);
});
req.end(data);
