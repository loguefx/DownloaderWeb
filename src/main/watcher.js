'use strict';

const fs = require('fs');
const organizer = require('./organizer');
const urltemplate = require('./urltemplate');
const manager = require('./queue');
const pending = require('./pending');
const schedule = require('./schedule');
const bulk = require('./bulk');

const DAY_MS = 24 * 60 * 60 * 1000;

// Re-checks the "waiting for dub" list. New episodes release weekly, so a daily
// pass is plenty. Each pending episode is (re)queued as a non-fatal item: if the
// dub is now available it downloads and leaves the list; otherwise it stays.
class Watcher {
  constructor() {
    this.timer = null;
    this.onLog = () => {};
  }

  start(onLog = () => {}) {
    this.onLog = onLog;
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), DAY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One scheduled pass: retry pending dubs, then pull new episodes for any
  // scheduled series.
  async tick() {
    this.checkNow();
    await this.checkSchedules();
  }

  // Re-detects each scheduled series and queues any episodes not already on disk
  // or in the queue. New weekly episodes get picked up automatically. Runs
  // non-fatal so one bad series never stops the queue.
  async checkSchedules() {
    const items = schedule.list();
    if (!items.length) return { checked: 0 };
    this.onLog(`Checking ${items.length} scheduled series for new episodes...`);
    for (const s of items) {
      schedule.markChecked(s.key);
      const entry = {
        series: s.series,
        season: s.season,
        baseUrl: s.baseUrl,
        template: s.template,
        startEp: '1',
        endEp: '',
        mode: s.mode || 'dub'
      };
      try {
        await bulk.startBatch([entry], s.outputRoot, this.onLog, { stopRunOnFail: false });
      } catch (e) {
        this.onLog(`Schedule check failed for "${s.series}": ${e.message}`);
      }
    }
    return { checked: items.length };
  }

  checkNow() {
    const items = pending.list();
    if (!items.length) return { checked: 0 };
    this.onLog(`Checking ${items.length} pending dub(s) for new releases...`);

    for (const spec of items) {
      const url = urltemplate.buildEpisodeUrl(
        { template: spec.template, baseUrl: spec.baseUrl, season: spec.season, series: spec.series },
        spec.episode
      );
      if (!url) {
        this.onLog(`Pending "${spec.label}" has no usable URL/template; skipping.`);
        continue;
      }

      // Already downloaded out-of-band? Clear it.
      const expected = organizer.expectedPath(
        spec.outputRoot,
        { series: spec.series, season: spec.season, episode: spec.episode },
        '.mp4'
      );
      if (fs.existsSync(expected)) {
        pending.remove(spec.key);
        continue;
      }

      pending.markChecked(spec.key);
      manager.add({
        label: spec.label,
        series: spec.series,
        season: spec.season,
        episode: spec.episode,
        outputRoot: spec.outputRoot,
        stopRunOnFail: false, // watcher must never nuke the queue
        key: spec.key,
        discover: bulk.makeDiscover(url, this.onLog, spec.mode || 'dub'),
        onUnavailable: () => pending.markChecked(spec.key),
        onDone: () => pending.remove(spec.key)
      });
    }
    return { checked: items.length };
  }
}

module.exports = new Watcher();
