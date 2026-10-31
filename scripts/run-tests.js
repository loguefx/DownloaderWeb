#!/usr/bin/env node
'use strict';

// Runs every scripts/test-*.js in its own process and prints one summary.
// `npm test`. Exit code 1 when any suite fails.
//
// Skipped: suites that need a live Electron window and real sites.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SKIP = new Set([
  'test-findtitle.js' // drives real catalog sites in an Electron window
]);

const dir = __dirname;
const suites = fs.readdirSync(dir).filter((f) => /^test-.*\.js$/.test(f) && !SKIP.has(f)).sort();
const failed = [];
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const summary = (out.trim().split('\n').filter((l) => /passed, \d+ failed/.test(l)).pop() || '').trim();
  const ok = r.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(28)} ${summary || (r.error ? r.error.message : 'exit ' + r.status)}`);
  if (!ok) {
    failed.push(f);
    // Enough to diagnose a failure that does not reproduce on the next run:
    // every failing check, then the end of the suite's own output.
    const lines = out.split('\n');
    console.log(lines.filter((l) => /FAIL|Error|error/.test(l)).slice(0, 15).map((l) => '       ' + l).join('\n'));
    console.log('       --- last lines of ' + f + ' ---');
    console.log(lines.slice(-25).map((l) => '       ' + l).join('\n'));
  }
}
console.log(`\n${suites.length - failed.length}/${suites.length} suites passed` + (SKIP.size ? ` (${[...SKIP].join(', ')} skipped: needs Electron + live sites)` : ''));
process.exit(failed.length ? 1 : 0);
