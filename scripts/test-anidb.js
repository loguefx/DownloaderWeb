'use strict';

// "English dub of this anime season?" (src/main/anidb.js) - the watch list's
// "eng dub" pill and the daily log line:
//   [1] the answer comes from the anime sources (Aniwave + Anime Village),
//       as dubbed episodes of the season;
//   [2] Anime Village unreachable -> unknown, never "no dub"; cached briefly;
//   [3] no title -> unknown; per-season results; ensure() dedupes;
//   [4] the TMDB -> AniDB id comes from the Anime-Lists file at its CURRENT
//       address (the old main/anidb-anime-lists*.json paths are 404),
//       served here by a mock on 127.0.0.1.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-anidb-test-'));

// ---- electron shim (anidb.js only needs app.getPath for the cache file) ----
const shim = {
  app: { getPath: () => DATA_DIR, on: () => {}, once: () => {}, whenReady: () => Promise.resolve(), quit: () => {} },
  ipcMain: { handle() {}, on() {} }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return shim;
  return origLoad.apply(this, arguments);
};

const M = require(path.join(REPO, 'src/main/anidb.js'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`);
  }
}

async function main() {
  // Mapping served locally; the source must be the CURRENT Anime-Lists file.
  const srcFile = fs.readFileSync(path.join(REPO, 'src/main/anidb.js'), 'utf8');
  check('mapping address is the current Anime-Lists file', /Fribb\/anime-lists\/master\/anime-list-mini\.json/.test(srcFile) && !/main\/anidb-anime-lists/.test(srcFile.replace(/\/\/.*$/gm, '')));
  check('no AniDB release API call left (it never answered)', !/api\.anidb\.net/.test(srcFile));
  let mapHits = 0;
  const srv = http.createServer((req, res) => {
    mapHits += 1;
    res.end(JSON.stringify([{ type: 'TV', anidb_id: 19479, themoviedb_id: { tv: 296286 } }, { anidb_id: 1, themoviedb_id: { tv: 26209 } }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  M._clearCaches();
  M._setMappingUrlsForTests([`http://127.0.0.1:${srv.address().port}/anime-list-mini.json`]);

  let calls = 0;
  let flaky = null;
  M._setSourcesForTests(async (title, season) => {
    calls += 1;
    if (title === 'Smoking Behind the Supermarket with You') {
      // Aniwave: 0 dubbed; Anime Village: all 12.
      return { aniwave: new Map(Array.from({ length: 12 }, (_, i) => [i + 1, false])), animevillage: new Map(Array.from({ length: 12 }, (_, i) => [i + 1, true])) };
    }
    if (title === 'Link Click' && season === 3) {
      return { aniwave: new Map([[1, true], [9, false], [11, false]]), animevillage: new Map([[1, true], [9, true], [11, false], [12, false]]) };
    }
    if (title === 'Sub Only') return { aniwave: new Map([[1, false]]), animevillage: new Map([[1, false], [2, false]]) };
    if (title === 'Down') return { aniwave: new Map([[1, false]]), animevillage: null };
    if (title === 'Empty AV') return { aniwave: new Map([[1, false], [2, false]]), animevillage: new Map() };
    if (title === 'Flaky') return flaky;
    return { aniwave: null, animevillage: null };
  });

  console.log('\n[1] From the anime sources');
  let d = await M.englishDubForTmdb('296286', { title: 'Smoking Behind the Supermarket with You', season: 1 });
  check('Smoking Behind: dub exists, 12 of 12 episodes (Anime Village)', d.available === true && d.englishDubReleases === 12 && d.totalReleases === 12 && d.sample === 'Anime Village', JSON.stringify(d));
  check('...AniDB id from the mapping', d.anidbId === 19479 || d.anidbId === '19479', String(d.anidbId));
  d = await M.englishDubForTmdb('123542', { title: 'Link Click', season: 3 });
  check('Link Click S3: episodes dubbed on EITHER source count (2 of 4)', d.available === true && d.englishDubReleases === 2 && d.totalReleases === 4 && d.sample === 'Aniwave + Anime Village', JSON.stringify(d));
  d = await M.englishDubForTmdb('5', { title: 'Sub Only', season: 1 });
  check('no dub on either source -> available: false', d.available === false && d.englishDubReleases === 0, JSON.stringify(d));

  console.log('\n[2] Unknown is never "no dub"');
  d = await M.englishDubForTmdb('6', { title: 'Down', season: 1 });
  check('Aniwave "no" + Anime Village unreachable -> unknown', d.available === null && d.reason === 'unreachable', JSON.stringify(d));

  d = await M.englishDubForTmdb('9', { title: 'Empty AV', season: 1 });
  check('an EMPTY Anime Village answer (site flaking) is unknown, not "no dub"', d.available === null, JSON.stringify(d));
  // Smoking Behind: "9 of 12" one pass, "none" (Anime Village flaking) the
  // next - a dub that existed does not disappear.
  flaky = { aniwave: null, animevillage: new Map(Array.from({ length: 12 }, (_, i) => [i + 1, i < 9])) };
  d = await M.englishDubForTmdb('10', { title: 'Flaky', season: 1 });
  check('first check: 9 of 12 dubbed', d.available === true && d.englishDubReleases === 9, JSON.stringify(d));
  flaky = { aniwave: null, animevillage: new Map(Array.from({ length: 12 }, (_, i) => [i + 1, false])) };
  d = await M.englishDubForTmdb('10', { title: 'Flaky', season: 1, force: true });
  check('a later flaky check seeing none keeps "9 of 12"', d.available === true && d.englishDubReleases === 9, JSON.stringify(d));
  flaky = { aniwave: null, animevillage: new Map(Array.from({ length: 12 }, (_, i) => [i + 1, i < 11])) };
  d = await M.englishDubForTmdb('10', { title: 'Flaky', season: 1, force: true });
  check('...and a real increase is taken (11 of 12)', d.available === true && d.englishDubReleases === 11, JSON.stringify(d));

  console.log('\n[3] Inputs, caching, dedupe');
  d = await M.englishDubForTmdb('7', {});
  check('no title -> unknown (no-title)', d.available === null && d.reason === 'no-title', JSON.stringify(d));
  const before = calls;
  await M.englishDubForTmdb('296286', { title: 'Smoking Behind the Supermarket with You', season: 1 });
  check('a second ask is cached', calls === before);
  check('peek answers per season', M.peek('296286', 1) && M.peek('296286', 1).available === true && M.peek('296286', 2) === null);
  const c0 = calls;
  await Promise.all([M.ensure('8', { title: 'Sub Only', season: 2 }), M.ensure('8', { title: 'Sub Only', season: 2 })]);
  check('ensure() dedupes concurrent asks', calls === c0 + 1, `calls=${calls - c0}`);

  console.log('\n[4] Mapping fetched once');
  check('mapping fetched once from the current address', mapHits === 1, `hits=${mapHits}`);

  srv.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  process.exit(1);
});
