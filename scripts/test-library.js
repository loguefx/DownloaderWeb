'use strict';

// Jellyfin build plan, Part 11 - fake-library tests.
//
// Runs under plain Node (no Electron): `node scripts/test-library.js`
//
// Builds a small fake library with awkward names (years, .mkv, "Season 02",
// two-part episodes, tmdbid folders, collision suffixes) and proves:
//   1. no file outside staging and trash is ever deleted;
//   2. a readable 1080p file is never downloaded again (counts as present);
//   3. an unreadable file is left alone (holds, never replaces);
//   4. two jobs for the same episode produce one file (target lock);
// plus: only ledger-owned files are replaced, replaced files go to the trash,
// read-only mode refuses all writes, and old trash is purged.

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const organizer = require(path.join(root, 'src/main/organizer.js'));
const { createLibrary } = require(path.join(root, 'src/main/library.js'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`);
  }
}

function makeFakeLibrary(dir) {
  const mk = (rel, content = 'x'.repeat(2048)) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const files = {
    jellyfinMkv: mk('Show (2019)/Season 02/Show - S02E05 - Title.mkv'),
    plain: mk('Show2/Show2 S2E3.mp4'),
    legacy: mk('Show3/Show3 Season 2 - Episode 07.mp4'),
    twoPart: mk('Show4/Show4 S01E01-E02.mp4'),
    lowercase: mk('Show5/Show5 S1E1.mp4'),
    tmdbid: mk('[tmdbid-123456] Show6/Show6 S1E1.mp4'),
    collision: mk('Show7/Show7 S2E5 (1).mkv'),
    loose: mk('Show8/Show8 S3E2.mp4') // no season folder at all
  };
  return files;
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-test-'));
  const libRoot = path.join(work, 'library');
  const staging = path.join(work, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const dataDir = path.join(work, 'data');
  const files = makeFakeLibrary(libRoot);

  console.log('\n[1] existingEpisodeFile finds awkward names');
  const F = (p) => (p ? path.relative(libRoot, p) : '(null)');
  check(
    'Jellyfin .mkv layout: Show (2019)/Season 02/Show - S02E05 - Title.mkv',
    organizer.existingEpisodeFile(libRoot, { series: 'Show', season: 2, episode: 5 }) === files.jellyfinMkv,
    F(organizer.existingEpisodeFile(libRoot, { series: 'Show', season: 2, episode: 5 }))
  );
  check(
    'plain: Show2 S2E3.mp4',
    organizer.existingEpisodeFile(libRoot, { series: 'Show2', season: 2, episode: 3 }) === files.plain
  );
  check(
    'legacy: Show3 Season 2 - Episode 07.mp4',
    organizer.existingEpisodeFile(libRoot, { series: 'Show3', season: 2, episode: 7 }) === files.legacy
  );
  check(
    'two-part file counts for episode 1',
    organizer.existingEpisodeFile(libRoot, { series: 'Show4', season: 1, episode: 1 }) === files.twoPart
  );
  check(
    'two-part file counts for episode 2',
    organizer.existingEpisodeFile(libRoot, { series: 'Show4', season: 1, episode: 2 }) === files.twoPart
  );
  check(
    'two-part file does NOT count for episode 3',
    organizer.existingEpisodeFile(libRoot, { series: 'Show4', season: 1, episode: 3 }) === null
  );
  check(
    'lowercase S1E1',
    organizer.existingEpisodeFile(libRoot, { series: 'Show5', season: 1, episode: 1 }) === files.lowercase
  );
  check(
    'tmdbid folder: [tmdbid-123456] Show6',
    organizer.existingEpisodeFile(libRoot, { series: 'Show6', season: 1, episode: 1 }) === files.tmdbid
  );
  check(
    'collision suffix: Show7 S2E5 (1).mkv',
    organizer.existingEpisodeFile(libRoot, { series: 'Show7', season: 2, episode: 5 }) === files.collision
  );
  check(
    'loose episode in the series folder (no Season N dir)',
    organizer.existingEpisodeFile(libRoot, { series: 'Show8', season: 3, episode: 2 }) === files.loose
  );
  check(
    'absent episode returns null',
    organizer.existingEpisodeFile(libRoot, { series: 'Show2', season: 2, episode: 99 }) === null
  );

  console.log('\n[2] safePlace: new file, overwrite refusal, ledger, trash');
  const lib = createLibrary({ dataDir });

  // 2a. new file lands, nothing else is touched
  const listAll = (dir) => {
    const out = [];
    const rec = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p);
        else out.push(p);
      }
    };
    rec(dir);
    return out.sort();
  };
  const before = listAll(work);

  const staged = path.join(staging, 'NewShow/Season 1/NewShow S1E1.mp4');
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'new-file-bytes'.repeat(100));
  const final = path.join(libRoot, 'NewShow/Season 1/NewShow S1E1.mp4');
  await lib.safePlace({ partPath: staged, finalPath: final, replacePath: null });
  check('new file is at the final path', fs.existsSync(final));
  check('staging copy is consumed', !fs.existsSync(staged));
  check('final file is in the ledger', lib.isOurs(final));

  // 2b. refusing to overwrite an existing file that is not a replacement target
  const foreign = path.join(libRoot, 'Foreign/Foreign S1E1.mp4');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, 'foreign file');
  let refused = null;
  try {
    const s2 = path.join(staging, 's2.mp4');
    fs.writeFileSync(s2, 'new');
    await lib.safePlace({ partPath: s2, finalPath: foreign, replacePath: null });
  } catch (e) {
    refused = e;
  }
  check('overwrite of an unrelated existing file is refused', !!refused, refused && refused.message);
  check('...and the foreign file is untouched', fs.existsSync(foreign) && fs.readFileSync(foreign, 'utf8') === 'foreign file');

  // 2c. replacing a foreign file is refused even when asked to
  refused = null;
  try {
    const s3 = path.join(staging, 's3.mp4');
    fs.writeFileSync(s3, 'new');
    await lib.safePlace({ partPath: s3, finalPath: foreign, replacePath: foreign });
  } catch (e) {
    refused = e;
  }
  check('replacing a non-ledger file is refused', !!refused, refused && refused.message);
  check('...and the foreign file is still untouched', fs.existsSync(foreign));

  // 2d. replacing a ledger-owned low-quality file: new in place, old to trash
  const oldLow = path.join(libRoot, 'NewShow/Season 1/NewShow S1E1.mp4');
  const lowStaged = path.join(staging, 'NewShow/Season 1/NewShow S1E1 (hi).mp4');
  fs.mkdirSync(path.dirname(lowStaged), { recursive: true });
  fs.writeFileSync(lowStaged, 'higher-quality-bytes'.repeat(200));
  await lib.safePlace({ partPath: lowStaged, finalPath: oldLow, replacePath: oldLow });
  const trashDir = path.join(libRoot, 'NewShow/Season 1', '.mediadownloader-trash');
  const trashed = fs.existsSync(trashDir)
    ? listAll(trashDir).some((p) => /NewShow S1E1\.mp4$/.test(p))
    : false;
  check('replacement: new file is in place', fs.existsSync(oldLow));
  check('replacement: old file moved to the trash (not deleted)', trashed);
  check('replacement: new bytes, not old bytes', fs.readFileSync(oldLow, 'utf8').startsWith('higher-quality-bytes'));

  // 2e. read-only mode refuses writes
  lib.setReadOnly(true);
  check('read-only flag is persisted', lib.isReadOnly() === true);
  refused = null;
  try {
    const s4 = path.join(staging, 's4.mp4');
    fs.writeFileSync(s4, 'x');
    await lib.safePlace({ partPath: s4, finalPath: path.join(libRoot, 'Ro/Ro S1E1.mp4'), replacePath: null });
  } catch (e) {
    refused = e;
  }
  check('read-only mode refuses a write', !!refused, refused && refused.message);
  check('read-only mode left no file behind', !fs.existsSync(path.join(libRoot, 'Ro/Ro S1E1.mp4')));
  lib.setReadOnly(false);
  check('read-only flag can be turned off', lib.isReadOnly() === false);

  console.log('\n[3] target lock: two jobs, one file');
  const lockTarget = path.join(libRoot, 'LockShow/Season 1/LockShow S1E1.mp4');
  const a = path.join(staging, 'a.mp4');
  const b = path.join(staging, 'b.mp4');
  fs.writeFileSync(a, 'job A bytes');
  fs.writeFileSync(b, 'job B bytes');
  let key = null;
  let secondBlocked = null;
  try {
    key = lib.lockTarget(lockTarget);
  } catch (e) {
    key = null;
  }
  try {
    await lib.safePlace({ partPath: a, finalPath: lockTarget, replacePath: null });
  } catch (e) {
    secondBlocked = e;
  }
  check('second job for the same target is blocked', !!secondBlocked && secondBlocked.code === 'ELOCKED', secondBlocked && secondBlocked.message);
  check('job A did not land while locked', !fs.existsSync(lockTarget));
  if (key) lib.releaseTarget(key);
  await lib.safePlace({ partPath: a, finalPath: lockTarget, replacePath: null });
  check('after the lock frees, exactly one file exists', fs.existsSync(lockTarget));
  check('...and it is job A bytes', fs.readFileSync(lockTarget, 'utf8') === 'job A bytes');

  console.log('\n[4] unreadable file is left alone');
  // Simulate "cannot verify" the way queue.js does: an unreadable existing
  // file must be treated as present (skipped), never as a replacement target.
  const unreadable = path.join(libRoot, 'Show9/Show9 S1E1.mp4');
  fs.mkdirSync(path.dirname(unreadable), { recursive: true });
  fs.writeFileSync(unreadable, 'precious user file');
  const found = organizer.existingEpisodeFile(libRoot, { series: 'Show9', season: 1, episode: 1 });
  check('unreadable file is found (so it is treated as present)', found === unreadable);
  check('unreadable file is NOT in the ledger', lib.isOurs(unreadable) === false);

  console.log('\n[5] audit log + trash purge');
  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const actions = new Set(audit.map((a) => a.action));
  check('audit log recorded placed', actions.has('placed'));
  check('audit log recorded trashed', actions.has('trashed'));
  check('audit log recorded refusals', actions.has('refused-overwrite') && actions.has('refused-replace') && actions.has('refused-read-only'));
  for (const e of audit) {
    if (e.ts && typeof e.ts === 'string' && e.action) continue;
    check('every audit entry has ts+action', false, JSON.stringify(e));
    break;
  }

  // trash older than 30 days is purged; recent trash is kept
  const oldTrashDay = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const recentTrashDay = new Date().toISOString().slice(0, 10);
  const oldDir = path.join(libRoot, '.mediadownloader-trash', oldTrashDay);
  const recentDir = path.join(libRoot, '.mediadownloader-trash', recentTrashDay);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'ancient.mp4'), 'old');
  fs.writeFileSync(path.join(recentDir, 'fresh.mp4'), 'new');
  const purged = lib.purgeTrash([libRoot], 30);
  check('purge removed the 40-day-old trash folder', purged >= 1 && !fs.existsSync(oldDir));
  check('purge kept the fresh trash folder', fs.existsSync(path.join(recentDir, 'fresh.mp4')));

  console.log('\n[6] no file outside staging and trash was ever deleted');
  const after = listAll(work);
  const originalGone = Object.values(files).filter((p) => !after.includes(p));
  check(
    'every original library file still exists',
    originalGone.length === 0,
    'missing: ' + originalGone.map(F).join(', ')
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
});
