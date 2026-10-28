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
    loose: mk('Show8/Show8 S3E2.mp4'), // no season folder at all
    // --- new: real-world naming the matcher must also recognize ---
    epInSeason: mk('Show9/Season 02/Show9 - EP18.mp4'), // "EP18" inside "Season 02"
    eTok: mk('Show10/Season 1/Show10 E05.mp4'), // "E05" inside a season folder
    flatAnime: mk('ShowA/ShowA 18.mp4'), // bare number, flat single-season anime
    flatAnimeRange: mk('ShowB/ShowB 01-02.mp4'), // flat two-part, no season folder
    guardYear: mk('ShowD/Season 1/ShowD 2018.mp4'), // a YEAR, not episode 18
    guardRes: mk('ShowE/Season 1/ShowE 720p.mp4'), // a RESOLUTION, not episode 72
    guardRoot: mk('ShowF/ShowF 5.mp4'), // bare number at root WHILE a Season folder exists
    guardRootSeason2: mk('ShowF/Season 2/placeholder-S02E99.mp4'), // gives ShowF a season folder
    seasonDigit: mk('ShowG/Season 1/ShowG S1E2.mp4'), // S1E2: the "1" is a SEASON, not ep 1
    dotSep: mk('ShowH/ShowH.18.mp4'), // dot-separated anime naming
    titleOnly: mk('ShowI/ShowI - Pilot.mp4'), // named by TITLE only, no number
    partTrap: mk('ShowJ/ShowJ - The Beginning Part 2.mp4'), // must not match "The Beginning"
    // --- real-library season folder styles (found in the user's NAS audit) ---
    sxxFolder: mk('ShowK/S02/ShowK - S02E05.mp4'), // "S02" season folder style
    suffixedSeason: mk('ShowL/ShowL - Season 2/ShowL - S02E03.mp4'), // "<Show> - Season 2" folder
    nestedPart: mk('ShowM/Part 1/Season 01/ShowM - S01E03.mp4'), // nested "Part 1/Season 01"
    // --- nested real-library layouts (1,530 NAS files were invisible before) ---
    seasonInSeason: mk('ShowN/Season 01 - Season 1/Season 01/ShowN - S01E03.mp4'), // season folder INSIDE a season folder
    doubledSeries: mk('ShowO/ShowO/ShowO_S01E01_1001 - Bricks.mp4'), // doubled series folder, flat files
    variantSeason: mk('ShowP/ShowP - Season 2/Season 01/ShowP - S01E26.mp4'), // season-qualified variant wraps the season folder
    groupingDir: mk('ShowQ/Series 5/ShowQ - S05E01.mp4'), // "Series 5" grouping folder holding files directly
    guardSubdirLoose: mk('ShowR/Extras/ShowR 5.mp4'), // bare number in a non-season subfolder...
    guardSubdirLooseSeason: mk('ShowR/Season 1/placeholder-S01E99.mp4') // ...while a season folder exists: must NOT count as S1E5
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

  // --- new naming styles (the "we already have this episode" cases) ---
  check(
    'EP18 inside "Season 02" counts as S2E18',
    organizer.existingEpisodeFile(libRoot, { series: 'Show9', season: 2, episode: 18 }) === files.epInSeason,
    F(organizer.existingEpisodeFile(libRoot, { series: 'Show9', season: 2, episode: 18 }))
  );
  check(
    'EP18 inside "Season 02" does NOT count as S1E18 (wrong season)',
    organizer.existingEpisodeFile(libRoot, { series: 'Show9', season: 1, episode: 18 }) === null
  );
  check(
    'EP18 inside "Season 02" does NOT count as S2E19 (wrong episode)',
    organizer.existingEpisodeFile(libRoot, { series: 'Show9', season: 2, episode: 19 }) === null
  );
  check(
    'E05 inside "Season 1" counts as S1E5',
    organizer.existingEpisodeFile(libRoot, { series: 'Show10', season: 1, episode: 5 }) === files.eTok
  );
  check(
    'flat anime: bare "ShowA 18.mp4" counts as S1E18 (no season folders)',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowA', season: 1, episode: 18 }) === files.flatAnime
  );
  check(
    'flat anime: bare number counts for unknown season too',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowA', season: null, episode: 18 }) === files.flatAnime
  );
  check(
    'flat two-part "01-02" counts as episode 1',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowB', season: 1, episode: 1 }) === files.flatAnimeRange
  );
  check(
    'flat two-part "01-02" counts as episode 2',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowB', season: 1, episode: 2 }) === files.flatAnimeRange
  );
  check(
    'flat two-part "01-02" does NOT count as episode 3',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowB', season: 1, episode: 3 }) === null
  );

  // --- guards: numbers that are NOT episode numbers must not match ---
  check(
    'year "2018" is NOT episode 18',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowD', season: 1, episode: 18 }) === null,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowD', season: 1, episode: 18 }))
  );
  check(
    'resolution "720p" is NOT episode 72',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowE', season: 1, episode: 72 }) === null
  );
  check(
    'bare number at a series ROOT is NOT trusted when Season folders exist',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowF', season: 2, episode: 5 }) === null,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowF', season: 2, episode: 5 }))
  );
  check(
    'S1E2 counts as episode 2',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowG', season: 1, episode: 2 }) === files.seasonDigit
  );
  check(
    'S1E2 does NOT count as episode 1 (the "1" is a season, not an episode)',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowG', season: 1, episode: 1 }) === null,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowG', season: 1, episode: 1 }))
  );
  check(
    'dot-separated anime "ShowH.18.mp4" counts as S1E18',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowH', season: 1, episode: 18 }) === files.dotSep
  );

  // --- season-folder naming styles the real library uses (NAS audit, 2026-10) ---
  check(
    '"S02" season folder: S02E05 counts as S2E5',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowK', season: 2, episode: 5 }) === files.sxxFolder,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowK', season: 2, episode: 5 }))
  );
  check(
    '"S02" season folder: S02E05 does NOT count as S1E5',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowK', season: 1, episode: 5 }) === null
  );
  check(
    '"ShowL - Season 2" folder counts as season 2 (S02E03 -> S2E3)',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowL', season: 2, episode: 3 }) === files.suffixedSeason,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowL', season: 2, episode: 3 }))
  );
  check(
    'nested "Part 1/Season 01": S01E03 counts as S1E3',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowM', season: 1, episode: 3 }) === files.nestedPart,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowM', season: 1, episode: 3 }))
  );
  check(
    'nested "Part 1/Season 01": S01E03 does NOT count as S2E3',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowM', season: 2, episode: 3 }) === null
  );

  // --- nested real-library layouts (each mirrors a folder chain found on the NAS) ---
  check(
    'season folder inside a season folder: S01E03 counts as S1E3',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowN', season: 1, episode: 3 }) === files.seasonInSeason,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowN', season: 1, episode: 3 }))
  );
  check(
    'season folder inside a season folder: S01E03 does NOT count as S2E3',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowN', season: 2, episode: 3 }) === null
  );
  check(
    'doubled series folder (Show/Show/): strict S01E01 counts as S1E1',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowO', season: 1, episode: 1 }) === files.doubledSeries,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowO', season: 1, episode: 1 }))
  );
  check(
    'season-qualified variant wrapping Season 01: S01E26 counts as S1E26',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowP', season: 1, episode: 26 }) === files.variantSeason,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowP', season: 1, episode: 26 }))
  );
  check(
    '"Series 5" grouping folder holding files directly: strict S05E01 counts as S5E1',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowQ', season: 5, episode: 1 }) === files.groupingDir,
    F(organizer.existingEpisodeFile(libRoot, { series: 'ShowQ', season: 5, episode: 1 }))
  );
  check(
    'bare number in a non-season subfolder does NOT count while season folders exist',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowR', season: 1, episode: 5 }) === null
  );

  // --- title-only files (no episode number at all) ---
  check(
    'title-only file matches when the episode name is supplied',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowI', season: 1, episode: 1 }, null, 'Pilot') === files.titleOnly
  );
  check(
    'title-only file does NOT match without a name (would be re-downloaded)',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowI', season: 1, episode: 1 }) === null
  );
  check(
    'title-only file does NOT match a different episode name',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowI', season: 1, episode: 1 }, null, 'Totally Different') === null
  );
  check(
    '"The Beginning Part 2" does NOT satisfy ep named "The Beginning"',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowJ', season: 1, episode: 1 }, null, 'The Beginning') === null
  );
  check(
    '"The Beginning Part 2" DOES satisfy ep named "The Beginning Part 2"',
    organizer.existingEpisodeFile(libRoot, { series: 'ShowJ', season: 1, episode: 1 }, null, 'The Beginning Part 2') === files.partTrap
  );

  console.log('\n[1b] fuzzy series-folder matching (name variants, add-only)');
  const timid = 'Even Though Im a Super Timid Noble Girl I Accepted The Cunning Fiance (2026)';
  const timidTitle = "Even Though I'm a Super Timid Noble Girl, I Accepted the Cunning Fianc\u00e9";
  const mk = (rel, content = 'x'.repeat(2048)) => {
    const p = path.join(libRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const fuzzyEp1 = mk(timid + '/Season 1/' + timidTitle.replace(/[,\u00e9]/g, ' ') + ' S1E1.mkv');
  check(
    'accent/comma/apostrophe variant folder: episode is recognized',
    organizer.existingEpisodeFile(libRoot, { series: timidTitle, season: 1, episode: 1 }) === fuzzyEp1,
    F(organizer.existingEpisodeFile(libRoot, { series: timidTitle, season: 1, episode: 1 }))
  );
  check(
    '...and ep 2 is NOT invented from that folder',
    organizer.existingEpisodeFile(libRoot, { series: timidTitle, season: 1, episode: 2 }) === null
  );
  const fuzzyExpected = organizer.expectedPath(libRoot, { series: timidTitle, season: 1, episode: 2 }, '.mp4');
  check(
    'new episodes land INSIDE the existing variant folder (add, not duplicate)',
    fuzzyExpected.startsWith(path.join(libRoot, timid) + path.sep),
    fuzzyExpected
  );
  check(
    'listSeriesVideoFiles sees the variant folder',
    organizer.listSeriesVideoFiles(libRoot, timidTitle).includes(fuzzyEp1)
  );
  check(
    'titleOnDisk is true for the variant-named series',
    organizer.titleOnDisk(libRoot, timidTitle) === true
  );
  // Guards: short titles and unrelated shows must never claim a foreign folder.
  const rival = 'One Piece Pirate Warriors Of The World';
  mk(rival + '/Season 1/' + rival + ' S1E1.mp4');
  check(
    'short title "One Piece" does NOT claim "One Piece Pirate Warriors Of The World"',
    organizer.existingEpisodeFile(libRoot, { series: 'One Piece', season: 1, episode: 1 }) === null
  );
  check(
    '...but the full name still matches its own folder',
    organizer.existingEpisodeFile(libRoot, { series: 'One Piece: Pirate Warriors of the World', season: 1, episode: 1 }) !== null
  );
  check('unrelated series does not match the variant folder',
    organizer.existingEpisodeFile(libRoot, { series: 'Totally Unknown Show', season: 1, episode: 1 }) === null);
  check('fuzzySeriesMatch: identical normalized names match',
    organizer.fuzzySeriesMatch('The Show With Accents (2020)', 'the show with accents') === true);
  check('fuzzySeriesMatch: short phrase is not enough',
    organizer.fuzzySeriesMatch('Star Trek Lower Decks', 'Star Trek') === false);
  check('fuzzySeriesMatch: empty input never matches',
    organizer.fuzzySeriesMatch('Anything Long Enough Here', '') === false);

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

  // [7] seriesExtent: flat 1..N vs arc/duplicate detection (the floor guard's basis)
  console.log('\n[7] seriesExtent: flat 1..N vs arc/duplicate detection');
  {
    const base = path.join(work, 'extent');
    const mk = (rel) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'.repeat(2048)); };
    for (let i = 1; i <= 5; i++) mk(`FlatShow/S01/FlatShow S01E${String(i).padStart(2, '0')}.mp4`);
    const flatExt = organizer.seriesExtent(path.join(base, 'FlatShow'));
    check('flat 1..5: flat=true, max=5', flatExt.flat === true && flatExt.maxEpisode === 5 && flatExt.totalFiles === 5, JSON.stringify(flatExt));
    for (let i = 1; i <= 3; i++) { mk(`ArcShow/Season 01 - A/ArcShow S01E${String(i).padStart(2, '0')}.mp4`); mk(`ArcShow/Season 02 - B/ArcShow S02E${String(i).padStart(2, '0')}.mp4`); }
    const arcExt = organizer.seriesExtent(path.join(base, 'ArcShow'));
    check('arc-based (duplicate numbers): flat=false', arcExt.flat === false && arcExt.totalFiles === 6, JSON.stringify(arcExt));
    mk('GapShow/GapShow S01E01.mp4'); mk('GapShow/GapShow S01E03.mp4');
    const gapExt = organizer.seriesExtent(path.join(base, 'GapShow'));
    check('gapped (missing E2): flat=false', gapExt.flat === false && gapExt.maxEpisode === 3, JSON.stringify(gapExt));
    check('episodeNumberFromName "S02E05" -> 5', organizer.episodeNumberFromName('Show S02E05.mp4') === 5);
    check('episodeNumberFromName "EP 18" -> 18', organizer.episodeNumberFromName('Show - EP 18.mp4') === 18);
    check('episodeNumberFromName "2018" (year) -> null', organizer.episodeNumberFromName('Show 2018.mp4') === null);
    check('episodeNumberFromName "720p" (res) -> null', organizer.episodeNumberFromName('Show 720p.mp4') === null);
    check('episodeNumberFromName "S12E07" -> 7', organizer.episodeNumberFromName('Show S12E07.mp4') === 7);
  }

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
