'use strict';

const path = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');
const { writeJsonAtomic, readJson } = require('./jsonfile');

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
    return [spec.series, (spec.season != null ? spec.season : ''), spec.mode || 'dub', spec.template || spec.baseUrl || ''].join('|');
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
      if (spec.library != null) existing.library = spec.library;
      if (spec.minHeight != null) existing.minHeight = Number(spec.minHeight) || 0;
      // Anime flag must survive re-submission so the daily re-check keeps the
      // anime rules (source-resolution floor off, no episode invention) even
      // after the original job is long gone.
      if (spec.anime != null) existing.anime = !!spec.anime;
      // TMDB ids power the daily "what has aired" check; keep them when a
      // re-submission carries them (older entries may not have any).
      if (spec.tmdb) existing.tmdb = String(spec.tmdb);
      if (spec.imdb) existing.imdb = String(spec.imdb);
      if (spec.movie != null) existing.movie = !!spec.movie;
      // Opt-out override: only a deliberate spec (frozen true/false) changes
      // it; a plain re-submission leaves the user's earlier decision intact so
      // an already-unfrozen at-risk title stays unfrozen across re-adds.
      if (spec.frozen !== undefined) existing.frozen = !!spec.frozen;
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
      // Engine (Part 5): new episodes for a watched series must land in the
      // library, not be stranded in staging.
      library: spec.library || null,
      minHeight: Number(spec.minHeight) || 0,
      anime: !!spec.anime,
      // TMDB ids: the daily check asks TMDB "what has aired" instead of
      // guessing from the source page (sources like Vidsrc list no episodes
      // at all, so the old path re-queued every future episode daily).
      tmdb: spec.tmdb ? String(spec.tmdb) : null,
      imdb: spec.imdb ? String(spec.imdb) : null,
      // A movie watch is just "is the file still there?" - no episodes.
      movie: !!spec.movie,
      // Opt-out: leave UNSET unless the caller set it explicitly. Unset means
      // "follow the engine risk-series policy" (watcher.isFrozen), which keeps
      // a freshly-queued at-risk title safe out of the box.
      ...(spec.frozen !== undefined ? { frozen: !!spec.frozen } : {}),
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

  // The watcher confirmed the NEXT season exists and queued it: advance the
  // watch to that season so daily checks track the show forward instead of
  // re-probing the season we are already caught up on. The key embeds the
  // season, so it is recomputed for the new value.
  bumpSeason(key, season) {
    this.load();
    const it = this.items.find((x) => x.key === key);
    if (!it || it.season === season) return;
    it.season = season;
    it.key = ScheduleStore.key({ series: it.series, season, mode: it.mode, template: it.template || it.baseUrl });
    // tmdb/imdb/movie are part of the entry, not the key - they carry over.
    this._save();
  }

  markChecked(key) {
    this.load();
    const it = this.items.find((x) => x.key === key);
    if (it) {
      it.lastChecked = Date.now();
      this._save();
    }
  }

  // Older entries predate TMDB-id storage; the watcher recovers the id from
  // the source URL and stores it here so the TMDB-aware check can run.
  setIds(key, tmdb, imdb) {
    this.load();
    const it = this.items.find((x) => x.key === key);
    if (!it) return;
    if (tmdb) it.tmdb = String(tmdb);
    if (imdb) it.imdb = String(imdb);
    this._save();
  }

  // Opt-out override for ONE entry. true = frozen (skip auto-download);
  // false = cleared (layout aligned / user verified - watch it again).
  setFrozen(key, value) {
    this.load();
    const it = this.items.find((x) => x.key === key);
    if (!it) return false;
    it.frozen = !!value;
    this._save();
    return true;
  }

  // Set the opt-out override on EVERY entry that carries this TMDB id (a
  // series can hold several season entries). Returns how many were touched.
  setFrozenByTmdb(tmdb, value) {
    this.load();
    const id = String(tmdb || '');
    let n = 0;
    for (const it of this.items) {
      if (it.tmdb && String(it.tmdb) === id) { it.frozen = !!value; n += 1; }
    }
    if (n) this._save();
    return n;
  }

  list() {
    this.load();
    return this.items.slice();
  }
}

module.exports = new ScheduleStore();
