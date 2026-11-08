'use strict';

// Below-floor copies (the 720p fallback) are checked weekly; once Vidsrc has
// the floor, the episode is queued again at it. Anime is never recorded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const up = require(path.join(__dirname, '..', 'src', 'main', 'upgrades.js'));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrades-'));
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrades-lib-'));
  const f1 = path.join(lib, 'House S01E03.mp4');
  const f2 = path.join(lib, 'House S01E04.mp4');
  fs.writeFileSync(f1, 'x');
  fs.writeFileSync(f2, 'x');
  let has = new Map([['3', false], ['4', true]]);
  const queued = [];
  up._setForTests({ dir, check: async (e) => has.get(String(e.episode)), queue: async (e) => { queued.push(e); } });
  const item = (ep) => ({ label: `House S1E${ep}`, series: 'House', season: 1, episode: ep, tmdb: '1408', url: `https://vidsrc.sh/embed/tv/1408-1-${ep}`, _floorFallback: 1080, minHeight: 720, library: { name: 'TV' } });
  const t0 = Date.parse('2026-11-08T12:00:00Z');

  console.log('\n[1] Recorded');
  check('a 720p fallback copy is recorded', up.add(item(3), f1, t0) && up.add(item(4), f2, t0) && up.list().length === 2);
  check('anime never', up.add(Object.assign(item(5), { anime: true }), path.join(lib, 'x.mp4'), t0) === false);
  check('a copy at the floor never', up.add(Object.assign(item(6), { _floorFallback: 0 }), path.join(lib, 'y.mp4'), t0) === false);

  console.log('\n[2] Weekly');
  let r = await up.runDue({ now: t0 + 3600 * 1000 });
  check('not checked again within the week', r.checked === 0 && queued.length === 0, JSON.stringify(r));
  r = await up.runDue({ now: t0 + up.RECHECK_MS + 1 });
  check('after a week: both checked', r.checked === 2, JSON.stringify(r));
  check('only the one with a 1080p copy now is queued, at 1080p', queued.length === 1 && queued[0].episode === 4 && queued[0].floor === 1080, JSON.stringify(queued));
  r = await up.runDue({ now: t0 + up.RECHECK_MS + 2 });
  check('the one still at 720p waits another week', r.checked === 0, JSON.stringify(r));

  console.log('\n[3] Done / gone');
  up.remove(f2);
  check('replaced by a copy at the floor: no longer checked', up.list().length === 1 && up.list()[0].episode === 3);
  fs.unlinkSync(f1);
  await up.runDue({ now: t0 + 3 * up.RECHECK_MS });
  check('file deleted by hand: dropped', up.list().length === 0);

  console.log('\n[4] Vidsrc paused');
  fs.writeFileSync(f1, 'x');
  up.add(item(3), f1, t0);
  has = new Map([['3', null]]);
  r = await up.runDue({ now: t0 + up.RECHECK_MS + 1 });
  check('no answer: not marked as checked (tried again next run)', up.list()[0].lastCheck === t0, JSON.stringify(up.list()[0]));

  console.log('\n[5] Library scan (TV / movies)');
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrades2-'));
    const tvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlib-'));
    const mvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvlib-'));
    const put = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
    const low1 = put(path.join(tvRoot, 'House', 'Season 1', 'House - S01E01 - Pilot.mkv'));
    const hi1 = put(path.join(tvRoot, 'House', 'Season 1', 'House - S01E02 - Paternity.mkv'));
    const odd = put(path.join(tvRoot, 'House', 'Season 1', 'bonus clip.mkv'));
    const mlow = put(path.join(mvRoot, 'The Hunger Games Mockingjay - Part 2 (2015)', 'The_Hunger_Games_Mockingjay_Part_2_(2015).mkv'));
    const dims = new Map([[low1, { width: 1280, height: 720 }], [hi1, { width: 1920, height: 1080 }], [odd, { width: 640, height: 360 }], [mlow, { width: 960, height: 532 }]]);
    let probes = 0;
    up._setForTests({ dir: dir2, probeFn: async (f) => { probes += 1; return dims.get(f) || null; }, tmdbFn: async (kind, name) => (kind === 'movie' ? '131634' : name === 'House' ? '1408' : '') });
    up.scanLibraries([{ name: 'TV', kind: 'tv', locations: [tvRoot] }, { name: 'Movies', kind: 'movie', locations: [mvRoot] }], { floor: 1080 });
    for (let i = 0; i < 100 && up.status().running; i++) await new Promise((r) => setTimeout(r, 20));
    const L = up.list();
    const by = (f) => L.find((x) => x.path === f);
    check('the 720p episode is found, matched, with its TMDB id and Vidsrc URL', by(low1) && !by(low1).problem && by(low1).tmdb === '1408' && by(low1).url === 'https://vidsrc.sh/embed/tv/1408-1-1', JSON.stringify(by(low1)));
    check('the 1080p episode is not listed', !by(hi1));
    check('the 532p film is found and matched', by(mlow) && !by(mlow).problem && by(mlow).kind === 'movie' && by(mlow).url === 'https://vidsrc.sh/embed/movie/131634', JSON.stringify(by(mlow)));
    check('a file with no episode number is listed but never upgraded (not matched)', by(odd) && /not matched/.test(by(odd).problem), JSON.stringify(by(odd)));
    check('scan status says so', up.status().found === 2 && up.status().unmatched === 1 && up.status().total === 4, JSON.stringify(up.status()));
    up.ignore(low1);
    const before = probes;
    up.scanLibraries([{ name: 'TV', kind: 'tv', locations: [tvRoot] }], { floor: 1080 });
    for (let i = 0; i < 100 && up.status().running; i++) await new Promise((r) => setTimeout(r, 20));
    check('"Stop tracking" keeps it out of later scans', !up.list().some((x) => x.path === low1));
    check('unchanged files are not measured again', probes === before, `${probes - before} new probes`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  process.exit(1);
});
