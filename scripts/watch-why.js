#!/usr/bin/env node
'use strict';
/**
 * Why is a watched title not picking up new episodes? (READ-ONLY)
 *
 *   node scripts/watch-why.js "Devil's Crest"
 *
 * Asks the running engine to run that title's daily check in report-only
 * mode (nothing is queued) and prints what it saw: TMDB's aired episodes,
 * what is on disk, the English-dub status of the missing ones, whether the
 * title is frozen, what waits for a dub, and when the daily check last ran.
 */

const path = require('path');
const http = require('http');

const SRC = path.join(__dirname, '..', 'src', 'main');
const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('Usage: node scripts/watch-why.js "<series name>"');
  process.exit(2);
}

function post(p, body) {
  const ec = require(path.join(SRC, 'engineconfig.js')).get() || {};
  const port = Number(ec.port) || 7878;
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Authorization: 'Bearer ' + ec.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`engine answered ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('engine answered something that is not JSON')); }
      });
    });
    req.on('error', (e) => reject(new Error(`engine not reachable on 127.0.0.1:${port} (${e.message}) - start the engine and run this again`)));
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 60000);
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

async function main() {
  console.log(`Watch check (report only): "${name}"\n`);
  const r = await post('/api/schedules/explain', { series: name });
  if (!r.found) {
    console.log(`"${name}" is not on the watch list. Watched titles:\n  ${(r.watched || []).join('\n  ')}`);
    return;
  }
  const e = r.entry;
  console.log(`Entry: "${e.series}"  tmdb ${e.tmdb || '-'}  season ${e.season}  ${e.anime ? 'anime' : 'TV'}  numbering ${e.numbering}  library ${e.library || '-'}`);
  console.log(`Frozen: ${e.frozen ? 'YES - skipped by the daily check' : 'no'}   Last checked: ${ago(e.lastChecked)}   Watcher mode: ${r.mode}`);
  if (r.lastPass) {
    const p = r.lastPass;
    console.log(`Daily check: ${p.running ? `RUNNING (${p.phase}), started ${ago(p.startedAt)}` : `last finished ${ago(p.finishedAt)}`}`);
  }
  console.log(`Waiting for dub: ${r.waiting.length ? r.waiting.join(', ') : 'none'}\n`);
  console.log('What the check saw:');
  for (const l of r.lines) console.log('  ' + l);
}

main().catch((e) => {
  console.error('Watch check failed: ' + e.message);
  process.exit(1);
});
