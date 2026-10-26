'use strict';

// Watcher (daily "download the latest episode once it releases") tests.
//
// Runs under plain Node with a fake `electron` module. The TMDB answers, the
// anime URL-number mapper, and the queue entry point are mocked; the real
// organizer (on-disk recognition), schedule store, and watcher logic run, so
// these tests pin the actual daily-check behavior:
//   1. only AIRED + missing episodes are queued (future ones are never);
//   2. episodes already on disk (staging or any library drive) are never
//      re-queued;
//   3. new season: caught up on S1 -> S2's aired-missing episodes are queued
//      and the watch advances to S2 (ids carried over);
//   4. anime: authoritative numbers in the FILE, mapped TMDB numbers in the
//      URL;
//   5. movie watch: on disk -> nothing; missing -> exactly ONE movie queued;
//   6. no TMDB id -> the legacy source-detection path is used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-watcher-'));

// ---- electron shim (must be in place before any app module loads) ----------
const shim = {
  app: {
    getPath: () => DATA_DIR,
    on: () => {},
    once: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    setLoginItemSettings: () => {},
    getName: () => 'webvideodownloader'
  },
  BrowserWindow: class {
    constructor() {
      throw new Error('BrowserWindow is not available in the test (expected fail-fast)');
    }
  },
  session: {
    fromPartition: () => ({
      setUserAgent() {},
      setPermissionRequestHandler() {},
      webRequest: { onBeforeSendHeaders() {} },
      clearCache: () => Promise.resolve()
    })
  },
  ipcMain: { handle() {}, on() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  nativeTheme: { on() {} },
  Menu: { setApplicationMenu() {} },
  shell: { openExternal() {} },
  clipboard: { readText: () => '', writeText() {} },
  globalShortcut: { on() {}, register() {}, unregister() {} }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return shim;
  return origLoad.apply(this, arguments);
};

const M = (p) => require(path.join(REPO, 'src/main', p));

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

const past = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const future = (daysAhead) => new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
const eps = (pairs) => pairs.map(([episode, airDate, name]) => ({ episode, airDate, name: name || `Ep ${episode}`, runtime: 2000 }));

async function main() {
  const organizer = M('organizer');
  const urltemplate = M('urltemplate');
  const bulk = M('bulk');
  const tmdb = M('tmdb');
  const animelayout = M('anime-layout');
  const schedule = M('schedule');
  const pending = M('pending');
  const manager = M('queue');
  const watcher = M('watcher');

  const libRoot = path.join(DATA_DIR, 'library');
  const staging = path.join(DATA_DIR, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const mkEp = (rel) => {
    const p = path.join(libRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(2048));
    return p;
  };

  // ---- mocks ----------------------------------------------------------------
  const queueCalls = [];
  const legacyCalls = [];
  bulk.queueOne = async (entry) => {
    queueCalls.push(entry);
    return { queued: 1, skipped: 0 };
  };
  bulk.startBatch = async (entries, outputRoot, onLog, opts) => {
    legacyCalls.push({ entries, outputRoot, opts });
    return { queued: 0, skipped: 0 };
  };
  // Next-season probe for the legacy path: "season not out yet".
  bulk.detectEpisodes = async () => ({ list: [], max: 0, aired: 0, total: 0 });
  // "Fast Show" (tmdb 999): S1 = 12 aired eps, S2 = 10 eps (4 aired).
  // "Future Show" (tmdb 111): S1 fully aired+on disk, S2 = 10 eps (5 aired).
  // "Anime Show" (tmdb 777): 3 aired eps, URL numbers are offset by 100.
  // "Recover Show" (tmdb 333): old-style entry, id only in the source URL.
  tmdb.tmdbInfo = async (id) => {
    if (id === '999') return { tmdb: '999', title: 'Fast Show', seasons: [{ season: 1, episodes: 12 }, { season: 2, episodes: 10 }] };
    if (id === '111') return { tmdb: '111', title: 'Future Show', seasons: [{ season: 1, episodes: 8 }, { season: 2, episodes: 10 }] };
    if (id === '777') return { tmdb: '777', title: 'Anime Show', seasons: [{ season: 1, episodes: 3 }] };
    if (id === '333') return { tmdb: '333', title: 'Recover Show', seasons: [{ season: 1, episodes: 4 }] };
    return null;
  };
  tmdb.tmdbSeason = async (id, season) => {
    if (id === '999' && season === 1) {
      return { tmdb: '999', season: 1, episodes: eps([[1, past(60)], [2, past(55)], [3, past(50)], [4, past(45)], [5, past(40)], [6, past(35)], [7, past(30)], [8, past(25)], [9, past(10)], [10, past(5)], [11, past(2)], [12, past(1)]]) };
    }
    if (id === '999' && season === 2) return { tmdb: '999', season: 2, episodes: [] }; // not out
    if (id === '111' && season === 1) {
      return { tmdb: '111', season: 1, episodes: eps([[1, past(90)], [2, past(80)], [3, past(70)], [4, past(60)], [5, past(50)], [6, past(40)], [7, past(30)], [8, past(20)]]) };
    }
    if (id === '111' && season === 2) {
      return {
        tmdb: '111',
        season: 2,
        episodes: eps([
          [1, past(14)], [2, past(7)], [3, past(3)], [4, past(1)], [5, past(1)],
          [6, future(4)], [7, future(11)], [8, future(18)], [9, future(25)], [10, future(32)]
        ])
      };
    }
    if (id === '777' && season === 1) {
      return { tmdb: '777', season: 1, episodes: eps([[1, past(20)], [2, past(13)], [3, past(6)]]) };
    }
    if (id === '333' && season === 1) {
      return { tmdb: '333', season: 1, episodes: eps([[1, past(30)], [2, past(20)], [3, past(10)], [4, past(2)]]) };
    }
    return null;
  };
  animelayout.urlMapFor = async (id) => {
    if (id === '777') return (season, episode) => ({ season, episode: episode + 100, mapped: true });
    return null;
  };
  watcher.onLog = () => {};

  const library = { name: 'TV', locations: [libRoot] };
  const vid = (tmdb, season, episode) => `https://vidsrc.sh/embed/tv/${tmdb}-${season}-${episode}`;

  // ---- 1. TV: only aired + missing are queued --------------------------------
  console.log('\n[1] TV series: aired episodes, on-disk dedupe, future skipped');
  // 8 of the 12 aired S1 episodes are on disk (Jellyfin-style layout).
  for (let e = 1; e <= 8; e++) mkEp(`Fast Show/Season 1/Fast Show S01E${String(e).padStart(2, '0')}.mp4`);
  schedule.add({
    series: 'Fast Show', season: 1, mode: 'dub',
    template: urltemplate.toTemplate(vid('999', 1, 5)).template,
    baseUrl: vid('999', 1, 5),
    outputRoot: staging, library, minHeight: 1080, anime: false,
    tmdb: '999', imdb: 'tt1', movie: false
  });
  queueCalls.length = 0;
  await watcher.checkSchedules();
  const fastCalls = queueCalls.filter((c) => c.series === 'Fast Show');
  check('queued exactly the 4 missing aired episodes', fastCalls.length === 4, JSON.stringify(fastCalls.map((c) => [c.season, c.episode])));
  check('...episodes 9..12, season 1', JSON.stringify(fastCalls.map((c) => c.episode).sort((a, b) => a - b)) === JSON.stringify([9, 10, 11, 12]));
  check('no on-disk episode was re-queued', fastCalls.every((c) => c.episode >= 9));
  check('URLs carry TMDB numbers for the right season/episode', fastCalls.every((c) => c.url === vid('999', 1, c.episode)), JSON.stringify(fastCalls.map((c) => c.url)));
  check('library + quality floor travel with the queued episodes', fastCalls.every((c) => c.library === library && c.minHeight === 1080));
  check('episode titles travel (hand-named file matching)', fastCalls.every((c) => typeof c.episodeName === 'string' && c.episodeName.length > 0));

  // ---- 2. New season: caught up -> S2 queued + watch advances -----------------
  console.log('\n[2] New season detection + watch advancement');
  for (let e = 1; e <= 8; e++) mkEp(`Future Show/Season 1/Future Show S1E${e}.mp4`);
  // 2 of the 5 aired S2 episodes already on disk.
  mkEp('Future Show/Season 2/Future Show S2E1.mp4');
  mkEp('Future Show/Season 2/Future Show S2E2.mp4');
  schedule.add({
    series: 'Future Show', season: 1, mode: 'dub',
    template: urltemplate.toTemplate(vid('111', 1, 3)).template,
    baseUrl: vid('111', 1, 3),
    outputRoot: staging, library, minHeight: 1080, anime: false,
    tmdb: '111', imdb: 'tt2', movie: false
  });
  queueCalls.length = 0;
  const r2 = await watcher.checkSchedules();
  const futureCalls = queueCalls.filter((c) => c.series === 'Future Show');
  check('S2 detected: its aired-but-missing episodes queued (3..5)', JSON.stringify(futureCalls.map((c) => c.episode).sort((a, b) => a - b)) === JSON.stringify([3, 4, 5]), JSON.stringify(futureCalls.map((c) => c.episode)));
  check('...in season 2, with S2 URLs', futureCalls.every((c) => c.season === 2 && c.url === vid('111', 2, c.episode)));
  check('future S2 episodes (6..10) were NOT queued', futureCalls.every((c) => c.episode <= 5));
  check('on-disk S2 episodes (1..2) were NOT re-queued', futureCalls.every((c) => c.episode >= 3));
  check('new season count reported', r2.newSeasons >= 1, String(r2.newSeasons));
  const bumped = schedule.list().find((x) => x.series === 'Future Show');
  check('watch advanced to season 2', bumped && bumped.season === 2, String(bumped && bumped.season));
  check('TMDB id + library survived the season bump', bumped && bumped.tmdb === '111' && bumped.library === library);

  // ---- 3. Anime: authoritative file numbers, TMDB URL numbers ----------------
  console.log('\n[3] Anime: Aniwave-style numbering, mapped source URLs');
  mkEp('Anime Show/Season 1/Anime Show S1E1.mp4');
  schedule.add({
    series: 'Anime Show', season: 1, mode: 'dub',
    template: urltemplate.toTemplate(vid('777', 1, 1)).template,
    baseUrl: vid('777', 1, 1),
    outputRoot: staging, library, minHeight: 0, anime: true,
    tmdb: '777', imdb: '', movie: false
  });
  queueCalls.length = 0;
  await watcher.checkSchedules();
  const animeCalls = queueCalls.filter((c) => c.series === 'Anime Show');
  check('ep 1 recognized on disk (authoritative number)', animeCalls.every((c) => c.episode !== 1));
  check('eps 2 and 3 queued with AUTHORITATIVE numbers (file naming)', JSON.stringify(animeCalls.map((c) => c.episode).sort((a, b) => a - b)) === JSON.stringify([2, 3]), JSON.stringify(animeCalls.map((c) => c.episode)));
  check('URLs use the MAPPED TMDB numbers (ep 2 -> 102)', animeCalls.every((c) => c.url === vid('777', 1, c.episode + 100)), JSON.stringify(animeCalls.map((c) => c.url)));
  check('anime flag travels to the queue (source floor off)', animeCalls.every((c) => c.anime === true && c.minHeight === 0));

  // ---- 4. Movie watch: presence check, single re-queue -----------------------
  console.log('\n[4] Movie watch: on disk -> nothing; missing -> one movie');
  mkEp('Movie Show/Movie Show.1080p.10bit.mp4');
  schedule.add({
    series: 'Movie Show', season: null, mode: 'dub',
    template: 'https://vidsrc.sh/embed/movie/550',
    baseUrl: 'https://vidsrc.sh/embed/movie/550',
    outputRoot: staging, library, minHeight: 1080, anime: false,
    tmdb: '550', imdb: '', movie: true
  });
  queueCalls.length = 0;
  await watcher.checkSchedules();
  check('movie already on disk: nothing queued', queueCalls.filter((c) => c.series === 'Movie Show').length === 0, JSON.stringify(queueCalls.map((c) => c.series)));
  const movieFile = path.join(libRoot, 'Movie Show/Movie Show.1080p.10bit.mp4');
  fs.rmSync(path.dirname(movieFile), { recursive: true, force: true });
  await watcher.checkSchedules();
  const movieCalls = queueCalls.filter((c) => c.series === 'Movie Show');
  check('missing movie re-queued exactly ONCE', movieCalls.length === 1, String(movieCalls.length));
  check('...as a movie (no season, no episode)', movieCalls.length === 1 && movieCalls[0].season === null && movieCalls[0].episode === null);

  // ---- 5. Legacy fallback without a TMDB id ----------------------------------
  console.log('\n[5] No TMDB id: legacy source-detection path');
  schedule.add({
    series: 'Legacy Show', season: 1, mode: 'dub',
    template: 'https://catalog.example/series/legacy/season-{season}/episode-{episode}',
    baseUrl: 'https://catalog.example/series/legacy/season-1/episode-3',
    outputRoot: staging, library, minHeight: 1080, anime: false,
    tmdb: '', imdb: '', movie: false
  });
  legacyCalls.length = 0;
  queueCalls.length = 0;
  await watcher.checkSchedules();
  check('legacy path used (startBatch with the schedule entry)', legacyCalls.length === 1, String(legacyCalls.length));
  check('no TMDB-based queueing for it', queueCalls.filter((c) => c.series === 'Legacy Show').length === 0);
  check('legacy keeps add-only opts (stopRunOnFail off, library kept)', legacyCalls.length === 1 && legacyCalls[0].opts && legacyCalls[0].opts.stopRunOnFail === false && legacyCalls[0].opts.library === library);

  // ---- 6. Backfill: TMDB id recovered from the source URL ----------------------
  console.log('\n[6] Old entries: TMDB id recovered from the source URL');
  mkEp('Recover Show/Season 1/Recover Show S1E01.mp4');
  mkEp('Recover Show/Season 1/Recover Show S1E02.mp4');
  schedule.add({
    series: 'Recover Show', season: 1, mode: 'dub',
    template: null,
    baseUrl: 'https://vidsrc.sh/embed/tv/333-1-4',
    outputRoot: staging, library, minHeight: 1080, anime: false,
    tmdb: '', imdb: '', movie: false
  });
  queueCalls.length = 0;
  legacyCalls.length = 0;
  await watcher.checkSchedules();
  const recoverCalls = queueCalls.filter((c) => c.series === 'Recover Show');
  const recovered = schedule.list().find((x) => x.series === 'Recover Show');
  check('tmdb id recovered from the vidsrc URL and stored', recovered && recovered.tmdb === '333', String(recovered && recovered.tmdb));
  check('TMDB-aware path ran (not the legacy guess)', recoverCalls.length === 2 && legacyCalls.filter((l) => l.entries[0].series === 'Recover Show').length === 0, JSON.stringify(recoverCalls.map((c) => c.episode)));
  check('...exactly the aired-but-missing eps 3 and 4', JSON.stringify(recoverCalls.map((c) => c.episode).sort((a, b) => a - b)) === JSON.stringify([3, 4]), JSON.stringify(recoverCalls.map((c) => c.episode)));

  // ---- 7. Pending dubs: library-aware, no re-download --------------------------
  console.log('\n[7] Waiting-for-dub list: on-disk in the library clears it');
  const managerAdds = [];
  manager.add = (rec) => { managerAdds.push(rec); return true; };
  const pendingTemplate = urltemplate.toTemplate(vid('444', 1, 2)).template;
  pending.add({
    label: 'Pending Show S1E7', series: 'Pending Show', season: 1, episode: 7,
    outputRoot: staging, template: pendingTemplate, baseUrl: vid('444', 1, 2),
    mode: 'dub', library, minHeight: 1080
  });
  mkEp('Pending Show/Season 1/Pending Show S1E07.mp4'); // landed out-of-band
  watcher.checkNow();
  check('episode already in the library: pending entry cleared', pending.list().length === 0, JSON.stringify(pending.list().map((p) => p.episode)));
  check('...and NOT re-queued', managerAdds.every((m) => m.series !== 'Pending Show'));
  pending.add({
    label: 'Pending Show S1E8', series: 'Pending Show', season: 1, episode: 8,
    outputRoot: staging, template: pendingTemplate, baseUrl: vid('444', 1, 2),
    mode: 'dub', library, minHeight: 1080
  });
  watcher.checkNow();
  check('missing pending episode is (re)queued for the dub', managerAdds.some((m) => m.series === 'Pending Show' && m.episode === 8));
  check('...and stays on the list until it downloads', pending.list().some((p) => p.episode === 8));

  // ---- summary ----------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(1);
});
