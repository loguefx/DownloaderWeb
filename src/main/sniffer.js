'use strict';

const { session } = require('electron');
const { EventEmitter } = require('events');
const config = require('./config');

// Resolution embedded in a stream URL (e.g. ".../720/index.m3u8").
function resOf(url) {
  const m = url.match(/(2160|1440|1080|720|480|360|240)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Quality ranking: HLS master > HLS variant (by res) > mp4 > dash.
function baseScore(d) {
  const u = d.url.toLowerCase();
  if (d.type === 'hls' && /master/.test(u)) return 100000;
  if (d.type === 'hls') return 50000 + resOf(u);
  if (d.type === 'mp4') return 40000 + resOf(u);
  if (d.type === 'dash') return 30000;
  return 0;
}

// Classifies a stream URL as 'dub', 'sub', or null (neutral) using site hints.
function urlMode(url, hints) {
  const u = (url || '').toLowerCase();
  const isDub = ((hints && hints.dub) || []).some((re) => re.test(u));
  const isSub = ((hints && hints.sub) || []).some((re) => re.test(u));
  if (isDub && !isSub) return 'dub';
  if (isSub && !isDub) return 'sub';
  return null;
}

// Watches a Chromium session for media requests (HLS/DASH/MP4) and records the
// URL together with the request headers (referer/cookie/user-agent/origin)
// needed to download it later. Attribution is per webContents so each tab /
// offscreen window has its own detection list.
class Sniffer extends EventEmitter {
  constructor() {
    super();
    // Map<webContentsId, Map<url, detection>>
    this.byTab = new Map();
    this.attached = false;
  }

  attach() {
    if (this.attached) return;
    const sess = session.fromPartition(config.sessionPartition);

    // Capture request headers as the request is sent.
    sess.webRequest.onSendHeaders((details) => {
      if (!this._isMediaUrl(details.url)) return;
      this._record(details, details.requestHeaders || {});
    });

    // Also catch media identified by response content-type (URL without a
    // recognizable extension, e.g. tokenized playlists).
    sess.webRequest.onHeadersReceived((details, cb) => {
      try {
        const ct = this._headerValue(details.responseHeaders, 'content-type');
        if (ct && this._isMediaContentType(ct) && !this._isIgnoredHost(details.url)) {
          this._record(details, {});
        }
      } catch (e) {
        // ignore
      }
      cb({});
    });

    this.attached = true;
  }

  _headerValue(headers, name) {
    if (!headers) return null;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) return null;
    const v = headers[key];
    return Array.isArray(v) ? v[0] : v;
  }

  _isMediaUrl(url) {
    if (!url || this._isIgnoredHost(url)) return false;
    if (config.media.urlPatterns.some((re) => re.test(url))) return true;
    return (config.media.subtitlePatterns || []).some((re) => re.test(url));
  }

  _isSubtitleUrl(url) {
    return (config.media.subtitlePatterns || []).some((re) => re.test(url));
  }

  _isMediaContentType(ct) {
    return config.media.contentTypePatterns.some((re) => re.test(ct));
  }

  _isIgnoredHost(url) {
    return config.media.ignoreHosts.some((re) => re.test(url));
  }

  _type(url) {
    if (this._isSubtitleUrl(url)) return 'sub';
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|$)/i.test(url)) return 'dash';
    if (/\.mp4(\?|$)/i.test(url)) return 'mp4';
    return 'hls'; // content-type detected playlists are usually HLS
  }

  _record(details, requestHeaders) {
    const id = details.webContentsId;
    if (id == null) return;
    if (!this.byTab.has(id)) this.byTab.set(id, new Map());
    const tabMap = this.byTab.get(id);
    if (tabMap.has(details.url)) return; // dedupe

    const detection = {
      url: details.url,
      type: this._type(details.url),
      headers: this._pickHeaders(requestHeaders),
      webContentsId: id,
      ts: Date.now()
    };
    tabMap.set(details.url, detection);
    this.emit('detected', detection);
  }

  // Keep only the headers servers commonly require for the media request.
  _pickHeaders(requestHeaders) {
    const wanted = ['referer', 'origin', 'cookie', 'user-agent', 'authorization'];
    const out = {};
    for (const k of Object.keys(requestHeaders || {})) {
      if (wanted.includes(k.toLowerCase())) out[k] = requestHeaders[k];
    }
    return out;
  }

  list(webContentsId) {
    const tabMap = this.byTab.get(webContentsId);
    return tabMap ? Array.from(tabMap.values()) : [];
  }

  // Newest detection of a downloadable type (hls/mp4/dash) for a tab.
  latest(webContentsId, types = ['hls', 'mp4', 'dash']) {
    const items = this.list(webContentsId).filter((d) => types.includes(d.type));
    if (!items.length) return null;
    return items.sort((a, b) => b.ts - a.ts)[0];
  }

  // The single best stream to download for a tab. Prefers an HLS *master*
  // playlist (it contains every quality, so ffmpeg picks the best), then the
  // highest-resolution variant, then mp4/dash, newest as the tiebreaker. This is
  // what guarantees one file per episode in bulk.
  best(webContentsId) {
    const items = this.list(webContentsId).filter((d) => ['hls', 'mp4', 'dash'].includes(d.type));
    if (!items.length) return null;
    return items.sort((a, b) => baseScore(b) - baseScore(a) || b.ts - a.ts)[0];
  }

  // Like best(), but filtered by requested audio mode using URL hints.
  //   strict=false (default): accept URLs marked for `mode` OR unmarked/neutral
  //     (we trust the click). Rejects URLs clearly marked for the OTHER audio.
  //   strict=true: accept ONLY URLs explicitly marked for `mode`. Used when a
  //     site is known to tag the audio in the path (e.g. ".../show-dub/..."), so
  //     an unmarked stream is assumed to be the default (sub) and is rejected.
  // Returns null when nothing qualifies.
  bestForMode(webContentsId, mode, hints, strict = false) {
    const items = this.list(webContentsId).filter((d) => ['hls', 'mp4', 'dash'].includes(d.type));
    if (!items.length) return null;
    const ok = items.filter((d) => {
      const m = urlMode(d.url, hints);
      return strict ? m === mode : m === null || m === mode;
    });
    if (!ok.length) return null;
    const score = (d) => baseScore(d) + (urlMode(d.url, hints) === mode ? 1000000 : 0);
    return ok.sort((a, b) => score(b) - score(a) || b.ts - a.ts)[0];
  }

  // True if any detected stream is explicitly marked for `mode`.
  hasMode(webContentsId, mode, hints) {
    return this.list(webContentsId)
      .filter((d) => ['hls', 'mp4', 'dash'].includes(d.type))
      .some((d) => urlMode(d.url, hints) === mode);
  }

  // Newest subtitle file detected for a tab (used by Sub mode).
  latestSub(webContentsId) {
    const items = this.list(webContentsId).filter((d) => d.type === 'sub');
    if (!items.length) return null;
    return items.sort((a, b) => b.ts - a.ts)[0];
  }

  clear(webContentsId) {
    this.byTab.delete(webContentsId);
  }
}

module.exports = new Sniffer();
