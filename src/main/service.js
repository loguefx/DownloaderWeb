'use strict';

// Service layer (Jellyfin build plan, Part 1).
//
// One control surface for the whole engine: the desktop app's IPC handlers and
// the HTTP API both call these functions, so the desktop app keeps working
// while the plugin gets the same behavior over the network.
//
// Jobs sent by the plugin look like:
//   {
//     "jobId": "5b0e...",            // GUID made by the plugin; resends are ignored
//     "kind": "series",              // "series" | "movie"
//     "title": "Starfall Academy",
//     "year": 2023,
//     "sourceUrl": "https://site/watch/starfall-academy/ep-1",
//     "mode": "dub",                 // "dub" | "sub"
//     "minHeight": 1080,
//     "library": { "id": "a1f...", "name": "Anime", "locations": ["/mnt/disk1/anime"] },
//     "scope": "episodes",           // "full" | "seasons" | "episodes"
//     "selections": [{ "season": 2, "episodes": [1, 2, 3] }],
//     "watch": true                  // keep watching the series (schedule)
//   }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const config = require('./config');
const vpn = require('./vpn');
const manager = require('./queue');
const bulk = require('./bulk');
const organizer = require('./organizer');
const pending = require('./pending');
const schedule = require('./schedule');
const watcher = require('./watcher');
const library = require('./library');
const placer = require('./placer');
const engineconfig = require('./engineconfig');
const cfsolve = require('./cfsolve');
const { episodeRefFromUrl } = require('./sites/findtitle');

const ACCEPTED_JOBS_FILE = path.join(app.getPath('userData'), 'accepted-jobs.json');

function onLog(msg) {
  try {
    console.log(msg);
  } catch (e) {
    // ignore
  }
  manager.emit('log', msg);
}

// ---- recent activity (the plugin's Queue > Activity log panel) ----
// Every queue/engine log line (manager 'log' events, which onLog also emits)
// lands in a small ring buffer, so the plugin can poll GET /api/log instead
// of holding an SSE stream open through Jellyfin.
const LOG_MAX = 1000;
const recent = [];
manager.on('log', (msg) => {
  recent.push({ ts: Date.now(), msg: String(msg == null ? '' : msg) });
  if (recent.length > LOG_MAX) recent.splice(0, recent.length - LOG_MAX);
});

function recentLog(since) {
  const after = Number(since) || 0;
  return { items: after ? recent.filter((l) => l.ts > after) : recent.slice() };
}

// ---- accepted-job dedupe (plugin can safely resend) ----

function loadAccepted() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACCEPTED_JOBS_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch (e) {
    // none yet
  }
  return {};
}

function saveAccepted(map) {
  try {
    fs.mkdirSync(path.dirname(ACCEPTED_JOBS_FILE), { recursive: true });
    const tmp = ACCEPTED_JOBS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, ACCEPTED_JOBS_FILE);
  } catch (e) {
    // non-fatal
  }
}

// ---- health ----

function queueCounts() {
  const items = manager.snapshot();
  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    total: items.length,
    queued: count('queued') + count('ready') + count('paused'),
    resolving: count('resolving'),
    downloading: count('downloading'),
    verifying: count('verifying'),
    placing: count('placing'),
    waiting: count('waiting'),
    failed: count('failed'),
    done: count('done')
  };
}

function stagingInfo() {
  const p = engineconfig.stagingPath();
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    // ignore
  }
  return {
    path: p,
    freeBytes: placer.freeBytes(p),
    totalBytes: placer.totalBytes(p)
  };
}

function health() {
  const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
  return {
    name: 'webvideodownloader-engine',
    version: pkg.version,
    platform: process.platform,
    engineMode: process.argv.slice(1).includes('--engine'),
    vpn: vpn.status(),
    readOnly: library.isReadOnly(),
    queue: queueCounts(),
    staging: stagingInfo(),
    cloudflare: { configured: cfsolve.enabled(), solverUrl: cfsolve.solverBase() }
  };
}

// ---- title (episode list + per-episode status) ----

function queuedKey(series, season, episode) {
  return [series, season == null ? '' : season, episode == null ? '' : episode].join('|');
}

function isQueued(series, season, episode) {
  const key = queuedKey(series, season, episode);
  return manager
    .snapshot()
    .some((it) => it.status !== 'cancelled' && queuedKey(it.series, it.season, it.episode) === key);
}

// Episode list for a pasted source URL, with each episode's status:
//   in-library  - a readable copy already exists (staging or a library folder)
//   queued      - already in the engine queue
//   missing     - nothing yet; selectable
async function title(sourceUrl, libraryLocations) {
  const url = String(sourceUrl || '').trim();
  if (!url) throw Object.assign(new Error('url is required'), { code: 'BAD_REQUEST', status: 400 });

  const det = await bulk.detectEpisodes(url, onLog, {});
  const ref = episodeRefFromUrl(url);
  const series = (ref && ref.title) || 'Unknown series';
  const season = det.season != null ? det.season : ref.season != null ? ref.season : 1;

  let list = det.list && det.list.length ? det.list.slice() : [];
  if (!list.length && det.max > 0) {
    for (let i = 1; i <= det.max; i++) list.push(i);
  }

  const locations = Array.isArray(libraryLocations) ? libraryLocations : [];
  const out = list.map((ep) => {
    const meta = { series, season, episode: ep };
    let status = 'missing';
    let foundPath = null;
    for (const loc of [engineconfig.stagingPath(), ...locations.map((l) => placer.toEnginePath(l))]) {
      try {
        const f = loc ? organizer.existingEpisodeFile(loc, meta) : null;
        if (f) {
          status = 'in-library';
          foundPath = f;
          break;
        }
      } catch (e) {
        // unreadable folder: ignore
      }
    }
    if (status === 'missing' && isQueued(series, season, ep)) status = 'queued';
    return { episode: ep, status, path: foundPath };
  });

  return {
    title: series,
    season,
    aired: det.aired || null,
    total: det.total || null,
    episodes: out
  };
}

// ---- jobs ----

function validateJob(job) {
  if (!job || typeof job !== 'object') throw Object.assign(new Error('job object required'), { code: 'BAD_REQUEST', status: 400 });
  if (!String(job.sourceUrl || '').trim()) throw Object.assign(new Error('sourceUrl is required'), { code: 'BAD_REQUEST', status: 400 });
  if (job.scope && !['full', 'seasons', 'episodes'].includes(job.scope)) {
    throw Object.assign(new Error('scope must be full, seasons or episodes'), { code: 'BAD_REQUEST', status: 400 });
  }
  if (job.scope === 'episodes') {
    if (!Array.isArray(job.selections) || !job.selections.length) {
      throw Object.assign(new Error('selections is required for scope=episodes'), { code: 'BAD_REQUEST', status: 400 });
    }
    for (const sel of job.selections) {
      if (!Array.isArray(sel.episodes) || !sel.episodes.length) {
        throw Object.assign(new Error('each selection needs a non-empty episodes array'), { code: 'BAD_REQUEST', status: 400 });
      }
    }
  }
}

async function submitJob(job) {
  validateJob(job);

  // Idempotency: the engine ignores a jobId it already accepted, so the
  // plugin (and an outbox retry after a lost reply) can safely resend.
  const accepted = loadAccepted();
  if (job.jobId && accepted[job.jobId]) {
    return { accepted: true, duplicate: true, summary: accepted[job.jobId] };
  }

  const url = String(job.sourceUrl).trim();
  const ref = episodeRefFromUrl(url);
  const series = String(job.title || (ref && ref.title) || 'Unknown series').trim();
  const mode = job.mode === 'sub' ? 'sub' : 'dub';
  const staging = engineconfig.stagingPath();
  const lib = job.library && Array.isArray(job.library.locations) ? job.library : null;
  // Quality floor for this job: an explicit job value wins, otherwise the
  // global minimum-quality setting (default 1080). 0 means "best available".
  const globalMin = engineconfig.get().minQuality != null ? Number(engineconfig.get().minQuality) : 1080;
  const minHeight = job.minHeight != null ? Number(job.minHeight) : globalMin;
  const scope = job.scope || 'full';
  // Anime: the plugin sends anime:true and minHeight 0, so the source's own
  // resolution (often 720p) is accepted. TV/movies keep the 1080p floor.
  const anime = !!job.anime;

  // Part 5: sign each library folder with the .mediadownloader marker so a
  // dropped NAS share can never silently collect finished files at its mount
  // point. Folders that are not mounted right now simply get no marker.
  if (lib) {
    const marks = placer.ensureMarkers(
      lib.locations.map((l) => placer.toEnginePath(l, engineconfig.get().pathMappings))
    );
    for (const m of marks) {
      if (!m.ok) onLog(`Library folder ${m.folder} is not ready (${m.reason}); it will be skipped until it is mounted.`);
    }
  }

  let queued = 0;
  let skipped = 0;

  const stamp = (rec) => {
    rec.library = lib;
    rec.minHeight = minHeight;
    rec.jobId = job.jobId || null;
    rec.anime = anime;
    return rec;
  };

  if (job.kind === 'movie') {
    // A movie is one file with no season/episode: <Library>/<Title>/<Title>.mp4
    // (organizer naming). Going through the episode path would name it
    // "<Title> S1E1" and file it under "Season 1".
    const r = await bulk.queueOne(
      stamp({ url, series, season: null, episode: null, mode, outputRoot: staging }),
      onLog
    );
    queued += r.queued;
    skipped += r.skipped;
  } else if (scope === 'episodes') {
    // Pick exact episodes. The pasted URL names one episode; the rest are
    // built from its template so S2E4..S2E11 all resolve.
    for (const sel of job.selections) {
      const season = sel.season != null ? sel.season : (ref && ref.season) || 1;
      for (const ep of sel.episodes) {
        const epUrl =
          require('./urltemplate').buildEpisodeUrl({ baseUrl: url, season, series }, ep) || url;
        const r = await bulk.queueOne(
          stamp({ url: epUrl, series, season, episode: ep, mode, outputRoot: staging }),
          onLog
        );
        queued += r.queued;
        skipped += r.skipped;
      }
    }
  } else {
    // full / seasons: let bulk auto-detect the episode count per season.
    const entries = [{ series, baseUrl: url, mode, startEp: '1', endEp: 'auto' }];
    if (scope === 'seasons' && Array.isArray(job.selections)) {
      entries.length = 0;
      for (const sel of job.selections) {
        entries.push({
          series,
          baseUrl: url,
          season: sel.season != null ? sel.season : (ref && ref.season) || 1,
          mode,
          startEp: '1',
          endEp: 'auto'
        });
      }
    }
    const r = await bulk.startBatch(entries, staging, onLog, {
      stopRunOnFail: false,
      library: lib,
      minHeight,
      anime,
      jobId: job.jobId || null
    });
    queued += r.queued;
    skipped += r.skipped;
  }

  // "Keep watching this series" -> the watcher pulls new episodes daily.
  // Any title that is ALREADY IN THE LIBRARY is watched automatically (new
  // episodes, new seasons, or a re-pull if the copy ever goes missing) - no
  // manual checkbox needed. (Movies included: the daily check just confirms
  // the file is still there.) Only an EXPLICIT opt-out (noWatch:true, sent
  // when the user unchecks the box) stops the auto-watch - a plain
  // watch:false is just "unchecked", which the old UI leaves in its default
  // state, so the library rule still applies for it.
  const optedOut = job.noWatch === true;
  const manualWatch = job.watch === true && job.kind !== 'movie';
  if (!optedOut && !manualWatch) {
    let onDisk = false;
    const roots = [staging];
    if (lib && Array.isArray(lib.locations)) {
      for (const l of lib.locations) {
        try {
          roots.push(placer.toEnginePath(l, engineconfig.get().pathMappings));
        } catch (e) {
          // unreadable location
        }
      }
    }
    for (const r of roots) {
      try {
        if (r && organizer.titleOnDisk(r, series)) {
          onDisk = true;
          break;
        }
      } catch (e) {
        // unreadable folder
      }
    }
    if (onDisk) {
      const { template, season } = bulk.entryTemplate({ baseUrl: url, season: (ref && ref.season) || null });
      schedule.add({
        series,
        season,
        mode,
        template,
        baseUrl: url,
        outputRoot: staging,
        library: lib,
        minHeight,
        anime
      });
      onLog(`"${series}" is already in your library - added to the watch list automatically (new episodes and seasons).`);
    }
  } else if (!optedOut && manualWatch) {
    const { template, season } = bulk.entryTemplate({ baseUrl: url, season: (ref && ref.season) || null });
    schedule.add({
      series,
      season,
      mode,
      template,
      baseUrl: url,
      outputRoot: staging,
      library: lib,
      minHeight,
      anime
    });
    onLog(`Watching "${series}" for new episodes.`);
  }

  const summary = {
    queued,
    skipped,
    series,
    mode,
    scope: job.kind === 'movie' ? 'movie' : scope,
    at: new Date().toISOString()
  };
  if (job.jobId) {
    accepted[job.jobId] = summary;
    saveAccepted(accepted);
  }
  return { accepted: true, duplicate: false, summary };
}

// ---- queue controls ----

function queueSnapshot() {
  return {
    counts: queueCounts(),
    items: manager.snapshot()
  };
}

function queuePause() {
  manager.pause();
  return { paused: true };
}
function queueResume() {
  manager.resume();
  return { paused: false };
}
function queueStop() {
  return manager.stopAll('Stopped via API');
}
function queueRemove(id) {
  // Queue ids are numbers; the HTTP route hands us a string.
  const n = Number(id);
  manager.removeByIds([Number.isFinite(n) ? n : id]);
  return { removed: true };
}
function queueRetry(id) {
  // A failed item: reset its attempts and put it back in the queue.
  const items = manager.items;
  const it = items.find((x) => x.id === Number(id));
  if (!it) throw Object.assign(new Error('queue item not found: ' + id), { code: 'NOT_FOUND', status: 404 });
  it.attempts = 0;
  it.error = null;
  it.status = 'queued';
  manager._emit();
  manager._kick();
  return { retried: true };
}

// ---- waiting for dub ----

function waitingList() {
  return pending.list();
}
function waitingRemove(key) {
  pending.remove(key);
  return { removed: true };
}

// ---- schedules (keep watching) ----

function schedulesList() {
  return schedule.list();
}
function schedulesAdd(spec) {
  const { template, season } = bulk.entryTemplate({
    baseUrl: spec.baseUrl,
    season: spec.season
  });
  const specKey = {
    series: spec.series,
    season,
    mode: spec.mode || 'dub',
    template: template || spec.template,
    baseUrl: spec.baseUrl,
    library: spec.library || null,
    minHeight: Number(spec.minHeight) || 0
  };
  const added = schedule.add(Object.assign({}, specKey, {
    outputRoot: spec.outputRoot || engineconfig.stagingPath()
  }));
  return { added, key: schedule.constructor.key(specKey) };
}
function schedulesRemove(key) {
  schedule.remove(key);
  return { removed: true };
}
function schedulesCheckNow() {
  return watcher.checkSchedules();
}

// ---- settings ----

function settingsGet() {
  const c = engineconfig.get();
  return {
    port: c.port,
    bind: c.bind,
    stagingPath: engineconfig.stagingPath(),
    reserveBytes: c.reserveBytes,
    fillMode: c.fillMode,
    pathMappings: c.pathMappings,
    minQuality: c.minQuality != null ? c.minQuality : 1080,
    jellyfin: { baseUrl: c.jellyfin.baseUrl, apiKey: c.jellyfin.apiKey ? 'set' : '' },
    readOnly: library.isReadOnly(),
    vpn: vpn.status(),
    // Cloudflare solver (FlareSolverr-compatible). When configured, challenged
    // pages are cleared automatically (no on-screen checkbox) and the CF-gated
    // catalogs become a popup-free backup. `reachable` is a live probe.
    cloudflare: { solverUrl: (c.cloudflare && c.cloudflare.solverUrl) || '' }
  };
}

async function settingsGetAsync() {
  const base = settingsGet();
  try {
    base.cloudflare = await cfsolve.status();
  } catch (e) {
    base.cloudflare = { configured: false, solverUrl: (engineconfig.get().cloudflare && engineconfig.get().cloudflare.solverUrl) || '' };
  }
  return base;
}

function settingsPut(patch) {
  const allowed = {};
  for (const k of ['port', 'bind', 'stagingPath', 'reserveBytes', 'fillMode', 'pathMappings']) {
    if (patch && patch[k] !== undefined) allowed[k] = patch[k];
  }
  if (patch && patch.minQuality != null) {
    const q = Number(patch.minQuality);
    allowed.minQuality = Number.isFinite(q) && q >= 0 ? q : 1080;
  }
  if (patch && patch.jellyfin) {
    allowed.jellyfin = {};
    if (patch.jellyfin.baseUrl !== undefined) allowed.jellyfin.baseUrl = String(patch.jellyfin.baseUrl);
    if (patch.jellyfin.apiKey !== undefined) allowed.jellyfin.apiKey = String(patch.jellyfin.apiKey);
  }
  if (patch && patch.cloudflare && patch.cloudflare.solverUrl !== undefined) {
    allowed.cloudflare = { solverUrl: String(patch.cloudflare.solverUrl).trim() };
  }
  if (Object.keys(allowed).length) engineconfig.set(allowed);
  if (patch && typeof patch.readOnly === 'boolean') {
    library.setReadOnly(patch.readOnly);
    manager._releaseGate(); // wake workers parked in read-only mode
  }
  return settingsGet();
}

// ---- Part 6: engine-side duplicate check ----
// Checks a title against the library folders + staging + the queue. The
// plugin calls this before showing any title, and the engine re-runs the same
// logic at queue time, so a job from curl or a stale outbox entry cannot
// create a duplicate either.
async function libraryCheck(payload) {
  const series = String((payload && payload.series) || '').trim();
  if (!series) throw Object.assign(new Error('series is required'), { code: 'BAD_REQUEST', status: 400 });
  const movie = payload.kind === 'movie';
  const season = !movie && payload.season != null ? payload.season : null;
  const episodes = !movie && Array.isArray(payload.episodes) && payload.episodes.length ? payload.episodes : [null];
  const locations = Array.isArray(payload.locations) ? payload.locations : [];
  const folders = [engineconfig.stagingPath(), ...locations.map((l) => placer.toEnginePath(l))];

  const out = [];
  for (const ep of episodes) {
    const meta = { series, season, episode: ep };
    let status = 'missing';
    let foundPath = null;
    for (const folder of folders) {
      try {
        if (!folder) continue;
        // A movie (no episode) is matched on its exact <Title>/<Title>.mp4 path.
        const f = ep != null || movie ? organizer.existingEpisodeFile(folder, meta) : null;
        if (f) {
          foundPath = f;
          break;
        }
      } catch (e) {
        // unreadable folder
      }
    }
    if (foundPath) {
      const probed = await require('./verify').verifyFile(foundPath);
      const floor = Number(payload.minHeight) || 0;
      status = probed.probeOk && (!floor || probed.height >= floor) ? 'in-library' : 'low-quality';
      out.push({
        episode: ep,
        status,
        path: foundPath,
        height: probed.height || null,
        ours: library.isOurs(foundPath)
      });
    } else if ((ep != null || movie) && isQueued(series, season, ep)) {
      out.push({ episode: ep, status: 'queued' });
    } else {
      out.push({ episode: ep, status: 'missing' });
    }
  }
  return { series, season, episodes: out };
}

// ---- drives verification (Part 5 safety net) ----
// The plugin (Settings > Verify drives) forwards the library set it sees; the
// engine resolves each location and does a write + read-back round-trip so the
// user gets a green/red answer that the drives really line up before trusting
// a download. Accepts { libraries: [{name, locations}] } or a single library.
async function verifyDrives(payload) {
  let libs = [];
  if (Array.isArray(payload && payload.libraries) && payload.libraries.length) {
    libs = payload.libraries;
  } else if (payload && payload.library) {
    libs = [payload.library];
  } else if (payload && Array.isArray(payload.locations)) {
    libs = [{ name: payload.name || '', locations: payload.locations }];
  }
  const out = [];
  for (const lib of libs) {
    out.push(await placer.verifyLibrary(lib));
  }
  return { verifiedAt: new Date().toISOString(), count: out.length, allOk: out.every((r) => r.ok), libraries: out };
}

// ---- source health (Overview "Sources" row) ----
// Lightweight reachability probe per known source, run FROM THE ENGINE so it
// reflects the engine's own IP (the thing that matters for downloads). Reports
// ok / limited / blocked / needs-solver / down per source so the user can see
// at a glance which catalogs are actually alive before queueing a title.
async function sourcesHealth() {
  const httpsMod = require('https');
  const httpMod = require('http');
  const UA = config.download.userAgent;
  const probes = [
    { id: 'vidsrc', name: 'Vidsrc', kind: 'api', url: 'https://data.vidsrc.sh/api.php?type=tv&tmdb=125988&season=1&episode=1' },
    { id: 'nontongo', name: 'NontonGo', kind: 'page', url: 'https://sv2.nontongo.day/01russia/multisourcesoap.php?id=125988&season=1&episode=1&type=tv' },
    { id: 'fmovies', name: 'FMovies', kind: 'cf', url: 'https://movienow.online/' },
    { id: 'flixtor', name: 'Flixtor', kind: 'cf', url: 'https://flixtor.to/' }
  ];
  async function probe(p) {
    const started = Date.now();
    const mod = p.url.startsWith('http:') ? httpMod : httpsMod;
    try {
      const res = await new Promise((resolve, reject) => {
        const req = mod.get(p.url, { headers: { 'User-Agent': UA }, timeout: 8000 }, (rs) => {
          rs.resume();
          resolve({ status: rs.statusCode || 0, headers: rs.headers || {} });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      const ms = Date.now() - started;
      const s = res.status;
      const cf = /cloudflare/i.test(String(res.headers['server'] || '')) || !!(res.headers['cf-ray']);
      let status = 'ok';
      let detail = 'HTTP ' + s;
      if (p.kind === 'api') {
        if (s === 200) { status = 'ok'; detail = 'API reachable'; }
        else if (s === 403) { status = 'blocked'; detail = 'HTTP 403 — this IP is blocked by Vidsrc (VPN node)'; }
        else if (s === 429) { status = 'limited'; detail = 'HTTP 429 — rate-limited right now'; }
        else { status = 'down'; detail = 'HTTP ' + s; }
      } else if (p.kind === 'cf') {
        if (s === 200) { status = 'ok'; detail = 'reachable'; }
        else if (s === 403 || cf) { status = 'needs-solver'; detail = 'Cloudflare challenge — needs the solver'; }
        else { status = 'down'; detail = 'HTTP ' + s; }
      } else {
        if (s === 200) { status = 'ok'; detail = 'reachable'; }
        else if (s === 403) { status = 'blocked'; detail = 'HTTP 403'; }
        else { status = 'down'; detail = 'HTTP ' + s; }
      }
      return { id: p.id, name: p.name, status, detail, ms };
    } catch (e) {
      return { id: p.id, name: p.name, status: 'down', detail: (e && e.message) || 'unreachable', ms: Date.now() - started };
    }
  }
  const sources = await Promise.all(probes.map(probe));
  try {
    const s = await cfsolve.status();
    sources.push({
      id: 'solver',
      name: 'Cloudflare solver',
      status: !s.configured ? 'off' : s.reachable ? 'ok' : 'down',
      detail: s.configured ? (s.reachable ? 'reachable · ' + s.solverUrl : 'unreachable · ' + s.solverUrl) : 'not configured',
      ms: 0
    });
  } catch (e) { /* ignore */ }
  // Include the VPN state so the UI can say which IP these probes ran on —
  // the whole point of this row is "what does the engine's IP see right now".
  let vpnInfo = null;
  try { vpnInfo = vpn.status(); } catch (e) { /* ignore */ }
  return { checkedAt: new Date().toISOString(), vpn: vpnInfo, sources };
}

module.exports = {
  health,
  title,
  submitJob,
  queueSnapshot,
  queuePause,
  queueResume,
  queueStop,
  queueRemove,
  queueRetry,
  waitingList,
  waitingRemove,
  schedulesList,
  schedulesAdd,
  schedulesRemove,
  schedulesCheckNow,
  settingsGet,
  settingsGetAsync,
  settingsPut,
  sourcesHealth,
  libraryCheck,
  verifyDrives,
  onLog,
  recentLog,
  stagingInfo
};
