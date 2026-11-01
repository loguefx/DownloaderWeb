#!/usr/bin/env node
'use strict';
/**
 * Why is an anime episode's English dub not downloading? (READ-ONLY)
 *
 *   node scripts/dub-check.js "Chained Soldier" 2 12
 *
 * Asks the two anime sources the engine downloads dubs from, directly, and
 * prints what each one answers for that episode:
 *   Aniwave        is the episode listed, and is it flagged dubbed?
 *   Anime Village  is the show found, is the episode listed, does a DUB
 *                  stream load, and is it a different file from the SUB one
 *                  (that difference is how the engine knows it is the dub)?
 * plus the answer the engine has cached (dubstatus.json), so a stale "dubbed"
 * is visible. Nothing is downloaded or changed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'main');
const aw = require(path.join(SRC, 'sites', 'aniwave_api.js'));
const av = require(path.join(SRC, 'sites', 'animevillage_api.js'));

const [title, seasonArg, episodeArg] = process.argv.slice(2);
const season = Number(seasonArg) || 1;
const episode = Number(episodeArg);
if (!title || !(episode > 0)) {
  console.error('Usage: node scripts/dub-check.js "<title>" <season> <episode>');
  process.exit(2);
}

const t0 = () => Date.now();
const secs = (s) => `${((Date.now() - s) / 1000).toFixed(1)} s`;

function dataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'webvideodownloader');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'webvideodownloader');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'webvideodownloader');
}

async function main() {
  console.log(`Dub check: "${title}" season ${season} episode ${episode}\n`);

  // ---- the engine's cached answer ----
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir(), 'dubstatus.json'), 'utf8'));
    const k = `av|${String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${season}|${episode}`;
    const hit = c[k] || (c.entries && c.entries[k]);
    if (hit) {
      const age = Math.round((Date.now() - (hit.at || 0)) / 3600000);
      console.log(`Engine cache: Anime Village said ${hit.dubbed === true ? 'DUBBED' : hit.dubbed === false ? 'not dubbed' : 'unknown'} ${age} h ago.`);
    } else {
      console.log('Engine cache: no Anime Village answer stored for this episode.');
    }
  } catch (e) {
    console.log('Engine cache: not readable here (' + e.message + ').');
  }

  // ---- Aniwave ----
  console.log('\n[Aniwave]');
  let s = t0();
  try {
    const info = await aw.seasonInfo(title, season);
    if (!info) {
      console.log(`  not found (${secs(s)}) - no entry for "${title}" season ${season}, or the site did not answer.`);
    } else {
      const e = info.episodes.find((x) => x.episode === episode);
      const dubbed = info.episodes.filter((x) => x.dub).length;
      console.log(`  entry: "${info.show.title}" (id ${info.show.id}) - ${info.episodes.length} episode(s), ${dubbed} dubbed (${secs(s)})`);
      if (!e) console.log(`  episode ${episode}: NOT LISTED yet`);
      else console.log(`  episode ${episode}: listed, sub ${e.sub ? 'yes' : 'no'}, DUB ${e.dub ? 'YES' : 'no'}`);
    }
  } catch (e) {
    console.log(`  error: ${e.message}`);
  }

  // ---- Anime Village ----
  console.log('\n[Anime Village]');
  s = t0();
  let show = null;
  try {
    show = await av.findShow(title, season);
  } catch (e) {
    show = null;
  }
  if (!show) {
    console.log(`  show not found (${secs(s)})${av.isDown() ? ' - the site gave NO answer (down / timing out)' : ''}.`);
    process.exit(0);
  }
  console.log(`  show: "${show.names[0]}" (id ${show.id}) (${secs(s)})`);
  s = t0();
  const eps = await av.episodes(show.id);
  if (!eps) {
    const sum = await av.info(show.id).catch(() => null);
    console.log(`  episode list did NOT load (${secs(s)})${sum ? ` - summary: ${sum.totalEpisodes || '?'} episode(s), dub ${sum.hasDub ? 'yes' : 'no'}` : ''}.`);
    process.exit(0);
  }
  const ep = eps.find((x) => x.number === episode);
  console.log(`  episode list: ${eps.length} episode(s) (${secs(s)})`);
  if (!ep) {
    console.log(`  episode ${episode}: NOT LISTED yet.`);
    process.exit(0);
  }
  s = t0();
  const dub = await av.stream(show.id, ep.epId, 'dub');
  console.log(`  DUB stream: ${dub ? `${dub.url} (server ${dub.server})` : 'did NOT load'} (${secs(s)})`);
  s = t0();
  const sub = await av.stream(show.id, ep.epId, 'sub');
  console.log(`  SUB stream: ${sub ? `${sub.url} (server ${sub.server})` : 'did NOT load'} (${secs(s)})`);
  if (dub && sub) {
    const d = av.fileKey(dub.url) !== av.fileKey(sub.url);
    console.log(`  => ${d ? 'DUBBED: the DUB stream is a different file from the SUB one.' : 'NOT dubbed: the "DUB" stream is the same file as the SUB one.'}`);
  } else if (!dub) {
    console.log('  => no DUB stream right now: either no dub yet, or the site\'s streaming is down.');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Dub check failed:', (e && e.stack) || e);
  process.exit(1);
});
