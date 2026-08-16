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
//
// Many embeds (echovideo / Vidplay) call getSources, receive the m3u8 URL, then
// never actually start playback in Electron — so media requests never fire.
// We therefore also pull stream URLs out of those source-list API responses.
class Sniffer extends EventEmitter {
  constructor() {
    super();
    // Map<webContentsId, Map<url, detection>>
    this.byTab = new Map();
    this.attached = false;
    this._sourcesMeta = new Map(); // apiUrl -> { webContentsId, headers }
    this._sourcesFetched = new Set();
    // Last iframe/embed URL per tab, from ajax source APIs (used to repair
    // players that set iframe.src to https://undefined/...).
    this._embeds = new Map();
  }

  attach() {
    if (this.attached) return;
    const sess = session.fromPartition(config.sessionPartition);

    // Capture media requests with their headers as they are sent.
    sess.webRequest.onSendHeaders((details) => {
      if (this._isMediaUrl(details.url)) {
        this._record(details, details.requestHeaders || {});
      }
      if (this._isSourcesApi(details.url) || this._isEmbedApi(details.url)) {
        this._sourcesMeta.set(details.url, {
          webContentsId: details.webContentsId,
          headers: details.requestHeaders || {}
        });
      }
    });

    // Content-type media + soft iframe unlock (XFO only — stripping CSP broke
    // some players into https://undefined/... embeds).
    sess.webRequest.onHeadersReceived((details, cb) => {
      try {
        const status = details.statusCode || 0;
        const ct = this._headerValue(details.responseHeaders, 'content-type');
        const byType = ct && this._isMediaContentType(ct) && !this._isIgnoredHost(details.url);
        const byUrl = this._isMediaUrl(details.url);

        if ((byUrl || byType) && status >= 200 && status < 300) {
          const existing = this.byTab.get(details.webContentsId);
          const prev = existing && existing.get(details.url);
          this._record(details, (prev && prev.headers) || {});
        } else if (byUrl && status >= 400) {
          this._forget(details.webContentsId, details.url);
        }

        if (details.resourceType === 'subFrame') {
          const headers = { ...(details.responseHeaders || {}) };
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'x-frame-options') delete headers[key];
          }
          cb({ responseHeaders: headers });
        } else {
          cb({});
        }
      } catch (e) {
        cb({});
      }
    });

    // When a player source-list API succeeds, pull stream URLs from the JSON
    // body. JW players often never request the m3u8 themselves under Electron.
    sess.webRequest.onCompleted((details) => {
      if (!this._isSourcesApi(details.url) && !this._isEmbedApi(details.url)) return;
      if (details.statusCode < 200 || details.statusCode >= 300) return;
      if (this._sourcesFetched.has(details.url)) return;
      this._sourcesFetched.add(details.url);
      setTimeout(() => this._sourcesFetched.delete(details.url), 120000);
      const meta = this._sourcesMeta.get(details.url) || {};
      this._pullSources(details.url, details.webContentsId || meta.webContentsId, meta.headers || {}).catch(
        () => {}
      );
    });

    this.attached = true;
  }

  _isSourcesApi(url) {
    return /\/getSources(?:\?|$)/i.test(url) || /\/mediainfo(?:\?|$)/i.test(url);
  }

  // Site ajax that returns the third-party player iframe URL (not the m3u8).
  // When this fails or the page drops the host, iframe.src becomes https://undefined/...
  _isEmbedApi(url) {
    return (
      /\/ajax\/(?:v2\/)?episode\/sources(?:\?|$)/i.test(url) ||
      /\/ajax\/embed(?:\/|source|\?|$)/i.test(url) ||
      /\/ajax\/server(?:\?|$)/i.test(url) ||
      /\/ajax\/(?:episode\/)?source(?:\?|$)/i.test(url)
    );
  }

  async _pullSources(apiUrl, webContentsId, reqHeaders) {
    if (webContentsId == null) return;
    const sess = session.fromPartition(config.sessionPartition);
    const headers = {};
    for (const [k, v] of Object.entries(reqHeaders || {})) {
      if (['referer', 'origin', 'cookie', 'user-agent', 'authorization'].includes(k.toLowerCase())) {
        headers[k] = v;
      }
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = config.download.userAgent;
    }

    const resp = await sess.fetch(apiUrl, { headers });
    if (!resp.ok) return;
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }

    const urls = this._extractUrlsFromSourcesJson(data);
    const embeds = this._extractEmbedUrlsFromJson(data);

    let referer = headers.Referer || headers.referer || '';
    let origin = headers.Origin || headers.origin || '';
    try {
      if (!origin && referer) origin = new URL(referer).origin;
      if (!referer && origin) referer = origin + '/';
    } catch (e) {
      /* ignore */
    }

    const mediaHeaders = {
      'User-Agent': headers['User-Agent'] || headers['user-agent'] || config.download.userAgent
    };
    if (referer) mediaHeaders.Referer = referer;
    if (origin) mediaHeaders.Origin = origin;

    if (embeds.length) {
      this._embeds.set(webContentsId, { url: embeds[0], headers: mediaHeaders, ts: Date.now() });
      this.emit('embed', { webContentsId, url: embeds[0] });
    }

    if (!urls.length) return;

    for (const url of urls) {
      this._record({ url, webContentsId }, mediaHeaders);
    }
  }

  _extractEmbedUrlsFromJson(data) {
    const out = [];
    const add = (u) => {
      if (typeof u !== 'string') return;
      const s = u.trim();
      if (!/^https?:\/\//i.test(s)) return;
      if (/:\/\/undefined\b/i.test(s)) return;
      if (this._isMediaUrl(s) || /\.(m3u8|mpd|mp4)(\?|$)/i.test(s)) return;
      out.push(s);
    };
    if (!data || typeof data !== 'object') return out;
    add(data.link);
    add(data.embed);
    add(data.embed_url);
    add(data.embedUrl);
    add(data.source);
    if (data.result && typeof data.result === 'object') {
      add(data.result.link);
      add(data.result.embed);
      add(data.result.url);
    }
    if (data.data && typeof data.data === 'object') {
      add(data.data.link);
      add(data.data.embed);
      add(data.data.url);
    }
    return [...new Set(out)];
  }

  _extractUrlsFromSourcesJson(data) {
    const out = [];
    const add = (u) => {
      if (typeof u !== 'string') return;
      const s = u.trim();
      if (!/^https?:\/\//i.test(s)) return;
      if (this._isMediaUrl(s) || /\.(m3u8|mpd|mp4)(\?|$)/i.test(s)) out.push(s);
    };

    if (data == null) return out;
    if (typeof data === 'string') {
      const t = data.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return this._extractUrlsFromSourcesJson(JSON.parse(t));
        } catch (e) {
          add(t);
          return out;
        }
      }
      add(t);
      return out;
    }
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') add(item);
        else if (item && typeof item === 'object') {
          add(item.file);
          add(item.src);
          add(item.url);
          add(item.link);
          if (item.sources != null) out.push(...this._extractUrlsFromSourcesJson(item.sources));
        }
      }
      return [...new Set(out)];
    }
    if (typeof data === 'object') {
      if (data.sources != null) out.push(...this._extractUrlsFromSourcesJson(data.sources));
      if (data.playlist != null) out.push(...this._extractUrlsFromSourcesJson(data.playlist));
      add(data.file);
      add(data.src);
      add(data.url);
      add(data.link);
    }
    return [...new Set(out)];
  }

  _forget(webContentsId, url) {
    const tabMap = this.byTab.get(webContentsId);
    if (!tabMap) return;
    tabMap.delete(url);
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
    const picked = this._pickHeaders(requestHeaders);
    if (tabMap.has(details.url)) {
      const prev = tabMap.get(details.url);
      if (picked && Object.keys(picked).length && (!prev.headers || !Object.keys(prev.headers).length)) {
        prev.headers = picked;
      }
      return;
    }

    const detection = {
      url: details.url,
      type: this._type(details.url),
      headers: picked,
      webContentsId: id,
      ts: Date.now()
    };
    tabMap.set(details.url, detection);
    this.emit('detected', detection);
  }

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

  latest(webContentsId, types = ['hls', 'mp4', 'dash']) {
    const items = this.list(webContentsId).filter((d) => types.includes(d.type));
    if (!items.length) return null;
    return items.sort((a, b) => b.ts - a.ts)[0];
  }

  best(webContentsId) {
    const items = this.list(webContentsId).filter((d) => ['hls', 'mp4', 'dash'].includes(d.type));
    if (!items.length) return null;
    return items.sort((a, b) => baseScore(b) - baseScore(a) || b.ts - a.ts)[0];
  }

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

  hasMode(webContentsId, mode, hints) {
    return this.list(webContentsId)
      .filter((d) => ['hls', 'mp4', 'dash'].includes(d.type))
      .some((d) => urlMode(d.url, hints) === mode);
  }

  latestSub(webContentsId) {
    const items = this.list(webContentsId).filter((d) => d.type === 'sub');
    if (!items.length) return null;
    return items.sort((a, b) => b.ts - a.ts)[0];
  }

  lastEmbed(webContentsId) {
    return this._embeds.get(webContentsId) || null;
  }

  clear(webContentsId) {
    this.byTab.delete(webContentsId);
  }
}

module.exports = new Sniffer();
