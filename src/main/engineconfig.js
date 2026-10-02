'use strict';

// Engine (service) configuration, persisted to <userData>/engine.json.
//
//   apiKey        Bearer key required by every /api/* request. Generated on
//                 first run; keep it - the Jellyfin plugin stores the same
//                 value, and the README lists this file for backups.
//   port          HTTP API port (default 7878).
//   bind          Interface to bind (default 0.0.0.0 = LAN; the firewall
//                 should still allow only the Jellyfin machine).
//   stagingPath   Finished downloads are verified here first, then placed on
//                 a library drive (Part 5). Default <userData>/staging.
//   reserveBytes  Free-space reserve a library drive must keep (Part 5).
//   fillMode      "order" = fill the library's folders in order;
//                 "spread" = use the folder with the most free space.
//   pathMappings  Jellyfin path -> engine path prefix pairs. Jellyfin may see
//                 a drive as /mnt/disk1/anime while the engine PC mounts the
//                 same share at Z:\anime; jobs and reports use Jellyfin paths,
//                 the engine converts only when it touches the disk.
//   jellyfin      baseUrl + API key (Dashboard -> API Keys) for the
//                 per-folder refresh call after a file is placed.
//
// Read-only library mode lives in library.js (library.json) so the desktop
// app and the engine share the same switch.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function defaultDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'webvideodownloader');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'webvideodownloader');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'webvideodownloader');
}

function defaults() {
  return {
    apiKey: crypto.randomBytes(20).toString('hex'),
    port: 7878,
    bind: '0.0.0.0',
    stagingPath: '',
    reserveBytes: 50 * 1024 * 1024 * 1024,
    fillMode: 'order',
    pathMappings: [],
    jellyfin: { baseUrl: '', apiKey: '' }
  };
}

const engineconfig = {
  dataDir: null,
  _data: null,

  file() {
    this.dataDir = this.dataDir || defaultDataDir();
    return path.join(this.dataDir, 'engine.json');
  },

  get() {
    if (this._data) return this._data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      this._data = Object.assign(defaults(), raw || {});
      // Keep the shape stable as new fields are added.
      this._data.jellyfin = Object.assign({ baseUrl: '', apiKey: '' }, (raw || {}).jellyfin || {});
      this._data.pathMappings = Array.isArray(this._data.pathMappings) ? this._data.pathMappings : [];
    } catch (e) {
      this._data = defaults();
      this._persist(); // first run: create the file with a generated key
    }
    return this._data;
  },

  // Merge a partial config and persist. Returns the new config.
  set(patch) {
    const next = Object.assign(this.get(), patch || {});
    if (patch && patch.jellyfin) next.jellyfin = Object.assign(this.get().jellyfin, patch.jellyfin);
    if (!Array.isArray(next.pathMappings)) next.pathMappings = [];
    this._data = next;
    this._persist();
    return next;
  },

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      const tmp = this.file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2));
      fs.renameSync(tmp, this.file());
    } catch (e) {
      // non-fatal: the in-memory copy still works this session
    }
  },

  // Where finished files are staged before placement (Part 5).
  stagingPath() {
    const c = this.get();
    if (c.stagingPath) return path.resolve(c.stagingPath);
    this.dataDir = this.dataDir || defaultDataDir();
    return path.join(this.dataDir, 'staging');
  }
};

module.exports = engineconfig;
module.exports.defaultDataDir = defaultDataDir;
