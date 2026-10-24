'use strict';
// Integration test for the "already in the library -> watch list
// automatically" rule and for the accuracy of the library-presence matching
// (1x01 style names, quality-tagged movie files, below-floor copies).
// Runs under plain Node with a fake `electron` module, like
// test-engine-smoke.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-watch-'));

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

(async () => {
  const organizer = M('organizer');
  const service = M('service');
  const schedule = M('schedule');
  const urltemplate = M('urltemplate');
  const engineconfig = M('engineconfig');

  // A real, probe-able 360p video (above the 64KB min, below the 1080 floor).
  const ffmpeg = require(path.join(REPO, 'node_modules', 'ffmpeg-static'));
  const goodMp4 = path.join(DATA_DIR, 'good.mp4');
  execFileSync(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=60', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', goodMp4],
    { stdio: 'pipe' }
  );
  const copyTo = (dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(goodMp4, dest);
  };

  // ---- 1. library presence matching ---------------------------------------
  console.log('\n[1] library presence matching');
  const lib = path.join(DATA_DIR, 'lib');
  copyTo(path.join(lib, 'South Park', 'Season 1', 'South Park S01E01.mp4'));
  copyTo(path.join(lib, 'XStyle', 'Season 1', 'XStyle 1x01.mp4'));
  copyTo(path.join(lib, 'MovieAlt', 'MovieAlt.1080p.10bit.mp4'));

  check('titleOnDisk: series with one episode', organizer.titleOnDisk(lib, 'South Park') === true);
  check('titleOnDisk: x-style named file', organizer.titleOnDisk(lib, 'XStyle') === true);
  check('titleOnDisk: quality-tagged movie', organizer.titleOnDisk(lib, 'MovieAlt') === true);
  check('titleOnDisk: unknown title is false', organizer.titleOnDisk(lib, 'Totally Unknown Show') === false);

  // ---- 2. service.libraryCheck accuracy ------------------------------------
  console.log('\n[2] service.libraryCheck');
  const lc1 = await service.libraryCheck({ series: 'South Park', season: 1, episodes: [1], locations: [lib], minHeight: 0 });
  check('standard SxxEyy -> in-library (floor 0)', lc1.episodes[0].status === 'in-library', JSON.stringify(lc1.episodes[0]));
  const lc2 = await service.libraryCheck({ series: 'South Park', season: 1, episodes: [1], locations: [lib], minHeight: 1080 });
  check('360p copy vs 1080 floor -> low-quality (replaceable)', lc2.episodes[0].status === 'low-quality', JSON.stringify(lc2.episodes[0]));
  const lc3 = await service.libraryCheck({ series: 'XStyle', season: 1, episodes: [1], locations: [lib], minHeight: 0 });
  check('1x01 style -> in-library', lc3.episodes[0].status === 'in-library', JSON.stringify(lc3.episodes[0]));
  const lc4 = await service.libraryCheck({ series: 'MovieAlt', kind: 'movie', locations: [lib], minHeight: 0 });
  check('quality-tagged movie -> in-library', lc4.episodes[0].status === 'in-library', JSON.stringify(lc4.episodes[0]));
  const lc5 = await service.libraryCheck({ series: 'Totally Unknown Show', season: 1, episodes: [1], locations: [lib], minHeight: 0 });
  check('unknown show -> missing', lc5.episodes[0].status === 'missing', JSON.stringify(lc5.episodes[0]));

  // ---- 2b. service.libraryReport (dry-run: recognize vs. on-disk) ----------
  console.log('\n[2b] service.libraryReport');
  copyTo(path.join(lib, 'TitleShow', 'TitleShow - Pilot.mp4')); // title-only, no number
  const rp1 = await service.libraryReport({
    series: 'South Park', season: 1, episodes: [1, 2], locations: [lib]
  });
  check(
    'report: ep1 recognized, ep2 missing',
    rp1.episodes.find((e) => e.episode === 1).status === 'recognized' &&
      rp1.episodes.find((e) => e.episode === 2).status === 'missing',
    JSON.stringify(rp1.episodes)
  );
  check(
    'report: the on-disk file is listed and matched to ep1',
    rp1.files.some((f) => /South Park S01E01/.test(f.path) && f.matched && f.matched.episode === 1),
    JSON.stringify(rp1.files)
  );
  check('report: no unrecognized files for South Park', rp1.unrecognized.length === 0, JSON.stringify(rp1.unrecognized));

  const rp2 = await service.libraryReport({
    series: 'TitleShow', season: 1, episodes: [1, 2], locations: [lib], epNames: { 1: 'Pilot' }
  });
  check(
    'report: title-only file recognized when the name is supplied',
    rp2.episodes.find((e) => e.episode === 1).status === 'recognized',
    JSON.stringify(rp2.episodes)
  );
  const rp3 = await service.libraryReport({
    series: 'TitleShow', season: 1, episodes: [1], locations: [lib]
  });
  check(
    'report: title-only file NOT recognized without a name (would be re-downloaded)',
    rp3.episodes.find((e) => e.episode === 1).status === 'missing' &&
      rp3.unrecognized.some((p) => /TitleShow - Pilot/.test(p)),
    JSON.stringify(rp3)
  );

  // ---- 3. auto watch-list rule (service.submitJob) --------------------------
  console.log('\n[3] auto watch-list rule');
  const LIB = { name: 'TV Shows', locations: [lib] };
  const seriesJob = (title, extra) =>
    Object.assign(
      {
        kind: 'series',
        title,
        sourceUrl: 'https://vidsrc.sh/embed/tv/76331-1-1',
        scope: 'episodes',
        selections: [{ season: 1, episodes: [1] }],
        library: LIB,
        minHeight: 0
      },
      extra || {}
    );
  const movieJob = (title, extra) =>
    Object.assign(
      { kind: 'movie', title, sourceUrl: 'https://vidsrc.sh/embed/movie/550', scope: 'full', library: LIB, minHeight: 0 },
      extra || {}
    );

  await service.submitJob(seriesJob('South Park')); // in library, no watch flag
  let keys = schedule.list().map((s) => s.series);
  check('series in library, no watch flag -> auto-watched', keys.includes('South Park'), JSON.stringify(keys));

  await service.submitJob(movieJob('MovieAlt')); // in library, no watch flag
  keys = schedule.list().map((s) => s.series);
  check('movie in library, no watch flag -> auto-watched', keys.includes('MovieAlt'), JSON.stringify(keys));

  await service.submitJob(seriesJob('XStyle', { watch: false })); // plain unchecked (old UI default)
  keys = schedule.list().map((s) => s.series);
  check('plain watch:false does NOT block the library auto-watch', keys.includes('XStyle'), JSON.stringify(keys));

  copyTo(path.join(lib, 'OptOut Show', 'Season 1', 'OptOut Show S01E01.mp4'));
  await service.submitJob(seriesJob('OptOut Show', { watch: false, noWatch: true })); // explicit opt-out
  keys = schedule.list().map((s) => s.series);
  check('noWatch:true opts out of auto-watch', !keys.includes('OptOut Show'), JSON.stringify(keys));

  await service.submitJob(seriesJob('Totally Unknown Show')); // not on disk
  keys = schedule.list().map((s) => s.series);
  check('title not on disk, no watch flag -> NOT watched', !keys.includes('Totally Unknown Show'), JSON.stringify(keys));

  // ---- 4. schedule helpers (new-season advance) -----------------------------
  console.log('\n[4] schedule.bumpSeason');
  const spec = { series: 'Bump Show', season: 3, mode: 'dub', template: 'https://vidsrc.sh/embed/tv/76331-{season}-{episode}', baseUrl: 'https://vidsrc.sh/embed/tv/76331-3-1' };
  schedule.add(spec);
  schedule.bumpSeason(schedule.constructor.key(spec), 4);
  const bumped = schedule.list().find((s) => s.series === 'Bump Show');
  check('bumpSeason advances the season', bumped && bumped.season === 4, JSON.stringify(bumped));
  check(
    'bumpSeason recomputes the key',
    bumped && bumped.key === schedule.constructor.key({ series: 'Bump Show', season: 4, mode: 'dub', template: spec.template }),
    bumped && bumped.key
  );

  // ---- 5. template season token --------------------------------------------
  console.log('\n[5] hasSeasonToken');
  check('vidsrc template has a season token', urltemplate.hasSeasonToken('https://vidsrc.sh/embed/tv/76331-{season}-{episode}') === true);
  check('literal-season URL has none', urltemplate.hasSeasonToken('https://example.com/season-3/ep-1') === false);
  check(
    'fill substitutes the season',
    urltemplate.fill('https://vidsrc.sh/embed/tv/76331-{season}-{episode}', { season: 5, episode: 1 }) === 'https://vidsrc.sh/embed/tv/76331-5-1'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
