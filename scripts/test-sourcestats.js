'use strict';

// Fallback sites that never produce a download are skipped (TV/movies),
// cold ones are asked last, a skipped site is re-checked once a day, and
// any hit brings it back. Kept on disk.

const fs = require('fs');
const os = require('os');
const path = require('path');

const st = require(path.join(__dirname, '..', 'src', 'main', 'sourcestats.js'));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srcstats-'));
  st._setDirForTests(dir);
  const t0 = Date.parse('2026-11-07T12:00:00Z');

  console.log('\n[1] Misses in a row');
  for (let i = 0; i < st.SKIP_STREAK - 1; i++) st.record('solarmovie', 'tv', false, t0 + i);
  check(`${st.SKIP_STREAK - 1} misses: still asked`, st.skip('solarmovie', 'tv', t0 + 100) === '');
  st.record('solarmovie', 'tv', false, t0 + 50);
  check(`${st.SKIP_STREAK} misses, never a hit: left out`, /never one/.test(st.skip('solarmovie', 'tv', t0 + 100)), st.skip('solarmovie', 'tv', t0 + 100));
  check('per kind: the same site for movies is still asked', st.skip('solarmovie', 'movie', t0 + 100) === '');
  check('re-checked once a day', st.skip('solarmovie', 'tv', t0 + 50 + st.PROBE_MS) === '');

  console.log('\n[2] A hit brings it back');
  st.record('solarmovie', 'tv', true, t0 + 200);
  check('asked again after a hit', st.skip('solarmovie', 'tv', t0 + 300) === '');
  for (let i = 0; i < st.SKIP_STREAK; i++) st.record('nontongo', 'tv', true, t0);
  for (let i = 0; i < st.SKIP_STREAK + 2; i++) st.record('nontongo', 'tv', false, t0 + 10 + i);
  check('a site with a hit this week is never left out, even after misses', st.skip('nontongo', 'tv', t0 + 1000) === '');

  console.log('\n[3] Order');
  for (let i = 0; i < st.COLD_STREAK; i++) st.record('fmovies', 'tv', false, t0 + i);
  const order = st.order([{ id: 'fmovies' }, { id: 'nontongo2' }, { id: 'solarmovie' }], 'tv').map((c) => c.id);
  check('cold sites go after the others, the rest keep their order', JSON.stringify(order) === '["nontongo2","solarmovie","fmovies"]', JSON.stringify(order));

  console.log('\n[4] Kept on disk');
  await new Promise((r) => setTimeout(r, 1300));
  check('written', fs.existsSync(path.join(dir, 'source-stats.json')));
  st._setDirForTests(dir);
  check('read back after a restart', st.summary().some((x) => x.site === 'solarmovie' && x.kind === 'tv' && x.hits === 1));

  console.log('\n[5] A TMDB embed player added as a JSON profile');
  {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'embedprof-'));
    fs.mkdirSync(path.join(ud, 'sites'));
    fs.writeFileSync(path.join(ud, 'sites', 'embed-ex.json'), JSON.stringify({
      id: 'embed-ex', name: 'Example', tmdbEmbed: { tv: 'https://player.example/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://player.example/embed/movie/{tmdb}' }
    }));
    const sites = require(path.join(__dirname, '..', 'src', 'main', 'sites'));
    sites.init(ud);
    const p = sites.profiles.find((x) => x.id === 'embed-ex');
    check('loaded as a fallback source', p && typeof p.findTitle === 'function' && p.fallbackRank === 3 && p.name === 'Example');
    check('TV: URL from the job\'s TMDB id (House = 1408)', p && (await p.findTitle({ tmdb: '1408', season: 1, episode: 9 })) === 'https://player.example/embed/tv/1408/1/9');
    check('movie URL', p && (await p.findTitle({ tmdb: '27205', season: null, episode: null })) === 'https://player.example/embed/movie/27205');
    check('never for anime', p && (await p.findTitle({ tmdb: '1', season: 1, episode: 1, anime: true })) === null);
    check('its pages resolve to it', sites.resolve('https://player.example/embed/tv/1408/1/9').id === 'embed-ex');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  process.exit(1);
});
