#!/usr/bin/env node
'use strict';
/**
 * What is filling the staging folder (and its drive)?
 *
 *   node scripts/staging-report.js            report only (nothing changes)
 *   node scripts/staging-report.js --clean    delete the safe leftovers
 *
 * Asks the running engine (it knows which files its queue still needs):
 *   in use         a download still in the queue owns it - never touched
 *   in library     its episode is already on a library drive - safe to delete
 *   leftovers      capture leftovers (.part / .hls) no download owns - safe
 *   unplaced       a video neither in a library nor queued - kept, listed
 *   other          anything else - kept, listed
 * --clean deletes ONLY "in library" and "leftovers".
 */

const path = require('path');
const http = require('http');

const SRC = path.join(__dirname, '..', 'src', 'main');
const clean = process.argv.includes('--clean');
const SHOW = Number((process.argv.find((a) => /^--show=\d+$/.test(a)) || '--show=15').split('=')[1]);

function request(method, p) {
  const ec = require(path.join(SRC, 'engineconfig.js')).get() || {};
  const port = Number(ec.port) || 7878;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Authorization: 'Bearer ' + ec.apiKey } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`engine answered ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('engine answered something that is not JSON')); }
      });
    });
    req.on('error', (e) => reject(new Error(`engine not reachable on 127.0.0.1:${port} (${e.message}) - start the engine and run this again`)));
    req.setTimeout(300000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const gb = (n) => `${(Number(n || 0) / 1024 ** 3).toFixed(1)} GB`;

async function main() {
  const r = await request(clean ? 'POST' : 'GET', clean ? '/api/staging/clean' : '/api/staging/report');
  const used = (r.drive.totalBytes || 0) - (r.drive.freeBytes || 0);
  console.log(`Staging folder: ${r.staging}`);
  console.log(`Drive: ${gb(r.drive.freeBytes)} free of ${gb(r.drive.totalBytes)} (${gb(used)} used)`);
  console.log(`  of the used space: staging ${gb(r.stagingBytes)}, everything else on the drive ${gb(r.otherDataOnDriveBytes)}`);
  if (r.otherDataOnDriveBytes > r.stagingBytes * 4 && r.otherDataOnDriveBytes > 50 * 1024 ** 3) {
    console.log('  -> most of the drive is NOT staging: other files on that drive are what is filling it.');
  }
  console.log(`Library drives checked: ${(r.libraryRoots || []).join(', ') || '(none known yet)'}\n`);
  const titles = {
    active: 'In use by the queue (never touched)',
    inLibrary: 'Already in your library (safe to delete)',
    junk: 'Leftovers from interrupted captures (safe to delete)',
    unplaced: 'Videos not in a library and not queued (kept - check these)',
    other: 'Other files (kept)'
  };
  for (const k of ['active', 'inLibrary', 'junk', 'unplaced', 'other']) {
    const g = r.groups[k];
    if (!g || !g.count) continue;
    console.log(`${titles[k]}: ${g.count} item(s), ${gb(g.bytes)}`);
    for (const f of g.files.slice(0, SHOW)) {
      const extra = f.item ? `  [${f.item} - ${f.status}]` : f.libraryFile ? `  -> ${f.libraryFile}` : '';
      console.log(`   ${gb(f.bytes).padStart(8)}  ${f.path}${extra}`);
    }
    if (g.files.length > SHOW) console.log(`   ... and ${g.files.length - SHOW} more (--show=${g.files.length} lists all)`);
    console.log('');
  }
  if (clean && r.cleaned) {
    console.log(`Cleaned: ${r.cleaned.deleted} item(s) deleted, ${gb(r.cleaned.freedBytes)} freed.`);
    if (r.cleaned.failed.length) console.log(`Could not delete: ${r.cleaned.failed.join(', ')}`);
  } else {
    const safe = (r.groups.inLibrary.bytes || 0) + (r.groups.junk.bytes || 0);
    console.log(safe ? `Run again with --clean to free ${gb(safe)} (only "in library" and "leftovers" are deleted).` : 'Nothing safe to delete.');
  }
}

main().catch((e) => {
  console.error('Staging report failed: ' + e.message);
  process.exit(1);
});
