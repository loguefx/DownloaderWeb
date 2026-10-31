'use strict';

// English-dub lifecycle for anime in DUB mode (engine side of the plugin's
// "EN DUB n/m" badge):
//   1. dubstatus counts dubbed episodes from the source's release names and
//      caches them (a second look is free);
//   2. queueing a season downloads only the dubbed episodes; the rest go to the
//      waiting-for-dub list and the series is watched;
//   3. the daily waiting-list pass queues an episode once its dub is out (even
//      in report-only mode - the user asked for it) and leaves the rest waiting;
//   4. the watch-list scan: once a season's dub has started, aired undubbed
//      episodes wait; a new season with NO dub yet just stays watched (nothing
//      queued, nothing parked); its first dub moves it back to waiting.
// The source is stubbed: no network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-dub-'));
const shim = {
  app: { getPath: () => DATA_DIR, on() {}, once() {}, whenReady: () => Promise.resolve(), getName: () => 'webvideodownloader' },
  BrowserWindow: class { constructor() { throw new Error('no windows in tests'); } static getAllWindows() { return []; } },
  session: { fromPartition: () => ({ setUserAgent() {}, setPermissionRequestHandler() {}, webRequest: { onBeforeSendHeaders() {} } }) },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
  ipcMain: { handle() {}, on() {} },
  screen: {}
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
  const vpn = M('vpn');
  vpn._setStatus(true, 'test', 'test');
  const dubstatus = M('dubstatus');
  const pending = M('pending');
  const schedule = M('schedule');
  const bulk = M('bulk');
  const manager = M('queue');
  const watcher = M('watcher');
  const service = M('service');

  // Fake source: which (tmdb, season, episode) are dubbed releases.
  const dubbed = new Set(['500|1|1', '500|1|2']);
  let lookups = 0;
  dubstatus._setLookupForTests(async (ref) => {
    lookups += 1;
    const d = dubbed.has(`${ref.tmdb}|${ref.season}|${ref.episode}`);
    return { status: 'ok', fileName: `Show.S0${ref.season}E0${ref.episode}.${d ? 'DUBBED.' : ''}1080p.WEB.H264-GRP.mkv` };
  });

  console.log('\n[1] Dub count from the source, cached');
  dubstatus._resetForTests();
  const r1 = await dubstatus.checkSeason('500', 1, [1, 2, 3, 4]);
  check('2 of 4 episodes dubbed', r1.dubbed === 2 && r1.notDubbed === 2 && r1.total === 4, JSON.stringify(r1));
  const before = lookups;
  const r2 = await dubstatus.checkSeason('500', 1, [1, 2, 3, 4]);
  check('a second look uses the cache (no lookups)', lookups === before && r2.dubbed === 2);
  check('peekSeason answers from the cache', dubstatus.peekSeason('500', 1, [1, 2, 3, 4]).dubbed === 2);
  const isD = await dubstatus.isDubbed('500', 1, 3);
  check('isDubbed: E3 is not dubbed', isD === false);

  console.log('\n[2] Queueing a season: dubbed episodes download, the rest wait');
  const queuedEps = [];
  bulk.queueOne = async (entry) => {
    queuedEps.push(entry.episode);
    return { queued: 1, skipped: 0 };
  };
  const job = {
    jobId: 'dub-job-1',
    kind: 'series',
    title: 'Dub Show',
    tmdb: '500',
    mode: 'dub',
    anime: true,
    minHeight: 0,
    sourceUrl: 'https://vidsrc.sh/embed/tv/500-1-1',
    scope: 'episodes',
    selections: [{ season: 1, episodes: [1, 2, 3, 4] }]
  };
  const res = await service.submitJob(job);
  check('E1 + E2 queued for download', JSON.stringify(queuedEps) === '[1,2]', JSON.stringify(queuedEps));
  const w = pending.list().filter((x) => x.series === 'Dub Show').map((x) => x.episode).sort();
  check('E3 + E4 on the waiting-for-dub list', JSON.stringify(w) === '[3,4]', JSON.stringify(w));
  check('summary reports 2 waiting', res.summary && res.summary.waiting === 2, JSON.stringify(res.summary));
  const wEntry = pending.list().find((x) => x.series === 'Dub Show' && x.episode === 3);
  check('waiting entry keeps anime + TMDB id + source numbering', wEntry && wEntry.anime === true && wEntry.tmdb === '500' && wEntry.urlEpisode === 3, JSON.stringify(wEntry));
  check('the series is now on the watch list', schedule.list().some((x) => x.series === 'Dub Show'));
  const sub = await service.submitJob(Object.assign({}, job, { jobId: 'sub-job-1', title: 'Sub Show', mode: 'sub' }));
  check('SUB mode is not gated by dub status', sub.summary && !sub.summary.waiting, JSON.stringify(sub.summary));

  console.log('\n[3] Daily waiting-list pass');
  const added = [];
  const realAdd = manager.add.bind(manager);
  manager.add = (item) => {
    added.push(item);
    return added.length;
  };
  const logs = [];
  watcher.onLog = (m) => logs.push(m);
  engineconfig.set({ watchDryRun: true }); // report-only mode on
  await watcher.checkNow();
  check('nothing queued while still not dubbed', added.length === 0, JSON.stringify(added.map((a) => a.episode)));
  check('log says episodes are still waiting', logs.some((m) => /"Dub Show" season 1: no new English-dubbed episodes; 2 episode\(s\) still waiting/.test(m)), logs.join(' | '));
  dubbed.add('500|1|3'); // E3's dub comes out ...
  dubstatus._resetForTests(); // ... and the next daily pass runs a day later (cache aged out)
  logs.length = 0;
  await watcher.checkNow();
  check('E3 queued once its dub is out (even in report-only mode)', added.length === 1 && added[0].episode === 3, JSON.stringify(added.map((a) => a.episode)));
  check('...queued with its TMDB id and anime flag', added[0] && added[0].tmdb === '500' && added[0].anime === true);
  check('log names the released episode', logs.some((m) => /English dub out for E3 - queued; 1 episode\(s\) still waiting/.test(m)), logs.join(' | '));
  manager.add = realAdd;

  console.log('\n[4] Watch-list scan follows the dub');
  const roots = [path.join(DATA_DIR, 'staging')];
  const s = { series: 'Watch Show', tmdb: '600', anime: true, mode: 'dub', outputRoot: roots[0], baseUrl: 'https://vidsrc.sh/embed/tv/600-2-1', key: 'watch-show' };
  const template = 'https://vidsrc.sh/embed/tv/600-{season}-{episode}';
  const eps = [1, 2, 3].map((n) => ({ episode: n, name: '' }));
  const queued2 = [];
  bulk.queueOne = async (entry) => {
    queued2.push(entry.episode);
    return { queued: 1, skipped: 0 };
  };
  // New season 2: no dub at all yet.
  logs.length = 0;
  watcher.onLog = (m) => logs.push(m);
  let r4 = await watcher.queueMissingEps(s, 2, eps, null, template, roots, false, 0);
  check('season with NO dub yet: nothing queued', queued2.length === 0 && r4.queued === 0, JSON.stringify(queued2));
  check('...and nothing parked on the waiting list', !pending.list().some((x) => x.series === 'Watch Show'));
  check('...the log says it is watching until the dub starts', logs.some((m) => /"Watch Show" season 2: 3 aired episode\(s\) not dubbed yet - the English dub has not started/.test(m)), logs.join(' | '));
  // First dub of season 2 arrives (E1).
  dubbed.add('600|2|1');
  dubstatus._resetForTests();
  r4 = await watcher.queueMissingEps(s, 2, eps, null, template, roots, false, 0);
  check('first dub out: E1 queued', JSON.stringify(queued2) === '[1]', JSON.stringify(queued2));
  const w2 = pending.list().filter((x) => x.series === 'Watch Show').map((x) => x.episode).sort();
  check('...E2 + E3 now wait for their dub', JSON.stringify(w2) === '[2,3]', JSON.stringify(w2));

  console.log('\n[5] A deleted episode is noticed, not skipped');
  {
    // Season already waiting for its dub (E1, E2 parked); E3 + E4 were
    // downloaded as Japanese and DELETED. With no dubbed episode in the
    // season, the deleted ones must go back on the waiting list - also in
    // report-only mode - and nothing is downloaded.
    const gs = { series: 'Gone Show', tmdb: '700', anime: true, mode: 'dub', outputRoot: roots[0], baseUrl: 'https://vidsrc.sh/embed/tv/700-1-1', key: 'gone-show' };
    for (const ep of [1, 2]) pending.add({ label: 'Gone Show S1E' + ep, series: 'Gone Show', season: 1, episode: ep, mode: 'dub', anime: true, tmdb: '700', baseUrl: 'https://vidsrc.sh/embed/tv/700-1-' + ep, outputRoot: roots[0] });
    const queued5 = [];
    bulk.queueOne = async (entry) => { queued5.push(entry.episode); return { queued: 1, skipped: 0 }; };
    dubstatus._resetForTests();
    await watcher.queueMissingEps(gs, 1, [1, 2, 3, 4].map((n) => ({ episode: n, name: '' })), null, 'https://vidsrc.sh/embed/tv/700-{season}-{episode}', roots, true, 0);
    const w5 = pending.list().filter((x) => x.series === 'Gone Show').map((x) => x.episode).sort();
    check('deleted E3 + E4 are back on the waiting list (report-only mode)', JSON.stringify(w5) === '[1,2,3,4]', JSON.stringify(w5));
    check('...and nothing was downloaded', queued5.length === 0, JSON.stringify(queued5));

    // A dub answer cached by the OLD rule (DUAL counted as dubbed) is looked up again.
    const file = path.join(DATA_DIR, 'dubstatus.json');
    dubstatus._resetForTests();
    let looks = 0;
    dubstatus._setLookupForTests(async () => { looks += 1; return { status: 'ok', fileName: 'Gone.Show.S01E04.1080p.CR.WEB-DL.DUAL-BiOMA.mkv' }; });
    fs.writeFileSync(file, JSON.stringify({ '700|1|4': { dubbed: true, file: 'old', at: Date.now() } }));
    dubstatus._resetForTests(true);
    const d4 = await dubstatus.isDubbed('700', 1, 4);
    check('old-rule cache entry is looked up again: a DUAL release is NOT dubbed', d4 === false && looks === 1, 'dubbed=' + d4 + ' lookups=' + looks);

    // The flat-library floor is re-read every pass.
    watcher.__flatFloorCache = new Map([['/somewhere', 12]]);
    await watcher._checkSchedules();
    check('flat-library floor cache is cleared each pass', !watcher.__flatFloorCache || !watcher.__flatFloorCache.has('/somewhere'));
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(1);
});
