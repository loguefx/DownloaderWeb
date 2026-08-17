'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');
const config = require('./config');
const vpn = require('./vpn');
const organizer = require('./organizer');
const { download } = require('./downloader');
const { verifyFile } = require('./verify');

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
    this._active = new Set(); // items currently being processed (up to concurrency)
    this._pauseWaiters = [];

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
    const ACTIVE = ['queued', 'resolving', 'downloading', 'verifying', 'paused'];
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
        bytes: 0,
        stopRunOnFail: false, // bulk sets true; single/watcher leave false
        onUnavailable: null,
        onDone: null,
        key: null,
        group: null, // series-batch id (for grouping + auto-removal in the UI)
        mode: null,
        episode: null,
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
      if (['queued', 'paused', 'downloading', 'resolving', 'verifying'].includes(it.status)) {
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

  // Once every episode of a series-batch is done, drop the whole group from the
  // queue so the next queued series becomes the focus. Groups with episodes
  // still waiting/queued/failed are kept.
  _pruneGroupIfComplete(group) {
    if (!group) return;
    const groupItems = this.items.filter((it) => it.group === group);
    if (!groupItems.length || !groupItems.every((it) => it.status === 'done')) return;
    const name = groupItems[0].series || groupItems[0].label || 'Series';
    this.items = this.items.filter((it) => it.group !== group);
    this._log(`Series complete: ${name} (${groupItems.length} episode(s)) - removed from queue.`);
    this._emit();
  }

  // ---- internals ----

  // Fills the worker pool: starts processing queued items until `concurrency`
  // downloads are running at once. Called whenever the queue changes or a slot
  // frees up.
  _kick() {
    if (this._stopRequested) return;
    const limit = Math.max(1, config.download.concurrency || 1);
    while (this._active.size < limit) {
      const item = this.items.find((it) => it.status === 'queued' && !this._active.has(it));
      if (!item) break;
      this._startWorker(item);
    }
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
        this._kick();
      });
  }

  // Blocks while paused or VPN is down, but bails immediately if the queue was
  // stopped or this item was removed (so Stop/Clear can tear a parked worker
  // down instead of leaving it stuck waiting).
  async _gate(item) {
    while ((this._paused || this._vpnDown) && !this._stopRequested && this.items.includes(item)) {
      await new Promise((resolve) => this._pauseWaiters.push(resolve));
    }
  }

  _releaseGate() {
    const w = this._pauseWaiters;
    this._pauseWaiters = [];
    w.forEach((fn) => fn());
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
        item.error = null;
        this._emit();

        const outcome = await item.discover();
        const status = outcome && outcome.status ? outcome.status : (outcome ? 'resolved' : 'failed');

        if (status === 'unavailable') {
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
          // the page; the stream just didn't arrive this try. Keep retrying until
          // it resolves or the watcher path parks it as unavailable.
          const reason = (outcome && outcome.reason) || 'All dubbed sources failed';
          item.attempts += 1;
          item.error = reason;
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

        const finalPath = organizer.buildOutputPath(
          item.outputRoot,
          { series: item.series, season: item.season, episode: item.episode },
          '.mp4'
        );
        item.finalPath = finalPath;
        const partPath = finalPath + '.part';

        item.status = 'downloading';
        item.progress = null;
        this._emit();

        await download(detection, partPath, {
          signal: controller.signal,
          onProgress: (p) => {
            item.progress = p.percent;
            item.bytes = p.received || item.bytes;
            this._emitProgress(item);
          }
        });

        item.status = 'verifying';
        this._emit();
        const v = await verifyFile(partPath);
        if (!v.ok) {
          try {
            fs.unlinkSync(partPath);
          } catch (e) {
            // ignore
          }
          throw new Error('Verification failed: ' + v.reason);
        }

        fs.renameSync(partPath, finalPath);
        item.status = 'done';
        item.progress = 1;
        this._emit();
        this._log(`Completed: ${path.basename(finalPath)}`);
        if (typeof item.onDone === 'function') {
          try {
            item.onDone(item);
          } catch (e) {
            // ignore
          }
        }
        this._pruneGroupIfComplete(item.group);
        return { fatal: false };
      } catch (err) {
        if (err.name === 'AbortError') {
          // Paused (VPN/user): keep partial, loop back through the gate.
          item.status = 'paused';
          this._emit();
          continue;
        }
        item.attempts += 1;
        item.error = err.message;
        this._log(`Error on "${item.label}" (attempt ${item.attempts}): ${err.message}`);
        item.status = 'queued';
        this._emit();
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
    this.emit('log', msg);
  }

  _manifestPath() {
    return path.join(app.getPath('userData'), 'queue-manifest.json');
  }

  _persist() {
    try {
      // Persist everything still in flight so a restart can resume it. Completed
      // and cancelled items are dropped (done files stay on disk).
      const RESUMABLE = ['queued', 'resolving', 'downloading', 'verifying', 'paused', 'waiting', 'failed'];
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
          status: it.status
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
      if (!rec || !rec.url) continue;
      let extra = {};
      try {
        extra = rebuild(rec) || {};
      } catch (e) {
        extra = {};
      }
      if (extra.skip) continue;
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
            baseUrl: rec.baseUrl,
            key: rec.key,
            stopRunOnFail: rec.stopRunOnFail
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
