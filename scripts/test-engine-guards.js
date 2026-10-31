'use strict';

// Engine safety guards:
//   1. watcher: episodes with no air date (TMDB "TBA") are not queued as aired;
//   2. engine.json with a typo is set aside, never silently replaced;
//   3. settings PUT rejects values that would stop the API from starting;
//   4. a jobId resent while the first copy is still running is not run twice,
//      and two jobs finishing together both stay recorded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-guards-'));
const shim = {
  app: { getPath: () => DATA_DIR, on() {}, once() {}, whenReady: () => Promise.resolve(), getName: () => 'webvideodownloader' },
  BrowserWindow: class { constructor() { throw new Error('no windows in tests'); } static getAllWindows() { return []; } },
  session: { fromPartition: () => ({ setUserAgent() {}, setPermissionRequestHandler() {}, webRequest: { onBeforeSendHeaders() {} } }) },
  ipcMain: { handle() {}, on() {} },
  webContents: { getAllWebContents: () => [] }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return shim;
  return origLoad.apply(this, arguments);
};

const REPO = path.join(__dirname, '..');
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

async function main() {
  const engineconfig = M('engineconfig');
  engineconfig.dataDir = DATA_DIR;

  console.log('\n[1] Watcher: TBA episodes are not "aired"');
  const { airedEpisodes } = M('watcher');
  const today = '2026-10-30';
  const ep = (n, d) => ({ episode: n, airDate: d });
  const running = [ep(1, '2026-10-01'), ep(2, '2026-10-08'), ep(3, '2026-11-05'), ep(4, null), ep(5, null)];
  check('future and undated tail episodes are not aired', JSON.stringify(airedEpisodes(running, today).map((e) => e.episode)) === '[1,2]',
    JSON.stringify(airedEpisodes(running, today).map((e) => e.episode)));
  const gap = [ep(1, '2026-01-01'), ep(2, null), ep(3, '2026-01-15')];
  check('an undated episode BEFORE an aired one counts as aired', JSON.stringify(airedEpisodes(gap, today).map((e) => e.episode)) === '[1,2,3]');
  const noDates = [ep(1, null), ep(2, null)];
  check('a season with no dates at all is taken as aired (old shows)', airedEpisodes(noDates, today).length === 2);

  console.log('\n[2] engine.json with a typo is set aside, not silently replaced');
  const file = engineconfig.file();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "apiKey": "keep-me", "port": 7878, }'); // trailing comma
  engineconfig._data = null;
  const origErr = console.error;
  let warned = '';
  console.error = (m) => { warned += String(m); };
  const c = engineconfig.get();
  console.error = origErr;
  const backups = fs.readdirSync(DATA_DIR).filter((n) => n.startsWith('engine.json.corrupt-'));
  check('the broken file is kept as engine.json.corrupt-*', backups.length === 1, fs.readdirSync(DATA_DIR).join(','));
  check('...with its original contents', backups.length === 1 && fs.readFileSync(path.join(DATA_DIR, backups[0]), 'utf8').includes('keep-me'));
  check('a loud warning names the backup', /not valid JSON/.test(warned) && /corrupt-/.test(warned), warned);
  check('the engine still starts (defaults)', c && c.port === 7878 && typeof c.apiKey === 'string');

  console.log('\n[3] Settings PUT rejects values that would break the next start');
  const service = M('service');
  const tryPut = (patch) => {
    try {
      service.settingsPut(patch);
      return null;
    } catch (e) {
      return e;
    }
  };
  const before = JSON.stringify(engineconfig.get());
  for (const [name, patch] of [
    ['port "abc"', { port: 'abc' }],
    ['port 99999', { port: 99999 }],
    ['bind ""', { bind: '' }],
    ['fillMode "random"', { fillMode: 'random' }],
    ['reserveBytes -1', { reserveBytes: -1 }],
    ['pathMappings not a list', { pathMappings: 'x' }]
  ]) {
    const e = tryPut(patch);
    check(`rejects ${name} with a 400`, e && e.status === 400, e ? e.message : 'accepted');
  }
  check('nothing was saved by the rejected requests', JSON.stringify(engineconfig.get()) === before);
  check('a valid change is still accepted', tryPut({ port: 8899, fillMode: 'spread' }) === null && engineconfig.get().port === 8899);

  console.log('\n[4] Job resends while the first copy runs');
  const bulk = M('bulk');
  let calls = 0;
  bulk.queueOne = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 150));
    return { queued: 1, skipped: 0 };
  };
  const job = (id) => ({ jobId: id, kind: 'movie', title: 'Film ' + id, sourceUrl: 'https://vidsrc.sh/embed/movie/1' + id.length, scope: 'full', noWatch: true });
  const [a, b] = await Promise.all([service.submitJob(job('job-A')), service.submitJob(job('job-A'))]);
  check('the job ran once', calls === 1, 'calls=' + calls);
  check('the resend is answered as a duplicate', a.duplicate === false && b.duplicate === true, JSON.stringify([a.duplicate, b.duplicate]));
  await Promise.all([service.submitJob(job('job-B')), service.submitJob(job('job-CC'))]);
  const accepted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'accepted-jobs.json'), 'utf8'));
  check('two jobs finishing together are both recorded', !!(accepted['job-A'] && accepted['job-B'] && accepted['job-CC']), Object.keys(accepted).join(','));
  const again = await service.submitJob(job('job-B'));
  check('a later resend is a duplicate and does not run', again.duplicate === true && calls === 3, 'calls=' + calls);

  console.log('\n[5] Startup sweep removes only single-use player partitions');
  const parts = path.join(DATA_DIR, 'Partitions');
  const mk = (n) => { fs.mkdirSync(path.join(parts, n, 'Cache'), { recursive: true }); fs.writeFileSync(path.join(parts, n, 'Cache', 'x'), 'x'); };
  ['wvd-1789246918865-232654', 'wvd-1789249223925-23537', 'wvd-player-vidsrc.sh', 'wvd-site', 'web', 'wvd-123-4'].forEach(mk);
  const dw = M('discoverwindow');
  const sw = await dw.sweepOneShotPartitions(DATA_DIR);
  const left = fs.readdirSync(parts).sort();
  check('both single-use partitions removed', sw.removed === 2 && !left.some((n) => /^wvd-\d{13}-/.test(n)), JSON.stringify(sw) + ' ' + left.join(','));
  check('shared per-host jars, the main session and short names are kept',
    JSON.stringify(left) === JSON.stringify(['web', 'wvd-123-4', 'wvd-player-vidsrc.sh', 'wvd-site']), left.join(','));
  const none = await dw.sweepOneShotPartitions(path.join(DATA_DIR, 'nope'));
  check('a missing Partitions folder is fine', none.removed === 0 && none.failed === 0);

  console.log('\n[6] Stale HLS segment caches are swept, fresh ones kept');
  const tmp = path.join(DATA_DIR, 'tmp');
  const old = path.join(tmp, 'wvd-hls-0123456789abcdef');
  const fresh = path.join(tmp, 'wvd-hls-fedcba9876543210');
  const other = path.join(tmp, 'wvd-hls-notacache');
  for (const d of [old, fresh, other]) fs.mkdirSync(d, { recursive: true });
  const fourDaysAgo = (Date.now() - 4 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old, fourDaysAgo, fourDaysAgo);
  fs.utimesSync(other, fourDaysAgo, fourDaysAgo);
  const n = await M('downloader').sweepStaleHlsCaches(undefined, tmp);
  check('the 4-day-old cache is removed', n === 1 && !fs.existsSync(old), 'removed=' + n);
  check('a cache in use (fresh) is kept', fs.existsSync(fresh));
  check('a folder that is not ours is kept', fs.existsSync(other));

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(1);
});
