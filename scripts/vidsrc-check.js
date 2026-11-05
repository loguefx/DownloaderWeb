#!/usr/bin/env node
'use strict';
/**
 * Why does a TV episode not download from Vidsrc? (READ-ONLY)
 *
 *   node scripts/vidsrc-check.js                 Lioness S1E1 (TMDB 113962)
 *   node scripts/vidsrc-check.js 113962 1 1      any TMDB id / season / episode
 *   node scripts/vidsrc-check.js 1396 1 1        a control (Breaking Bad)
 *
 * Walks exactly what the engine's headless Vidsrc path does, printing every
 * hop: the player chain on each relay host (vs_src.php -> landing page ->
 * player page -> API token), the data API's answer, and the quality of each
 * stream source. Nothing is downloaded.
 */

const path = require('path');
const vs = require(path.join(__dirname, '..', 'src', 'main', 'sites', 'vidsrc_dl.js'));

const [id = '113962', season = '1', episode = '1'] = process.argv.slice(2);
const ref = /^tt\d+$/.test(id)
  ? { type: 'tv', imdb: id, season, episode }
  : { type: 'tv', tmdb: id, season, episode };
const secs = (t) => `${((Date.now() - t) / 1000).toFixed(1)} s`;

async function main() {
  console.log(`Vidsrc check: ${id} S${season}E${episode}\n`);

  console.log('[1] Player chain (API token) on each relay host');
  let anyToken = false;
  for (const relay of vs.RELAY_HOSTS) {
    const t = Date.now();
    let tok = '';
    try {
      tok = await vs.tokenChain(relay, ref);
    } catch (e) {
      tok = '';
    }
    if (tok) anyToken = true;
    console.log(`  ${relay}: ${tok ? `token OK (${tok.length} chars)` : 'NO TOKEN - ' + (vs.chainResult(relay) || 'unknown')} (${secs(t)})`);
    if (vs.landingFor(relay)) console.log(`    sent to: ${vs.landingFor(relay)}`);
    const pp = vs.playerPageFor(relay);
    if (!tok && pp) {
      // What the player page holds instead of the token (the site changed it).
      const keys = [...new Set((pp.text.match(/[A-Za-z_]*(?:token|Token|TOKEN|api|Api)[A-Za-z_]*/g) || []))].slice(0, 20);
      console.log(`    player page: ${pp.url}`);
      console.log(`    token-like names on it: ${keys.join(', ') || '(none)'}`);
      console.log(`    first 600 characters: ${pp.text.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    // A timeout: is that host slow, or not answering at all? Once more with
    // a long wait.
    if (!tok && /timeout/.test(vs.chainResult(relay))) {
      const t1 = Date.now();
      try {
        tok = await vs.tokenChain(relay, ref, { relayMs: 45000, pageMs: 45000, ignoreDead: true });
      } catch (e) {
        tok = '';
      }
      if (tok) anyToken = true;
      console.log(`    with 45 s per step: ${tok ? 'token OK - the host is just SLOW' : 'still ' + (vs.chainResult(relay) || 'no token')} (${secs(t1)})`);
    }
  }

  console.log('\n[2] Data API (stream list)');
  const t2 = Date.now();
  let list = null;
  try {
    list = await vs.fetchStreamUrls(ref);
    console.log(`  OK: "${list.meta.title}" - ${list.urls.length} source(s) (${secs(t2)})`);
    if (list.meta.fileName) console.log(`  release: ${list.meta.fileName}`);
  } catch (e) {
    console.log(`  FAILED: ${e.message} (${secs(t2)})`);
    if (!anyToken) console.log('  -> no relay gave an API token: the API refuses token-less calls (403).');
    if (vs.isBlocked()) console.log('  -> Vidsrc answered with a block page: this IP is blocked (switch VPN server).');
  }

  if (list) {
    // The video servers' own token (generate.php): status and body, plain and
    // with the headers a browser player would send.
    console.log('\n[2b] Video servers (generate.php)');
    const origins = [...new Set(list.urls.map((u) => { try { return new URL(u).origin; } catch (e) { return ''; } }).filter(Boolean))];
    for (const origin of origins) {
      for (const [label, headers] of [['plain', {}], ['as the player', { Referer: 'https://vidsrc.sh/', Origin: 'https://vidsrc.sh' }]]) {
        try {
          const r = await vs.request(origin + '/generate.php', headers, 15000);
          console.log(`  ${origin} (${label}): HTTP ${r.status} - ${r.body.toString('utf8').replace(/\s+/g, ' ').slice(0, 160)}`);
        } catch (e) {
          console.log(`  ${origin} (${label}): ${e.message}`);
        }
      }
    }
    console.log('\n[3] Stream sources (first passing one >= 1080p wins)');
    const t3 = Date.now();
    try {
      const best = await vs.pick1080(ref, (m) => console.log('  ' + m), 1080, { preferOnly: false });
      console.log(best ? `  => passes the 1080p floor: ${best.realWidth || best.width}x${best.realHeight || best.height}${(best.realHeight || best.height) < 1080 ? ' (widescreen 1080p)' : ''} from ${best.host} (${secs(t3)})` : `  => NO source reached 1080p (${secs(t3)})`);
    } catch (e) {
      console.log(`  => failed: ${e.message}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Vidsrc check failed:', (e && e.stack) || e);
  process.exit(1);
});
