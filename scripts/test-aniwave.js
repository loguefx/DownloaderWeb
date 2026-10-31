'use strict';

// Aniwave as the anime English-dub source (sites/aniwave_api.js, the
// aniwave adapter's findTitle, dubstatus.isDubbedForJob, the watcher):
//   1. catalog parsing: /filter results and /ajax/episode/list dub flags
//      (fixtures shaped like the live pages, Oct 2026);
//   2. the right entry per title + season; spin-offs never picked;
//   3. findTitle: anime only; DUB only for an episode Aniwave flags dubbed;
//   4. an episode is dubbed when Vidsrc has an English release OR Aniwave
//      flags it (Vidsrc often streams only the Japanese track);
//   5. the watcher queues an episode only Aniwave has dubbed.
// No network: the catalog's HTTP layer is stubbed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-aniwave-'));
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

// ---- fixtures shaped like aniwaves.ru ----------------------------------------
const filterPage = (items) =>
  '<html><body><div class="ani items">' +
  items.map(([slugId, jp, title]) => `<div class="item"><a class="name d-title" href="/watch/${slugId}" data-jp="${jp}">${title}</a></div>`).join('') +
  '</div></body></html>';
const episodeList = (n, dubbed) =>
  JSON.stringify({
    status: 200,
    result:
      '<div class="head"></div><ul class="ep-range">' +
      Array.from({ length: n }, (_, i) => {
        const e = i + 1;
        return `<li><a href="/watch/x/ep-${e}" data-ids="1&amp;eps=${e}" data-num="${e}" data-slug="${e}" data-sub="1" data-dub="${dubbed.includes(e) ? 1 : 0}" enabled="1">${e}</a></li>`;
      }).join('') +
      '</ul>'
  });
const SITE = {
  '/filter?keyword=Solo+Leveling': filterPage([
    ['ore-dake-level-up-na-ken-76040', 'Ore dake Level Up na Ken', 'Solo Leveling'],
    ['ore-dake-level-up-na-ken-how-to-get-stronger-82325', 'Ore dake Level Up na Ken: How to Get Stronger', 'Solo Leveling: How to Get Stronger'],
    ['ore-dake-level-up-na-ken-season-2-arise-from-the-shadow-82064', 'Ore dake Level Up na Ken Season 2', 'Solo Leveling Season 2: Arise from the Shadow']
  ]),
  '/filter?keyword=Smoking+Behind+the+Supermarket+with+You': filterPage([
    ['super-no-ura-de-yani-suu-futari-82730', 'Super no Ura de Yani Suu Futari', 'Smoking Behind the Supermarket with You']
  ]),
  '/ajax/episode/list/76040': episodeList(12, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  '/ajax/episode/list/82064': episodeList(13, [1, 2, 3]),
  '/ajax/episode/list/82730': episodeList(12, [])
};

async function main() {
  const aw = M('sites/aniwave_api');
  let requests = 0;
  aw._setGetForTests(async (p) => {
    requests += 1;
    return Object.prototype.hasOwnProperty.call(SITE, p) ? SITE[p] : null;
  });

  console.log('\n[1] Catalog parsing');
  const res = await aw.search('Solo Leveling');
  check('search lists 3 entries with id/slug/title', res.length === 3 && res[0].id === '76040' && res[0].title === 'Solo Leveling', JSON.stringify(res[0]));
  const eps = await aw.episodes('82064');
  check('episode list: 13 episodes, E1-E3 dubbed', eps.length === 13 && eps.filter((e) => e.dub).length === 3 && eps[2].dub && !eps[3].dub);
  const before = requests;
  await aw.search('Solo Leveling');
  check('results are cached', requests === before);

  console.log('\n[2] The right entry per title + season');
  check('Solo Leveling S1 -> the base entry (not "How to Get Stronger")', (aw.pickShow(res, 'Solo Leveling', 1) || {}).id === '76040');
  check('Solo Leveling S2 -> "Season 2: Arise from the Shadow"', (aw.pickShow(res, 'Solo Leveling', 2) || {}).id === '82064');
  check('Solo Leveling S3 -> nothing (does not exist)', aw.pickShow(res, 'Solo Leveling', 3) === null);
  check('another show never matches', aw.pickShow(res, 'Solo', 1) === null);
  check('"2nd Season" naming is read as season 2', aw.seasonOfTitle('Golden Kamuy 2nd Season') === 2);

  console.log('\n[3] findTitle (cross-site fallback)');
  const sites = M('sites');
  sites.init(DATA_DIR);
  const awProfile = sites.profiles.find((p) => p.id === 'aniwave');
  check('Aniwave is a cross-site fallback, ranked right after Vidsrc', awProfile && typeof awProfile.findTitle === 'function' && awProfile.fallbackRank === 1);
  const logs = [];
  const log = (m) => logs.push(m);
  let u = await awProfile.findTitle({ title: 'Solo Leveling', season: 1, episode: 3, anime: true, mode: 'dub' }, {}, log);
  check('anime DUB, dubbed episode -> its Aniwave page', u === 'https://aniwaves.ru/watch/ore-dake-level-up-na-ken-76040/ep-3', u);
  u = await awProfile.findTitle({ title: 'Solo Leveling', season: 2, episode: 5, anime: true, mode: 'dub' }, {}, log);
  check('anime DUB, episode with no dub yet -> nothing (says why)', u === null && logs.some((m) => /no English dub for "Solo Leveling Season 2: Arise from the Shadow" E5/.test(m)), logs.join(' | '));
  u = await awProfile.findTitle({ title: 'Solo Leveling', season: 2, episode: 5, anime: true, mode: 'sub' }, {}, log);
  check('SUB mode takes the subbed episode', /82064\/ep-5$/.test(String(u)), u);
  u = await awProfile.findTitle({ title: 'Solo Leveling', season: 1, episode: 3, anime: false, mode: 'dub' }, {}, log);
  check('not anime -> Aniwave is not asked', u === null);
  u = await awProfile.findTitle({ title: 'Solo Leveling', season: 9, episode: 1, displaySeason: 1, displayEpisode: 3, anime: true, mode: 'dub' }, {}, log);
  check("the job's own numbering wins over the TMDB numbering", /76040\/ep-3$/.test(String(u)), u);

  console.log('\n[4] Dubbed = Vidsrc English release OR Aniwave flag');
  const dubstatus = M('dubstatus');
  dubstatus._resetForTests();
  dubstatus._setLookupForTests(async (ref) => ({ status: 'ok', fileName: `Show.S01E0${ref.episode}.${ref.episode === 1 ? 'DUBBED.' : ''}1080p.mkv` }));
  const job = (title, season, episode) => dubstatus.isDubbedForJob({ tmdb: '127532', srcSeason: season, srcEpisode: episode, title, season, episode });
  check('Vidsrc dubbed (E1) -> dubbed', (await job('Solo Leveling', 1, 1)) === true);
  check('Vidsrc Japanese-only but Aniwave dubbed (E3) -> dubbed', (await job('Solo Leveling', 1, 3)) === true);
  check('neither has a dub -> not dubbed', (await job('Smoking Behind the Supermarket with You', 1, 3)) === false);

  console.log('\n[5] The watcher queues an episode only Aniwave has dubbed');
  const engineconfig = M('engineconfig');
  engineconfig.dataDir = DATA_DIR;
  const bulk = M('bulk');
  const pending = M('pending');
  const watcher = M('watcher');
  const queued = [];
  bulk.queueOne = async (entry) => {
    queued.push(entry.episode);
    return { queued: 1, skipped: 0 };
  };
  watcher.onLog = () => {};
  const roots = [path.join(DATA_DIR, 'staging')];
  const s = { series: 'Solo Leveling', tmdb: '127532', anime: true, mode: 'dub', outputRoot: roots[0], baseUrl: 'https://vidsrc.sh/embed/tv/127532-1-1', key: 'sl' };
  await watcher.queueMissingEps(s, 1, [2, 3, 4].map((n) => ({ episode: n, name: '' })), null, 'https://vidsrc.sh/embed/tv/127532-{season}-{episode}', roots, false, 0);
  check('E2-E4 queued (Vidsrc has none of them dubbed; Aniwave has all)', JSON.stringify(queued) === '[2,3,4]', JSON.stringify(queued));
  check('...none parked on the waiting list', !pending.list().some((x) => x.series === 'Solo Leveling'));

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(1);
});
