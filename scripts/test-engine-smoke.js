'use strict';
// Smoke test for the engine Phase 3 wiring (build plan Parts 1 + 5).
// Runs under plain Node with a fake `electron` module so the real app
// modules can be loaded: engineconfig, placer, service, api, queue, bulk.
//
// Checks:
//   1. engineconfig first-run file + generated API key
//   2. placer path mapping + marker + folderReady + pickFolder order/spread
//   3. placer.placeItem moves a REAL verified mp4 from staging onto the library
//   4. placer NO_SPACE leaves the file in staging and throws NO_SPACE
//   5. service.libraryCheck reports in-library / missing
//   6. HTTP API: 401 without/wrong key, 200 health/queue, 400 bad job,
//      idempotent jobId, library stamping on queued items
//   7. queue manifest persists library/minHeight/jobId

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-smoke-'));

// ---- electron shim (must be in place before any app module loads) ----------
const shim = {
  app: {
    getPath: () => DATA_DIR,
    on: () => {},
    once: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => process.exit(0),
    setLoginItemSettings: () => {},
    getName: () => 'webvideodownloader'
  },
  BrowserWindow: class {
    constructor() {
      throw new Error('BrowserWindow is not available in the smoke test (expected fail-fast)');
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
async function checkThrows(name, fn, code) {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (e) {
    check(name, code ? e.code === code : true, `threw: ${e.code || e.message}`);
  }
}

async function main() {
  const engineconfig = M('engineconfig');
  engineconfig.dataDir = path.join(DATA_DIR, 'cfg'); // isolate from the real config
  const library = M('library');
  library.dataDir = path.join(DATA_DIR, 'libdata');

  const organizer = M('organizer');
  const placer = M('placer');
  const vpn = M('vpn');
  const manager = M('queue');
  const service = M('service');
  const api = M('api');
  const config = M('config');

  // ---- 1. engineconfig first run -------------------------------------------
  console.log('\n[1] engineconfig first run');
  const cfg = engineconfig.get();
  check('engine.json created', fs.existsSync(path.join(DATA_DIR, 'cfg', 'engine.json')));
  check('apiKey generated (40 hex)', /^[0-9a-f]{40}$/.test(cfg.apiKey), cfg.apiKey);
  check('default port 7878', cfg.port === 7878);
  check('stagingPath default', engineconfig.stagingPath() === path.join(DATA_DIR, 'cfg', 'staging'));

  // ---- 2. placer basics ------------------------------------------------------
  console.log('\n[2] placer path mapping + markers');
  engineconfig.set({
    pathMappings: [{ jellyfin: '\\\\nas\\anime', engine: DATA_DIR + '/lib/anime' }],
    reserveBytes: 0,
    fillMode: 'order',
    port: 17878
  });
  const mapped = placer.toEnginePath('\\\\nas\\anime\\Show (2019)', engineconfig.get().pathMappings);
  check('toEnginePath maps jellyfin->engine', mapped === DATA_DIR + '/lib/anime/Show (2019)', mapped);

  const libA = DATA_DIR + '/lib/anime';
  const libB = DATA_DIR + '/lib/anime2';
  const staging = engineconfig.stagingPath();
  fs.mkdirSync(staging, { recursive: true });
  const marks = placer.ensureMarkers([libA, libB]);
  check('ensureMarkers ok', marks.every((m) => m.ok), JSON.stringify(marks));
  check('folderReady sees marker', placer.folderReady(libA).ready);
  check('folderReady rejects unmarked folder', !placer.folderReady(DATA_DIR + '/lib/nope').ready);

  // ---- real test videos ------------------------------------------------------
  const { execFileSync } = require('child_process');
  const ffmpeg = require(path.join(REPO, 'node_modules', 'ffmpeg-static'));
  const goodMp4 = DATA_DIR + '/good.mp4';
  // testsrc + 60s keeps the file above the engine's minFileBytes (64KB) floor.
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=60', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', goodMp4], { stdio: 'pipe' });

  // ---- 3. placeItem: staging -> library -------------------------------------
  console.log('\n[3] placer.placeItem (real verified mp4)');
  const item = {
    label: 'Show S1E1',
    series: 'Show',
    season: 1,
    episode: 1,
    minHeight: 0,
    library: { name: 'Anime', locations: ['\\\\nas\\anime', DATA_DIR + '/lib/anime2'] }
  };
  const copyTo = (src, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };
  const stagedName = organizer.expectedPath(staging, { series: 'Show', season: 1, episode: 1 }, '.mp4');
  copyTo(goodMp4, stagedName);
  const placed = await placer.placeItem(item, stagedName);
  check('placed on the mapped drive', placed.placed && placed.folder === libA, JSON.stringify(placed));
  check('staging copy moved away (not duplicated)', !fs.existsSync(stagedName));
  check('library file exists at expected path', fs.existsSync(placed.finalPath), placed.finalPath);
  check('ledger now owns the placed file', library.isOurs(placed.finalPath));
  check('audit recorded placed-on-library', fs.existsSync(path.join(library.dataDir, 'audit.log')));

  // ---- 4. NO_SPACE ------------------------------------------------------------
  console.log('\n[4] NO_SPACE keeps the file in staging');
  engineconfig.set({ reserveBytes: 1024 ** 7 }); // 128 TiB reserve: nothing fits
  const item2 = Object.assign({}, item, {
    label: 'Show S1E2',
    episode: 2,
    library: { name: 'Anime', locations: [DATA_DIR + '/lib/anime2'] }
  });
  const staged2 = organizer.expectedPath(staging, { series: 'Show', season: 1, episode: 2 }, '.mp4');
  copyTo(goodMp4, staged2);
  await checkThrows('placeItem throws NO_SPACE', () => placer.placeItem(item2, staged2), 'NO_SPACE');
  check('staged file survived NO_SPACE', fs.existsSync(staged2));
  engineconfig.set({ reserveBytes: 0 });

  // ---- 5. service.libraryCheck ------------------------------------------------
  console.log('\n[5] service.libraryCheck');
  const lc = await service.libraryCheck({ series: 'Show', season: 1, episodes: [1, 2, 4], locations: ['\\\\nas\\anime', libB] });
  const ep1 = lc.episodes.find((e) => e.episode === 1);
  const ep2 = lc.episodes.find((e) => e.episode === 2);
  const ep4 = lc.episodes.find((e) => e.episode === 4);
  check('ep1 in-library (placed above)', ep1 && ep1.status === 'in-library', JSON.stringify(ep1));
  check('ep1 reported as engine-owned', ep1 && ep1.ours === true);
  check(
    'ep2 visible in staging (NO_SPACE residue, not lost)',
    ep2 && (ep2.status === 'in-library' || ep2.status === 'low-quality') && String(ep2.path).startsWith(staging),
    JSON.stringify(ep2)
  );
  check('ep4 missing', ep4 && ep4.status === 'missing', JSON.stringify(ep4));

  // A season with nothing on disk must list each folder ONCE, not once per
  // episode: 444 listings for 12 episodes froze the engine for 10-20 s on a
  // network share and the plugin reported it offline (Ranma ½ Season 2).
  {
    const libC = path.join(DATA_DIR, 'lib', 'many');
    for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(libC, `Other ${i}`, 'Season 1'), { recursive: true });
    let lists = 0;
    const realReaddir = fs.readdirSync;
    fs.readdirSync = function () { lists += 1; return realReaddir.apply(this, arguments); };
    let lcBig;
    try {
      lcBig = await service.libraryCheck({
        series: 'Nothing Here Yet', season: 2, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        epNames: { 1: "Ranma's Weakness", 2: 'Attack of the Wild Mousse' }, locations: [libC, libB]
      });
    } finally {
      fs.readdirSync = realReaddir;
    }
    check('12 missing episodes reported missing', lcBig && lcBig.episodes.every((e) => e.status === 'missing'), JSON.stringify(lcBig && lcBig.episodes.slice(0, 2)));
    check('each folder listed once per check (not once per episode)', lists <= 20, 'readdirSync calls: ' + lists);
  }

  // ---- 5b. service.verifyDrives (drive alignment, Part 5) -------------------
  console.log('\n[5b] service.verifyDrives');
  engineconfig.set({ pathMappings: [] }); // same-letter case: engine path == jellyfin path
  const vd = await service.verifyDrives({ libraries: [{ name: 'Anime', locations: [libA, libB, DATA_DIR + '/lib/nope'] }] });
  check('verify returns the one library', vd.count === 1 && Array.isArray(vd.libraries), JSON.stringify(vd && vd.count));
  const vdLib = vd.libraries[0];
  check('Anime library ok (a writable drive exists)', vdLib.ok === true, JSON.stringify(vdLib && vdLib.folders));
  const vdA = vdLib && vdLib.folders.find((f) => f.engine === libA);
  const vdNope = vdLib && vdLib.folders.find((f) => f.engine === DATA_DIR + '/lib/nope');
  check('libA writable + write round-trip ok', vdA && vdA.writable === true && vdA.roundTrip && vdA.roundTrip.ok === true, JSON.stringify(vdA));
  check('libA marker present', vdA && vdA.marker === true, JSON.stringify(vdA && vdA.marker));
  check('missing share not writable, round-trip not run', vdNope && vdNope.writable === false && vdNope.roundTrip && vdNope.roundTrip.ok === false, JSON.stringify(vdNope));
  engineconfig.set({ pathMappings: [{ jellyfin: '\\\\nas\\anime', engine: DATA_DIR + '/lib/anime' }] });

  // ---- 6. HTTP API -------------------------------------------------------------
  console.log('\n[6] HTTP API');
  // Make discovery fail fast instead of hanging on the shim.
  vpn._setStatus(true, 'smoke', 'test');
  await api.start();
  const BASE = 'http://127.0.0.1:17878';
  const KEY = engineconfig.get().apiKey;
  const req = (method, url, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const mod = require('http');
      const r = mod.request(BASE + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(d); } catch (e) { /* not json */ }
          resolve({ status: res.statusCode, body: d, json });
        });
      });
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });

  let r = await req('GET', '/api/health');
  check('health without key -> 401', r.status === 401, String(r.status));
  r = await req('GET', '/api/health', null, { authorization: 'Bearer wrongkey' });
  check('health with wrong key -> 401', r.status === 401, String(r.status));
  r = await req('GET', '/api/health', null, { authorization: `Bearer ${KEY}` });
  check('health with key -> 200', r.status === 200, r.body.slice(0, 120));
  check('health reports engineMode flag list', r.json && typeof r.json.queue === 'object' && 'placing' in r.json.queue, JSON.stringify(r.json && r.json.queue));
  check('health staging info', r.json && typeof r.json.staging.freeBytes === 'number');

  r = await req('GET', '/api/queue', null, { authorization: `Bearer ${KEY}` });
  check('queue snapshot -> 200', r.status === 200 && Array.isArray(r.json.items));

  // Regression (Pause/Resume/Stop buttons 404'd): the dispatcher used to read
  // the action from the {id}/{action} slot (parts[3]) instead of parts[2],
  // so POST /api/queue/pause fell through to "no such endpoint".
  r = await req('POST', '/api/queue/pause', null, { authorization: `Bearer ${KEY}` });
  check('POST /api/queue/pause -> 200 + paused', r.status === 200 && r.json && r.json.paused === true, r.body.slice(0, 120));
  r = await req('POST', '/api/queue/resume', null, { authorization: `Bearer ${KEY}` });
  check('POST /api/queue/resume -> 200 + unpaused', r.status === 200 && r.json && r.json.paused === false, r.body.slice(0, 120));

  r = await req('POST', '/api/jobs', { title: 'X' }, { authorization: `Bearer ${KEY}` });
  check('job without sourceUrl -> 400', r.status === 400, r.body.slice(0, 120));

  r = await req('POST', '/api/library/check', { season: 1 }, { authorization: `Bearer ${KEY}` });
  check('library/check without series -> 400', r.status === 400);

  // A real job (fake site): must be accepted, deduped, and stamped with the library.
  // The manifest assertions below need queue persistence ON: the default is
  // start-empty mode, which deliberately never writes queue-manifest.json. (The
  // old harness read that file unconditionally and crashed here, silently
  // skipping every check after this point.)
  config.download.persistQueueAcrossRestarts = true;
  const job = {
    jobId: 'smoke-1',
    kind: 'series',
    title: 'Show',
    sourceUrl: 'https://example.invalid/watch/show/ep-1',
    mode: 'dub',
    minHeight: 1080,
    library: { id: 'lib1', name: 'Anime', locations: ['\\\\nas\\anime'] },
    scope: 'episodes',
    selections: [{ season: 1, episodes: [3] }],
    watch: false
  };
  r = await req('POST', '/api/jobs', job, { authorization: `Bearer ${KEY}` });
  check('job accepted -> 202', r.status === 202, r.body.slice(0, 200));
  check('job queued 1', r.json && r.json.summary && r.json.summary.queued === 1, r.body.slice(0, 200));

  r = await req('POST', '/api/jobs', job, { authorization: `Bearer ${KEY}` });
  check('same jobId resent -> duplicate:true', r.json && r.json.duplicate === true, r.body.slice(0, 200));

  const it = manager.items.find((x) => x.series === 'Show' && x.episode === 3);
  check('queued item carries library', it && it.library && it.library.name === 'Anime');
  check('queued item carries minHeight', it && it.minHeight === 1080);
  check('queued item carries jobId', it && it.jobId === 'smoke-1');

  const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'queue-manifest.json'), 'utf8'));
  const mrec = manifest.find((x) => x.series === 'Show' && x.episode === 3);
  check('manifest persists library', mrec && mrec.library && mrec.library.name === 'Anime', JSON.stringify(mrec));
  check('manifest persists minHeight/jobId', mrec && mrec.minHeight === 1080 && mrec.jobId === 'smoke-1');
  config.download.persistQueueAcrossRestarts = false; // back to the start-empty default

  // accepted-jobs dedupe file
  check('accepted-jobs.json written', fs.existsSync(path.join(DATA_DIR, 'accepted-jobs.json')));

  // The plugin's vidsrc job: ONE job covers a season. The sample URL names
  // episode 1; the rest are built from its {season}/{episode} template.
  r = await req('POST', '/api/jobs', {
    jobId: 'smoke-vidsrc',
    kind: 'series',
    title: 'Vid Show',
    sourceUrl: 'https://vidsrc.sh/embed/tv/125988-2-1',
    library: { id: 'lib1', name: 'Anime', locations: ['\\\\nas\\anime'] },
    scope: 'episodes',
    selections: [{ season: 2, episodes: [1, 2, 3] }]
  }, { authorization: `Bearer ${KEY}` });
  check('vidsrc season job queued 3', r.json && r.json.summary && r.json.summary.queued === 3, r.body.slice(0, 200));
  const vid3 = manager.items.find((x) => x.series === 'Vid Show' && x.episode === 3);
  check('vidsrc episode URL built from template', vid3 && vid3.url === 'https://vidsrc.sh/embed/tv/125988-2-3', vid3 && vid3.url);
  check('vidsrc episode keeps season 2', vid3 && vid3.season === 2);

  // A movie job: one unnumbered item, named <Title>, never "S1E1".
  r = await req('POST', '/api/jobs', {
    jobId: 'smoke-movie',
    kind: 'movie',
    title: 'Some Movie',
    sourceUrl: 'https://vidsrc.sh/embed/movie/550',
    library: { id: 'lib1', name: 'Anime', locations: ['\\\\nas\\anime'] },
    scope: 'full'
  }, { authorization: `Bearer ${KEY}` });
  check('movie job queued 1', r.json && r.json.summary && r.json.summary.queued === 1, r.body.slice(0, 200));
  const mv = manager.items.find((x) => x.series === 'Some Movie');
  check('movie item has no season/episode', mv && mv.season == null && mv.episode == null, mv && JSON.stringify([mv.season, mv.episode]));
  check('movie item label is the bare title', mv && mv.label === 'Some Movie', mv && mv.label);

  r = await req('POST', '/api/library/check', { series: 'Some Movie', kind: 'movie', locations: [] }, { authorization: `Bearer ${KEY}` });
  check('library/check sees a queued movie', r.json && r.json.episodes && r.json.episodes[0] && r.json.episodes[0].status === 'queued', r.body.slice(0, 200));

  r = await req('GET', '/api/log', null, { authorization: `Bearer ${KEY}` });
  check('GET /api/log returns recent lines', r.status === 200 && r.json && Array.isArray(r.json.items) && r.json.items.some((l) => /Queued/.test(l.msg)), r.body.slice(0, 200));

  r = await req('DELETE', `/api/queue/${mv.id}`, null, { authorization: `Bearer ${KEY}` });
  check('DELETE /api/queue/{id} removes the item', r.status === 200 && !manager.items.some((x) => x.id === mv.id));

  // Stop is sticky (workers stay parked), so it is the LAST queue-control call
  // in this harness.
  r = await req('POST', '/api/queue/stop', null, { authorization: `Bearer ${KEY}` });
  check('POST /api/queue/stop -> 200', r.status === 200, r.body.slice(0, 120));
  check('stop parks the workers (sticky)', !!manager._stopRequested, String(manager._stopRequested));

  // ---- renumber anime files to TMDB's seasons (Link Click) ----------------
  {
    console.log('\n[6b] renumber: anime sites\' season numbering -> TMDB (Jellyfin)');
    const al = M('anime-layout');
    const lib = path.join(DATA_DIR, 'lib', 'renumber');
    const lc = path.join(lib, 'Link Click');
    const put = (rel) => { const f = path.join(lc, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'.repeat(10 + rel.length)); return f; };
    for (let e = 1; e <= 11; e++) put(`Season 1/Link Click - EP${e}.mp4`);
    for (let e = 1; e <= 12; e++) put(`Season 2/Link Click Season 2 - EP${e}.mp4`);
    for (const e of [1, 2, 3, 4, 5, 6, 7, 8, 10]) put(`Season 3/Link Click S3E${e}.mp4`);
    // A file already sitting at one target name must never be overwritten.
    put('Season 4/Link Click S4E10.mp4');
    // TMDB: S3 = Bridon Arc (6), S4 = the 2026 season. Aniwave: S3 = 2026.
    al._internals.cacheSet('tmdb:126318', [{ season: 1, episodes: 11 }, { season: 2, episodes: 12 }, { season: 3, episodes: 6 }, { season: 4, episodes: 12 }]);
    al._internals.cacheSet('plan:126318|link click', al.buildSourcePlan(
      [{ season: 1, episodes: 11 }, { season: 2, episodes: 12 }, { season: 3, episodes: 6 }, { season: 4, episodes: 12 }],
      [{ season: 1, episodes: 11 }, { season: 2, episodes: 12 }, { season: 3, episodes: 12 }],
      [{ entry: { id: 'b', title: 'Link Click: Bridon Arc' }, count: 6 }]));
    const body = { series: 'Link Click', tmdb: '126318', locations: [lib] };
    r = await req('POST', '/api/library/renumber', body, { authorization: `Bearer ${KEY}` });
    const pv = r.json || {};
    check('preview: 8 moves Season 3 -> Season 4 (E10 conflicts)', r.status === 200 && pv.moves && pv.moves.length === 8, r.body.slice(0, 300));
    check('preview: S3E7 -> S4E7 in "Season 4"', pv.moves && pv.moves.some((m) => m.fromLabel === 'S3E7' && m.toLabel === 'S4E7' && m.to.endsWith(path.join('Link Click', 'Season 4', 'Link Click S4E7.mp4'))), JSON.stringify(pv.moves && pv.moves.slice(0, 2)));
    check('preview: existing S4E10 reported as a conflict, not overwritten', pv.conflicts && pv.conflicts.length === 1 && /S3E10/.test(pv.conflicts[0].fromLabel), JSON.stringify(pv.conflicts));
    check('preview: Seasons 1 and 2 untouched (same in both numberings)', pv.moves && pv.moves.every((m) => m.fromLabel.startsWith('S3')));
    check('preview moved nothing', fs.existsSync(path.join(lc, 'Season 3', 'Link Click S3E7.mp4')));

    // Apply only what was confirmed (two files), then the rest.
    const pick = pv.moves.filter((m) => /S3E[12]$/.test(m.fromLabel)).map((m) => m.from);
    r = await req('POST', '/api/library/renumber', Object.assign({}, body, { apply: true, confirm: pick }), { authorization: `Bearer ${KEY}` });
    check('apply: only the 2 confirmed files renamed', r.json && r.json.applied && r.json.applied.length === 2 &&
      fs.existsSync(path.join(lc, 'Season 4', 'Link Click S4E1.mp4')) && fs.existsSync(path.join(lc, 'Season 3', 'Link Click S3E3.mp4')), r.body.slice(0, 200));
    r = await req('POST', '/api/library/renumber', body, { authorization: `Bearer ${KEY}` });
    r = await req('POST', '/api/library/renumber', Object.assign({}, body, { apply: true, confirm: r.json.moves.map((m) => m.from) }), { authorization: `Bearer ${KEY}` });
    check('apply: the remaining 6 renamed', r.json && r.json.applied && r.json.applied.length === 6, r.body.slice(0, 200));
    check('the pre-existing S4E10 file is untouched; S3E10 stays put', fs.readFileSync(path.join(lc, 'Season 4', 'Link Click S4E10.mp4'), 'utf8').length === 10 + 'Season 4/Link Click S4E10.mp4'.length && fs.existsSync(path.join(lc, 'Season 3', 'Link Click S3E10.mp4')));
    check('Season 1/2 files never moved', fs.existsSync(path.join(lc, 'Season 1', 'Link Click - EP11.mp4')) && fs.existsSync(path.join(lc, 'Season 2', 'Link Click Season 2 - EP12.mp4')));

    // Ambiguous: a Season 3 whose episodes all fit TMDB's Season 3 is left alone.
    const amb = path.join(lib, 'Other Show');
    for (const e of [1, 2, 3]) { const f = path.join(amb, 'Season 3', `Other Show S3E${e}.mp4`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
    al._internals.cacheSet('tmdb:555001', [{ season: 1, episodes: 11 }, { season: 2, episodes: 12 }, { season: 3, episodes: 6 }, { season: 4, episodes: 12 }]);
    al._internals.cacheSet('plan:555001|other show', al._internals.cacheGet('plan:126318|link click'));
    r = await req('POST', '/api/library/renumber', { series: 'Other Show', tmdb: '555001', locations: [lib] }, { authorization: `Bearer ${KEY}` });
    check('no evidence (E1-E3 fit TMDB S3): no moves, reported ambiguous', r.json && r.json.moves.length === 0 && r.json.ambiguous.length === 1, r.body.slice(0, 300));

    // Read-only mode refuses to rename.
    library.setReadOnly(true);
    r = await req('POST', '/api/library/renumber', Object.assign({}, body, { apply: true, confirm: [path.join(lc, 'Season 3', 'Link Click S3E10.mp4')] }), { authorization: `Bearer ${KEY}` });
    check('read-only mode: apply refused', r.status === 409, String(r.status));
    library.setReadOnly(false);
    r = await req('POST', '/api/library/renumber', { series: 'Link Click' }, { authorization: `Bearer ${KEY}` });
    check('missing TMDB id -> 400', r.status === 400);
  }

  // settings round-trip
  r = await req('PUT', '/api/settings', { fillMode: 'spread' }, { authorization: `Bearer ${KEY}` });
  check('settings PUT -> 200 + applied', r.status === 200 && r.json.fillMode === 'spread', r.body.slice(0, 120));
  check('engineconfig persisted', engineconfig.get().fillMode === 'spread');

  r = await req('GET', '/api/nope', null, { authorization: `Bearer ${KEY}` });
  check('unknown endpoint -> 404', r.status === 404);

  manager.stopAll('smoke test done');
  await api.stop();

  // ---- summary -----------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('failures:', failures);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0); // don't wait on retry timers
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
