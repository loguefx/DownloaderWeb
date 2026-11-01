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
    // One entry per episode: lists saved before entries were identified
    // by the episode (not its URL) can hold the same episode twice - LINK
    // CLICK S3E11 parked once with the old URL (3-11) and once with the
    // corrected TMDB one (4-11). Keep the oldest, with the newest URL.
    const merged = [];
    for (const it of this.items) {
      const prev = merged.find((x) => PendingStore.identity(x) === PendingStore.identity(it));
      if (!prev) {
        merged.push(it);
        continue;
      }
      const newer = (it.addedAt || 0) >= (prev.addedAt || 0) ? it : prev;
      const older = newer === it ? prev : it;
      Object.assign(older, { baseUrl: newer.baseUrl, template: newer.template, urlSeason: newer.urlSeason, urlEpisode: newer.urlEpisode });
      if (older !== prev) merged[merged.indexOf(prev)] = older;
    }
    if (merged.length !== this.items.length) {
      this.items = merged;
      this._save();
    }
  }

  // The episode an entry is for, whatever source URL it carries.
  static identity(spec) {
    const name = String(spec.series || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return [name, spec.season != null ? Number(spec.season) : '', Number(spec.episode), spec.mode || 'dub'].join('|');
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
    // Already waiting under another URL: same episode - keep the one entry,
    // with the newer URL (a corrected source address wins).
    const same = this.items.find((it) => PendingStore.identity(it) === PendingStore.identity(spec));
    if (same) {
      if ((spec.baseUrl || spec.template) && (same.baseUrl !== (spec.baseUrl || null) || same.template !== (spec.template || null))) {
        same.baseUrl = spec.baseUrl || null;
        same.template = spec.template || null;
        if (spec.urlSeason != null) same.urlSeason = Number(spec.urlSeason);
        if (spec.urlEpisode != null) same.urlEpisode = Number(spec.urlEpisode);
        this._save();
      }
      return false;
    }
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
      // Season numbering of the target library ('anime' = AniDB-style).
      numbering: spec.numbering === 'anime' ? 'anime' : 'tmdb',
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

  // A finished download clears its waiting entry, whoever queued it (the
  // watch list queued Chained Soldier S2E12; its waiting entry stayed until
  // the next daily pass found the file). Returns the number removed.
  removeEpisode(spec) {
    this.load();
    const id = PendingStore.identity(spec);
    const before = this.items.length;
    this.items = this.items.filter((it) => PendingStore.identity(it) !== id);
    const n = before - this.items.length;
    if (n) this._save();
    return n;
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
