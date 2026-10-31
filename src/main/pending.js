'use strict';

const path = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');
const { writeJsonAtomic, readJson } = require('./jsonfile');

// Persistent list of episodes whose dubbed version is not out yet. The watcher
// re-checks these on a schedule and removes them once downloaded.
class PendingStore extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this._loaded = false;
  }

  _file() {
    return path.join(app.getPath('userData'), 'pending.json');
  }

  load() {
    if (this._loaded) return;
    const items = readJson(this._file(), []);
    this.items = Array.isArray(items) ? items : [];
    this._loaded = true;
  }

  _save() {
    try {
      writeJsonAtomic(this._file(), this.items);
    } catch (e) {
      // non-fatal
    }
    this.emit('update', this.list());
  }

  static key(spec) {
    return [spec.series, (spec.season != null ? spec.season : ''), spec.episode, spec.mode || 'dub', spec.template || spec.baseUrl || ''].join('|');
  }

  add(spec) {
    this.load();
    const key = PendingStore.key(spec);
    if (this.items.some((it) => it.key === key)) return false;
    this.items.push({
      key,
      label: spec.label,
      series: spec.series,
      season: spec.season != null ? spec.season : null,
      episode: spec.episode,
      outputRoot: spec.outputRoot,
      template: spec.template || null,
      baseUrl: spec.baseUrl || null,
      mode: spec.mode || 'dub',
      // Engine (Part 5): re-queued episodes must still land in the library.
      library: spec.library || null,
      minHeight: Number(spec.minHeight) || 0,
      // Anime DUB entries: the daily pass checks the source for the dub
      // (TMDB id + the TMDB-numbered pair the source URL uses) before it
      // re-queues anything.
      anime: !!spec.anime,
      tmdb: spec.tmdb ? String(spec.tmdb) : null,
      urlSeason: spec.urlSeason != null ? Number(spec.urlSeason) : null,
      urlEpisode: spec.urlEpisode != null ? Number(spec.urlEpisode) : null,
      episodeName: spec.episodeName || '',
      addedAt: Date.now(),
      lastChecked: null
    });
    this._save();
    return true;
  }

  // Returns true when an entry was removed.
  remove(key) {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((it) => it.key !== key);
    if (this.items.length === before) return false;
    this._save();
    return true;
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

module.exports = new PendingStore();
