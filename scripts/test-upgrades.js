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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  process.exit(1);
});
