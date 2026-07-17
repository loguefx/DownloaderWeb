'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');

// Persistent list of "scheduled" series. The watcher periodically re-detects the
// episode count for each one and queues any episodes that are not already on
// disk (or already queued) - so newly released episodes are pulled automatically.
class ScheduleStore extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this._loaded = false;
  }

  _file() {
    return path.join(app.getPath('userData'), 'schedule.json');
  }

  load() {
    if (this._loaded) return;
    try {
      this.items = JSON.parse(fs.readFileSync(this._file(), 'utf8')) || [];
    } catch (e) {
      this.items = [];
    }
    this._loaded = true;
  }

  _save() {
    try {
      fs.writeFileSync(this._file(), JSON.stringify(this.items, null, 2));
    } catch (e) {
      // non-fatal
    }
    this.emit('update', this.list());
  }

  static key(spec) {
    return [spec.series, spec.season || '', spec.mode || 'dub', spec.template || spec.baseUrl || ''].join('|');
  }

  // Adds (or refreshes) a scheduled series. Returns true if newly added.
  add(spec) {
    this.load();
    const key = ScheduleStore.key(spec);
    const existing = this.items.find((it) => it.key === key);
    if (existing) {
      existing.outputRoot = spec.outputRoot || existing.outputRoot;
      existing.template = spec.template || existing.template;
      existing.baseUrl = spec.baseUrl || existing.baseUrl;
      this._save();
      return false;
    }
    this.items.push({
      key,
      series: spec.series,
      season: spec.season != null ? spec.season : null,
      mode: spec.mode || 'dub',
      template: spec.template || null,
      baseUrl: spec.baseUrl || null,
      outputRoot: spec.outputRoot,
      addedAt: Date.now(),
      lastChecked: null
    });
    this._save();
    return true;
  }

  remove(key) {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((it) => it.key !== key);
    if (this.items.length !== before) this._save();
  }

  markChecked(key) {
    this.load();
    const it = this.items.find((x) => x.key === key);
    if (it) {
      it.lastChecked = Date.now();
      this._save();
    }
  }

  list() {
    this.load();
    return this.items.slice();
  }
}

module.exports = new ScheduleStore();
