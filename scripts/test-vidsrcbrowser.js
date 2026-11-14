'use strict';
// The in-page scan the browser fallback runs: finds Vidsrc's API token (a JWT
// with an expiry) whatever it is called, in globals or in the markup.
const vm = require('vm');
const path = require('path');
const { SCAN } = require(path.join(__dirname, '..', 'src', 'main', 'vidsrcbrowser.js'));

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`); }
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = b64({ typ: 'JWT' }) + '.' + b64({ exp: 9999999999, ip: '1.2.3.4' }) + '.c2lnbmF0dXJlLXBhcnQ';
const decoy = b64({ typ: 'JWT' }) + '.' + b64({ sub: 'session' }) + '.c2lnbmF0dXJlLXBhcnQ';
const run = (win, html) => {
  const ctx = Object.assign({ atob: (x) => Buffer.from(x, 'base64').toString('binary'), Node: class {}, document: { documentElement: { innerHTML: html || '' } } }, win);
  ctx.window = ctx;
  return vm.runInNewContext(SCAN, ctx);
};
check('in window.CONFIG.apiToken (as before)', run({ CONFIG: { apiToken: jwt } }) === jwt);
check('renamed and nested', run({ CFG: { player: { auth: { t: jwt } } } }) === jwt);
check('under any global name', run({ __vs_state: { x: jwt } }) === jwt);
check('only in the markup', run({}, '<script>var q="' + jwt + '";</script>') === jwt);
check('a JWT without expiry/IP is not it', run({ CONFIG: { session: decoy } }) === '');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
