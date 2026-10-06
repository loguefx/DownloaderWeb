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
const { download } = require('./downloader');
const { verifyFile, belowMinHeight } = require('./verify');
const hlscheck = require('./hlscheck');
const sites = require('./sites');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;

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
    this._pauseWaiters = [];
    this._downloadWaiters = [];

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
        library: null,
        minHeight: 0,
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
    this._emit();
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

  // Fills the worker pool: up to each site's concurrency downloads, plus that
  // site's prefetch so the queue does not sit idle between files.
  _kick() {
    if (this._stopRequested) return;
    for (const item of this.items) {
      if (item.status !== 'queued' || this._active.has(item)) continue;
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
    this._emit();
    this._log(
      result && result.existing
        ? `Completed: "${item.label}" was already in the library; the staging copy was dropped.`
        : (note || `Completed: ${path.basename(item.finalPath)}`) +
            ` (placed on ${path.dirname(item.finalPath)})`
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

        let outcome;
        let noQuality = false;
        {
          const _prof = sites.resolve(item.url || item.baseUrl || '');
          if (_prof && typeof _prof.directResolve === 'function') {
            try {
              outcome = await _prof.directResolve(
                {
                  title: item.label || item.series,
                  series: item.series,
                  season: item.season,
                  episode: item.episode,
                  url: item.url || item.baseUrl || '',
                  baseUrl: item.baseUrl || item.url || ''
                },
                { onLog: (m) => this._log(m) }
              );
            } catch (e) {
              this._log('Headless resolve failed (' + ((e && e.message) || e) + '); using browser path.');
              outcome = null;
            }
          }
        }
        // The headless path checked every Vidsrc source and found no 1080p.
        // Still try the browser path (other sites might have it), but cap
        // retries to 2 — the fallback sites are usually Cloudflare-gated,
        // so 6 retries just burns hours on "Still waiting for Cloudflare".
        if (outcome && outcome.status === 'no_quality') {
          noQuality = true;
          item._noQuality = true; // persist on the item so the retry cap applies on every attempt
          this._log(`"${item.label}" has no 1080p on Vidsrc; trying browser fallback (limited retries).`);
          outcome = await item.discover();
        } else if (!outcome || outcome.status !== 'resolved') {
          outcome = await item.discover();
        }
        const status = outcome && outcome.status ? outcome.status : (outcome ? 'resolved' : 'failed');

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
          const reason = (outcome && outcome.reason) || 'All dubbed sources failed';
          item.attempts += 1;
          item.error = reason;
          // No-1080p episodes: the fallback sites are Cloudflare-gated, so extra
          // retries just burn time on "Still waiting for Cloudflare". Cap at 2.
          const max = item._noQuality
            ? Math.max(1, Math.min(2, config.download.maxRetries || 6))
            : Math.max(1, config.download.maxRetries || 6);
          if (item.attempts >= max) {
            // Endless retries on one dead episode (S2E03 at 190+ tries) held the
            // only Linux worker and blocked every later season behind it.
            const idx = this.items.indexOf(item);
            if (idx >= 0 && idx < this.items.length - 1) {
              this.items.splice(idx, 1);
              this.items.push(item);
            }
            item.status = 'failed';
            this._emit();
            if (item._noQuality) {
              this._log(
                `"${item.label}" — no 1080p source found (Vidsrc + fallback). ` +
                  'This show does not have a 1080p encode available right now.'
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
              item.bytes = (p && p.received) || item.bytes;
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
          // Paused (VPN/user): keep partial and the download slot so a
          // prefetched episode cannot start while we are paused.
          item.status = 'paused';
          this._emit();
          continue;
        }
        this._releaseDownloadSlot(item);
        item.attempts += 1;
        item.error = err.message;
        this._log(`Error on "${item.label}" (attempt ${item.attempts}): ${err.message}`);
        item.status = 'queued';
        this._emit();
        const wrongRes = /downloaded \d+p, not \d+p/.test(err.message || '');
        if (wrongRes) {
          const max = Math.max(1, config.download.maxRetries || 6);
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
    this.emit('update', this.snapshot());
    this._persist();
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
          baseUrl: it.baseUrl,
          key: it.key,
          stopRunOnFail: it.stopRunOnFail,
          library: it.library || null,
          minHeight: it.minHeight || 0,
          jobId: it.jobId || null,
          status: it.status,
          attempts: it.attempts || 0,
          skipSources: Array.isArray(it.skipSources) ? it.skipSources : [],
          expectedDuration: it.expectedDuration || 0,
          baseUrl: it.baseUrl || it.url || null
        }));
      fs.writeFileSync(this._manifestPath(), JSON.stringify(data, null, 2));
    } catch (e) {
      // non-fatal
    }
  }

  // Rebuilds the queue from the persisted manifest after an app restart. The
  // `rebuild(record)` callback (supplied by main, which can require bulk/pending)
  // returns the live `{ discover, onUnavailable }` for a record, or `{ skip:true }`
  // to drop it (e.g. the file already finished downloading between sessions).
  restore(rebuild) {
    let data = [];
    try {
      data = JSON.parse(fs.readFileSync(this._manifestPath(), 'utf8'));
    } catch (e) {
      return 0;
    }
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
            minHeight: Number(rec.minHeight) || 0,
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

module.exports = new DownloadManager();
