'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');
const config = require('./config');
const vpn = require('./vpn');
const organizer = require('./organizer');
const library = require('./library');
const placer = require('./placer');
const { download, lastFfmpegStderr } = require('./downloader');
const { verifyFile, belowMinHeight, audioLanguages } = require('./verify');
const audiolang = require('./audiolang');
const integrity = require('./integrity');
const hlscheck = require('./hlscheck');
const sites = require('./sites');
const cfsolve = require('./cfsolve');
const tmdb = require('./tmdb');
const { writeJsonAtomic, readJson } = require('./jsonfile');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;

// Servers that delivered the WRONG audio for a series (a DUB row whose stream
// is the original language), remembered for this run: the series' next
// episodes skip them instead of each downloading a whole wrong file first.
// "series|mode" -> Set(server label)
const wrongAudioServers = new Map();

// ---- queue liveness (future-proofing: nothing may sit stuck forever) ------
// Phase caps for the watchdog. Any phase that runs past its cap is killed
// and the item is retried like any other failed attempt - a hang (a promise
// that never settles, a page that never finishes, a copy that never ends)
// can never wedge the queue. Caps are deliberately generous so a SLOW but
// healthy download is never touched:
//   resolving  - discovery walks several sources; 20 min is very slow
//   ready      - waiting for a download slot; the slot holder has its own
//                (downloading) cap, so this just needs to be bounded
//   verifying  - ffprobe is capped at 30 s; 10 min is far beyond it
//   placing    - must exceed the placement child's own 90-min timeout
// downloading  - computed per item: the downloader's own watchdog allows up
//                to 6x the media duration, so the cap must be looser (below).
const PHASE_CAPS_MS = {
  resolving: 20 * 60000,
  ready: 14 * 3600000,
  verifying: 10 * 60000,
  placing: 95 * 60000
};
const DOWNLOAD_CAP_MIN_MS = 30 * 60000;

// Sequential download manager. Each item carries a `discover()` closure that
// resolves a fresh stream (used on first attempt and on every retry, so expiring
// tokens are re-fetched). Integrates VPN gating (pause on drop, resume on
// reconnect), retries with backoff, integrity verification, and atomic rename.
class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this._paused = false;
    this._vpnDown = false;
    this._active = new Set(); // items currently being processed (per-site concurrency + prefetch)
    this._noQualitySeasons = new Map(); // "<tmdb|series>|<season>" -> when an episode fell back to 720p
    this._pauseWaiters = [];
    this._downloadWaiters = [];
    this._watchdogTimer = null;
    this.watchdogTickMs = 30000; // mutable for tests

    vpn.on('status', ({ connected }) => this._onVpnStatus(connected));
  }

  // Abort the in-flight network request of every active download (used by
  // pause / VPN-drop / stop). Aborted downloads keep their partial file and are
  // resumed/retried through the gate.
  _abortAll() {
    for (const it of this._active) {
      if (it._controller) it._controller.abort();
    }
  }

  _onVpnStatus(connected) {
    if (!connected) {
      this._vpnDown = true;
      this._log('VPN disconnected - pausing downloads.');
      this._abortAll();
    } else {
      if (this._vpnDown) this._log('VPN reconnected - resuming downloads.');
      this._vpnDown = false;
      this._releaseGate();
      this._kick();
    }
    this._emit();
  }

  // ---- public API ----

  add(item) {
    this._startWatchdog();
    const ACTIVE = ['queued', 'resolving', 'downloading', 'verifying', 'paused', 'ready', 'placing'];
    // Dedupe by key (used by the watcher): skip if an equivalent item is already
    // active; replace any stale (waiting/failed/done) one so it can retry.
    if (item.key) {
      if (this.items.some((it) => it.key === item.key && ACTIVE.includes(it.status))) {
        return null;
      }
      this.items = this.items.filter((it) => it.key !== item.key);
    }
    // A fresh add re-enables the runner after a previous user Stop.
    this._stopRequested = null;
    const it = Object.assign(
      {
        id: nextId++,
        status: 'queued',
        progress: null,
        error: null,
        attempts: 0,
        finalPath: null,
        expectedDuration: 0,
        bytes: 0,
        stopRunOnFail: false, // bulk sets true; single/watcher leave false
        onUnavailable: null,
        onDone: null,
        key: null,
        group: null, // series-batch id (for grouping + auto-removal in the UI)
        mode: null,
        episode: null,
        // Engine (Part 5): the library this job's finished files belong in,
        // plus the quality floor and the plugin's jobId for traceability.
        // minHeight null = "no explicit floor" -> _minHeight falls back to the
        // site profile's floor (desktop items). A number (even 0 = best
        // available) is an explicit per-job choice and wins.
        library: null,
        minHeight: null,
        jobId: null,
        // Fields needed to rebuild this item after an app restart.
        url: null,
        template: null,
        baseUrl: null
      },
      item
    );
    this.items.push(it);
    this._emit();
    this._kick();
    return it.id;
  }

  pause() {
    this._paused = true;
    this._log('Paused by user.');
    this._abortAll();
    this._emit();
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._log('Resumed by user.');
    this._releaseGate();
    this._kick();
    this._emit();
  }

  // Stop everything and drop the rest of the queue.
  stopAll(reason) {
    this._stopRequested = reason || 'Stopped';
    // Stop overrides a prior Pause so workers aren't left parked at the gate.
    this._paused = false;
    this.items.forEach((it) => {
      if (['queued', 'paused', 'downloading', 'resolving', 'verifying', 'ready'].includes(it.status)) {
        it.status = this._active.has(it) ? it.status : 'cancelled';
      }
    });
    this._abortAll(); // kill in-flight downloads
    this._releaseGate(); // wake any paused/VPN-gated workers so they can exit
    this._emit();
  }

  // Remove specific items by id (aborting any active downloads in the set).
  // Used by the per-series Remove button.
  removeByIds(ids) {
    const set = new Set(ids || []);
    if (!set.size) return;
    for (const it of this._active) {
      if (set.has(it.id) && it._controller) it._controller.abort();
    }
    this.items = this.items.filter((it) => !set.has(it.id));
    // Wake workers parked at the pause/VPN gate or waiting for a download
    // slot: their loops see the item is gone and exit. Without this a removed
    // "ready"/paused item kept its worker forever, and that site lost a slot
    // until restart.
    this._releaseGate();
    this._emit();
  }

  // Put a finished item (failed / cancelled / waiting / skipped) back on the
  // queue with a fresh retry budget. An item that is still being worked on is
  // left alone: resetting it would corrupt the running worker's state.
  // Returns false when the id is unknown, null when the item is still active.
  retry(id) {
    const it = this.items.find((x) => x.id === Number(id));
    if (!it) return false;
    if (this._active.has(it)) return null;
    it.attempts = 0;
    it._failStreak = 0;
    it.error = null;
    it.status = 'queued';
    // A fresh look: what the last run concluded (not on any site, not out
    // yet, Vidsrc refusing, ...) is asked again, not taken as given.
    for (const k of ['_notFound', '_noQuality', '_unobtainable', '_notOutChecked', '_skipVidsrcPages', '_heldForVidsrc', '_notBefore', '_exclusive', '_exclusiveHintChecked', '_exclusiveHint', '_wrongAudio', '_headlessTried', '_watchdogKilled', '_watchdogKilledAt']) delete it[k];
    it.skipSources = [];
    this._stopRequested = null;
    this._emit();
    this._kick();
    return true;
  }

  // Re-check every parked worker (after read-only mode or a setting that
  // gates downloads changes).
  wake() {
    this._releaseGate();
    this._kick();
  }

  // Write the restart manifest now (app quit).
  persist() {
    this._persist();
  }

  // Remove everything and abort all active downloads.
  clearAll() {
    // Clear overrides Pause so the manager isn't left paused for future adds.
    this._paused = false;
    this.items = [];
    this._abortAll(); // kill in-flight downloads
    this._releaseGate(); // wake any paused/VPN-gated workers so they exit (items now empty)
    this._emit();
  }

  snapshot() {
    return this.items.map((it) => ({
      id: it.id,
      label: it.label,
      status: it.status,
      progress: it.progress,
      bytes: it.bytes || 0,
      parts: it.status === 'downloading' ? it.parts || null : null,
      speed: it.status === 'downloading' && it.speed > 0 ? Math.round(it.speed) : null,
      eta: it.status === 'downloading' && it.eta > 0 ? Math.round(it.eta) : null,
      error: it.error,
      attempts: it.attempts,
      finalPath: it.finalPath,
      series: it.series,
      season: it.season,
      episode: it.episode,
      mode: it.mode,
      group: it.group
    }));
  }

  // Once every episode of a series-batch has reached a terminal state, drop
  // the whole group from the queue so the next queued series becomes the
  // focus. Groups with episodes still waiting/queued/failed are kept. "skipped"
  // (already in the library, left untouched) counts as terminal.
  _pruneGroupIfComplete(group) {
    if (!group) return;
    const groupItems = this.items.filter((it) => it.group === group);
    const terminal = (it) => it.status === 'done' || it.status === 'skipped';
    if (!groupItems.length || !groupItems.every(terminal)) return;
    const name = groupItems[0].series || groupItems[0].label || 'Series';
    this.items = this.items.filter((it) => it.group !== group);
    this._log(`Series complete: ${name} (${groupItems.length} episode(s)) - removed from queue.`);
    this._emit();
  }

  // ---- internals ----

  // The episode's file on one of the TARGET library's drives, or ''. Only
  // the job's own library (the one it will be placed in), with the drive
  // paths translated to the engine PC's, the same way placement does.
  _inTargetLibrary(item, meta) {
    const lib = item && item.library;
    const locs = lib && Array.isArray(lib.locations) ? lib.locations : [];
    if (!locs.length) return '';
    let mappings = [];
    try { mappings = (require('./engineconfig').get() || {}).pathMappings || []; } catch (e) { mappings = []; }
    for (const loc of locs) {
      let root = '';
      try { root = placer.toEnginePath(loc, mappings); } catch (e) { root = ''; }
      if (!root) continue;
      try {
        const f = organizer.existingEpisodeFile(root, meta, null, (item && item.episodeName) || '');
        if (f) return f;
      } catch (e) {
        // unreadable drive: placement still refuses to overwrite
      }
    }
    return '';
  }

  // Per-site download limits. SFlix uses the global 5-wide queue (NontonGo MP4).
  // Player-bound token CDNs still serialize via _playerBoundHeld.
  _itemLimits(item) {
    const url = String((item && (item.url || item.baseUrl)) || '');
    const profile = url ? sites.resolve(url) : null;
    const site = (profile && profile.download) || {};
    const concurrency = Math.max(
      1,
      site.concurrency != null ? site.concurrency : config.download.concurrency || 1
    );
    const prefetch = Math.max(
      0,
      site.prefetchDiscover != null ? site.prefetchDiscover : config.download.prefetchDiscover || 0
    );
    return {
      siteId: (profile && profile.id) || 'generic',
      concurrency,
      prefetch,
      maxWorkers: concurrency + prefetch
    };
  }

  _siteActiveCount(siteId) {
    let n = 0;
    for (const it of this._active) {
      if (this._itemLimits(it).siteId === siteId) n += 1;
    }
    return n;
  }

  _siteDownloadHeld(siteId) {
    let n = 0;
    for (const it of this.items) {
      if (it._holdsDownloadSlot && this._itemLimits(it).siteId === siteId) n += 1;
    }
    return n;
  }

  _playerBoundHeld() {
    let n = 0;
    for (const it of this.items) {
      if (it._holdsDownloadSlot && it._playerBoundDownload) n += 1;
    }
    return n;
  }

  // ---- queue liveness watchdog ---------------------------------------------
  // Belt-and-braces around EVERY phase, including ones added later:
  //   1. phase caps - a stuck item is killed and retried (never parked);
  //   2. re-kick    - queued items with no running worker get kicked again,
  //      so a dead worker or a lost kick can never wedge the queue.
  // The downloader's stall watchdog (inside the ffmpeg/stream layer) is the
  // fast, byte-level guard; this is the slow net around the whole lifecycle.
  _phaseCap(item) {
    if (item.status === 'verifying') {
      // The playback check decodes the whole file (~1 s per minute of 1080p
      // here; slower machines more): scale with the runtime.
      const dur = item.expectedDuration > 0 ? item.expectedDuration : 0;
      return Math.max(PHASE_CAPS_MS.verifying, dur * 2 * 1000);
    }
    const cap = PHASE_CAPS_MS[item.status];
    if (cap != null) return cap;
    if (item.status === 'downloading') {
      const dur = item.expectedDuration > 0 ? item.expectedDuration : 0;
      return Math.max(DOWNLOAD_CAP_MIN_MS, (dur * 6 + 30 * 60) * 1000);
    }
    return null; // queued (gated), waiting, paused, failed, done: legitimate holds
  }

  _watchdogTick() {
    const now = Date.now();
    for (const item of this.items) {
      if (!this._active.has(item)) continue;
      if (item._lastPhase !== item.status) {
        item._lastPhase = item.status;
        item._phaseAt = now;
        continue;
      }
      const cap = this._phaseCap(item);
      if (!cap) continue;
      const age = now - (item._phaseAt || now);
      if (age <= cap) continue;
      const mins = Math.max(1, Math.round(age / 60000));
      // Already killed and still not back: the abort is on its way (or the
      // wait ignores it). Say so again at most every 10 min, not every tick.
      if (item._watchdogKilled && item._watchdogKilledAt && now - item._watchdogKilledAt < 10 * 60000) continue;
      item._watchdogKilledAt = now;
      this._log(
        `"${item.label}" was stuck in "${item.status}" for ${mins} min - killing it so the queue can move on (it will retry).`
      );
      // A stuck download: surface what ffmpeg was actually doing (segment 403s,
      // reconnect loops, a slow drip) so the next log tells us the root cause
      // instead of only the phase name.
      if (item.status === 'downloading') {
        try {
          const snap = lastFfmpegStderr();
          if (snap && snap.tail && Date.now() - (snap.at || 0) < 15 * 60000) {
            const lines = String(snap.tail)
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(-8)
              .join(' | ');
            this._log(`ffmpeg (last output before kill): ${lines.slice(-700)}`);
          }
        } catch (e) {
          /* diagnostics only */
        }
      }
      item._watchdogKilled = true;
      item._watchdogReason = `stuck in "${item.status}" for ${mins} min`;
      try {
        if (item._controller) item._controller.abort();
      } catch (e) {
        /* ignore */
      }
    }
    // Re-kick liveness. (isReadOnly can throw if the data dir is unreadable;
    // never let the watchdog itself die.)
    let readOnly = false;
    try {
      readOnly = library.isReadOnly();
    } catch (e) {
      readOnly = false;
    }
    if (
      !this._paused &&
      !this._vpnDown &&
      !this._stopRequested &&
      !readOnly &&
      this._active.size === 0 &&
      this.items.some((i) => i.status === 'queued' && !(i._notBefore && i._notBefore > Date.now()))
    ) {
      this._log('Queue liveness: items are queued but no worker is running - re-kicking.');
      this._kick();
    }
  }

  _startWatchdog() {
    if (this._watchdogTimer) return;
    const tick = this.watchdogTickMs > 0 ? this.watchdogTickMs : 30000;
    this._watchdogTimer = setInterval(() => {
      try {
        this._watchdogTick();
      } catch (e) {
        this._log('Queue watchdog error: ' + e.message);
      }
    }, tick);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  // Fills the worker pool: up to each site's concurrency downloads, plus that
  // site's prefetch so the queue does not sit idle between files.
  _kick() {
    if (this._stopRequested) return;
    for (const item of this.items) {
      if (item.status !== 'queued' || this._active.has(item)) continue;
      if (item._notBefore && item._notBefore > Date.now()) continue; // held (Vidsrc paused)
      const lim = this._itemLimits(item);
      if (this._siteActiveCount(lim.siteId) >= lim.maxWorkers) continue;
      this._startWorker(item);
    }
  }

  async _waitDownloadSlot(item) {
    if (item._holdsDownloadSlot) return true;
    const lim = this._itemLimits(item);
    while (!this._stopRequested && this.items.includes(item)) {
      if (!this._paused && !this._vpnDown && this._siteDownloadHeld(lim.siteId) < lim.concurrency) {
        item._holdsDownloadSlot = true;
        return true;
      }
      if (item.status !== 'ready') {
        item.status = 'ready';
        this._log(`"${item.label}" is ready; download starts when a ${lim.siteId} slot frees.`);
        this._emit();
      }
      await new Promise((resolve) => this._downloadWaiters.push(resolve));
    }
    return false;
  }

  _releaseDownloadSlots() {
    const w = this._downloadWaiters;
    this._downloadWaiters = [];
    w.forEach((fn) => fn());
  }

  _releaseDownloadSlot(item) {
    if (item && item._holdsDownloadSlot) {
      item._holdsDownloadSlot = false;
    }
    this._releaseDownloadSlots();
  }

  _startWorker(item) {
    this._active.add(item);
    // A worker only ever affects its OWN item. Whatever the outcome (done,
    // failed, waiting, cancelled), we just free the slot and pull in the next
    // queued item - one episode can never stop the rest of the queue.
    this._process(item)
      .catch((e) => this._log('Runner error: ' + e.message))
      .finally(() => {
        this._active.delete(item);
        this._releaseDownloadSlot(item);
        this._kick();
      });
  }

  // TMDB "licensed exclusive" hint for this item's title, when the source URL
  // carries a TMDB id. '' when unknown - this must NEVER block a download on a
  // guess, so any lookup failure degrades to "not exclusive" (old behaviour).
  // The answer is cached on the item: it is per-title and stable within a run.
  async _exclusiveHint(item) {
    if (item._exclusiveHintChecked) return item._exclusiveHint || '';
    item._exclusiveHintChecked = true;
    try {
      const src = String(item.url || item.baseUrl || '');
      let tmdbId = String(item.tmdb || '');
      if (!tmdbId) {
        const m = src.match(/embed\/(?:tv|movie)\/(\d{1,9})(?=[-/?#]|$)/);
        if (m) tmdbId = m[1];
      }
      if (!tmdbId) return '';
      const isMovie = /\/embed\/movie\//.test(src);
      const provs = await tmdb.watchProviders(tmdbId, isMovie ? 'movie' : 'tv');
      const hint = tmdb.exclusiveHint(provs) || '';
      item._exclusiveHint = hint;
      return hint;
    } catch (e) {
      return '';
    }
  }

  // Blocks while paused, VPN is down, or the library is in read-only mode, but
  // bails immediately if the queue was stopped or this item was removed (so
  // Stop/Clear can tear a parked worker down instead of leaving it stuck
  // waiting).
  async _gate(item) {
    let readOnlyNoted = false;
    while (
      (this._paused || this._vpnDown || library.isReadOnly()) &&
      !this._stopRequested &&
      this.items.includes(item)
    ) {
      if (library.isReadOnly() && !readOnlyNoted) {
        readOnlyNoted = true;
        this._log('Library is in read-only mode; downloads are held until it is turned off.');
      }
      await new Promise((resolve) => this._pauseWaiters.push(resolve));
    }
  }

  _releaseGate() {
    const w = this._pauseWaiters;
    this._pauseWaiters = [];
    w.forEach((fn) => fn());
    this._releaseDownloadSlots();
  }

  _minHeight(item) {
    // Anime: no resolution floor (the source's own resolution, often 720p,
    // is accepted). TV/movies keep the profile's 1080p floor.
    if (item && item.anime) return 0;
    // An explicit per-item floor (engine jobs stamp it; 0 = "best available")
    // wins over the profile, same rule dubselect applies. Items without an
    // explicit value (desktop queue, template default null) keep the profile's
    // floor as before.
    if (item && item.minHeight != null) return Number(item.minHeight) || 0;
    const url = String((item && (item.url || item.baseUrl)) || '');
    const profile = url ? sites.resolve(url) : null;
    return (profile && profile.minHeight) || 0;
  }

  // Only ever called on the .part file of a failed/low-quality download.
  // Library files at finalPath are never dropped here (Part 11 rule).
  _dropShortFile(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      // ignore
    }
  }

  // 1080p first, 720p as the fallback (TV and movies). When every try at the
  // job's floor has failed for QUALITY reasons (Vidsrc handed out 720p-only
  // servers, the fallback sites had nothing better), the episode is tried
  // once more accepting 720p or better - a 720p copy beats none. The watch
  // list counts any copy as present, so it is not re-fetched in a loop; the
  // placer replaces it only if the episode is queued again and a better copy
  // is found. Anime has no floor (the source's own resolution).
  _fallbackFloor(item, reason, opts = {}) {
    const FALLBACK = 720;
    if (!item || item.anime || item._floorFallback || item._exclusive || item.upgrade) return false;
    const floor = this._minHeight(item);
    if (!(floor > FALLBACK)) return false;
    const quality = item._noQuality || /no \d+p|not \d+p|\d+p, not \d+p|below \d+p|no 1080p/i.test(String(reason || ''));
    if (!quality) return false;
    item._floorFallback = floor;
    // The rest of this season gets the same answer from the same sources:
    // remember it so its next episodes skip the minutes-long 1080p search.
    if (!opts.quiet) this._noQualitySeasons.set(this._seasonKey(item), Date.now());
    item.minHeight = FALLBACK;
    item.attempts = 0;
    item._noQuality = false;
    item._notFound = false;
    item._failStreak = 0;
    item.skipSources = [];
    item.status = 'queued';
    item.error = null;
    this._emit();
    this._log(opts.quiet
      ? `"${item.label}": earlier episodes of this season had no ${floor}p copy anywhere either; taking the best copy at ${FALLBACK}p or better.`
      : `"${item.label}": no ${floor}p copy on any source; trying again for the best copy at ${FALLBACK}p or better.`);
    return true;
  }

  // Speed and time left, from the last ~20 s of progress: bytes per second
  // when the bytes are known, and the time left from how fast the progress
  // itself moves (works for part counts too).
  _sampleRate(item, p) {
    const now = Date.now();
    const bytes = p && p.unit === 'parts' ? Number(p.bytesThisRun) || 0 : Number(p && p.received) || 0;
    const prog = item.progress != null ? item.progress : 0;
    const w = (item._rateWin = item._rateWin || []);
    w.push({ t: now, bytes, prog });
    while (w.length > 2 && now - w[0].t > 20000) w.shift();
    const a = w[0];
    const dt = (now - a.t) / 1000;
    if (dt < 2) return;
    const db = bytes - a.bytes;
    item.speed = db > 0 ? db / dt : 0;
    const dp = prog - a.prog;
    item.eta = dp > 0 ? ((1 - prog) / dp) * dt : null;
  }

  // One show (the 720p-fallback memory). Per show, not per season: the same
  // sources serve every season the same way (House S1-S8 are all 720p-only on
  // Vidsrc and on no other site), and each season used to pay the full
  // 1080p search again. Movies are their own key.
  _seasonKey(item) {
    return String((item && (item.tmdb || item.series)) || '').toLowerCase() + (item && item.episode == null ? '|movie' : '');
  }

  // An episode of this show fell back to 720p within the last 6 h.
  _seasonFellBack(item) {
    const at = this._noQualitySeasons.get(this._seasonKey(item)) || 0;
    return Date.now() - at < 6 * 3600 * 1000;
  }

  // A wait inside "resolving" that does not listen to the item's abort (a
  // hung discovery window, a site API that never answers) used to hold the
  // worker forever: the watchdog "killed" House S1E1 every 30 s for 7 h and
  // nothing moved. Every such wait is raced against the item's abort; the
  // abandoned promise is left to settle on its own.
  _abortable(item, promise) {
    const sig = item && item._controller && item._controller.signal;
    if (!sig) return promise;
    if (sig.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      sig.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        (v) => { sig.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { sig.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  }

  // Stopped (Stop all) or removed while it was being worked on.
  _interrupted(item) {
    return !!(this._stopRequested || !this.items.includes(item) || (item && item._controller && item._controller.signal && item._controller.signal.aborted));
  }

  // Do the dub sources list this anime episode as English-dubbed? (Aniwave's
  // episode list, Anime Village's saved answers.) true / false / null, never
  // slower than 20 s.
  async _knownDubbed(item) {
    if (!item || item.episode == null) return null;
    try {
      const ds = require('./dubstatus');
      return await Promise.race([
        ds.isDubbedForJob({ title: item.series, season: item.season, episode: item.episode, tmdb: item.tmdb, numbering: item.numbering }),
        new Promise((res) => setTimeout(() => res(null), 20000))
      ]);
    } catch (e) {
      return null;
    }
  }

  // A finished episode is no longer waiting for its dub, whoever queued it.
  _clearWaiting(item) {
    if (!item || item.episode == null) return;
    try {
      const n = require('./pending').removeEpisode({ series: item.series, season: item.season, episode: item.episode, mode: item.mode || 'dub' });
      if (n) this._log(`"${item.label}" is downloaded - removed from the waiting-for-dub list.`);
    } catch (e) {
      // the daily pass clears it from disk anyway
    }
  }

  // Every "done" exit goes through here (Jellyfin build plan Part 5).
  // Engine jobs carry a library: the finished file still sits in staging and
  // must be placed onto a library drive first. NO_SPACE leaves the file in
  // staging and re-queues the item (the next pass re-places it, no re-download)
  // when a drive has room. Desktop jobs (no library) behave exactly as before.
  async _settle(item, finishedPath, bytes, note) {
    item.finalPath = finishedPath;
    if (bytes) item.bytes = bytes;
    if (typeof item.onDone === 'function') {
      try {
        item.onDone(item);
      } catch (e) {
        // ignore
      }
    }
    if (!item.library) {
      item.status = 'done';
      item.progress = 1;
      this._clearWaiting(item);
      this._emit();
      this._log(note || `Completed: ${path.basename(finishedPath)}`);
      this._pruneGroupIfComplete(item.group);
      return { fatal: false };
    }
    item.status = 'placing';
    this._emit();
    this._log(`Placing ${path.basename(finishedPath)} onto "${item.library.name || 'the library'}"...`);
    let result;
    try {
      result = await placer.placeItem(item, finishedPath);
    } catch (err) {
      if (err && err.code === 'NO_SPACE') {
        if (this._stopRequested) {
          item.status = 'cancelled';
          this._emit();
          this._pruneGroupIfComplete(item.group);
          return { fatal: false };
        }
        // The file stays in staging; the next pass finds it and re-places it.
        item.status = 'queued';
        item.error = err.message;
        this._emit();
        this._log(
          `${err.message}. "${item.label}" stays in staging and will be placed once a drive has room.`
        );
        const wait = Math.min(
          config.download.retryMaxDelayMs || 60000,
          (config.download.retryBaseDelayMs || 2000) * 3
        );
        await delay(wait);
        return { retry: true };
      }
      throw err;
    }
    item.finalPath = (result && result.finalPath) || finishedPath;
    item.status = 'done';
    item.progress = 1;
    this._clearWaiting(item);
    // Saved below its quality floor (the 720p fallback): checked weekly for a
    // better copy. A copy at the floor replacing one: no longer checked.
    try {
      const up = require('./upgrades');
      if (item._floorFallback && !(result && result.existing)) up.add(item, item.finalPath);
      else if (!item._floorFallback) {
        up.remove(item.finalPath);
        // The file this upgrade replaced (it may have had another name).
        if (item.upgradeFrom) up.remove(item.upgradeFrom);
      }
    } catch (e) { /* bookkeeping only */ }
    this._emit();
    // The library name can differ from the staging one (named like the
    // episodes next to it): say which file it became.
    const placedAs = path.basename(item.finalPath) !== path.basename(finishedPath) ? ` as "${path.basename(item.finalPath)}"` : '';
    this._log(
      result && result.existing
        ? `Completed: "${item.label}" was already in the library; the staging copy was dropped.`
        : (note || `Completed: ${path.basename(finishedPath)}`) +
            `${placedAs} (placed on ${path.dirname(item.finalPath)})`
    );
    this._pruneGroupIfComplete(item.group);
    return { fatal: false };
  }

  async _process(item) {
    while (true) {
      if (this._stopRequested) {
        if (item.status !== 'done') item.status = 'cancelled';
        this._emit();
        return { fatal: false };
      }
      if (!this.items.includes(item)) return { fatal: false }; // removed by user
      await this._gate(item);
      if (this._stopRequested) {
        if (item.status !== 'done') item.status = 'cancelled';
        this._emit();
        return { fatal: false }; // stopped while gated
      }
      if (!this.items.includes(item)) return { fatal: false }; // removed while gated

      const controller = new AbortController();
      item._controller = controller;

      try {
        item.status = 'resolving';
        item.progress = null;
        item.error = null;
        this._emit();

        const meta = { series: item.series, season: item.season, episode: item.episode };
        const finalPath = organizer.expectedPath(item.outputRoot, meta, '.mp4');
        organizer.ensureDir(path.dirname(finalPath));
        item.finalPath = finalPath;
        organizer.cleanupCaptureJunk(path.dirname(finalPath));
        const partPath = finalPath + '.part';
        // Any video container in the library counts as present (.mkv and
        // friends are the normal Jellyfin layout).
        // The TARGET LIBRARY first, before anything is downloaded. This used
        // to check only staging: an episode already on a library drive was
        // downloaded in full and thrown away at placement ("already in
        // library") - Succession S4 was fetched three more times that way.
        // Same rules as placement: a full-quality copy wins; a below-floor
        // copy the engine placed may be replaced; anything unreadable holds.
        // Every identity the episode may be filed under in the library: by
        // the folder's [tmdb-N] id, its TMDB pair (AniDB-numbered jobs) and
        // its absolute number ("S02E25" for Blue Lock S2E1; Ranma's disk
        // Season 2 for TMDB S1E24). Never downloads what is there under
        // another number.
        if (/^\d+$/.test(String(item.tmdb || '').trim()) && item.episode != null) {
          meta.tmdb = String(item.tmdb).trim();
          try {
            meta.alt = await this._abortable(item, tmdb.episodeAlternates(meta.tmdb, { anime: !!item.anime, numbering: item.numbering }, item.season, item.episode));
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            meta.alt = null;
          }
          if (meta.alt) item.presenceAlt = meta.alt;
        }
        // One folder listing per check (several identities, several drives).
        const libHit = organizer.withScanCache(() => this._inTargetLibrary(item, meta));
        if (libHit) {
          const floorL = this._minHeight(item);
          const have = await verifyFile(libHit, {});
          if (have.probeOk && !belowMinHeight(have, floorL)) {
            library.audit('skipped-already-in-library', libHit, `not downloaded: ${item.label}`);
            this._log(`Already in the library, not downloading: ${libHit}`);
            item.status = 'skipped';
            item.error = null;
            item.finalPath = libHit;
            this._emit();
            this._pruneGroupIfComplete(item.group);
            return { fatal: false };
          }
          if (have.probeOk && !library.isOurs(libHit)) {
            library.audit('skipped-foreign', libHit, `${have.height}p below the ${floorL}p floor, but not engine-owned`);
            this._log(`"${path.basename(libHit)}" is ${have.height}p (below ${floorL}p) but was not placed by this engine; left untouched, not downloaded.`);
            item.status = 'skipped';
            item.error = 'existing file is not engine-owned; not replaced';
            this._emit();
            this._pruneGroupIfComplete(item.group);
            return { fatal: false };
          }
          if (!have.probeOk) {
            this._log(`Library copy "${path.basename(libHit)}" could not be verified (${have.reason}); holding "${item.label}" without downloading.`);
            item.status = 'queued';
            item.error = `existing library file unreadable: ${have.reason}`;
            this._emit();
            await delay(Math.min(config.download.retryMaxDelayMs || 60000, (config.download.retryBaseDelayMs || 2000) * 3));
            continue;
          }
          // Below the floor and ours: download the better copy (placement
          // replaces it under the same name).
        }

        const found = organizer.existingEpisodeFile(item.outputRoot, meta) || '';
        // A .part is an aborted remux until proven otherwise. verifyFile with no
        // minDuration only asks for 20s and 64KB, so promoting one on that basis
        // renamed truncated files to .mp4 and reported them Completed. Only trust
        // a .part when a previous attempt recorded how long the episode runs.
        const expected = item.expectedDuration > 0 ? item.expectedDuration : 0;
        const floor = this._minHeight(item);
        if (found) {
          const already = await verifyFile(found, expected ? { minDuration: expected } : {});
          if (already.probeOk && !belowMinHeight(already, floor)) {
            const settled = await this._settle(
              item,
              found,
              already.bytes || item.bytes,
              `Completed: ${path.basename(found)} (kept a finished file from a previous attempt)`
            );
            if (settled.retry) continue;
            return settled;
          }
          if (already.probeOk && belowMinHeight(already, floor)) {
            // Low quality. Only a file the engine itself placed may be
            // replaced; anything else is a library file we must never touch.
            if (!library.isOurs(found)) {
              library.audit('skipped-foreign', found, `${already.height}p below the ${floor}p floor, but not engine-owned`);
              this._log(
                `"${path.basename(found)}" is ${already.height}p (below ${floor}p) but was not placed by this engine; ` +
                  `it is left untouched. Use the quality check to replace it by hand.`
              );
              item.status = 'skipped';
              item.error = 'existing file is not engine-owned; not replaced';
              this._emit();
              this._pruneGroupIfComplete(item.group);
              return { fatal: false };
            }
            item._replacePath = found;
            item._replaceHeight = already.height;
            this._log(
              `"${item.label}" is ${already.height}p, not ${floor}p. On the download list; ` +
                `the old file goes to the trash folder when the ${floor}p copy replaces it.`
            );
          }
          if (!already.probeOk) {
            // "Can't read" (NAS asleep, network blip, ffprobe timeout) is NOT
            // "bad": hold this episode and retry later instead of downloading
            // over a file we cannot inspect. Never replaced.
            this._log(
              `Existing "${path.basename(found)}" could not be verified (${already.reason}); ` +
                `holding "${item.label}" without re-downloading.`
            );
            item.status = 'queued';
            item.error = `existing file unreadable: ${already.reason}`;
            this._emit();
            const wait = Math.min(
              config.download.retryMaxDelayMs || 60000,
              (config.download.retryBaseDelayMs || 2000) * 3
            );
            await delay(wait);
            continue;
          }
        } else if (expected > 0 && fs.existsSync(partPath)) {
          const already = await verifyFile(partPath, { minDuration: expected });
          if (already.ok && !belowMinHeight(already, floor)) {
            await library.safePlace({ partPath, finalPath, replacePath: null });
            const settled = await this._settle(
              item,
              finalPath,
              already.bytes || item.bytes,
              `Completed: ${path.basename(finalPath)} (kept a finished file from a previous attempt)`
            );
            if (settled.retry) continue;
            return settled;
          }
        }

        // Servers that already served this series the wrong audio this run.
        {
          const bad = wrongAudioServers.get(`${item.series}|${item.mode || 'dub'}`);
          if (bad && bad.size) {
            item.skipSources = Array.isArray(item.skipSources) ? item.skipSources : [];
            for (const k of bad) if (!item.skipSources.includes(k)) item.skipSources.push(k);
          }
        }
        let outcome;
        let noQuality = false;
        if (item.anime) {
          // Anime comes from the anime sites only: Anime Village (headless,
          // a separate English-dub file per episode) first, then Aniwave
          // through discovery. Vidsrc and its page are not used for anime.
          item._wrongAudio = true;
          if (!(item.skipSources || []).includes('animevillage')) {
            try {
              // Bounded: its API retries when busy, and the watchdog kills an
              // item stuck in "resolving" for a minute.
              let capTimer = null;
              outcome = await Promise.race([
                require('./sites/animevillage').resolveForJob(
                  { title: item.series, season: item.season, episode: item.episode, mode: item.mode || 'dub', tmdb: item.tmdb, numbering: item.numbering },
                  { onLog: (m) => this._log(m) }
                ),
                new Promise((res) => {
                  capTimer = setTimeout(() => res({ status: 'none', reason: 'Anime Village did not answer in 40 s' }), 40000);
                })
              ]).finally(() => clearTimeout(capTimer));
              if (outcome && outcome.status !== 'resolved' && /40 s/.test(outcome.reason || '')) {
                // Hanging, not answering: skip it for a while for every item.
                require('./sites/animevillage_api').markDown();
                this._log(`${outcome.reason}; trying Aniwave (Anime Village skipped for 10 min).`);
              }
            } catch (e) {
              this._log('Anime Village lookup failed (' + ((e && e.message) || e) + '); trying Aniwave.');
              outcome = null;
            }
          }
        } else {
          const _prof = sites.resolve(item.url || item.baseUrl || '');
          // After Vidsrc showed it has no copy in the requested audio, later
          // attempts go straight to the dub/sub-aware sites.
          if (_prof && typeof _prof.directResolve === 'function' && !item._wrongAudio) {
            // The source has a headless resolver (Vidsrc): its page in a
            // browser can only replay what that resolver already saw.
            item._headlessTried = true;
            try {
              outcome = await this._abortable(item, _prof.directResolve(
                {
                  title: item.label || item.series,
                  series: item.series,
                  season: item.season,
                  episode: item.episode,
                  url: item.url || item.baseUrl || '',
                  baseUrl: item.baseUrl || item.url || '',
                  anime: !!item.anime,
                  minHeight: item.minHeight != null ? item.minHeight : undefined,
                  // The dub/sub choice the user made when queueing. Headless
                  // resolvers can't toggle servers, but they can at least tell
                  // us when the file they found contradicts that choice.
                  mode: item.mode || 'dub'
                },
                { onLog: (m) => this._log(m) }
              ));
            } catch (e) {
              if (e && e.name === 'AbortError') throw e;
              outcome = null;
              if (e && e.code === 'VIDSRC_NOT_FOUND' && !item.anime) {
                // Vidsrc answered "not here": its pages (which call the same
                // API) would only say it again after ~30 s each. Straight to
                // the other sites.
                item._skipVidsrcPages = true;
                this._log(`Vidsrc does not have "${item.label}"; skipping its pages and searching the other sites.`);
              } else {
                this._log('Headless resolve failed (' + ((e && e.message) || e) + '); using browser path.');
              }
            }
          }
        }
        // Licensed-exclusive titles (Netflix/HBO/Prime originals, ...) are not
        // on the CF-free catalogs, and the only places they show up are the
        // Cloudflare-gated fallbacks - which need a solver to use. Without one,
        // every attempt burns ~4 minutes on "Still waiting for Cloudflare" and
        // then fails. Detect it once from TMDB and stop with an explanation
        // instead of 6 pointless retries. With a solver configured the normal
        // path runs unchanged (the gated sites ARE the user's best chance).
        if (!item._exclusive && !cfsolve.enabled()) {
          const hint = await this._abortable(item, this._exclusiveHint(item));
          if (hint) {
            item._exclusive = true;
            item._exclusiveHint = hint;
          }
        }
        // The headless path checked every Vidsrc source and found no 1080p.
        // Still try the browser path (other sites might have it), but cap
        // retries to 2 — the fallback sites are usually Cloudflare-gated,
        // so 6 retries just burns hours on "Still waiting for Cloudflare".
        // Not on Vidsrc, and nothing else can have it: a special (Season 0 is
        // only taken from TMDB-numbered sources = Vidsrc) or a film that is
        // only in cinemas. Answer now instead of minutes of searching per try.
        if (!item._exclusive && item._skipVidsrcPages && !item._notOutChecked) {
          item._notOutChecked = true;
          const isMovie = /\/embed\/movie\//.test(String(item.url || item.baseUrl || ''));
          if (!isMovie && item.season != null && item.season !== '' && Number(item.season) === 0) {
            item._unobtainable = 'Vidsrc has no copy of this special (specials are only taken from Vidsrc)';
          } else if (isMovie) {
            let tm = String(item.tmdb || '');
            if (!/^\d+$/.test(tm)) tm = (String(item.url || item.baseUrl || '').match(/embed\/movie\/(\d{1,9})(?=[/?#]|$)/) || [])[1] || '';
            let hint = '';
            try { hint = await this._abortable(item, tmdb.movieNotOutHint(tm)); } catch (e) { if (e && e.name === 'AbortError') throw e; hint = ''; }
            if (hint) item._unobtainable = `"${item.label}" is ${hint}, so no download site has it`;
          }
        }
        if (item._unobtainable) {
          this._log(`${item._unobtainable}. Not retrying.`);
          outcome = { status: 'failed', reason: item._unobtainable };
        } else if (item._exclusive) {
          this._log(
            `"${item.label}" — ${item._exclusiveHint || 'a licensed exclusive'}. ` +
              'The free catalogs will not have it and no Cloudflare solver is configured, so the gated fallbacks are unusable. Not retrying.'
          );
          outcome = { status: 'failed', reason: item._exclusiveHint || 'licensed exclusive' };
        } else if (outcome && outcome.status === 'wrong_audio') {
          // Vidsrc only has the other audio. Its page would play the same
          // file, so discovery skips it and asks the dub/sub-aware sites
          // (anime sites with DUB/SUB server rows). No dub anywhere -> the
          // episode lands on the waiting-for-dub list.
          item._wrongAudio = true;
          this._log(`"${item.label}": ${outcome.reason || 'wrong audio on Vidsrc'}; trying sites with a ${(item.mode || 'dub').toUpperCase()} option.`);
          outcome = await this._abortable(item, item.discover(item));
        } else if (outcome && outcome.status === 'no_quality') {
          // Anime DUB: the Vidsrc page in the browser would replay the same
          // unverifiable file - go to the sites with DUB/SUB rows instead.
          if (item.anime && (item.mode || 'dub') === 'dub') item._wrongAudio = true;
          // TV/movies: the headless path already measured every Vidsrc source;
          // its pages in the browser would replay the same ones.
          if (!item.anime) item._skipVidsrcPages = true;
          noQuality = true;
          item._noQuality = true; // persist on the item so the retry cap applies on every attempt
          // Another episode of this season already went through every site
          // for 1080p and fell back: straight to the 720p copy.
          if (!item.upgrade && this._seasonFellBack(item) && this._fallbackFloor(item, 'no 1080p', { quiet: true })) continue;
          this._log(`"${item.label}" has no 1080p on Vidsrc; trying browser fallback (limited retries).`);
          outcome = await this._abortable(item, item.discover(item));
        } else if (!outcome || outcome.status !== 'resolved') {
          // Same when Vidsrc was busy, unreachable or has no copy of the
          // episode at all (lookup error): anime DUB skips its page.
          if (item._headlessTried && item.anime && (item.mode || 'dub') === 'dub') item._wrongAudio = true;
          // TV/movies: Vidsrc is refusing this IP - its pages in the browser
          // hit the same servers. Ask only the other sites this time.
          const vsBlocked = !item.anime && outcome && outcome.blocked;
          if (vsBlocked) item._skipVidsrcPages = true;
          outcome = await this._abortable(item, item.discover(item));
          if (vsBlocked && !(outcome && outcome.status === 'resolved')) item._heldForVidsrc = true;
        }
        let status = outcome && outcome.status ? outcome.status : (outcome ? 'resolved' : 'failed');

        // Anime DUB: never download a stream without proof it is the English
        // dub - Vidsrc's checked release, a dub-marked stream URL / variant, or
        // a server from a DUB row. Players without DUB/SUB labels (the Vidsrc
        // page itself, an episode page's own playlist) serve whatever audio the
        // file has, and Vidsrc audio carries no language tag to check later -
        // that is how a Japanese "DUAL" release got saved as the dub. No proof
        // -> the episode waits for its dub (checked every 24 h).
        if (status === 'resolved' && item.anime && (item.mode || 'dub') === 'dub') {
          const det0 = (outcome && outcome.detection) || outcome;
          if (!(det0 && det0.dubEvidence)) {
            this._log(`"${item.label}": the stream found has no proof it is the English dub (${(det0 && det0.sourceLabel) || 'unlabelled player'}); not downloading it.`);
            if (det0 && typeof det0.releaseDiscover === 'function') {
              try { det0.releaseDiscover(); } catch (e) { /* ignore */ }
            }
            outcome = { status: 'unavailable', reason: 'no verified English-dub source yet' };
            status = 'unavailable';
          }
        }

        // Stop / Remove interrupted this search: an interrupted dub search can
        // come back "unavailable" - that is a cancel, never "no dub yet".
        if (status === 'unavailable' && this._interrupted(item)) {
          this._releaseDownloadSlot(item);
          if (this.items.includes(item)) item.status = 'cancelled';
          this._emit();
          return { fatal: false };
        }
        // Anime DUB "not released yet" from one page scan (the page showed no
        // DUB server row in time) while the dub sources' own episode list says
        // it IS dubbed: a scan miss, not a missing dub. Retry instead of
        // parking it - One Piece E1123+ went to the waiting list this way.
        if (status === 'unavailable' && item.anime && (item.mode || 'dub') === 'dub' && (await this._knownDubbed(item)) === true) {
          this._log(`"${item.label}": the page showed no DUB server, but the dub sources list this episode as dubbed - retrying instead of waiting.`);
          outcome = { status: 'failed', reason: 'DUB server did not show on the page (the episode is listed as dubbed)' };
          status = 'failed';
          item._listedDubbed = true;
        }

        // Only anime waits for an English dub. A TV show or film answered "not
        // released" by some page is just not found there: retried / searched
        // like any other miss, never parked on the waiting-for-dub list.
        if (status === 'unavailable' && !item.anime) {
          outcome = { status: 'failed', reason: 'No video sources found on the page' };
          status = 'failed';
        }

        if (status === 'unavailable') {
          this._releaseDownloadSlot(item);
          item.status = 'waiting';
          item.error = (outcome && outcome.reason) || 'Dub not released yet';
          this._emit();
          this._log(`Waiting for dub: ${item.label} (${item.error})`);
          if (typeof item.onUnavailable === 'function') {
            try {
              item.onUnavailable(outcome);
            } catch (e) {
              // ignore
            }
          }
          return { fatal: false };
        }

        if (status === 'failed') {
          // Timeouts / empty players are NOT "dub missing". DUB buttons were on
          // the page; the stream just didn't arrive this try.
          this._releaseDownloadSlot(item);
          // Mullvad dropped mid-discovery (its windows were torn down): this is
          // an abort, not a failure. Hold the item without counting a retry;
          // _gate below parks the worker until the tunnel is back.
          if (!vpn.isConnected()) {
            item.status = 'queued';
            this._emit();
            this._log(`Mullvad is down; holding "${item.label}" without counting a retry.`);
            continue;
          }
          // Vidsrc refused this IP and no other site had it: not the episode's
          // fault. Hold it until Vidsrc's pause ends instead of spending its
          // tries (House S1E9-13 were all given up this way in minutes).
          if (item._heldForVidsrc) {
            item._heldForVidsrc = false;
            item._skipVidsrcPages = false;
            const until = require('./sites/vidsrc_dl').blockedUntilMs();
            const wait = Math.max(30000, Math.min(16 * 60000, until - Date.now()));
            item.status = 'queued';
            item.error = 'Vidsrc is refusing this IP; waiting for it (switching the Mullvad server clears it sooner)';
            this._releaseDownloadSlot(item);
            this._emit();
            this._log(`Holding "${item.label}" for ${Math.round(wait / 60000)} min: Vidsrc is refusing this IP and no other site had it (not counted as a try). Switching the Mullvad server clears it sooner.`);
            // Step aside (the worker is freed for anime and everything else);
            // the queue picks it up again once the pause is over.
            item._notBefore = Date.now() + wait;
            setTimeout(() => { try { this._kick(); } catch (e) { /* ignore */ } }, wait + 500).unref?.();
            return { fatal: false };
          }
          const reason = (outcome && outcome.reason) || 'All dubbed sources failed';
          item.attempts += 1;
          item.error = reason;
          // Not on ANY source (every site searched, no stream, no dub copy):
          // retrying seconds later finds the same nothing and holds the only
          // worker for ~25 min (Vivant S3E1). Two tries, then the daily
          // checks take over (waiting-for-dub list for anime, the watch list
          // otherwise).
          if (/no video sources found|no 1080p stream on any source|no dub copy on the source site|no search result/i.test(reason)) {
            item._notFound = true;
          }
          // No-1080p episodes: the fallback sites are Cloudflare-gated, so extra
          // retries just burn time on "Still waiting for Cloudflare". Cap at 2.
          // Licensed exclusives: nothing will ever find it; cap at 1.
          // TV/movies with no copy at the floor: ONE full search, then the 720p
          // fallback (a second identical search found the same nothing; Vidsrc
          // already asks for another server up to 3 times within one try).
          const oneTry = item._exclusive || item._unobtainable || (item._noQuality && !item.anime && !item._floorFallback);
          const max = item._noQuality || item._exclusive || item._notFound || item._unobtainable
            ? Math.max(1, Math.min(oneTry ? 1 : 2, config.download.maxRetries || 6))
            : Math.max(1, config.download.maxRetries || 6);
          if (item.attempts >= max) {
            // Endless retries on one dead episode (S2E03 at 190+ tries) held the
            // only Linux worker and blocked every later season behind it.
            const idx = this.items.indexOf(item);
            if (idx >= 0 && idx < this.items.length - 1) {
              this.items.splice(idx, 1);
              this.items.push(item);
            }
            // Anime DUB: the dub sources not answering (Anime Village timing
            // out, Aniwave without that episode's dub) is "not available
            // yet", not a dead episode - it goes on the waiting-for-dub list,
            // which re-checks it every day and downloads it once a source
            // has it. (Marked failed, it sat until the next full watch pass.)
            if (item.anime && (item.mode || 'dub') === 'dub' && !item._exclusive && typeof item.onUnavailable === 'function' &&
                !this._interrupted(item) && !item._listedDubbed && (await this._knownDubbed(item)) !== true) {
              item.status = 'waiting';
              item.error = `no dub source answered after ${item.attempts} tries (${reason}) - on the waiting-for-dub list, re-checked daily`;
              this._emit();
              this._log(`Waiting for dub: ${item.label} - ${item.error}.`);
              try {
                item.onUnavailable({ status: 'unavailable', reason });
              } catch (e) {
                // ignore
              }
              return { fatal: false };
            }
            if (this._fallbackFloor(item, reason)) continue;
            // A weekly upgrade that found nothing better after all: the
            // library copy stays as it is - not a failure to retry.
            if (item.upgrade) {
              try { if (item.upgradeFrom) require('./upgrades').markResult(item.upgradeFrom, 'download found no 1080p after all - checked again next week'); } catch (e) { /* bookkeeping */ }
              item.status = 'skipped';
              item.error = 'no better copy after all - the library copy is kept';
              this._emit();
              this._log(`Upgrade of "${item.label}": no better copy after all; keeping the one in the library.`);
              this._pruneGroupIfComplete(item.group);
              return { fatal: false };
            }
            item.status = 'failed';
            this._emit();
            if (item._exclusive) {
              this._log(
                `"${item.label}" — ${item._exclusiveHint || 'a licensed exclusive per TMDB'}. ` +
                  'It is not on the free sources; set a Cloudflare solver (Settings) if you still want to try the gated sites.'
              );
            } else if (item._noQuality) {
              this._log(
                `"${item.label}" — no copy at ${this._minHeight(item)}p or better found (Vidsrc + fallback sites)` +
                  (item._floorFallback ? `, not even the ${this._minHeight(item)}p fallback.` : '.')
              );
            } else {
              this._log(
                `Gave up on "${item.label}" after ${item.attempts} tries (${reason}). ` +
                  'Stopped retrying so other downloads can start.'
              );
            }
            return { fatal: false };
          }
          item.status = 'queued';
          this._emit();
          const wait = Math.min(
            config.download.retryMaxDelayMs || 60000,
            config.download.retryBaseDelayMs * Math.min(item.attempts, 20)
          );
          this._log(
            `No stream yet for "${item.label}" (attempt ${item.attempts}): ${reason}; retrying in ${Math.round(wait / 1000)}s.`
          );
          await delay(wait);
          continue;
        }

        const detection = (outcome && outcome.detection) || outcome;

        // Remembered so a later resume can hold a leftover .part to the same
        // 90%-of-runtime bar the post-download check uses.
        if (detection && detection.playlistDuration > 0) {
          item.expectedDuration = detection.playlistDuration;
        }

        item._playerBoundDownload = !!(
          detection && hlscheck.isPlayerBoundCdn(detection.url, detection.embedUrl)
        );
        const claimed = await this._waitDownloadSlot(item);
        if (!claimed) {
          if (detection && typeof detection.releaseDiscover === 'function') {
            try {
              detection.releaseDiscover();
            } catch (e) {
              // ignore
            }
          }
          if (this._stopRequested && item.status !== 'done') {
            item.status = 'cancelled';
            this._emit();
          }
          return { fatal: false };
        }

        item.status = 'downloading';
        item._rateWin = [];
        item.speed = 0;
        item.eta = null;
        item.progress = null;
        this._emit();

        const releaseDiscover = () => {
          if (detection && typeof detection.releaseDiscover === 'function') {
            try {
              detection.releaseDiscover();
            } catch (e) {
              // ignore
            }
            detection.releaseDiscover = null;
          }
        };

        try {
          await download(detection, partPath, {
            signal: controller.signal,
            onLog: (m) => this._log(m),
            onProgress: (p) => {
              const next = p && typeof p.percent === 'number' ? p.percent : null;
              if (next != null) {
                item.progress = item.progress == null ? next : Math.max(item.progress, next);
              }
              if (p && p.unit === 'parts') item.parts = `${p.received}/${p.total}`;
              else item.bytes = (p && p.received) || item.bytes;
              this._sampleRate(item, p);
              this._emitProgress(item);
            }
          });
        } catch (err) {
          const lab = detection && detection.sourceLabel;
          const bound = !!(detection && hlscheck.isPlayerBoundCdn(detection.url, detection.embedUrl));
          // Blacklist a failed NontonGo/MP4 server so the next try can fall
          // through to Vidfast. Do not blacklist a live token-CDN player: that
          // is the Linux fallback when NontonGo does not yield.
          if (lab && !bound) {
            item.skipSources = Array.isArray(item.skipSources) ? item.skipSources : [];
            const key = String(lab).toLowerCase();
            if (!item.skipSources.includes(key)) item.skipSources.push(key);
            this._log(
              `"${item.label}" could not download from "${lab}"; next try will use a different server.`
            );
          } else if (lab && bound && /not return an HLS playlist|no playlist/i.test((err && err.message) || '')) {
            item.skipSources = Array.isArray(item.skipSources) ? item.skipSources : [];
            const key = String(lab).toLowerCase();
            if (!item.skipSources.includes(key)) item.skipSources.push(key);
            this._log(
              `"${item.label}" got an empty playlist from "${lab}"; next try will use a different server.`
            );
          } else if (lab && bound) {
            this._log(
              `"${item.label}" capture from "${lab}" failed; retrying the same player on the next attempt.`
            );
          }
          throw err;
        } finally {
          releaseDiscover();
        }

        item.status = 'verifying';
        this._emit();
        const v = await verifyFile(partPath, {
          minDuration: detection && detection.playlistDuration
        });
        if (!v.ok) {
          try {
            fs.unlinkSync(partPath);
          } catch (e) {
            // ignore
          }
          throw new Error('Verification failed: ' + v.reason);
        }
        // Anime DUB: the finished file must not be tagged with only
        // non-English audio. Every path (Vidsrc, catalog sites, captured
        // players) ends here, so a mislabelled "dub" server is caught too.
        // Untagged audio is not evidence and is accepted.
        if (item.anime && (item.mode || 'dub') === 'dub') {
          const langs = await audioLanguages(partPath);
          const audio = audiolang.audioVerdict({ streamLangs: langs });
          if (audio.verdict === 'foreign') {
            this._dropShortFile(partPath);
            const lab = detection && detection.sourceLabel;
            if (lab) {
              item.skipSources = Array.isArray(item.skipSources) ? item.skipSources : [];
              const key = String(lab).toLowerCase();
              if (!item.skipSources.includes(key)) item.skipSources.push(key);
              const sk = `${item.series}|${item.mode || 'dub'}`;
              if (!wrongAudioServers.has(sk)) wrongAudioServers.set(sk, new Set());
              wrongAudioServers.get(sk).add(key);
            }
            item._wrongAudio = true;
            throw new Error(`downloaded audio is ${audiolang.langLabel(audio.langs)}, not an English dub`);
          }
        }
        // Playback integrity: no skips, no repeated or missing content, audio
        // in sync, (optionally) no damaged frames. Checked on EVERY path's
        // output, because each path can lose a segment differently (ffmpeg's
        // HLS reader skips a segment it cannot fetch and still exits 0; the
        // MP4 muxer then hides the hole as one stretched frame, which only
        // looks like "the video skips" when watched).
        {
          const expected = (detection && detection.playlistDuration) || item.expectedDuration || 0;
          const started = Date.now();
          const integ = await integrity.checkIntegrity(partPath, {
            expectedDuration: expected,
            decode: config.download.decodeCheck !== false,
            remuxWarnings: (detection && detection.remuxWarnings) || []
          });
          let host = '';
          try {
            host = new URL(String((detection && detection.url) || '')).host;
          } catch (e) {
            host = '';
          }
          const ctx = {
            label: item.label,
            source: [detection && detection.sourceLabel, host].filter(Boolean).join(' @ '),
            release: (detection && detection.release) || '',
            segmentStarts: detection && detection.segmentStarts,
            remuxWarnings: detection && detection.remuxWarnings,
            expectedDuration: expected,
            attempt: item.attempts + 1,
            elapsedMs: Date.now() - started
          };
          for (const line of integrity.report(integ, ctx)) this._log(line);
          integrity.record(finalPath, integ, ctx);
          if (!integ.ok) {
            this._dropShortFile(partPath);
            // The same server serves the same broken file again (One Piece
            // E174 from "vidplay", 9 s short audio, 3 identical tries): the
            // next try uses the episode's other servers. When every server
            // has failed, the picker tries them all again.
            const labBad = detection && detection.sourceLabel;
            if (labBad) {
              item.skipSources = Array.isArray(item.skipSources) ? item.skipSources : [];
              const key = String(labBad).toLowerCase();
              if (!item.skipSources.includes(key)) item.skipSources.push(key);
              this._log(`"${item.label}": the copy from "${labBad}" failed the playback check; the next try uses a different server.`);
            }
            throw new Error(`playback check failed: ${integ.problems.join('; ')}`);
          }
        }
        if (belowMinHeight(v, floor)) {
          // Only the .part we just wrote is ever dropped here. A file already
          // at finalPath belongs to the library: it stays untouched.
          this._dropShortFile(partPath);
          const lab = detection && detection.sourceLabel;
          if (lab) {
            item.skipSources = Array.isArray(item.skipSources) ? item.skipSources : [];
            const key = String(lab).toLowerCase();
            if (!item.skipSources.includes(key)) item.skipSources.push(key);
          }
          throw new Error(`downloaded ${v.height}p, not ${floor}p`);
        }

        const previous = item._replacePath;
        const previousHeight = item._replaceHeight;
        // Never a raw renameSync: safePlace refuses to overwrite a file that is
        // not this job's recorded replacement target, moves the old file to the
        // trash (never deletes it), and copies across drives atomically.
        await library.safePlace({
          partPath,
          finalPath,
          replacePath: previous || null
        });
        const settled = await this._settle(
          item,
          finalPath,
          v.bytes || item.bytes,
          previousHeight
            ? `Replaced ${path.basename(finalPath)}: removed the ${previousHeight}p file, saved ${v.height}p.`
            : `Completed: ${path.basename(finalPath)}`
        );
        if (settled.retry) continue;
        return settled;
      } catch (err) {
        if (err.name === 'AbortError') {
          if (item._watchdogKilled) {
            // The queue watchdog killed a phase that ran past its cap: this
            // is a FAILED ATTEMPT (retry with backoff), not a user pause.
            item._watchdogKilled = false;
            err.message = item._watchdogReason || 'killed by the queue watchdog';
          } else {
            // Paused (VPN/user): keep partial and the download slot so a
            // prefetched episode cannot start while we are paused.
            item.status = 'paused';
            this._emit();
            continue;
          }
        }
        this._releaseDownloadSlot(item);
        item.attempts += 1;
        item.error = err.message;
        // Consecutive failures that made NO progress. A long download that
        // keeps resuming (expired CDN token -> fresh token -> next part) moves
        // forward every time and is never cut off; one that fails the same
        // way every time is.
        const progressed = (item.progress || 0) > (item._progressAtLastFail || 0) || (item.bytes || 0) > (item._bytesAtLastFail || 0);
        item._failStreak = progressed ? 1 : (item._failStreak || 0) + 1;
        item._progressAtLastFail = item.progress || 0;
        item._bytesAtLastFail = item.bytes || 0;
        this._log(`Error on "${item.label}" (attempt ${item.attempts}): ${err.message}`);
        item.status = 'queued';
        this._emit();
        // A target file that already exists in the library is a terminal state,
        // not a transient error: re-downloading cannot change the outcome, so
        // retrying it forever (the old 28× "Refusing to overwrite" loop) just
        // hangs the queue. Stop and surface a clear, actionable message.
        const existsConflict =
          /Refusing to (overwrite|replace)\b/i.test(err.message || '');
        if (existsConflict) {
          item.status = 'failed';
          item.error = err.message;
          this._log(
            `"${item.label}": ${err.message} — the target is already present, so I stopped ` +
              'retrying (this is not a download failure; the file is in the library).'
          );
          this._emit();
          this._pruneGroupIfComplete(item.group);
          return { fatal: false };
        }
        const wrongRes = /downloaded \d+p, not \d+p/.test(err.message || '');
        if (wrongRes) {
          const max = Math.max(1, config.download.maxRetries || 6);
          if (item.attempts >= max && this._fallbackFloor(item, err.message)) continue;
          if (item.attempts >= max) {
            item.status = 'failed';
            this._emit();
            this._log(
              `Gave up on "${item.label}" after ${item.attempts} tries (${err.message}). ` +
                'Stopped retrying so other downloads can start.'
            );
            return { fatal: false };
          }
          item.status = 'queued';
          this._emit();
          const wait = Math.min(
            config.download.retryMaxDelayMs || 60000,
            config.download.retryBaseDelayMs * Math.min(item.attempts, 20)
          );
          this._log(
            `"${item.label}" ${err.message}. Back on the queue for a higher-quality copy; retrying in ${Math.round(wait / 1000)}s.`
          );
          await delay(wait);
          continue;
        }
        const rateLimited = /429|too many requests/i.test(err.message || '');
        // Endless retries on one dead episode held a worker for hours (the
        // 190-try S2E03). Rate limits are waited out, never counted.
        const maxStreak = Math.max(1, (config.download.maxRetries || 6) * 2);
        if (!rateLimited && item._failStreak >= maxStreak) {
          const idx = this.items.indexOf(item);
          if (idx >= 0 && idx < this.items.length - 1) {
            this.items.splice(idx, 1);
            this.items.push(item);
          }
          item.status = 'failed';
          this._emit();
          this._log(
            `Gave up on "${item.label}" after ${item._failStreak} tries in a row with no progress (${err.message}). ` +
              'Use Retry to try again; other downloads continue.'
          );
          return { fatal: false };
        }
        const wait = rateLimited
          ? Math.min(90000, (config.download.rateLimitCooldownMs || 30000) * Math.min(item.attempts, 3))
          : Math.min(
              config.download.retryMaxDelayMs || 60000,
              config.download.retryBaseDelayMs * Math.min(item.attempts, 20)
            );
        if (rateLimited) {
          this._log(`CDN rate-limited "${item.label}"; pausing HLS for ${Math.round(wait / 1000)}s before retry.`);
        } else {
          this._log(`Will keep retrying "${item.label}" in ${Math.round(wait / 1000)}s (dub was found; not marking failed).`);
        }
        await delay(wait);
      }
    }
  }

  _emit() {
    this._noteOutcomes();
    this.emit('update', this.snapshot());
    this._persist();
  }

  // The last 24 h at a glance (daily summary line, Overview): every item
  // that reached done / failed / waiting is counted once.
  _noteOutcomes() {
    const now = Date.now();
    const ev = (this._outcomes = this._outcomes || []);
    for (const it of this.items) {
      if (!['done', 'failed', 'waiting'].includes(it.status) || it._reported === it.status) continue;
      it._reported = it.status;
      ev.push({ at: now, kind: it.status, below: it.status === 'done' && !!it._floorFallback, upgrade: it.status === 'done' && !!it.upgrade });
    }
    while (ev.length && now - ev[0].at > 24 * 3600 * 1000) ev.shift();
  }

  last24h() {
    this._noteOutcomes();
    const ev = this._outcomes || [];
    const c = { done: 0, below: 0, upgraded: 0, failed: 0, waiting: 0 };
    for (const e of ev) {
      if (e.kind === 'done') {
        c.done += 1;
        if (e.below) c.below += 1;
        if (e.upgrade) c.upgraded += 1;
      } else if (e.kind === 'failed') c.failed += 1;
      else if (e.kind === 'waiting') c.waiting += 1;
    }
    c.queued = this.items.filter((i) => i.status === 'queued' || i.status === 'ready').length;
    return c;
  }

  logDailySummary() {
    const c = this.last24h();
    this._log(
      `Last 24 h: ${c.done} downloaded` + (c.below ? ` (${c.below} below 1080p, checked weekly for a better copy)` : '') +
        (c.upgraded ? `, ${c.upgraded} upgraded to 1080p` : '') +
        `, ${c.failed} failed, ${c.waiting} went to the waiting-for-dub list; ${c.queued} still queued.`
    );
    return c;
  }

  _emitProgress(item) {
    // Lightweight progress event (no manifest write) to keep the UI smooth.
    this.emit('update', this.snapshot());
  }

  _log(msg) {
    try {
      console.log(msg);
    } catch (e) {
      // ignore
    }
    this.emit('log', msg);
  }

  _manifestPath() {
    return path.join(app.getPath('userData'), 'queue-manifest.json');
  }

  _persist() {
    // Start-empty mode (the default): don't accumulate a manifest, so removed or
    // failed episodes can never be resurrected on the next run.
    if (!config.download.persistQueueAcrossRestarts) return;
    try {
      // Persist everything still in flight so a restart can resume it. Completed
      // and cancelled items are dropped (done files stay on disk).
      const RESUMABLE = ['queued', 'resolving', 'downloading', 'verifying', 'paused', 'waiting', 'failed', 'ready', 'placing'];
      const data = this.items
        .filter((it) => RESUMABLE.includes(it.status) && it.url)
        .map((it) => ({
          label: it.label,
          series: it.series,
          season: it.season,
          episode: it.episode,
          mode: it.mode,
          group: it.group,
          outputRoot: it.outputRoot,
          url: it.url,
          template: it.template,
          key: it.key,
          stopRunOnFail: it.stopRunOnFail,
          library: it.library || null,
          minHeight: it.minHeight || 0,
          floorFallback: it._floorFallback || 0,
          upgrade: !!it.upgrade,
          upgradeFrom: it.upgradeFrom || null,
          anime: !!it.anime,
          // Without these a restored item lost its TMDB id (the library
          // presence check by folder id, the anime source mapping) and its
          // season numbering (an AniDB-numbered anime filed under TMDB's).
          tmdb: it.tmdb || null,
          numbering: it.numbering || 'tmdb',
          episodeName: it.episodeName || '',
          jobId: it.jobId || null,
          status: it.status,
          attempts: it.attempts || 0,
          skipSources: Array.isArray(it.skipSources) ? it.skipSources : [],
          expectedDuration: it.expectedDuration || 0,
          baseUrl: it.baseUrl || it.url || null
        }));
      writeJsonAtomic(this._manifestPath(), data);
    } catch (e) {
      // non-fatal
    }
  }

  // Remove the persisted manifest so a start-empty session never resurrects
  // episodes the user already removed (and to shed a manifest left behind by an
  // older build or a previous run that had persistence on).
  clearPersistedQueue() {
    try {
      fs.unlinkSync(this._manifestPath());
    } catch (e) {
      /* no manifest to clear */
    }
  }

  // Rebuilds the queue from the persisted manifest after an app restart. The
  // `rebuild(record)` callback (supplied by main, which can require bulk/pending)
  // returns the live `{ discover, onUnavailable }` for a record, or `{ skip:true }`
  // to drop it (e.g. the file already finished downloading between sessions).
  restore(rebuild) {
    const data = readJson(this._manifestPath(), []);
    if (!Array.isArray(data) || !data.length) return 0;
    let restored = 0;
    for (const rec of data) {
      if (!rec) continue;
      if (!rec.url && rec.baseUrl) rec.url = rec.baseUrl;
      if (!rec.url) continue;
      let extra = {};
      try {
        extra = rebuild(rec) || {};
      } catch (e) {
        extra = {};
      }
      if (extra.skip) continue;
      delete rec.status;
      this.add(
        Object.assign(
          {
            label: rec.label,
            series: rec.series,
            season: rec.season,
            episode: rec.episode,
            mode: rec.mode,
            group: rec.group,
            outputRoot: rec.outputRoot,
            url: rec.url,
            template: rec.template,
            baseUrl: rec.baseUrl || rec.url,
            key: rec.key,
            stopRunOnFail: rec.stopRunOnFail,
            library: rec.library || null,
            // null stays null: "no explicit floor" (desktop items) must keep
            // the profile's floor after a restart; a stored number (even 0) is
            // an explicit per-job choice.
            minHeight: rec.minHeight != null ? Number(rec.minHeight) || 0 : null,
            _floorFallback: Number(rec.floorFallback) || 0,
            upgrade: !!rec.upgrade,
            upgradeFrom: rec.upgradeFrom || null,
            anime: !!rec.anime,
            tmdb: rec.tmdb || null,
            numbering: rec.numbering === 'anime' ? 'anime' : 'tmdb',
            episodeName: rec.episodeName || '',
            jobId: rec.jobId || null,
            skipSources: Array.isArray(rec.skipSources) ? rec.skipSources.slice() : [],
            expectedDuration: rec.expectedDuration || 0,
            // Carrying the old count over meant a restored item that already sat
            // at maxRetries was marked failed by its first timeout this session,
            // so whole shows died at once. The in-session cap still stops runaways.
            attempts: 0
          },
          extra
        )
      );
      restored += 1;
    }
    if (restored) this._log(`Restored ${restored} download(s) from the previous session.`);
    return restored;
  }
}

const manager = new DownloadManager();
module.exports = manager;
// Exposed for the liveness tests (they shorten caps/tick and assert the kill).
module.exports.PHASE_CAPS_MS = PHASE_CAPS_MS;
module.exports.DOWNLOAD_CAP_MIN_MS = DOWNLOAD_CAP_MIN_MS;
