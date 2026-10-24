'use strict';

const fs = require('fs');
const organizer = require('./organizer');
const urltemplate = require('./urltemplate');
const manager = require('./queue');
const vpn = require('./vpn');
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
  // scheduled series. Both go online (episode detection, discovery), so the
  // whole pass holds until Mullvad is confirmed up (Part 3).
  async tick() {
    await vpn.waitUntilConnected();
    this.checkNow();
    await this.checkSchedules();
  }

  // Re-detects each scheduled series and queues any episodes not already on disk
  // or in the queue. New weekly episodes get picked up automatically. Runs
  // non-fatal so one bad series never stops the queue.
  //
  // New-season support: once a watched season is fully caught up, probe
  // season+1 (only for templates that carry a {season} token, so the probe
  // can be filled for any season). A real episode list there means the season
  // exists - queue its missing episodes and advance the watch to it. An empty
  // probe just means the season is not out yet, so the watch stays put.
  async checkSchedules() {
    const items = schedule.list();
    if (!items.length) return { checked: 0 };
    this.onLog(`Checking ${items.length} scheduled series for new episodes...`);
    let newSeasons = 0;
    for (const s of items) {
      schedule.markChecked(s.key);
      const runOpts = {
        // Engine (Part 5): watched series keep their library + quality floor
        // so new episodes get placed like the original job did.
        stopRunOnFail: false,
        library: s.library || null,
        minHeight: s.minHeight || 0
      };
      const entry = {
        series: s.series,
        season: s.season,
        baseUrl: s.baseUrl,
        template: s.template,
        startEp: '1',
        endEp: '',
        mode: s.mode || 'dub'
      };
      let r = null;
      try {
        r = await bulk.startBatch([entry], s.outputRoot, this.onLog, runOpts);
      } catch (e) {
        this.onLog(`Schedule check failed for "${s.series}": ${e.message}`);
      }
      if (
        r &&
        r.queued === 0 &&
        s.season &&
        typeof s.template === 'string' &&
        urltemplate.hasSeasonToken(s.template)
      ) {
        const next = s.season + 1;
        try {
          const probeUrl = urltemplate.fill(s.template, { season: next, episode: 1 });
          if (probeUrl) {
            const det = await bulk.detectEpisodes(probeUrl, this.onLog, { season: next });
            const found = (det && det.list && det.list.length > 0) || (det && det.max > 0);
            if (found) {
              this.onLog(`New season detected: "${s.series}" season ${next} - queuing its new episodes.`);
              await bulk.startBatch(
                [
                  {
                    series: s.series,
                    season: next,
                    baseUrl: s.baseUrl,
                    template: s.template,
                    startEp: '1',
                    endEp: 'auto',
                    mode: s.mode || 'dub'
                  }
                ],
                s.outputRoot,
                this.onLog,
                runOpts
              );
              schedule.bumpSeason(s.key, next);
              newSeasons += 1;
            }
          }
        } catch (e) {
          // Next season is not out yet (or the probe failed) - stay on this one.
        }
      }
    }
    return { checked: items.length, newSeasons };
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
      if (
        organizer.existingEpisodeFile(
          spec.outputRoot,
          { series: spec.series, season: spec.season, episode: spec.episode },
          '.mp4'
        )
      ) {
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
        library: spec.library || null,
        minHeight: spec.minHeight || 0,
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
