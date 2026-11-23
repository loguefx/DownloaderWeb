#!/usr/bin/env node
'use strict';
/**
 * Has the engine missed any episodes of the anime on the watch list?
 *
 *   node scripts/missed-episodes.js            report only (nothing queued)
 *   node scripts/missed-episodes.js --queue    also queue the missed / failed
 *                                              ones that are dubbed
 *   node scripts/missed-episodes.js "Devil's Crest"   one title
 *
 * Checks each watched anime's current season, aired episode by episode,
 * against your library and says where every missing one stands. "HOLE" =
 * missing while a later episode is on disk (Devils' Crest: E4 there, E3 not).
 */

const path = require('path');
const http = require('http');

const SRC = path.join(__dirname, '..', 'src', 'main');
const args = process.argv.slice(2);
const queue = args.includes('--queue');
const series = args.filter((a) => a !== '--queue').join(' ').trim() || null;

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
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

async function main() {
  console.log(`Missed-episode check${series ? ` for "${series}"` : ' (every watched anime)'}${queue ? ' - queueing what can be fetched' : ' - report only'}. This can take a few minutes.\n`);
  const r = await post('/api/schedules/gaps', { queue, series });
  let complete = 0;
  let holes = 0;
  for (const s of r.series) {
    if (!s.missing.length) {
      complete += 1;
      if (s.note) console.log(`"${s.series}" S${s.season}: ${s.note}`);
      continue;
    }
    console.log(`"${s.series}" season ${s.season}: ${s.aired} aired, ${s.onDisk} on disk, ${s.missing.length} missing${s.frozen ? ' (FROZEN - the daily check skips it)' : ''}${s.queued != null ? `, ${s.queued} queued now` : ''}`);
    for (const m of s.missing) {
      if (m.hole) holes += 1;
      const dub = m.dubbedOnAniwave === true ? 'dubbed on Aniwave' : m.dubbedOnAniwave === false ? 'no dub on Aniwave' : 'Aniwave: unknown';
      console.log(`   E${m.episode}${m.hole ? '  HOLE' : ''}  [${dub}]  ${m.state}`);
    }
    if (s.note) console.log(`   note: ${s.note}`);
  }
  console.log(`\n${r.audited} watched anime checked: ${complete} complete, ${r.audited - complete} with missing episodes, ${holes} hole(s).`);
  if (!queue && r.series.some((s) => s.missing.some((m) => /^(MISSED|FAILED)/.test(m.state)))) {
    console.log('Run again with --queue to queue the MISSED / FAILED ones that are dubbed.');
  }
}

main().catch((e) => {
  console.error('Missed-episode check failed: ' + e.message);
  process.exit(1);
});
