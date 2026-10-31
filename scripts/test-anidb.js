'use strict';

// AniDB English-dub availability tests (scripts/test-anidb.js).
//
// Both upstreams are mocked on 127.0.0.1:
//   - the Anime-Lists TMDB->AniDB mapping (JSON)
//   - the AniDB release API (XML)
// so the test proves the PARSING + DECISION + CACHING without touching the
// real AniDB (which is port-blocked on many networks, including CI).

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
Module._load = function (request, parent, isMain) {
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

// ---- [1] release XML parsing ------------------------------------------------
console.log('\n[1] parseReleases');
{
  const xml = `<anidb>
 <release id="1">
  <name>Smoking Behind the Supermarket with You S01E03 - 03 [1080p] [English]</name>
  <audio>English</audio>
  <date>2026-07-24</date>
 </release>
 <release id="2">
  <name>Smoking Behind the Supermarket with You S01E03 - 03 [1080p] [Japanese]</name>
  <audio>Japanese</audio>
  <date>2026-07-23</date>
 </release>
</anidb>`;
  const rels = M.parseReleases(xml);
  check('two releases parsed', rels.length === 2, String(rels.length));
  check('audio captured', rels[0].audio === 'English' && rels[1].audio === 'Japanese', JSON.stringify(rels));
  check('name + date captured', /English/.test(rels[0].name) && rels[0].date === '2026-07-24', JSON.stringify(rels[0]));
  check('empty input -> []', M.parseReleases('').length === 0);
}

// ---- [2] english dub present -> available: true -----------------------------
// ---- [3] english dub absent -> available: false -----------------------------
// ---- [4] tmdb id not in the mapping -> available: null (not-on-anidb) -------
// ---- [5] AniDB unreachable -> available: null (network), failure cached -----
// ---- [6] ensure() dedupes concurrent fetches --------------------------------
async function main() {
console.log('\n[2]-[6] mocked upstreams');
{
  const state = { mappingHits: 0, anidbHits: 0 };
  const MAPPING = [
    { anidb_id: 19479, themoviedb_id: { tv: 296286 } }, // Smoking Behind (has EN dub)
    { anidb_id: 1111, themoviedb_id: { tv: 424242 } } // no English dub
  ];
  const XML_WITH_EN = `<anidb>
 <release id="1"><name>Foo S01E03 [1080p] [Eng Sub]</name><audio>English, Japanese</audio><date>2026-01-01</date></release>
 <release id="2"><name>Foo S01E03 [1080p]</name><audio>Japanese</audio><date>2026-01-01</date></release>
</anidb>`;
  const XML_NO_EN = `<anidb>
 <release id="1"><name>Bar S01E01 [1080p]</name><audio>Japanese</audio><date>2026-01-01</date></release>
 <release id="2"><name>Bar S01E02 [1080p]</name><audio>Japanese</audio><date>2026-01-02</date></release>
</anidb>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/mapping.json') {
      state.mappingHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(MAPPING));
    }
    if (u.pathname === '/3/') {
      state.anidbHits += 1;
      const anime = u.searchParams.get('anime');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      // anime= is the ANIDB id (1111 = the no-English-dub show in MAPPING)
      return res.end(anime === '1111' ? XML_NO_EN : XML_WITH_EN);
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  M._clearCaches();
  M._setMappingUrlsForTests([`${base}/mapping.json`]);
  M._setAnidbBasesForTests([{ lib: http, host: '127.0.0.1', port, scheme: 'http:' }]);

  // [2] English dub present
  const ok = await M.englishDubForTmdb('296286');
  check('available: true when an English-audio release exists', ok.available === true, JSON.stringify(ok));
  check('anidb id resolved from the mapping', ok.anidbId === 19479, String(ok.anidbId));
  check('english release counted (1 of 2)', ok.englishDubReleases === 1 && ok.totalReleases === 2, JSON.stringify(ok));
  check('sample name captured', /Eng/.test(ok.sample), ok.sample);

  // [3] No English dub
  const no = await M.englishDubForTmdb('424242');
  check('available: false when no release has English audio', no.available === false, JSON.stringify(no));
  check('total releases still reported', no.totalReleases === 2, String(no.totalReleases));

  // [4] Not in the mapping
  const nf = await M.englishDubForTmdb('999999');
  check('available: null + reason not-on-anidb', nf.available === null && nf.reason === 'not-on-anidb', JSON.stringify(nf));

  // [5] AniDB unreachable (dead port) -> network, and the FAILURE is cached
  M._clearCaches();
  M._setAnidbBasesForTests([{ lib: http, host: '127.0.0.1', port: 1, scheme: 'http:' }]);
  const net = await M.englishDubForTmdb('296286');
  check('unavailable -> available: null, reason network', net.available === null && net.reason === 'network', JSON.stringify(net));
  const hitsAfterFirst = state.anidbHits; // (unchanged: dead port never hit the server)
  const net2 = await M.englishDubForTmdb('296286');
  check('failure result is cached (same answer, no re-throw)', net2.available === null && net2.reason === 'network', JSON.stringify(net2));
  check('dead upstream never hit the real server', state.anidbHits === hitsAfterFirst, `hits=${state.anidbHits}`);

  // [6] ensure() dedupes: two concurrent calls -> ONE mapping fetch total for a fresh id
  M._clearCaches();
  M._setAnidbBasesForTests([{ lib: http, host: '127.0.0.1', port, scheme: 'http:' }]);
  const before = state.mappingHits;
  const [a, b] = await Promise.all([M.ensure('296286'), M.ensure('296286')]);
  check('ensure() resolves for both callers', a.available === true && b.available === true);
  check('concurrent ensure() fetched the mapping once', state.mappingHits - before <= 1, `delta=${state.mappingHits - before}`);

  // peek() is a pure cache read
  check('peek() returns the cached result', M.peek('296286') && M.peek('296286').available === true);
  check('peek() is null for an unknown id', M.peek('31337') === null);

  srv.close();
}

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
