'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

// BYFMS (and similar) will happily serve a master playlist whose first media
// segment is a 20-minute stub that 502s. ffmpeg then copies the leftover 45s of
// tail segments, exits 0, and we used to hand that to the queue as a "success"
// that immediately failed verification / truncation checks — download, then
// resolve, forever.

// Whole-probe budget. Node's socket `timeout` only fires on idle sockets; a TLS
// hang through a VPN often never goes idle, so without this hard cap discovery
// sits silent until the stall watchdog kills the episode.
const PROBE_MS = 8000;

const CDN_HOST_RE =
  /peakstorm|vidfast|ashencloud|ashenlion|orbitnorth|hiddenmesa|solidbear|primecomet|calmcanvas|nobleember|plainorbit|nobletrail|rapidtree|metaldisk|cybergate|quietraven|thunderpencil|pearlmaple|novaoak|lightgrove|peakbadger/i;
const CDN_PATH_RE = /\/r6\/|\/r2\/|\/vd\//i;
const PAGE_CDN_RE =
  'peakstorm|ashencloud|ashenlion|orbitnorth|hiddenmesa|solidbear|primecomet|calmcanvas|nobleember|plainorbit|nobletrail|rapidtree|metaldisk|vidfast|thunderpencil|pearlmaple|novaoak|lightgrove|peakbadger|\\/r6\\/|\\/r2\\/|\\/vd\\/';
const CDP_FETCH_PATTERNS = [
  { urlPattern: '*peakstorm*', requestStage: 'Response' },
  { urlPattern: '*ashencloud*', requestStage: 'Response' },
  { urlPattern: '*ashenlion*', requestStage: 'Response' },
  { urlPattern: '*orbitnorth*', requestStage: 'Response' },
  { urlPattern: '*hiddenmesa*', requestStage: 'Response' },
  { urlPattern: '*solidbear*', requestStage: 'Response' },
  { urlPattern: '*primecomet*', requestStage: 'Response' },
  { urlPattern: '*calmcanvas*', requestStage: 'Response' },
  { urlPattern: '*nobleember*', requestStage: 'Response' },
  { urlPattern: '*plainorbit*', requestStage: 'Response' },
  { urlPattern: '*nobletrail*', requestStage: 'Response' },
  { urlPattern: '*rapidtree*', requestStage: 'Response' },
  { urlPattern: '*metaldisk*', requestStage: 'Response' },
  { urlPattern: '*/r2/*', requestStage: 'Response' },
  { urlPattern: '*/r6/*', requestStage: 'Response' },
  { urlPattern: '*/vd/*', requestStage: 'Response' }
];
const CDP_BODY_MAX = 12 * 1024 * 1024;
const fetchBodyQueues = new WeakMap();

function enqueueFetchBodyCopy(wc, fn) {
  const prev = (wc && fetchBodyQueues.get(wc)) || Promise.resolve();
  const run = prev.then(fn, fn);
  if (wc) fetchBodyQueues.set(wc, run.catch(() => {}));
  return run;
}

function finishOnce() {
  let done = false;
  return (fn) => (v) => {
    if (done) return;
    done = true;
    fn(v);
  };
}

function requestNode(url, headers, { method = 'GET', maxBytes = 0, timeoutMs = PROBE_MS, redirectsLeft = 4, signal } = {}) {
  return new Promise((resolve) => {
    let req;
    const fin = finishOnce()((v) => {
      clearTimeout(hard);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(v);
    });
    const kill = () => {
      try {
        if (req) req.destroy();
      } catch (e) {
        // ignore
      }
      fin({ status: 0, body: '', url });
    };
    const hard = setTimeout(kill, timeoutMs);
    const onAbort = () => kill();
    if (signal) {
      if (signal.aborted) return fin({ status: 0, body: '', url });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return fin({ status: 0, body: '', url });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const h = { ...(headers || {}) };
    try {
      req = lib.request(url, { method, headers: h, timeout: timeoutMs }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return request(new URL(res.headers.location, url).toString(), headers, {
            method,
            maxBytes,
            timeoutMs,
            redirectsLeft: redirectsLeft - 1,
            signal
          }).then(fin);
        }
        if (maxBytes <= 0) {
          res.resume();
          return fin({ status: code, body: '', url });
        }
        const chunks = [];
        let n = 0;
        res.on('data', (c) => {
          if (n >= maxBytes) return;
          const take = c.length + n > maxBytes ? c.subarray(0, maxBytes - n) : c;
          chunks.push(take);
          n += take.length;
          if (n >= maxBytes) {
            res.destroy();
            try {
              req.destroy();
            } catch (e) {
              // ignore
            }
          }
        });
        res.on('end', () => fin({ status: code, body: Buffer.concat(chunks).toString('utf8'), url }));
        res.on('error', () => fin({ status: code, body: Buffer.concat(chunks).toString('utf8'), url }));
      });
    } catch (e) {
      return fin({ status: 0, body: '', url });
    }
    req.on('timeout', kill);
    req.on('error', () => fin({ status: 0, body: '', url }));
    req.end();
  });
}

async function requestViaSession(url, headers, { maxBytes = 0, timeoutMs = PROBE_MS, signal } = {}) {
  let ses;
  try {
    const { session } = require('electron');
    const config = require('./config');
    ses = session.fromPartition(config.sessionPartition);
    if (!ses || typeof ses.fetch !== 'function') return null;
  } catch (e) {
    return null;
  }
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  const hard = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) return { status: 0, body: '', url };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await ses.fetch(url, { headers: headers || {}, signal: ac.signal });
    const code = res.status || 0;
    if (maxBytes <= 0) {
      try {
        if (res.body && typeof res.body.cancel === 'function') res.body.cancel();
      } catch (e) {
        // ignore
      }
      return { status: code, body: '', url: res.url || url };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: code, body: buf.subarray(0, maxBytes).toString('utf8'), url: res.url || url };
  } catch (e) {
    return { status: 0, body: '', url };
  } finally {
    clearTimeout(hard);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function request(url, headers, opts = {}) {
  const viaChromium = await requestViaSession(url, headers, opts);
  if (viaChromium) return viaChromium;
  return requestNode(url, headers, opts);
}

function firstUri(playlist) {
  return (playlist || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
}

function looksLikePlaylist(text) {
  return /^#EXTM3U/m.test(text || '');
}

function isMasterPlaylist(text) {
  const t = String(text || '');
  return /#EXT-X-STREAM-INF/i.test(t) && !/#EXTINF:/i.test(t);
}

function isMediaPlaylist(text) {
  return /#EXTINF:/i.test(String(text || ''));
}

function playlistPathname(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return String(url || '').split('?')[0];
  }
}

function playlistFromBuffer(buf, url) {
  if (!buf || !buf.length) return null;
  const utf8 = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (looksLikePlaylist(utf8)) return { body: utf8, url, status: 200 };
  const latin1 = Buffer.isBuffer(buf) ? buf.toString('latin1') : utf8;
  if (looksLikePlaylist(latin1)) return { body: latin1, url, status: 200 };
  return null;
}

function looksLikeHtml(text) {
  const t = String(text || '')
    .slice(0, 256)
    .trim();
  return /^<!DOCTYPE/i.test(t) || /^<html/i.test(t) || /<html[\s>]/i.test(t);
}

function looksLikeJson(text) {
  const t = String(text || '')
    .slice(0, 64)
    .trim();
  return t.startsWith('{') || t.startsWith('[');
}

function parseStreamInf(line) {
  const bw = parseInt((String(line).match(/\bBANDWIDTH=(\d+)/i) || [])[1] || '0', 10) || 0;
  const res = String(line).match(/RESOLUTION=(\d+)x(\d+)/i);
  return {
    bw,
    w: res ? parseInt(res[1], 10) : 0,
    h: res ? parseInt(res[2], 10) : 0,
    audio: ((String(line).match(/AUDIO="([^"]+)"/i) || [])[1] || '').trim()
  };
}

function variantScore(info) {
  return (info.h || 0) * 1e12 + (info.w || 0) * 1e6 + (info.bw || 0);
}

function bestAudioGroupId(playlist) {
  let bestId = '';
  let bestScore = -1;
  for (const line of String(playlist || '').split(/\r?\n/)) {
    if (!/#EXT-X-MEDIA:/i.test(line) || !/TYPE=AUDIO/i.test(line)) continue;
    const id = ((line.match(/GROUP-ID="([^"]+)"/i) || [])[1] || '').trim();
    if (!id) continue;
    const ch = parseInt((line.match(/CHANNELS="([^"]+)"/i) || [])[1] || '0', 10) || 0;
    const def = /DEFAULT=YES/i.test(line) ? 1 : 0;
    const name = ((line.match(/NAME="([^"]+)"/i) || [])[1] || '').toLowerCase();
    const hi = /atmos|truehd|ddp|eac-3|ec-3|5\.1|7\.1/i.test(name) ? 50 : 0;
    const score = ch * 1000 + hi + def;
    if (score >= bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

function bestVariantUri(playlist, base) {
  const lines = String(playlist || '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const wantAudio = bestAudioGroupId(playlist);
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
    const next = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!next) continue;
    const info = parseStreamInf(lines[i]);
    let score = variantScore(info);
    if (wantAudio && info.audio === wantAudio) score += 1e15;
    if (score >= bestScore) {
      bestScore = score;
      best = next;
    }
  }
  const pick = best || firstUri(playlist);
  if (!pick) return null;
  try {
    return new URL(pick, base).toString();
  } catch (e) {
    return null;
  }
}

// The player picks its own rendition by ABR, and the window.Hls hook in
// player-hook-preload never lands on bundlers that keep hls.js module-scoped
// (vidfast). With several captures running at once ABR reads the contention as
// low bandwidth and settles on 360-800p, so we harvest a downgraded stream.
// Serving a master that advertises only the best variant removes the choice.
// EXT-X-MEDIA rows stay so the variant's AUDIO/SUBTITLES groups still resolve.
function trimMasterToBest(text, base) {
  if (!isMasterPlaylist(text)) return '';
  const best = bestVariantUri(text, base);
  if (!best) return '';
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let kept = false;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i].trim())) {
      out.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
    if (j >= lines.length) break;
    let abs = '';
    try {
      abs = new URL(lines[j].trim(), base).toString();
    } catch (e) {
      abs = '';
    }
    if (!kept && abs === best) {
      out.push(lines[i].trim(), lines[j].trim());
      kept = true;
    }
    i = j;
  }
  if (!kept) return '';
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// Replaying the upstream headers keeps CORS intact; the body length and any
// content-encoding no longer describe what we are about to send.
function fulfillHeadersFrom(headers) {
  const out = [];
  for (const h of headers || []) {
    if (!h || !h.name) continue;
    if (/^(content-length|content-encoding)$/i.test(h.name)) continue;
    out.push({ name: String(h.name), value: String(h.value) });
  }
  return out;
}

function playlistMediaDuration(text) {
  let dur = 0;
  for (const m of String(text || '').matchAll(/#EXTINF:([\d.]+)/gi)) dur += parseFloat(m[1]) || 0;
  return dur;
}

function mediaPlaylistScore(url, text) {
  if (isMasterPlaylist(text)) return -1e9;
  const n = (String(text).match(/^#EXTINF/gm) || []).length || 0;
  let dur = 0;
  for (const m of String(text).matchAll(/#EXTINF:([\d.]+)/gi)) dur += parseFloat(m[1]) || 0;
  let score = n * 10 + dur;
  if (/\/r2\//i.test(url) || /index-s1080p/i.test(url)) score += 5000;
  if (/index-s720p/i.test(url)) score += 2000;
  if (/index-s480p/i.test(url)) score += 200;
  if (/peakstorm\.top\/s\//i.test(url)) score -= 500;
  return score;
}

function describeMediaPlaylist(url, text) {
  const n = (String(text).match(/^#EXTINF/gm) || []).length;
  let dur = 0;
  for (const m of String(text).matchAll(/#EXTINF:([\d.]+)/gi)) dur += parseFloat(m[1]) || 0;
  const inf = String(text).match(/#EXT-X-STREAM-INF:[^\n]+/i);
  const info = inf ? parseStreamInf(inf[0]) : {};
  const parts = [];
  if (info.h) parts.push(`${info.w}x${info.h}`);
  if (info.bw) parts.push(`${Math.round(info.bw / 1000)}kbps`);
  if (n) parts.push(`${n} part(s)`);
  if (dur) parts.push(`${Math.round(dur)}s`);
  // Deliberately not claiming a quality here: this used to print "high-bitrate"
  // for any /r2/ URL, which labelled 640x360 captures as high-bitrate and sent
  // every quality investigation down the wrong path. A media playlist does not
  // say what resolution it carries.
  if (/\/r2\//i.test(url || '')) parts.push('vod');
  return parts.join(', ') || String(url || '').slice(0, 80);
}

function rewritePlaylistUris(text, base) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return t.replace(/URI=(["'])([^"']+)\1/gi, (_, q, u) => {
          try {
            return `URI=${q}${new URL(u, base).toString()}${q}`;
          } catch (e) {
            return `URI=${q}${u}${q}`;
          }
        });
      }
      try {
        return new URL(t, base).toString();
      } catch (e) {
        return t;
      }
    })
    .join('\n');
}

function notPlaylistError(kind, status) {
  const err = new Error(
    kind === 'html' || kind === 'json'
      ? 'CDN returned a webpage instead of a playlist; will retry with a fresh stream'
      : 'CDN did not return an HLS playlist'
  );
  err.code = 'not-playlist';
  err.kind = kind || 'other';
  err.status = status || 0;
  return err;
}

// Full playlist body via Chromium (cookies/TLS) so ffmpeg does not have to
// open the token URL itself. Token CDNs often give Chromium a real #EXTM3U and
// ffmpeg a challenge page, which then dies with "Invalid data".
async function playlistFromPlayerHook(wc, url) {
  if (!wc || wc.isDestroyed()) return null;
  const want = String(url || '');
  for (const frame of collectFrames(wc)) {
    try {
      const b64 = await frame.executeJavaScript(
        `(() => {
          const parts = window.__wvdParts || {};
          const want = ${JSON.stringify(want)};
          if (parts[want]) return parts[want];
          const keys = Object.keys(parts);
          const hit = keys.find((k) => {
            if (k === want) return true;
            try {
              return k.split('?')[0] === want.split('?')[0];
            } catch (e) {
              return false;
            }
          }) || keys.find((k) => /\\.m3u8/i.test(k));
          return hit ? parts[hit] : '';
        })()`,
        true
      );
      if (!b64) continue;
      const got = playlistFromBuffer(Buffer.from(b64, 'base64'), url);
      if (got) return got;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
  }
  return null;
}

function cachedPlaylist(playerWebContentsId, url) {
  const wc = liveWebContents(playerWebContentsId);
  if (!wc || !wc._cdpPlaylists || !wc._cdpPlaylists.size) return null;
  const want = String(url || '');
  if (want && wc._cdpPlaylists.has(want)) {
    const text = wc._cdpPlaylists.get(want);
    if (looksLikePlaylist(text)) return { text, base: want };
  }
  if (want) {
    const wantPath = playlistPathname(want);
    const wantName = wantPath.split('/').filter(Boolean).pop() || '';
    for (const [u, text] of wc._cdpPlaylists) {
      if (!looksLikePlaylist(text)) continue;
      const p = playlistPathname(u);
      if (p === wantPath) return { text, base: u };
      if (wantName && wantName !== 'master.m3u8' && p.endsWith('/' + wantName)) return { text, base: u };
    }
    return null;
  }
  return bestCachedPlaylist(playerWebContentsId);
}

function bestCachedPlaylist(playerWebContentsId) {
  const wc = liveWebContents(playerWebContentsId);
  if (!wc || !wc._cdpPlaylists || !wc._cdpPlaylists.size) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const [u, text] of wc._cdpPlaylists) {
    if (!looksLikePlaylist(text) || isMasterPlaylist(text) || !isMediaPlaylist(text)) continue;
    const score = mediaPlaylistScore(u, text);
    if (score > bestScore) {
      bestScore = score;
      best = { text, base: u };
    }
  }
  return best;
}

async function fetchPlaylist(url, headers, signal = null, playerWebContentsId = null) {
  const h = { ...(headers || {}) };
  const cached = cachedPlaylist(playerWebContentsId, url);
  if (cached) return { body: cached.text, url: cached.base, status: 200 };
  const wc = liveWebContents(playerWebContentsId);
  if (wc) {
    try {
      const fromCache = playlistFromBuffer(await readPageResource(wc, url), url);
      if (fromCache) return fromCache;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
    const hooked = await playlistFromPlayerHook(wc, url);
    if (hooked) return hooked;
    // One-shot /s/ tokens die if anything besides the player fetches them.
    // VOD `/vd/` playlists can be re-fetched from the live page.
    if (isOneShotHls(url)) throw notPlaylistError('other', 0);
    try {
      const buf = await fetchViaWebContents(wc, url, { timeoutMs: 10000, signal });
      const fromPage = playlistFromBuffer(buf, url);
      if (fromPage) return fromPage;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
    try {
      const extra = await wc.executeJavaScript(
        `performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /m3u8|peakstorm/i.test(n)).slice(-8)`,
        true
      );
      for (const u of extra || []) {
        if (!u || u === url) continue;
        try {
          const fromRes = playlistFromBuffer(await readPageResource(wc, u), u);
          if (fromRes) return fromRes;
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
        }
        const buf = await fetchViaWebContents(wc, u, { timeoutMs: 8000, signal });
        const fromPage = playlistFromBuffer(buf, u);
        if (fromPage) return fromPage;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
  }
  const via = await requestViaSession(url, h, { maxBytes: 2_000_000, timeoutMs: 15000, signal });
  if (via && looksLikePlaylist(via.body)) return via;
  const node = await requestNode(url, h, { maxBytes: 2_000_000, timeoutMs: 15000, signal });
  if (node && looksLikePlaylist(node.body)) return node;
  const body = (via && via.body) || (node && node.body) || '';
  const status = (via && via.status) || (node && node.status) || 0;
  if (looksLikeHtml(body)) throw notPlaylistError('html', status);
  if (looksLikeJson(body)) throw notPlaylistError('json', status);
  throw notPlaylistError('other', status);
}

async function loadMediaPlaylist(url, headers, signal = null, playerWebContentsId = null) {
  let text = '';
  let base = url;
  const exact = cachedPlaylist(playerWebContentsId, url);
  if (exact) {
    text = exact.text;
    base = exact.base;
  } else {
    const master = await fetchPlaylist(url, headers, signal, playerWebContentsId);
    text = master.body;
    base = master.url || url;
  }
  if (isMasterPlaylist(text) || (/#EXT-X-STREAM-INF/i.test(text) && !isMediaPlaylist(text))) {
    const variant = bestVariantUri(text, base);
    if (!variant) throw new Error('Master playlist has no variants');
    const vCached = cachedPlaylist(playerWebContentsId, variant);
    if (vCached && isMediaPlaylist(vCached.text)) {
      text = vCached.text;
      base = vCached.base;
    } else {
      try {
        const v = await fetchPlaylist(variant, headers, signal, playerWebContentsId);
        if (looksLikePlaylist(v.body) && isMediaPlaylist(v.body)) {
          text = v.body;
          base = v.url || variant;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        const fallback = bestCachedPlaylist(playerWebContentsId);
        if (fallback && isMediaPlaylist(fallback.text)) {
          text = fallback.text;
          base = fallback.base;
        } else {
          throw new Error('Could not load the highest-quality media playlist from the master');
        }
      }
    }
  }
  if (isMasterPlaylist(text) || !isMediaPlaylist(text)) {
    const fallback = bestCachedPlaylist(playerWebContentsId);
    if (fallback && isMediaPlaylist(fallback.text)) {
      text = fallback.text;
      base = fallback.base;
    }
  }
  if (isMasterPlaylist(text) || !isMediaPlaylist(text)) {
    throw new Error('Player did not yield a media playlist');
  }
  return { text: rewritePlaylistUris(text, base), base };
}

async function materializePlaylist(url, headers, destPath, signal = null) {
  const { text } = await loadMediaPlaylist(url, headers, signal);
  fs.writeFileSync(destPath, text, 'utf8');
  return destPath;
}

function isPng(buf) {
  return (
    buf &&
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

function isFmp4At(buf, i) {
  if (!buf || i + 8 > buf.length) return false;
  const typ = buf.toString('ascii', i + 4, i + 8);
  return typ === 'ftyp' || typ === 'moof' || typ === 'mdat' || typ === 'moov' || typ === 'sidx';
}

function isMediaAt(buf, i) {
  return (buf && buf[i] === 0x47) || isFmp4At(buf, i);
}

// Chromium's CDP returns binary as a JS string. Decoding that as UTF-8 inserts
// U+FFFD and ffmpeg then dies with "Invalid data found when processing input".
function bufferFromCdpString(data, base64Encoded) {
  const raw = data || '';
  if (!raw) return Buffer.alloc(0);
  if (base64Encoded) return Buffer.from(raw, 'base64');
  if (raw.indexOf('\uFFFD') !== -1) return Buffer.alloc(0);
  return Buffer.from(raw, 'latin1');
}

// Vidfast/peakstorm (and similar) prepend a 1x1 PNG so ffmpeg's HLS demuxer
// probes "png" and dies with "Invalid data found when processing input".
// The real media is MPEG-TS (0x47) or fMP4 after the PNG chunks.
function stripPngWrapper(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  if (!isPng(buf)) return buf;
  let i = 8;
  while (i + 12 <= buf.length) {
    if (isMediaAt(buf, i)) break;
    const len = buf.readUInt32BE(i);
    if (len > 10 * 1024 * 1024) break;
    const type = buf.toString('ascii', i + 4, i + 8);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  while (i < buf.length && !isMediaAt(buf, i)) i += 1;
  return i > 0 && i < buf.length ? buf.subarray(i) : buf;
}

function isTokenCdn(url, embedUrl) {
  return /peakstorm\.|vidfast\.|megacloud\.|rabbitstream\.|vidcloud/i.test(
    `${url || ''} ${embedUrl || ''}`
  );
}

// Vidfast/peakstorm playlists resolve, but Node/net.request cannot pull the
// parts (partitioned cookies). The live player can. One-shot `/s/` tokens die
// if anything besides playback fetches them. `/vd/` and `/r2/` are VOD: the
// player page/worker can fetch remaining segments without burning a token.
function isPlayerBoundCdn(url, embedUrl) {
  const s = `${url || ''} ${embedUrl || ''}`;
  if (CDN_PATH_RE.test(s)) return true;
  return /peakstorm\.|vidfast\.|ashencloud\.|ashenlion\.|orbitnorth\.|hiddenmesa\.|solidbear\.|primecomet\.|calmcanvas\.|nobleember\.|plainorbit\.|nobletrail\.|rapidtree\.|metaldisk\.|thunderpencil\.|pearlmaple\.|novaoak\./i.test(
    s
  );
}

// `/s/` tokens are spent by the first non-playback request. They are not always
// hex: `/r6/s/ma9yIsUHLd1o…` is base64url, and treating those as VOD made the
// main process refetch a spent token and get 400 on every segment.
function isOneShotHls(url) {
  const s = String(url || '');
  if (/\/vd\/|\/r2\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return /peakstorm|vidfast/i.test(u.hostname) && /\/s\/[A-Za-z0-9_-]{6,}/.test(u.pathname);
  } catch (e) {
    return /peakstorm\.top\/(?:[a-z0-9]+\/)?s\//i.test(s);
  }
}

function isVodHls(text, url) {
  if (isOneShotHls(url)) return false;
  const t = String(text || '');
  const u = String(url || '');
  if (/\/vd\/|\/r2\//i.test(u)) return true;
  if (/#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(t)) return true;
  if (/#EXT-X-ENDLIST/i.test(t) && /#EXT-X-ALLOW-CACHE:\s*YES/i.test(t)) return true;
  return false;
}

function looksLikeSegment(buf) {
  if (!buf || buf.length < 200) return false;
  if (utf8ReplacementCount(buf, 4096) >= 3) return false;
  if (isPng(buf)) return true;
  if (buf[0] === 0x47) return true;
  if (isFmp4At(buf, 0)) return true;
  return false;
}

function utf8ReplacementCount(buf, limit) {
  let n = 0;
  const end = Math.min(buf.length - 2, limit || buf.length);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) n += 1;
  }
  return n;
}

function cdpSegmentCount(wc) {
  try {
    if (!wc || !wc._cdpParts) return 0;
    let n = 0;
    for (const buf of wc._cdpParts.values()) {
      if (looksLikeSegment(buf)) n += 1;
    }
    return n;
  } catch (e) {
    return 0;
  }
}

async function readPageResource(wc, url) {
  if (!wc || wc.isDestroyed() || !url) return null;
  try {
    await installPlayerCdpTap(wc);
    const dbg = wc.debugger;
    if (!dbg.isAttached()) return null;
    if (!wc._cdpFrameId) {
      const { frameTree } = await dbg.sendCommand('Page.getResourceTree');
      wc._cdpFrameId = frameTree && frameTree.frame && frameTree.frame.id;
    }
    if (!wc._cdpFrameId) return null;
    const { content, base64Encoded } = await dbg.sendCommand('Page.getResourceContent', {
      frameId: wc._cdpFrameId,
      url
    });
    const buf = bufferFromCdpString(content, base64Encoded);
    return buf.length ? buf : null;
  } catch (e) {
    return null;
  }
}

async function streamIsDownloadable(det, { signal, onLog } = {}) {
  if (!det || !det.url) return false;
  if (!isPlayerBoundCdn(det.url, det.embedUrl)) return true;
  const wc = liveWebContents(det.playerWebContentsId);
  if (!wc) {
    if (onLog) onLog('Token CDN has no live player page; segments cannot be downloaded.');
    return false;
  }
  const hasParts = async () => {
    if (cdpSegmentCount(wc) > 0) return true;
    try {
      const n = await wc.executeJavaScript(
        '(Object.keys(window.__wvdParts || {}).length) + ((window.__wvdMse || []).length)',
        true
      );
      return Number(n) > 0;
    } catch (e) {
      return false;
    }
  };
  try {
    await playPlayerVideo(wc, null);
  } catch (e) {
    // ignore
  }
  const hasPlayable = async () => {
    if (await hasParts()) return true;
    const cached = cachedPlaylist(det.playerWebContentsId, det.url);
    if (cached && /#EXTINF:/i.test(cached.text)) return true;
    try {
      const ready = await wc.executeJavaScript(
        `Math.max(0, ...Array.from(document.querySelectorAll('video')).map((v) => v.readyState || 0))`,
        true
      );
      return Number(ready) >= 2;
    } catch (e) {
      return false;
    }
  };
  if (await hasPlayable()) return true;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return false;
    await new Promise((r) => setTimeout(r, 400));
    if (!wc || wc.isDestroyed()) break;
    try {
      await playPlayerVideo(wc, null);
    } catch (e) {
      // ignore
    }
    if (await hasPlayable()) return true;
  }
  // Playlist + live player is enough: the downloader captures MSE/CDP bytes
  // while this window stays open. Bailing here skipped every Vidfast source
  // on Linux before any segment arrived.
  if (onLog) onLog('Token CDN playlist found; keeping the live player to capture segments during download.');
  return true;
}

function netHeaderPairs(headers) {
  const skip = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
  const out = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (!v || skip.has(String(k).toLowerCase())) continue;
    out.push([k, String(v)]);
  }
  return out;
}

function isRetryableNetErr(err) {
  if (!err || err.name === 'AbortError') return false;
  const st = err.status;
  if (st === 429 || (st >= 500 && st < 600)) return true;
  if (st && st >= 400 && st < 500) return false;
  const msg = String(err.message || err);
  return /ERR_FAILED|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_ABORTED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    msg
  );
}

function withLock(holder, key, fn) {
  const prev = holder[key] || Promise.resolve();
  const run = prev.then(fn, fn);
  holder[key] = run.catch(() => {});
  return run;
}

async function ensureDebugger(wc) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) {
    try {
      await dbg.attach('1.3');
    } catch (e) {
      if (!/already attached/i.test(String((e && e.message) || e))) throw e;
    }
  }
  if (!wc._cdpNetOn) {
    await dbg.sendCommand('Network.enable', {
      maxResourceBufferSize: 64 * 1024 * 1024,
      maxTotalBufferSize: 512 * 1024 * 1024
    });
    await dbg.sendCommand('Page.enable');
    wc._cdpNetOn = true;
  }
  return dbg;
}

function walkCdpFrames(node, out = []) {
  if (node && node.frame) out.push(node.frame);
  for (const child of (node && node.childFrames) || []) walkCdpFrames(child, out);
  return out;
}

async function readCdpStream(dbg, handle) {
  const chunks = [];
  for (;;) {
    const part = await dbg.sendCommand('IO.read', { handle, size: 256 * 1024 });
    const data = part.data || '';
    if (data) chunks.push(bufferFromCdpString(data, part.base64Encoded));
    if (part.eof) break;
  }
  try {
    await dbg.sendCommand('IO.close', { handle });
  } catch (e) {
    // ignore
  }
  return Buffer.concat(chunks);
}

// Load a URL as the player frame. This sends partitioned cookies and is not a
// CORS fetch, which is what the CDN requires for PNG-wrapped HLS parts.
async function fetchViaCdp(wc, url, { timeoutMs = 60000, signal } = {}) {
  if (!wc || wc.isDestroyed()) throw new Error('player window is gone');
  return withLock(wc, '_cdpLock', async () => {
    if (signal && signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const dbg = await ensureDebugger(wc);
    const { frameTree } = await dbg.sendCommand('Page.getFrameTree');
    const frames = walkCdpFrames(frameTree);
    if (!frames.length) throw new Error('no player frames');
    let last;
    const timeout = Math.max(8000, timeoutMs || 60000);
    for (const frame of frames) {
      try {
        const work = (async () => {
          const { resource } = await dbg.sendCommand('Network.loadNetworkResource', {
            frameId: frame.id,
            url,
            options: { disableCache: true, includeCredentials: true }
          });
          const code = resource && resource.httpStatusCode;
          if (!resource || resource.success === false) {
            const err = new Error(`HTTP ${code || resource.netError || 0}`);
            err.status = code;
            throw err;
          }
          if (resource.stream) return readCdpStream(dbg, resource.stream);
          throw new Error('empty CDP body');
        })();
        const buf = await Promise.race([
          work,
          new Promise((_, reject) => setTimeout(() => reject(new Error('CDP fetch timed out')), timeout))
        ]);
        if (buf && buf.length) return buf;
      } catch (e) {
        last = e;
        if (e && e.name === 'AbortError') throw e;
      }
    }
    throw last || new Error('CDP fetch failed');
  });
}

function liveWebContents(id) {
  if (id == null) return null;
  try {
    const { webContents } = require('electron');
    const wc = webContents.fromId(Number(id));
    if (wc && !wc.isDestroyed()) return wc;
  } catch (e) {
    // ignore
  }
  return null;
}

function siblingWebContents(wc) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (!c || c.isDestroyed() || seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  };
  add(wc);
  try {
    const win = wc.getOwnerBrowserWindow && wc.getOwnerBrowserWindow();
    if (!win || win.isDestroyed()) return out;
    const { webContents } = require('electron');
    for (const other of webContents.getAllWebContents()) {
      try {
        if (other.getOwnerBrowserWindow && other.getOwnerBrowserWindow() === win) add(other);
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }
  return out;
}

function collectFrames(wc) {
  const out = [];
  const seen = new Set();
  const add = (frame) => {
    if (!frame || seen.has(frame)) return;
    seen.add(frame);
    out.push(frame);
  };
  const walk = (frame) => {
    add(frame);
    try {
      for (const child of frame.frames || []) walk(child);
    } catch (e) {
      // ignore
    }
  };
  for (const contents of siblingWebContents(wc)) {
    try {
      add(contents.mainFrame);
      const sub = contents.mainFrame && contents.mainFrame.framesInSubtree;
      if (sub && sub.length) for (const f of sub) add(f);
    } catch (e) {
      // ignore
    }
    try {
      walk(contents.mainFrame);
    } catch (e) {
      // ignore
    }
  }
  return out.length ? out : [wc];
}

function frameUrl(frame) {
  try {
    return frame.url || '';
  } catch (e) {
    return '';
  }
}

function fetchScript(url, timeoutMs, cacheMode) {
  const cache = cacheMode || 'reload';
  return `(async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ${Math.max(4000, timeoutMs - 1000)});
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        credentials: 'include',
        cache: ${JSON.stringify(cache)},
        signal: ac.signal
      });
      const status = res.status || 0;
      if (status >= 400) return { ok: false, status };
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      const step = 0x4000;
      for (let i = 0; i < bytes.length; i += step) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return { ok: true, status, b64: btoa(bin) };
    } catch (e) {
      return { ok: false, status: 0, error: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  })()`;
}

async function runFetchScript(target, url, opts = {}) {
  if (!target || (typeof target.isDestroyed === 'function' && target.isDestroyed())) {
    const err = new Error('player window is gone');
    err.status = 0;
    throw err;
  }
  const timeoutMs = opts.timeoutMs || 60000;
  const signal = opts.signal;
  const timeout = Math.max(4000, timeoutMs);
  let timer;
  let onAbort = null;
  const hard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('player fetch timed out')), timeout);
    if (signal) {
      onAbort = () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    const result = await Promise.race([
      target.executeJavaScript(fetchScript(url, timeout, opts.cacheMode), true),
      hard
    ]);
    if (!result || !result.ok) {
      const err = new Error((result && result.error) || `HTTP ${(result && result.status) || 0}`);
      err.status = result && result.status;
      throw err;
    }
    const buf = Buffer.from(result.b64 || '', 'base64');
    if (!buf.length) throw new Error('empty body');
    return buf;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch (e) {
        // ignore
      }
    }
  }
}

// Token CDNs (vidfast/peakstorm) bind segment access to the live player page:
// partitioned cookies, CORS, and a short-lived edge token. net.request from the
// main process still 502s even with the sniffed Referer. Fetch from the player
// document so origin + cookies match playback.
async function fetchViaWebContents(wc, url, opts = {}) {
  let last;
  const frames = collectFrames(wc);
  const preferred = [];
  const other = [];
  for (const frame of frames) {
    if (
      /vidfast|peakstorm|soap2day|sflix|ashencloud|ashenlion|orbitnorth|primecomet|calmcanvas|nobleember/i.test(
        frameUrl(frame)
      )
    ) {
      preferred.push(frame);
    }
    else other.push(frame);
  }
  const order = preferred.length ? preferred : other;
  for (const frame of order) {
    try {
      const buf = await runFetchScript(frame, url, opts);
      if (buf && buf.length) return buf;
    } catch (e) {
      last = e;
      if (e && e.name === 'AbortError') throw e;
    }
  }
  const hosts = frames.map((f) => frameUrl(f).slice(0, 80)).filter(Boolean);
  const err = last || new Error('player fetch failed');
  err.message = `${err.message} [frames=${hosts.join(' || ') || 'none'}]`;
  throw err;
}

async function fetchViaWorker(wc, url, opts = {}) {
  if (!wc || wc.isDestroyed() || !wc.debugger) {
    const err = new Error('player window is gone');
    err.status = 0;
    throw err;
  }
  const sessions = (wc._cdpWorkerSessions || []).slice();
  if (!sessions.length) {
    const err = new Error('no player worker session');
    err.status = 0;
    throw err;
  }
  const timeout = Math.max(4000, opts.timeoutMs || 10000);
  const expr = `(() => {
    const url = ${JSON.stringify(url)};
    return fetch(url, { credentials: 'include', cache: ${JSON.stringify(opts.cacheMode || 'default')}, mode: 'cors' }).then((res) => {
      if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status };
      return res.arrayBuffer().then((buf) => {
        const u8 = new Uint8Array(buf);
        let bin = '';
        const step = 0x8000;
        for (let i = 0; i < u8.length; i += step) {
          bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
        }
        return { ok: true, status: res.status, b64: btoa(bin) };
      });
    }).catch((e) => ({ ok: false, status: 0, error: String(e && e.message || e) }));
  })()`;
  let last;
  for (const sid of sessions) {
    try {
      const raw = await cdpSendTimed(
        wc.debugger,
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        sid,
        timeout
      );
      const value = raw && raw.result && raw.result.value;
      if (raw && raw.exceptionDetails) {
        last = new Error((raw.exceptionDetails.text || 'worker evaluate failed').slice(0, 160));
        continue;
      }
      if (!value || !value.ok) {
        const err = new Error((value && value.error) || `HTTP ${(value && value.status) || 0}`);
        err.status = value && value.status;
        last = err;
        continue;
      }
      const buf = Buffer.from(value.b64 || '', 'base64');
      if (!buf.length) {
        last = new Error('empty worker body');
        continue;
      }
      return buf;
    } catch (e) {
      last = e;
      if (e && e.name === 'AbortError') throw e;
    }
  }
  throw last || new Error('worker fetch failed');
}

// session.fetch is Chromium's Fetch API: it enforces CORS and silently drops
// Referer/Origin/User-Agent. Token CDNs (vidfast/peakstorm) then fail every
// segment with net::ERR_FAILED even though the same URL plays in the player.
// electron.net.request uses the session's cookies but is not a web fetch, so
// those headers actually go out.
function fetchBufferViaNet(url, headers, { timeoutMs = 60000, signal, session: sesOpt } = {}) {
  return new Promise((resolve, reject) => {
    let net;
    let ses;
    try {
      const electron = require('electron');
      const config = require('./config');
      net = electron.net;
      ses = sesOpt || electron.session.fromPartition(config.sessionPartition);
      if (!net || typeof net.request !== 'function') {
        return reject(new Error('no net.request'));
      }
    } catch (e) {
      return reject(e);
    }

    let req;
    let done = false;
    const chunks = [];
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      try {
        if (req) req.abort();
      } catch (e) {
        // ignore
      }
      const err = new Error('Aborted');
      err.name = 'AbortError';
      finish(() => reject(err));
    };
    const hard = setTimeout(() => {
      try {
        if (req) req.abort();
      } catch (e) {
        // ignore
      }
      finish(() => reject(new Error('CDN connection timed out')));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      req = net.request({
        method: 'GET',
        url,
        session: ses,
        useSessionCookies: true,
        redirect: 'follow'
      });
    } catch (e) {
      return finish(() => reject(e));
    }

    for (const [k, v] of netHeaderPairs(headers)) {
      try {
        req.setHeader(k, v);
      } catch (e) {
        // ignore illegal header names
      }
    }

    req.on('response', (res) => {
      const code = res.statusCode || 0;
      if (code >= 400) {
        res.resume();
        const err = new Error(`HTTP ${code}`);
        err.status = code;
        return finish(() => reject(err));
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
      res.on('error', (e) => finish(() => reject(e)));
    });
    req.on('error', (e) => finish(() => reject(e)));
    req.end();
  });
}

async function disablePlayerFetchTap(wc) {
  if (!wc || wc.isDestroyed()) return;
  wc._cdpSkipFetch = true;
  wc._cdpFetchOn = false;
  if (!wc.debugger) return;
  try {
    if (wc.debugger.isAttached()) await wc.debugger.sendCommand('Fetch.disable');
  } catch (e) {
    // ignore
  }
  for (const sid of wc._cdpWorkerSessions || []) {
    try {
      await cdpSend(wc.debugger, 'Fetch.disable', {}, sid);
    } catch (e) {
      // ignore
    }
  }
}

function playerSessionHeaders(wc, headers) {
  const h = { ...(headers || {}) };
  try {
    const u = wc && typeof wc.getURL === 'function' ? wc.getURL() : '';
    if (u && /^https?:/i.test(u)) {
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'referer')) h.Referer = u;
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'origin')) {
        h.Origin = new URL(u).origin;
      }
    }
  } catch (e) {
    // ignore
  }
  return h;
}

const sessionDownloadState = new WeakMap();
let vodPullSeq = 0;

function sessionDownloads(ses) {
  let st = sessionDownloadState.get(ses);
  if (st) return st;
  st = { pending: new Map() };
  sessionDownloadState.set(ses, st);
  ses.on('will-download', (_event, item) => {
    const chain = [];
    try {
      if (typeof item.getURLChain === 'function') chain.push(...(item.getURLChain() || []));
    } catch (e) {
      // ignore
    }
    try {
      chain.push(item.getURL());
    } catch (e) {
      // ignore
    }
    let rec = null;
    let key = null;
    for (const u of chain) {
      if (st.pending.has(u)) {
        rec = st.pending.get(u);
        key = u;
        break;
      }
    }
    if (!rec) {
      try {
        const p = new URL(item.getURL()).pathname;
        for (const [u, r] of st.pending) {
          try {
            if (new URL(u).pathname === p) {
              rec = r;
              key = u;
              break;
            }
          } catch (e2) {
            // ignore
          }
        }
      } catch (e) {
        // ignore
      }
    }
    if (!rec && st.pending.size === 1) {
      key = st.pending.keys().next().value;
      rec = st.pending.get(key);
    }
    if (!rec) return;
    try {
      item.setSavePath(rec.dest);
    } catch (e) {
      rec.fail(e);
      return;
    }
    item.on('done', (_e, state) => {
      st.pending.delete(key);
      if (state === 'completed') rec.ok();
      else rec.fail(new Error('download ' + state));
    });
  });
  return st;
}

function downloadViaWebContents(wc, url, dest, { timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!wc || wc.isDestroyed() || typeof wc.downloadURL !== 'function') {
      return reject(new Error('no downloadURL'));
    }
    const ses = wc.session;
    if (!ses) return reject(new Error('no session'));
    const st = sessionDownloads(ses);
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      if (signal) signal.removeEventListener('abort', onAbort);
      st.pending.delete(url);
      fn();
    };
    const rec = {
      dest,
      ok: () => finish(() => resolve(dest)),
      fail: (e) => finish(() => reject(e))
    };
    st.pending.set(url, rec);
    const onAbort = () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      rec.fail(err);
    };
    const hard = setTimeout(() => rec.fail(new Error('download timed out')), timeoutMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      wc.downloadURL(url);
    } catch (e) {
      rec.fail(e);
    }
  });
}

function vodPullStartExpr(url, id, credentials) {
  return `(async () => {
    try {
      self.__wvdPull = self.__wvdPull || {};
      const res = await fetch(${JSON.stringify(url)}, {
        credentials: ${JSON.stringify(credentials || 'omit')},
        mode: 'cors',
        cache: 'default'
      });
      if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status };
      const buf = new Uint8Array(await res.arrayBuffer());
      self.__wvdPull[${JSON.stringify(id)}] = buf;
      return { ok: true, status: res.status, n: buf.length };
    } catch (e) {
      return { ok: false, status: 0, error: String((e && e.message) || e) };
    }
  })()`;
}

function vodPullSliceExpr(id, off, step) {
  return `(function() {
    const buf = (self.__wvdPull || {})[${JSON.stringify(id)}];
    if (!buf) return { ok: false, error: 'missing' };
    const n = Math.min(${step}, buf.length - ${off});
    if (n <= 0) return { ok: true, b64: '', n: 0 };
    const slice = buf.subarray(${off}, ${off} + n);
    let bin = '';
    const s = 0x4000;
    for (let i = 0; i < slice.length; i += s) {
      bin += String.fromCharCode.apply(null, slice.subarray(i, i + s));
    }
    return { ok: true, b64: btoa(bin), n: n };
  })()`;
}

function vodPullClearExpr(id) {
  return `(function() { if (self.__wvdPull) delete self.__wvdPull[${JSON.stringify(id)}]; return true; })()`;
}

async function evalReturn(run, expr, timeoutMs, awaitPromise) {
  const raw = await run(expr, timeoutMs, awaitPromise);
  if (raw && raw.result && Object.prototype.hasOwnProperty.call(raw.result, 'value')) {
    return raw.result.value;
  }
  return raw;
}

async function fetchChunkedViaEvaluate(run, url, { timeoutMs = 90000 } = {}) {
  const id = 'p' + ++vodPullSeq;
  const start = await evalReturn(run, vodPullStartExpr(url, id, 'omit'), Math.max(20000, timeoutMs), true);
  if (!start || !start.ok) {
    const again = await evalReturn(run, vodPullStartExpr(url, id, 'same-origin'), Math.max(20000, timeoutMs), true);
    if (!again || !again.ok) {
      const err = new Error((start && start.error) || (again && again.error) || `HTTP ${(start && start.status) || 0}`);
      err.status = (again && again.status) || (start && start.status);
      throw err;
    }
    return fetchChunkedSlices(run, id, again.n);
  }
  return fetchChunkedSlices(run, id, start.n);
}

async function fetchChunkedSlices(run, id, size) {
  const chunks = [];
  const step = 256 * 1024;
  let off = 0;
  try {
    while (off < size) {
      const part = await evalReturn(run, vodPullSliceExpr(id, off, step), 8000, false);
      if (!part || !part.ok) throw new Error((part && part.error) || 'chunk missing');
      if (part.n) chunks.push(Buffer.from(part.b64 || '', 'base64'));
      off += part.n || 0;
      if (!part.n) break;
    }
  } finally {
    try {
      await evalReturn(run, vodPullClearExpr(id), 2000, false);
    } catch (e) {
      // ignore
    }
  }
  return Buffer.concat(chunks);
}

function workerEvaluate(wc, sid) {
  return async (expr, timeoutMs, awaitPromise) => {
    const raw = await cdpSendTimed(
      wc.debugger,
      'Runtime.evaluate',
      { expression: expr, awaitPromise: !!awaitPromise, returnByValue: true },
      sid,
      timeoutMs
    );
    if (raw && raw.exceptionDetails) {
      throw new Error((raw.exceptionDetails.text || 'worker evaluate failed').slice(0, 160));
    }
    return raw;
  };
}

function pageEvaluate(wc) {
  return async (expr, timeoutMs, awaitPromise) => {
    const result = await Promise.race([
      wc.executeJavaScript(expr, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('page fetch timed out')), timeoutMs))
    ]);
    return { result: { value: result } };
  };
}

async function fetchVodPartViaPlayer(wc, url, { timeoutMs = 90000 } = {}) {
  let last;
  const sessions = (wc._cdpWorkerSessions || []).slice();
  if (wc.debugger && wc.debugger.isAttached()) {
    for (const sid of sessions) {
      try {
        const buf = await fetchChunkedViaEvaluate(workerEvaluate(wc, sid), url, { timeoutMs });
        if (buf && buf.length) return buf;
      } catch (e) {
        last = e;
        if (e && e.name === 'AbortError') throw e;
      }
    }
  }
  try {
    const buf = await fetchChunkedViaEvaluate(pageEvaluate(wc), url, { timeoutMs });
    if (buf && buf.length) return buf;
  } catch (e) {
    last = e;
    if (e && e.name === 'AbortError') throw e;
  }
  throw last || new Error('player chunked fetch failed');
}

function saveVodJobBuf(dir, job, buf0) {
  let buf = buf0;
  if (!buf || !buf.length) return false;
  if (job.strip) {
    const head = buf.toString('utf8', 0, 256);
    if (looksLikeHtml(head) || looksLikeJson(head)) return false;
    buf = stripPngWrapper(buf);
  }
  if (!buf || buf.length < 200) return false;
  if (!looksLikeSegment(buf) && buf.length < 24 * 1024) return false;
  fs.writeFileSync(path.join(dir, job.name), buf);
  return true;
}

async function kickWorkerFetches(wc, urls, opts = {}) {
  const list = (urls || []).filter(Boolean).slice(0, 8);
  if (!list.length || !wc || wc.isDestroyed()) return 0;
  const timeout = Math.max(8000, opts.timeoutMs || 30000);
  const expr = `(() => {
    const urls = ${JSON.stringify(list)};
    return Promise.all(urls.map((url) =>
      fetch(url, { credentials: 'omit', cache: 'default', mode: 'cors' })
        .then((res) => ({ ok: res.ok, status: res.status }))
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
    ));
  })()`;
  const sessions = (wc._cdpWorkerSessions || []).slice();
  if (sessions.length && wc.debugger && wc.debugger.isAttached()) {
    try {
      await cdpSendTimed(
        wc.debugger,
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        sessions[0],
        timeout
      );
      return list.length;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
  }
  try {
    await Promise.race([
      wc.executeJavaScript(expr, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('kick timeout')), timeout))
    ]);
    return list.length;
  } catch (e) {
    return 0;
  }
}

function matchJobUrl(jobs, url) {
  if (!url) return null;
  for (const job of jobs) {
    if (job.abs === url) return job;
  }
  try {
    const p = new URL(url).pathname;
    for (const job of jobs) {
      try {
        if (new URL(job.abs).pathname === p) return job;
      } catch (e) {
        // ignore
      }
    }
    const base = p.split('/').filter(Boolean).pop();
    if (base) {
      for (const job of jobs) {
        try {
          if (new URL(job.abs).pathname.split('/').filter(Boolean).pop() === base) return job;
        } catch (e) {
          // ignore
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function drainCdpPartsToDir(wc, jobs, dir) {
  const parts = wc && wc._cdpParts;
  if (!parts || !parts.size) return 0;
  let n = 0;
  for (const [url, buf0] of [...parts]) {
    const job = matchJobUrl(jobs, url);
    if (!job) continue;
    if (jobFileOk(dir, job)) {
      parts.delete(url);
      continue;
    }
    let buf = Buffer.isBuffer(buf0) ? buf0 : Buffer.from(buf0 || []);
    if (job.strip) buf = stripPngWrapper(buf);
    if (!buf || buf.length < 200) continue;
    fs.writeFileSync(path.join(dir, job.name), buf);
    parts.delete(url);
    n += 1;
  }
  return n;
}

async function pullRemainingViaPlayer(wc, remaining, jobs, dir, { signal, onProgress, onLog, headers } = {}) {
  await disablePlayerFetchTap(wc);
  const h = playerSessionHeaders(wc, headers);
  const ses = wc && wc.session;
  const report = () => {
    const have = jobs.filter((job) => jobFileOk(dir, job)).length;
    if (onProgress) {
      onProgress({ received: have, total: jobs.length, percent: Math.min(0.99, have / jobs.length) });
    }
    return have;
  };
  let how = '';
  let lastErr;
  let lastLog = 0;
  let netWorks = null;
  let netProbeFails = 0;
  let skipDownload = false;
  let downloadFails = 0;
  // A spent one-shot token answers 400 for every segment. Without this the pool
  // walked all 330 jobs, three transports each, and re-queued for 20 minutes.
  let deadStreak = 0;
  let spent = false;
  const throwIfAborted = () => {
    if (signal && signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
  };
  const noteFail = (e) => {
    lastErr = e;
    if (e && (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 410)) {
      deadStreak += 1;
      if (!how && deadStreak >= 6) spent = true;
    }
  };
  const fetchOne = async (job) => {
    throwIfAborted();
    if (spent) return false;
    if (jobFileOk(dir, job)) return true;
    if (netWorks !== false) {
      try {
        const buf = await fetchBufferViaNet(job.abs, h, {
          timeoutMs: netWorks ? 60000 : 20000,
          signal,
          session: ses
        });
        if (saveVodJobBuf(dir, job, buf)) {
          netWorks = true;
          deadStreak = 0;
          if (!how) how = 'net.request';
          return true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        noteFail(e);
        if (netWorks !== true) {
          netProbeFails += 1;
          if (netProbeFails >= 2) netWorks = false;
        }
      }
    }
    try {
      throwIfAborted();
      const buf = await fetchVodPartViaPlayer(wc, job.abs, { timeoutMs: 90000 });
      if (saveVodJobBuf(dir, job, buf)) {
        deadStreak = 0;
        if (!how) how = 'player fetch';
        return true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      noteFail(e);
    }
    if (!skipDownload && !spent) {
      try {
        throwIfAborted();
        const dest = path.join(dir, `${job.name}.part`);
        await downloadViaWebContents(wc, job.abs, dest, { timeoutMs: 45000, signal });
        let buf = fs.readFileSync(dest);
        try {
          fs.unlinkSync(dest);
        } catch (e2) {
          // ignore
        }
        if (saveVodJobBuf(dir, job, buf)) {
          deadStreak = 0;
          if (!how) how = 'downloadURL';
          return true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        noteFail(e);
        downloadFails += 1;
        if (downloadFails >= 2) skipDownload = true;
      }
    }
    return false;
  };

  const deadline = Date.now() + 8 * 60 * 1000;
  let round = 0;
  let before = report();
  while (Date.now() < deadline) {
    throwIfAborted();
    drainCdpPartsToDir(wc, jobs, dir);
    const left = jobs.filter((job) => !jobFileOk(dir, job));
    if (!left.length) break;
    round += 1;
    if (onLog && round === 1) {
      onLog('Pulling leftover VOD parts without copying multi-MB bodies through the debugger.');
    }
    await mapPool(left, 2, async (job) => {
      await fetchOne(job);
      const have = report();
      if (onLog && Date.now() - lastLog > 3000) {
        lastLog = Date.now();
        onLog(`Fetched ${have}/${jobs.length} HLS parts.`);
      }
    });
    drainCdpPartsToDir(wc, jobs, dir);
    const have = report();
    if (have >= jobs.length) break;
    if (spent) {
      if (onLog) onLog('CDN rejects every leftover segment (token already spent); giving up on this capture.');
      break;
    }
    // A round that gained nothing will not gain anything on the next pass
    // either; retrying only hammers the CDN and holds the player window open.
    if (have <= before) {
      if (onLog) {
        const hint = lastErr && lastErr.message ? ` (${String(lastErr.message).slice(0, 120)})` : '';
        onLog(`Direct fetch made no progress this pass${hint}; stopping.`);
      }
      break;
    }
    before = have;
    if (onLog) {
      const hint = lastErr && lastErr.message ? `; last error: ${String(lastErr.message).slice(0, 120)}` : '';
      onLog(`Direct fetch still missing ${jobs.length - have} part(s); retrying${hint}.`);
    }
    await new Promise((r) => setTimeout(r, 500 * Math.min(round, 6)));
  }
  if (onLog) {
    const left = jobs.filter((job) => !jobFileOk(dir, job)).length;
    if (how && !left) onLog(`Fetched remaining HLS parts via ${how}.`);
    if (left) {
      const hint = lastErr && lastErr.message ? ` (${String(lastErr.message).slice(0, 120)})` : '';
      onLog(`Direct fetch left ${left} part(s) missing${hint}.`);
    } else onLog(`Fetched all ${jobs.length} HLS parts.`);
  }
}

async function fetchBuffer(url, headers, opts = {}) {
  const wc = opts.webContents || liveWebContents(opts.playerWebContentsId);
  if (wc && opts.allowCdp) {
    try {
      const buf = await fetchViaCdp(wc, url, opts);
      if (buf && buf.length) return buf;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
  }
  if (wc && !opts.skipPageFetch) {
    try {
      const buf = await fetchViaWebContents(wc, url, opts);
      if (buf && buf.length) return buf;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
  }

  try {
    const buf = await fetchBufferViaNet(url, headers, {
      ...opts,
      session: opts.session || (wc && wc.session)
    });
    if (buf && buf.length) return buf;
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    // Fall through to session.fetch only when net.request is missing.
    if (!/no net\.request/i.test(String((e && e.message) || ''))) throw e;
  }

  const { session } = require('electron');
  const config = require('./config');
  const ses = session.fromPartition(config.sessionPartition);
  if (!ses || typeof ses.fetch !== 'function') throw new Error('no session fetch');

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  const hard = setTimeout(() => ac.abort(), opts.timeoutMs || 60000);
  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const safe = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (!/^(referer|origin|cookie|user-agent|host)$/i.test(k)) safe[k] = v;
    }
    const res = await ses.fetch(url, { headers: safe, signal: ac.signal });
    const code = res.status || 0;
    if (code >= 400) {
      const err = new Error(`HTTP ${code}`);
      err.status = code;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(hard);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function fetchBufferRetry(url, headers, opts = {}) {
  let last;
  for (let n = 0; n < 6; n++) {
    try {
      const buf = await fetchBuffer(url, headers, opts);
      if (buf && buf.length) return buf;
      throw new Error('empty body');
    } catch (e) {
      last = e;
      if (e && e.name === 'AbortError') throw e;
      if (!isRetryableNetErr(e) || n === 5) break;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, n)));
    }
  }
  const wrap = new Error(`${last && last.message ? last.message : last} (${url})`);
  wrap.status = last && last.status;
  wrap.cause = last;
  throw wrap;
}

async function mapPool(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

function ensureMseHookScript() {
  return `(function() {
    if (window.__wvdMseHooked) return 'ok';
    window.__wvdMseHooked = 'ok';
    window.__wvdMse = window.__wvdMse || [];
    try {
      const orig = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function(data) {
        try {
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : (data && data.buffer)
              ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0)
              : null;
          if (bytes && bytes.length && window.__wvdMse.length < 20000) {
            let bin = '';
            const step = 0x4000;
            for (let i = 0; i < bytes.length; i += step) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
            }
            window.__wvdMse.push(btoa(bin));
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    } catch (e) {}
    return 'ok';
  })()`;
}

function playerHookScript() {
  return `(function() {
    try {
      var bc = new BroadcastChannel('__wvdParts');
      bc.onmessage = function(ev) {
        var d = ev && ev.data;
        if (d && d.url && d.b64) {
          window.__wvdParts = window.__wvdParts || {};
          if (!window.__wvdParts[d.url]) window.__wvdParts[d.url] = d.b64;
        }
      };
    } catch (e) {}
    if (window.__wvdHooked) return window.__wvdHooked;
    window.__wvdHooked = 'ok';
    window.__wvdParts = window.__wvdParts || {};
    window.__wvdSeen = window.__wvdSeen || [];
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: function() { return false; } });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: function() { return 'visible'; } });
    } catch (e) {}
    const keep = (url, buf) => {
      if (url && window.__wvdSeen.length < 40) window.__wvdSeen.push(String(url).slice(0, 120));
      if (!url || !/${PAGE_CDN_RE}/i.test(String(url))) return;
      if (window.__wvdParts[url]) return;
      try {
        const bytes = buf instanceof Uint8Array
          ? buf
          : buf instanceof ArrayBuffer
            ? new Uint8Array(buf)
            : (buf && buf.buffer)
              ? new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || buf.length || 0)
              : null;
        if (!bytes || !bytes.length) return;
        let bin = '';
        const step = 0x4000;
        for (let i = 0; i < bytes.length; i += step) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        }
        window.__wvdParts[url] = btoa(bin);
      } catch (e) {}
    };
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url && window.__wvdSeen.length < 40) window.__wvdSeen.push('fetch:' + String(url).slice(0, 110));
      return origFetch(input, init).then((res) => {
        if (/${PAGE_CDN_RE}/i.test(url)) {
          res.clone().arrayBuffer().then((buf) => keep(url, buf)).catch(() => {});
        }
        return res;
      });
    };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__wvdUrl = url;
      if (url && window.__wvdSeen.length < 40) window.__wvdSeen.push('xhr:' + String(url).slice(0, 110));
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      const xhr = this;
      const finish = () => {
        if (xhr.readyState !== 4) return;
        if (window.__wvdSeen.length < 40) {
          window.__wvdSeen.push('xhr4:' + (xhr.status || 0) + ':' + String(xhr.__wvdUrl || '').slice(0, 90));
        }
        if (xhr.status < 200 || xhr.status >= 300) return;
        try {
          const r = xhr.response;
          if (r == null) return;
          if (typeof r === 'string') {
            const bytes = new Uint8Array(r.length);
            for (let i = 0; i < r.length; i++) bytes[i] = r.charCodeAt(i) & 0xff;
            keep(xhr.__wvdUrl, bytes.buffer);
            return;
          }
          if (r instanceof ArrayBuffer) {
            keep(xhr.__wvdUrl, r);
            return;
          }
          if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(r)) {
            keep(xhr.__wvdUrl, r.buffer);
            return;
          }
          if (typeof Blob !== 'undefined' && r instanceof Blob) {
            r.arrayBuffer().then((b) => keep(xhr.__wvdUrl, b)).catch(() => {});
          }
        } catch (e) {}
      };
      xhr.addEventListener('readystatechange', finish);
      xhr.addEventListener('load', finish);
      return origSend.apply(this, arguments);
    };
    return 'ok';
  })()`;
}

function isCdnMediaUrl(url) {
  const u = String(url || '');
  return CDN_HOST_RE.test(u) || CDN_PATH_RE.test(u) || /\.m3u8|\/hls\/|\.ts(\?|$)|mp2t|video\/mp4|\/_stream/i.test(u);
}

function shouldCopyFetchBody(url, len) {
  if (/\.m3u8(\?|$)/i.test(url || '')) return true;
  if (!isCdnMediaUrl(url)) return false;
  // Linux Electron 31 SIGSEGV'd / timed out on multi-MB Fetch.getResponseBody.
  // VOD /r2/ parts are 3–5 MB; copy those via net.request / chunked worker fetch.
  if (len > 0 && process.platform === 'linux' && len >= 2 * 1024 * 1024) return false;
  if (len > 0 && len >= CDP_BODY_MAX) return false;
  return true;
}

function maybeGunzip(buf) {
  if (!buf || buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  try {
    return zlib.gunzipSync(buf);
  } catch (e) {
    return buf;
  }
}

function cdpSend(dbg, method, params, sessionId) {
  if (sessionId) return dbg.sendCommand(method, params || {}, sessionId);
  return dbg.sendCommand(method, params || {});
}

function cdpSendTimed(dbg, method, params, sessionId, ms) {
  return Promise.race([
    cdpSend(dbg, method, params, sessionId),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cdp timeout')), ms))
  ]);
}

function cdpReqKey(sessionId, requestId) {
  return `${sessionId || ''}:${requestId}`;
}

function storeCdpPart(wc, url, buf0) {
  if (!wc || !url || !buf0 || !buf0.length) return;
  const buf = maybeGunzip(buf0);
  if (!wc._cdpParts) wc._cdpParts = new Map();
  if (!wc._cdpPlaylists) wc._cdpPlaylists = new Map();
  const asText = buf.toString('utf8');
  const playlistUrl = /\.m3u8(\?|$)|peakstorm\.top\/s\//i.test(url);
  if (playlistUrl || looksLikePlaylist(asText)) {
    wc._cdpPlaylists.set(url, asText);
    const head = asText.slice(0, 48).replace(/\s+/g, ' ');
    console.log(
      `[cdp] ${looksLikePlaylist(asText) ? 'playlist' : 'm3u8-body'} ${String(url).slice(0, 72)} (${buf.length}b) ${head}`
    );
    if (looksLikePlaylist(asText)) return;
  }
  if (looksLikeSegment(buf) || (isCdnMediaUrl(url) && buf.length >= 24 * 1024)) wc._cdpParts.set(url, buf);
}

async function attachTarget(dbg, wc, t) {
  if (!t || !t.targetId) return;
  const typ = String(t.type || '');
  if (!/worker|service/i.test(typ)) return;
  wc._cdpAttachedIds = wc._cdpAttachedIds || new Set();
  if (wc._cdpAttachedIds.has(t.targetId)) return;
  wc._cdpAttachedIds.add(t.targetId);
  try {
    const att = await dbg.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = att && att.sessionId;
    if (!sid) return;
    await enableCdpSession(dbg, sid, false, wc);
    rememberWorkerSession(wc, sid, t);
    console.log(`[cdp] attached-to ${t.type} sid=${String(sid).slice(0, 8)} ${String(t.url || '').slice(0, 60)}`);
  } catch (e) {
    wc._cdpAttachedIds.delete(t.targetId);
    console.log(`[cdp] attach fail ${t.type} ${e && e.message}`);
  }
}

async function scanWorkerTargets(dbg, wc) {
  try {
    const { targetInfos } = await dbg.sendCommand('Target.getTargets');
    if (!wc._cdpLoggedTargets) {
      wc._cdpLoggedTargets = true;
      console.log(
        `[cdp] targets ${(targetInfos || [])
          .map((t) => `${t.type}:${String(t.url || '').slice(0, 40)}`)
          .join(' | ')
          .slice(0, 400)}`
      );
    }
    for (const t of targetInfos || []) attachTarget(dbg, wc, t).catch(() => {});
  } catch (e) {
    if (!wc._cdpLoggedTargets) {
      wc._cdpLoggedTargets = true;
      console.log(`[cdp] getTargets ${e && e.message}`);
    }
  }
}

function rememberWorkerSession(wc, sessionId, targetInfo) {
  if (!wc || !sessionId) return;
  const t = String((targetInfo && targetInfo.type) || '');
  const u = String((targetInfo && targetInfo.url) || '');
  if (!/worker/i.test(t) && !/hls\.worker|transmuxer/i.test(u)) return;
  wc._cdpWorkerSessions = wc._cdpWorkerSessions || [];
  if (!wc._cdpWorkerSessions.includes(sessionId)) wc._cdpWorkerSessions.push(sessionId);
}

async function injectWorkerFetchHook(dbg, sessionId) {
  const expr = `(function() {
    if (self.__wvdHooked) return self.__wvdHooked;
    self.__wvdHooked = 'ok';
    self.__wvdParts = self.__wvdParts || {};
    var re = /${PAGE_CDN_RE}/i;
    function send(url, buf) {
      if (!url || !re.test(String(url))) return;
      if (self.__wvdParts[url]) return;
      try {
        var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        if (!bytes.length) return;
        var bin = '';
        var step = 0x4000;
        for (var i = 0; i < bytes.length; i += step) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        }
        var b64 = btoa(bin);
        self.__wvdParts[url] = b64;
        try { new BroadcastChannel('__wvdParts').postMessage({ url: String(url), b64: b64 }); } catch (e1) {}
      } catch (e) {}
    }
    function wrapFetch() {
      try {
        var origFetch = self.fetch;
        if (!origFetch || origFetch.__wvd) return;
        var wrapped = function(input, init) {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          return origFetch.call(self, input, init).then(function(res) {
            try { res.clone().arrayBuffer().then(function(buf) { send(url, buf); }).catch(function(){}); } catch (e) {}
            return res;
          });
        };
        wrapped.__wvd = true;
        self.fetch = wrapped;
      } catch (e) {}
    }
    wrapFetch();
    try { setInterval(wrapFetch, 750); } catch (e) {}
    try {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__wvdUrl = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        xhr.addEventListener('load', function() {
          if (xhr.status < 200 || xhr.status >= 300) return;
          try {
            var r = xhr.response;
            if (r instanceof ArrayBuffer) send(xhr.__wvdUrl, r);
            else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(r)) send(xhr.__wvdUrl, r.buffer);
          } catch (e) {}
        });
        return origSend.apply(this, arguments);
      };
    } catch (e) {}
    return 'hooked';
  })()`;
  const r = await cdpSend(dbg, 'Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  const val = r && r.result && r.result.value;
  console.log(`[cdp] worker fetch hook sid=${String(sessionId || '').slice(0, 8)} ${val || ''}`);
}

async function enableCdpSession(dbg, sessionId, waitingForDebugger, wc) {
  try {
    await cdpSend(dbg, 'Runtime.enable', {}, sessionId);
  } catch (e) {
    // ignore
  }
  try {
    await injectWorkerFetchHook(dbg, sessionId);
  } catch (e) {
    // ignore
  }
  try {
    await cdpSend(
      dbg,
      'Network.enable',
      {
        maxResourceBufferSize: 64 * 1024 * 1024,
        maxTotalBufferSize: 512 * 1024 * 1024
      },
      sessionId
    );
  } catch (e) {
    // ignore
  }
  try {
    if (!(wc && wc._cdpSkipFetch)) {
      await cdpSend(
        dbg,
        'Fetch.enable',
        {
          patterns: CDP_FETCH_PATTERNS
        },
        sessionId
      );
    }
  } catch (e) {
    // ignore
  }
  if (waitingForDebugger) {
    try {
      await cdpSend(dbg, 'Runtime.runIfWaitingForDebugger', {}, sessionId);
    } catch (e) {
      // ignore
    }
  }
}

// Intercept the player's own responses before navigation. Extra fetch/XHR
// from the page CORS-fails; copying bodies the player already received is
// the only way peakstorm segments leave Chromium.
async function installPlayerCdpTap(wc) {
  if (!wc || wc.isDestroyed() || wc._cdpTap) return !!wc._cdpTap;
  const dbg = wc.debugger;
  wc._cdpParts = wc._cdpParts || new Map();
  wc._cdpPending = wc._cdpPending || new Map();
  wc._cdpMsgs = 0;
  wc._cdpTap = true;
  dbg.on('message', (_event, method, params, msgSessionId) => {
    wc._cdpMsgs = (wc._cdpMsgs || 0) + 1;
    if (method === 'Target.targetCreated' && params && params.targetInfo) {
      const t = params.targetInfo;
      console.log(`[cdp] created ${t.type} ${String(t.url || t.title || '').slice(0, 80)}`);
      attachTarget(dbg, wc, t).catch(() => {});
      return;
    }
    if (method === 'Target.attachedToTarget' && params && params.sessionId) {
      const t = (params.targetInfo && params.targetInfo.type) || '';
      const u = (params.targetInfo && params.targetInfo.url) || '';
      console.log(`[cdp] attached ${t} ${String(u).slice(0, 80)} sid=${String(params.sessionId).slice(0, 8)}`);
      rememberWorkerSession(wc, params.sessionId, params.targetInfo);
      enableCdpSession(dbg, params.sessionId, true, wc).catch(() => {});
      return;
    }
    const sessionId = msgSessionId || '';
    if (method === 'Network.requestWillBeSent') {
      const url = params.request && params.request.url;
      if (url && params.requestId) {
        wc._cdpReqUrl = wc._cdpReqUrl || new Map();
        wc._cdpReqUrl.set(params.requestId, { url, sessionId });
        if (isCdnMediaUrl(url)) {
          wc._cdpPending.set(cdpReqKey(sessionId, params.requestId), {
            url,
            sessionId,
            requestId: params.requestId
          });
        }
      }
      return;
    }
    if (method === 'Network.responseReceived') {
      const url = (params.response && params.response.url) || '';
      if (url && params.requestId) {
        wc._cdpReqUrl = wc._cdpReqUrl || new Map();
        wc._cdpReqUrl.set(params.requestId, { url, sessionId });
        if (isCdnMediaUrl(url)) {
          wc._cdpPending.set(cdpReqKey(sessionId, params.requestId), {
            url,
            sessionId,
            requestId: params.requestId
          });
        }
      }
      return;
    }
    if (method === 'Fetch.requestPaused') {
      const requestId = params.requestId;
      const url = (params.request && params.request.url) || '';
      const sid = sessionId;
      const resume = () => {
        cdpSend(dbg, 'Fetch.continueRequest', { requestId }, sid).catch(() => {});
      };
      const code = params.responseStatusCode || 0;
      let len = 0;
      for (const h of params.responseHeaders || []) {
        if (h && /content-length/i.test(h.name)) len = Number(h.value) || 0;
      }
      if (code >= 200 && code < 400 && isCdnMediaUrl(url) && shouldCopyFetchBody(url, len)) {
        const bodyMs = len > 512 * 1024 ? 12000 : 3000;
        enqueueFetchBodyCopy(wc, async () => {
          let answered = false;
          try {
            const body = await cdpSendTimed(dbg, 'Fetch.getResponseBody', { requestId }, sid, bodyMs);
            const buf = bufferFromCdpString(body.body, body.base64Encoded);
            storeCdpPart(wc, url, buf);
            if (/\.m3u8(\?|$)/i.test(url) && buf.length) {
              const trimmed = trimMasterToBest(buf.toString('utf8'), url);
              if (trimmed) {
                await cdpSend(
                  dbg,
                  'Fetch.fulfillRequest',
                  {
                    requestId,
                    responseCode: 200,
                    responseHeaders: fulfillHeadersFrom(params.responseHeaders),
                    body: Buffer.from(trimmed, 'utf8').toString('base64')
                  },
                  sid
                );
                answered = true;
                if (!wc._cdpLockedQuality) {
                  wc._cdpLockedQuality = true;
                  console.log(`[cdp] locked player to best variant ${String(url).slice(0, 96)}`);
                }
              }
            }
          } catch (e) {
            // ignore
          }
          if (!answered) resume();
        });
      } else {
        resume();
      }
      return;
    }
    if (method === 'Network.loadingFailed') {
      const rec = (wc._cdpReqUrl && wc._cdpReqUrl.get(params.requestId)) || {};
      if (/m3u8|peakstorm/i.test(rec.url || '')) {
        console.log(`[cdp] load fail ${params.errorText || ''} ${String(rec.url).slice(0, 80)}`);
      }
      return;
    }
    if (method === 'Network.loadingFinished') {
      const rec =
        (wc._cdpPending.get(cdpReqKey(sessionId, params.requestId)) ||
          (wc._cdpReqUrl && wc._cdpReqUrl.get(params.requestId))) ||
        null;
      const url = rec && rec.url;
      const n = params.encodedDataLength || 0;
      const interesting = /m3u8|peakstorm|ashencloud|ashenlion|orbitnorth|hiddenmesa|solidbear|primecomet|plainorbit|\/r2\/|\/vd\/|\/s\//i.test(
        url || ''
      );
      if (!interesting) return;
      console.log(`[cdp] fin n=${n} id=${params.requestId} ${String(url || '(no url)').slice(0, 96)}`);
      // 3–5 MB VOD parts time out or SIGSEGV inside Network.getResponseBody on
      // Linux. Do not enqueue those copies; pullRemainingViaPlayer writes them.
      if (process.platform === 'linux' && n > 2 * 1024 * 1024) return;
      const sid = (rec && rec.sessionId) || sessionId;
      enqueueFetchBodyCopy(wc, async () => {
        try {
          const body = await cdpSendTimed(
            dbg,
            'Network.getResponseBody',
            { requestId: params.requestId },
            sid,
            n > 512 * 1024 ? 8000 : 2500
          );
          storeCdpPart(
            wc,
            url || `https://orphan.invalid/${params.requestId}`,
            bufferFromCdpString(body.body, body.base64Encoded)
          );
        } catch (e) {
          console.log(`[cdp] body fail n=${n} ${String(url || params.requestId).slice(0, 80)} ${e && e.message}`);
        }
      });
    }
  });
  try {
    const ready = (async () => {
      if (!dbg.isAttached()) await dbg.attach('1.3');
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Network.enable', {
        maxResourceBufferSize: 64 * 1024 * 1024,
        maxTotalBufferSize: 512 * 1024 * 1024
      });
      try {
        await dbg.sendCommand('Network.setBypassServiceWorker', { bypass: true });
      } catch (e) {
        // ignore
      }
      try {
        await dbg.sendCommand('Fetch.enable', {
          patterns: CDP_FETCH_PATTERNS
        });
        wc._cdpFetchOn = true;
      } catch (e) {
        // ignore
      }
      try {
        await dbg.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: 'worker' }, { type: 'shared_worker' }, { type: 'service_worker' }]
        });
      } catch (e) {
        try {
          await dbg.sendCommand('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true
          });
        } catch (e2) {
          // older Electron
        }
      }
      scanWorkerTargets(dbg, wc).catch(() => {});
      if (wc._cdpScan) clearInterval(wc._cdpScan);
      wc._cdpScan = setInterval(() => scanWorkerTargets(dbg, wc).catch(() => {}), 800);
      const stopScan = () => {
        if (wc._cdpScan) {
          clearInterval(wc._cdpScan);
          wc._cdpScan = null;
        }
      };
      wc.once('destroyed', stopScan);
    })();
    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cdp attach timeout')), 4000))
    ]);
    return true;
  } catch (e) {
    wc._cdpTap = false;
    return false;
  }
}

async function installPlayerFetchHook(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    await Promise.race([
      wc.session.clearStorageData({ storages: ['serviceworkers'] }),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
  } catch (e) {
    // ignore
  }
  try {
    await installPlayerCdpTap(wc);
  } catch (e) {
    // still inject the in-page hook
  }
  const source = playerHookScript();
  const mse = ensureMseHookScript();
  const injectOne = (contents) => {
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(source, true).catch(() => {});
    contents.executeJavaScript(mse, true).catch(() => {});
    try {
      const seen = new Set();
      const frames = [];
      const add = (frame) => {
        if (!frame || seen.has(frame)) return;
        seen.add(frame);
        frames.push(frame);
      };
      add(contents.mainFrame);
      const sub = contents.mainFrame && contents.mainFrame.framesInSubtree;
      if (sub && sub.length) for (const f of sub) add(f);
      for (const frame of frames) {
        frame.executeJavaScript(source, true).catch(() => {});
        frame.executeJavaScript(mse, true).catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  };
  const inject = () => {
    if (!wc || wc.isDestroyed()) return;
    for (const contents of siblingWebContents(wc)) injectOne(contents);
  };
  wc.on('dom-ready', inject);
  wc.on('did-finish-load', inject);
  wc.on('did-frame-finish-load', inject);
  try {
    const { app } = require('electron');
    const onCreated = (_e, contents) => {
      try {
        if (!contents || contents.isDestroyed() || wc.isDestroyed()) return;
        const win = wc.getOwnerBrowserWindow && wc.getOwnerBrowserWindow();
        const other = contents.getOwnerBrowserWindow && contents.getOwnerBrowserWindow();
        if (!win || !other || win !== other) return;
        installPlayerCdpTap(contents).catch(() => {});
        contents.on('dom-ready', () => injectOne(contents));
        contents.on('did-finish-load', () => injectOne(contents));
      } catch (e) {
        // ignore
      }
    };
    app.on('web-contents-created', onCreated);
    const detach = () => {
      try {
        app.removeListener('web-contents-created', onCreated);
      } catch (e) {
        // ignore
      }
    };
    wc.once('destroyed', detach);
    wc.once('render-process-gone', detach);
  } catch (e) {
    // ignore
  }
  return true;
}

async function playPlayerVideo(wc, seekTo) {
  const frames = collectFrames(wc);
  let best = 0;
  const mode =
    seekTo === 'nudge' ? 'nudge' : seekTo == null || !Number.isFinite(Number(seekTo)) ? 'play' : 'seek';
  const seekNum = mode === 'seek' ? Number(seekTo) : 0;
  for (const frame of frames) {
    try {
      const info = await frame.executeJavaScript(
        `(() => {
          const findV = (root) => {
            if (!root) return null;
            const direct = root.querySelector && root.querySelector('video');
            if (direct) return direct;
            const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const el of els) {
              if (el.shadowRoot) {
                const inner = findV(el.shadowRoot);
                if (inner) return inner;
              }
            }
            return null;
          };
          const v = findV(document);
          if (!v) {
            try {
              document.querySelectorAll('.vjs-big-play-button, .jw-icon-playback, [aria-label="Play"], [aria-label="play"]').forEach((el) => el.click());
            } catch (e) {}
            return 0;
          }
          v.muted = true;
          try { v.autoplay = true; } catch (e) {}
          try { v.playbackRate = 3; } catch (e) {}
          try { v.play().catch(() => {}); } catch (e) {}
          try { v.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (e) {}
          try {
            if (window.__wvdHls && window.__wvdHls.config) {
              window.__wvdHls.config.maxBufferLength = 4000;
              window.__wvdHls.config.maxMaxBufferLength = 8000;
              window.__wvdHls.config.maxBufferSize = 500 * 1000 * 1000;
              window.__wvdHls.config.capLevelToPlayerSize = false;
              window.__wvdHls.config.abrEwmaDefaultEstimate = 20000000;
            }
            if (window.__wvdHls && window.__wvdHls.levels && window.__wvdHls.levels.length) {
              const levels = window.__wvdHls.levels;
              let best = 0;
              for (let i = 1; i < levels.length; i++) {
                const a = levels[i] || {};
                const b = levels[best] || {};
                const ah = a.height || 0;
                const bh = b.height || 0;
                const ab = a.bitrate || 0;
                const bb = b.bitrate || 0;
                if (ah > bh || (ah === bh && ab > bb)) best = i;
              }
              try { window.__wvdHls.autoLevelCapping = -1; } catch (e) {}
              try { window.__wvdHls.currentLevel = best; } catch (e) {}
              try { window.__wvdHls.loadLevel = best; } catch (e) {}
              try { window.__wvdHls.nextLevel = best; } catch (e) {}
            }
          } catch (e) {}
          const d = Number(v.duration);
          const mode = ${JSON.stringify(mode)};
          if (Number.isFinite(d) && d > 0) {
            if (mode === 'nudge') {
              const t = Math.min(Math.max(0, d - 0.25), (v.currentTime || 0) + 1);
              if (Math.abs((v.currentTime || 0) - t) > 0.2) v.currentTime = t;
            } else if (mode === 'seek') {
              const t = Math.max(0, Math.min(${seekNum}, Math.max(0, d - 0.25)));
              try { v.currentTime = t; } catch (e) {}
              try {
                if (window.__wvdHls && typeof window.__wvdHls.startLoad === 'function') {
                  window.__wvdHls.startLoad(t);
                }
              } catch (e) {}
            } else {
              try {
                if (window.__wvdHls && typeof window.__wvdHls.startLoad === 'function' && !window.__wvdHlsLoadKicked) {
                  window.__wvdHlsLoadKicked = true;
                  window.__wvdHls.startLoad(-1);
                }
              } catch (e) {}
            }
          }
          return Number.isFinite(d) && d > 0 ? d : 0;
        })()`,
        true
      );
      const n = Number(info);
      if (Number.isFinite(n) && n > best) best = n;
    } catch (e) {
      // ignore
    }
  }
  return best;
}

async function kickHlsLoad(wc, startSec) {
  const t = Number(startSec) || 0;
  for (const frame of collectFrames(wc)) {
    try {
      await frame.executeJavaScript(
        `(() => {
          const hls = window.__wvdHls;
          if (!hls) return 'no-hls';
          try { hls.config.maxBufferLength = 4000; } catch (e) {}
          try { hls.config.maxMaxBufferLength = 8000; } catch (e) {}
          try { hls.config.maxBufferSize = 500 * 1000 * 1000; } catch (e) {}
          try { if (typeof hls.startLoad === 'function') hls.startLoad(${JSON.stringify(t)}); } catch (e) {}
          return 'ok';
        })()`,
        true
      );
    } catch (e) {
      // ignore
    }
  }
}

async function drainMseChunks(wc) {
  const frames = collectFrames(wc);
  const out = [];
  for (const frame of frames) {
    try {
      const batch = await frame.executeJavaScript(
        `(function() {
          const all = window.__wvdMse || [];
          const take = all.splice(0, 80);
          return take;
        })()`,
        true
      );
      if (Array.isArray(batch)) out.push(...batch);
    } catch (e) {
      // ignore
    }
  }
  return out;
}

function splitMp4Boxes(buf) {
  const boxes = [];
  if (!buf || buf.length < 8) return boxes;
  let i = 0;
  while (i + 8 <= buf.length) {
    let size = buf.readUInt32BE(i);
    if (size === 1 && i + 16 <= buf.length) {
      size = buf.readUInt32BE(i + 8) * 0x100000000 + buf.readUInt32BE(i + 12);
    }
    if (size < 8 || i + size > buf.length) {
      if (i < buf.length) boxes.push(buf.subarray(i));
      break;
    }
    boxes.push(buf.subarray(i, i + size));
    i += size;
  }
  return boxes;
}

function classifyMseBuffers(buf) {
  if (!buf || !buf.length) return [];
  if (buf[0] === 0x47) return [{ kind: 'ts', buf }];
  const parts = splitMp4Boxes(buf);
  if (!parts.length) return [{ kind: isFmp4At(buf, 0) ? 'init' : 'media', buf }];
  const out = [];
  let init = [];
  let frag = [];
  const flushInit = () => {
    if (!init.length) return;
    out.push({ kind: 'init', buf: Buffer.concat(init) });
    init = [];
  };
  const flushFrag = () => {
    if (!frag.length) return;
    out.push({ kind: 'media', buf: Buffer.concat(frag) });
    frag = [];
  };
  for (const box of parts) {
    if (box.length < 8) continue;
    const typ = box.toString('ascii', 4, 8);
    if (typ === 'ftyp' || typ === 'moov' || typ === 'mvex' || typ === 'sidx' || typ === 'styp') {
      flushFrag();
      init.push(box);
    } else if (typ === 'moof' || typ === 'mdat' || typ === 'emsg') {
      flushInit();
      frag.push(box);
    } else if (frag.length) {
      frag.push(box);
    } else {
      init.push(box);
    }
  }
  flushInit();
  flushFrag();
  return out.length ? out : [{ kind: 'media', buf }];
}

function forEachIsoBox(buf, fn, start = 0, end = buf.length) {
  let i = start;
  while (i + 8 <= end) {
    const size = buf.readUInt32BE(i);
    const typ = buf.toString('ascii', i + 4, i + 8);
    if (size < 8 || i + size > end) break;
    fn(typ, i, size);
    i += size;
  }
}

function tfhdTrackId(buf) {
  let id = 0;
  const visit = (from, to) => {
    forEachIsoBox(
      buf,
      (typ, i, size) => {
        if (typ === 'tfhd' && size >= 16) id = buf.readUInt32BE(i + 12);
        else if (typ === 'moof' || typ === 'traf') visit(i + 8, i + size);
      },
      from,
      to
    );
  };
  visit(0, buf.length);
  return id;
}

function tfdtBaseMediaDecodeTime(buf) {
  let t = null;
  const visit = (from, to) => {
    forEachIsoBox(
      buf,
      (typ, i, size) => {
        if (typ === 'tfdt' && size >= 16) {
          const ver = buf[i + 8];
          t =
            ver === 1 && size >= 24
              ? buf.readUInt32BE(i + 12) * 0x100000000 + buf.readUInt32BE(i + 16)
              : buf.readUInt32BE(i + 12);
        } else if (typ === 'moof' || typ === 'traf') visit(i + 8, i + size);
      },
      from,
      to
    );
  };
  visit(0, buf.length);
  return t;
}

function tkhdTrackId(buf) {
  let id = 0;
  const visit = (from, to) => {
    forEachIsoBox(
      buf,
      (typ, i, size) => {
        if (typ === 'tkhd' && size >= 24) {
          const ver = buf[i + 8];
          id = ver === 1 ? buf.readUInt32BE(i + 28) : buf.readUInt32BE(i + 20);
        } else if (typ === 'moov' || typ === 'trak') visit(i + 8, i + size);
      },
      from,
      to
    );
  };
  visit(0, buf.length);
  return id;
}

function initStreamKind(buf) {
  const s = buf.toString('latin1');
  if (s.indexOf('soun') !== -1 || s.indexOf('SoundHandler') !== -1) return 'audio';
  if (s.indexOf('vide') !== -1 || s.indexOf('VideoHandler') !== -1) return 'video';
  return 'video';
}

function writeMseHlsPlaylist(dir, initName, mediaNames, durationSec, fileName) {
  if (!mediaNames.length) return null;
  const each = durationSec && mediaNames.length ? durationSec / mediaNames.length : 4;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(each))}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0'
  ];
  if (initName) lines.push(`#EXT-X-MAP:URI="${initName}"`);
  for (const name of mediaNames) {
    lines.push(`#EXTINF:${each.toFixed(3)},`);
    lines.push(name);
  }
  lines.push('#EXT-X-ENDLIST');
  const playlistPath = path.join(dir, fileName || 'mse-index.m3u8');
  fs.writeFileSync(playlistPath, lines.join('\n'));
  return playlistPath;
}

// Walk the playing video and collect MSE appendBuffer chunks. Token CDNs
// never give those bytes to net.request; this is the media the player already
// decoded into <video>.
async function harvestPlayerMse(wc, dir, { signal, onProgress, onLog } = {}) {
  if (!wc || wc.isDestroyed()) throw new Error('player window is gone');
  fs.mkdirSync(dir, { recursive: true });
  try {
    await wc.executeJavaScript(ensureMseHookScript(), true);
  } catch (e) {
    // ignore
  }
  const early = [];
  for (let n = 0; n < 6; n++) {
    const batch = await drainMseChunks(wc);
    for (const b64 of batch) {
      const buf = Buffer.from(b64 || '', 'base64');
      if (buf.length) early.push(buf);
    }
    if (early.length) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (early.length) {
    if (onLog) onLog(`Player is feeding MSE (${early.length} fragment(s)); capturing those.`);
    const rest = await drainMseChunks(wc);
    for (const b64 of rest) {
      const buf = Buffer.from(b64 || '', 'base64');
      if (buf.length) early.push(buf);
    }
    const joined = Buffer.concat(early);
    const box = joined.length >= 8 ? joined.toString('ascii', 4, 8) : '';
    // Live MSE is fMP4 fragments (ftyp/moof) without a full moov/trex. Remuxing
    // a few seconds of those dies immediately; the HLS part walk has the episode.
    if (joined[0] !== 0x47) {
      throw new Error(
        'MSE snapshot is incomplete fMP4 (' +
          (box || 'unknown') +
          ', ' +
          early.length +
          ' fragment(s)); capturing HLS parts instead'
      );
    }
    if (joined.length < 2 * 1024 * 1024) {
      throw new Error('MSE capture too short for remux');
    }
    const rawPath = path.join(dir, 'player.ts');
    fs.writeFileSync(rawPath, joined);
    return rawPath;
  }
  if (onLog) onLog('Player does not use MSE appends (native HLS); intercepting its CDN responses.');
  throw new Error('no MSE fragments');
}

async function harvestMediaRecorder(wc, dir, { signal, onProgress, onLog } = {}) {
  try {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed()) {
      try {
        require('./discoverwindow').cloakForPlayback(win);
      } catch (e2) {
        // ignore
      }
      try {
        wc.setBackgroundThrottling(false);
      } catch (e2) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }
  const startWork = wc.executeJavaScript(
    `(() => {
      try {
        const v = document.querySelector('video');
        if (!v) return { ok: false, error: 'no video' };
        try { v.muted = true; } catch (e) {}
        try { v.playbackRate = 1; } catch (e) {}
        try { v.play(); } catch (e) {}
        if (typeof v.captureStream !== 'function') {
          return { ok: false, error: 'captureStream unavailable', ready: v.readyState, src: (v.currentSrc || '').slice(0, 80) };
        }
        const stream = v.captureStream();
        const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
        window.__wvdRecChunks = [];
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size) window.__wvdRecChunks.push(e.data);
        };
        rec.start(1500);
        window.__wvdRecorder = rec;
        return {
          ok: true,
          mime,
          dur: v.duration || 0,
          state: rec.state,
          ready: v.readyState,
          src: (v.currentSrc || '').slice(0, 120)
        };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })()`,
    true
  );
  const start = await Promise.race([
    startWork,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: 'MediaRecorder start timed out' }), 8000)
    )
  ]);
  if (!start || !start.ok) throw new Error((start && start.error) || 'MediaRecorder failed');
  if (onLog) {
    onLog(
      `Recording the playing video (${Math.round(start.dur || 0)}s, ${start.mime || 'webm'})...`
    );
  }

  const chunks = [];
  const duration = start.dur || 0;
  const deadline = Date.now() + Math.max(90000, duration * 1100 + 20000);
  const pull = async () => {
    const info = await wc.executeJavaScript(
      `(async () => {
        const v = document.querySelector('video');
        const rec = window.__wvdRecorder;
        const pending = (window.__wvdRecChunks || []).splice(0);
        const parts = [];
        for (const b of pending) {
          const buf = await b.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          const step = 0x4000;
          for (let i = 0; i < bytes.length; i += step) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
          }
          parts.push(btoa(bin));
        }
        return {
          t: v ? v.currentTime : 0,
          dur: v ? v.duration || 0 : 0,
          ended: !!(v && (v.ended || (v.duration && v.currentTime >= v.duration - 0.4))),
          state: rec ? rec.state : '',
          parts
        };
      })()`,
      true
    );
    for (const b64 of (info && info.parts) || []) {
      const buf = Buffer.from(b64 || '', 'base64');
      if (buf.length) chunks.push(buf);
    }
    return info || {};
  };

  while (Date.now() < deadline) {
    if (signal && signal.aborted) {
      try {
        await wc.executeJavaScript(
          `(async () => { try { window.__wvdRecorder && window.__wvdRecorder.stop(); } catch (e) {} })()`,
          true
        );
      } catch (e) {
        // ignore
      }
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const info = await pull();
    if (onProgress && (info.dur || duration)) {
      const tot = info.dur || duration;
      onProgress({
        received: info.t || 0,
        total: tot,
        percent: tot ? Math.min(0.99, (info.t || 0) / tot) : null
      });
    }
    if (info.ended) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    await wc.executeJavaScript(
      `(async () => {
        const rec = window.__wvdRecorder;
        if (rec && rec.state !== 'inactive') {
          await new Promise((res) => { rec.onstop = () => res(true); rec.stop(); setTimeout(res, 2000); });
        }
        return true;
      })()`,
      true
    );
  } catch (e) {
    // ignore
  }
  await pull();
  if (!chunks.length) throw new Error('MediaRecorder produced no data');
  const rawPath = path.join(dir, 'player.webm');
  fs.writeFileSync(rawPath, Buffer.concat(chunks));
  if (onLog) onLog(`Recorded ${Math.round(Buffer.concat(chunks).length / 1024)} KB of playback.`);
  return rawPath;
}

async function watchPlayerSegments(wc, jobs, dir, { signal, onProgress, onLog, drainOnly, maxWatchMs, allowPartial, prefetchRemaining } = {}) {
  if (!wc || wc.isDestroyed()) throw new Error('player window is gone');
  try {
    if (onLog) {
    const uniq = new Set(jobs.map((j) => j.abs)).size;
    let uniqP = 0;
    try {
      uniqP = new Set(jobs.map((j) => new URL(j.abs).pathname)).size;
    } catch (e) {
      uniqP = 0;
    }
    onLog(`Playlist has ${jobs.length} part(s) (${uniq} unique URL(s), ${uniqP} unique path(s)).`);
  }
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed()) {
      require('./discoverwindow').cloakForPlayback(win);
    }
  } catch (e) {
    // ignore
  }

  const remaining = new Map(jobs.map((j) => [j.abs, j]));
  const byPath = new Map();
  const byName = new Map();
  const pathCount = new Map();
  const nameCount = new Map();
  for (const job of jobs) {
    try {
      const p = new URL(job.abs).pathname;
      pathCount.set(p, (pathCount.get(p) || 0) + 1);
      const base = p.split('/').filter(Boolean).pop();
      if (base) nameCount.set(base, (nameCount.get(base) || 0) + 1);
    } catch (e) {
      // ignore
    }
  }
  for (const job of jobs) {
    try {
      const p = new URL(job.abs).pathname;
      if (pathCount.get(p) === 1) byPath.set(p, job);
      const base = p.split('/').filter(Boolean).pop();
      if (base && nameCount.get(base) === 1 && !byName.has(base)) byName.set(base, job);
    } catch (e) {
      // ignore
    }
  }
  const written = new Set();
  let done = 0;
  for (const job of jobs) {
    try {
      const p = path.join(dir, job.name);
      if (fs.existsSync(p) && fs.statSync(p).size > 200) {
        written.add(job.name);
        remaining.delete(job.abs);
        done += 1;
      }
    } catch (e) {
      // ignore
    }
  }
  const matchJob = (url) => {
    if (!url) return null;
    if (remaining.has(url)) return remaining.get(url);
    try {
      const u = new URL(url);
      u.hash = '';
      u.search = '';
      if (remaining.has(u.toString())) return remaining.get(u.toString());
      if (byPath.has(u.pathname)) return byPath.get(u.pathname);
      const base = u.pathname.split('/').filter(Boolean).pop();
      if (base && byName.has(base)) return byName.get(base);
      for (const job of jobs) {
        if (written.has(job.name)) continue;
        try {
          if (new URL(job.abs).pathname === u.pathname) return job;
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
    return null;
  };

  let mseLogged = false;
  const mseInits = { audio: null, video: null };
  const mseMedia = { audio: [], video: [] };
  const mseTrackKind = Object.create(null);
  const mseLastSig = { audio: '', video: '' };
  const mseTfdt = { audio: new Set(), video: new Set() };
  let mseN = 0;
  const mseCount = () => mseMedia.audio.length + mseMedia.video.length;
  const flushMse = async () => {
    const batch = await drainMseChunks(wc);
    for (const b64 of batch) {
      const raw = Buffer.from(b64 || '', 'base64');
      if (!raw.length) continue;
      for (const piece of classifyMseBuffers(raw)) {
        if (piece.kind === 'init') {
          const kind = initStreamKind(piece.buf);
          if (mseInits[kind]) continue;
          const name = kind === 'audio' ? 'init-a.mp4' : 'init-v.mp4';
          fs.writeFileSync(path.join(dir, name), piece.buf);
          mseInits[kind] = name;
          const tid = tkhdTrackId(piece.buf);
          if (tid) mseTrackKind[tid] = kind;
          continue;
        }
        if (piece.kind === 'ts') {
          const name = `mse${String(mseN).padStart(5, '0')}.ts`;
          mseN += 1;
          fs.writeFileSync(path.join(dir, name), piece.buf);
          mseMedia.video.push(name);
          continue;
        }
        const tid = tfhdTrackId(piece.buf);
        const kind =
          mseTrackKind[tid] || (piece.buf.length < 400000 ? 'audio' : 'video');
        const sig = String(piece.buf.length) + ':' + piece.buf.slice(0, 24).toString('hex');
        if (mseLastSig[kind] === sig) continue;
        mseLastSig[kind] = sig;
        const dt = tfdtBaseMediaDecodeTime(piece.buf);
        if (dt != null) {
          if (mseTfdt[kind].has(dt)) continue;
          mseTfdt[kind].add(dt);
        }
        const name = `${kind === 'audio' ? 'a' : 'v'}${String(mseMedia[kind].length).padStart(5, '0')}.m4s`;
        fs.writeFileSync(path.join(dir, name), piece.buf);
        mseMedia[kind].push(name);
      }
    }
    if (!mseLogged && mseCount()) {
      mseLogged = true;
      if (onLog) {
        onLog(
          `Capturing the live player buffer (video ${mseMedia.video.length}, audio ${mseMedia.audio.length}).`
        );
      }
    }
    if (onProgress && jobs.length) {
      const byMse = mseCount() / Math.max(jobs.length, 1);
      const byHls = done / jobs.length;
      onProgress({
        received: Math.max(done, mseCount()),
        total: jobs.length,
        percent: Math.min(0.99, Math.max(byMse, byHls))
      });
    }
  };

  const hookJs = playerHookScript();

  const drainJs = `(function() {
    const out = window.__wvdParts || {};
    const keys = Object.keys(out);
    const batch = {};
    let bytes = 0;
    let n = 0;
    for (const k of keys) {
      const v = out[k];
      const len = (v && v.length) || 0;
      if (n && (n >= 6 || bytes + len > 16 * 1024 * 1024)) break;
      batch[k] = v;
      bytes += len;
      delete out[k];
      n += 1;
    }
    return { hooked: window.__wvdHooked || '', n: keys.length, batch };
  })()`;

  const frames = collectFrames(wc);
  let hooked = 0;
  for (const frame of frames) {
    try {
      const r = await frame.executeJavaScript(hookJs, true);
      if (r) hooked += 1;
    } catch (e) {
      // ignore
    }
  }
  if (onLog) onLog(`Hooked fetch/XHR in ${hooked} player frame(s).`);
  try {
    await wc.executeJavaScript(ensureMseHookScript(), true);
  } catch (e) {
    // preload already hooked appendBuffer
  }

  try {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) {
      await Promise.race([
        dbg.attach('1.3'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('attach timeout')), 2000))
      ]);
    }
    // Linux Electron 31 SIGSEGV'd inside Fetch.getResponseBody on 8MB+
    // peakstorm/ashencloud parts. Network.enable in installPlayerCdpTap still
    // copies those bodies without pausing the request.
    // Linux SIGSEGV'd on 8MB+ Fetch.getResponseBody copies. Segment TS parts
    // are a few hundred KB; skip anything over 2 MB.
    if (wc._cdpFetchOn || wc._cdpTap) {
      if (onLog) onLog('Intercepting player CDN responses.');
    } else if (!wc._cdpFetchOn) {
      dbg.on('message', async (_event, method, params) => {
        wc._cdpMsgs = (wc._cdpMsgs || 0) + 1;
        if (method !== 'Fetch.requestPaused') return;
        const requestId = params.requestId;
        const url = (params.request && params.request.url) || '';
        try {
          const code = params.responseStatusCode || 0;
          const headers = params.responseHeaders || [];
          let len = 0;
          for (const h of headers) {
            if (h && /content-length/i.test(h.name)) len = Number(h.value) || 0;
          }
          if (code >= 200 && code < 400 && isCdnMediaUrl(url) && shouldCopyFetchBody(url, len)) {
            await enqueueFetchBodyCopy(wc, async () => {
              try {
                const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
                storeCdpPart(wc, url, bufferFromCdpString(body.body, body.base64Encoded));
              } catch (e) {
                // ignore
              }
            });
          }
        } finally {
          try {
            await dbg.sendCommand('Fetch.continueRequest', { requestId });
          } catch (e) {
            // ignore
          }
        }
      });
      await Promise.race([
        dbg.sendCommand('Fetch.enable', {
          patterns: CDP_FETCH_PATTERNS
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch.enable timeout')), 2000))
      ]);
      wc._cdpFetchOn = true;
      if (onLog) onLog('Intercepting player CDN responses.');
    }
  } catch (e) {
    if (onLog) onLog(`Could not intercept player CDN (${e.message || e}).`);
  }

  const writeJob = (job, buf0, note) => {
    let buf = Buffer.isBuffer(buf0) ? buf0 : Buffer.from(buf0 || []);
    if (job.strip) buf = stripPngWrapper(buf);
    if (!buf || !buf.length) return false;
    fs.writeFileSync(path.join(dir, job.name), buf);
    written.add(job.name);
    remaining.delete(job.abs);
    done += 1;
    if (done === 1 && onLog) onLog(note || 'Captured first HLS part from the player.');
    else if (onLog && done <= 6) onLog(`Wrote ${job.name}`);
    else if (onLog && done % 40 === 0) onLog(`Captured ${done}/${jobs.length} HLS part(s).`);
    if (onProgress) onProgress({ received: done, total: jobs.length, percent: done / jobs.length });
    return true;
  };

  const drainCdp = () => {
    const parts = wc._cdpParts;
    if (!parts || !parts.size) return;
    for (const [url, buf0] of [...parts]) {
      const job = matchJob(url);
      if (!job || written.has(job.name)) continue;
      if (writeJob(job, buf0, 'Captured first HLS part from the player debugger.')) parts.delete(url);
    }
  };

  const drainPageResources = async () => {
    let urls = [];
    try {
      urls = await wc.executeJavaScript(
        `performance.getEntriesByType('resource').map((e) => e.name)`,
        true
      );
    } catch (e) {
      urls = [];
    }
    const seen = new Set();
    for (const url of urls || []) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const job = matchJob(url);
      if (!job || written.has(job.name)) continue;
      const buf = await readPageResource(wc, url);
      if (looksLikeSegment(buf)) writeJob(job, buf, 'Captured first HLS part from the player cache.');
    }
  };

  const hookAllFrames = async () => {
    const mse = ensureMseHookScript();
    const fetchHook = playerHookScript();
    for (const frame of collectFrames(wc)) {
      try {
        await frame.executeJavaScript(fetchHook, true);
      } catch (e) {
        // ignore
      }
      try {
        await frame.executeJavaScript(mse, true);
      } catch (e) {
        // ignore
      }
    }
  };

  const drainWorkers = async () => {
    const dbg = wc.debugger;
    if (!dbg || !dbg.isAttached()) return;
    for (const sid of wc._cdpWorkerSessions || []) {
      for (let i = 0; i < 4; i++) {
        let val = null;
        try {
          const r = await cdpSendTimed(
            dbg,
            'Runtime.evaluate',
            {
              expression: `(function() {
                var o = self.__wvdParts || {};
                var keys = Object.keys(o);
                if (!keys.length) return { n: 0, url: '', b64: '' };
                var url = keys[0];
                var b64 = o[url] || '';
                delete o[url];
                return { n: keys.length - 1, url: url, b64: b64 };
              })()`,
              returnByValue: true
            },
            sid,
            10000
          );
          val = r && r.result && r.result.value;
        } catch (e) {
          break;
        }
        if (!val || !val.url || !val.b64) break;
        const job = matchJob(val.url);
        if (!job || written.has(job.name)) {
          if (!job && onLog && done < 3) onLog(`Unmatched worker part ${String(val.url).slice(0, 120)}`);
          continue;
        }
        writeJob(job, Buffer.from(val.b64, 'base64'), 'Captured first HLS part from the player worker.');
      }
    }
  };

  const drain = async () => {
    await hookAllFrames();
    // In-page fetch hook copies ArrayBuffers (binary-safe). CDP Network bodies
    // on Linux are often UTF-8-mangled; only use them to fill gaps.
    for (const frame of collectFrames(wc)) {
      let info;
      try {
        info = await frame.executeJavaScript(drainJs, true);
      } catch (e) {
        continue;
      }
      const batch = (info && info.batch) || {};
      for (const [url, b64] of Object.entries(batch)) {
        const job = matchJob(url);
        if (!job || written.has(job.name)) {
          if (!job && onLog && done === 0 && isCdnMediaUrl(url)) {
            onLog(`Unmatched player part ${String(url).slice(0, 100)}`);
          }
          continue;
        }
        let buf = Buffer.from(b64 || '', 'base64');
        if (job.strip) buf = stripPngWrapper(buf);
        if (!buf || !buf.length) continue;
        fs.writeFileSync(path.join(dir, job.name), buf);
        written.add(job.name);
        remaining.delete(job.abs);
        done += 1;
        if (done === 1 && onLog) onLog('Captured first HLS part from the player.');
        else if (onLog && done % 40 === 0) onLog(`Captured ${done}/${jobs.length} HLS part(s).`);
        if (onProgress) onProgress({ received: done, total: jobs.length, percent: done / jobs.length });
      }
    }
    drainCdp();
    await drainWorkers();
    await drainPageResources();
    await flushMse();
  };

  let duration = await playPlayerVideo(wc, 0);
  for (let i = 0; i < 20 && !duration; i++) {
    await new Promise((r) => setTimeout(r, 400));
    duration = await playPlayerVideo(wc, null);
  }
  if (onLog) {
    onLog(
      `Waiting for the player to fetch ${jobs.length} part(s)` +
        (duration ? ` (video ${Math.round(duration)}s)` : ' (waiting for duration)') +
        '...'
    );
  }

  await drain();
  if (done && onLog) onLog(`Already had ${done} HLS part(s) from the live player.`);
  try {
    const hook = await wc.executeJavaScript(
      `({ w: window.__wvdWorkerPatched || '', seen: window.__wvdWorkerSeen || [], parts: Object.keys(window.__wvdParts || {}).length })`,
      true
    );
    if (onLog) {
      onLog(
        `Player worker hook: ${hook && hook.w ? hook.w : 'none'}; parts=${hook && hook.parts}; seen=${JSON.stringify((hook && hook.seen) || [])}`
      );
    }
  } catch (e) {
    // ignore
  }
  if (drainOnly && !maxWatchMs) return;

  const started = Date.now();
  let warned = false;
  const deadline = maxWatchMs
    ? Date.now() + Math.max(3000, maxWatchMs)
    : Date.now() + Math.max(180000, Math.min((duration || 600) * 800, 15 * 60 * 1000));
  let lastVideo = 0;
  let lastWritten = written.size;
  let stagnant = 0;
  let peakPercent = 0;
  let lastSeekIdx = -1;
  let playerFetchLogged = false;
  // A one-shot token that expired while the episode waited in the queue makes
  // the player 400 on every segment. Without this the loop seeked for the full
  // 15-minute deadline and the UI sat on "Downloading" at 0%. Bailing lets the
  // queue re-resolve the episode and get a fresh token.
  let lastGainAt = Date.now();
  const idleLimitMs = maxWatchMs ? Math.max(8000, maxWatchMs) : 90000;
  const report = () => {
    if (!onProgress) return;
    const byJobs = jobs.length ? written.size / jobs.length : 0;
    const expectMse = Math.max(24, duration ? duration / 4 : 24);
    const byMse = jobs.length > 10 ? 0 : mseMedia.video.length / expectMse;
    const p = Math.min(0.99, Math.max(byJobs, byMse, peakPercent));
    peakPercent = p;
    onProgress({
      received: written.size,
      total: jobs.length || mseMedia.video.length,
      percent: p
    });
  };
  while (written.size < jobs.length && Date.now() < deadline) {
    if (signal && signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (!warned && Date.now() - started > 8000 && written.size === 0) {
      warned = true;
      let diag = '';
      try {
        diag = await wc.executeJavaScript(
          `(() => {
            const perf = performance.getEntriesByType('resource').map((e) => e.name).slice(-8);
            const ifr = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '').slice(0, 6);
            return JSON.stringify({
              hooked: window.__wvdHooked || '',
              workerPatched: window.__wvdWorkerPatched || '',
              workerSeen: window.__wvdWorkerSeen || [],
              parts: Object.keys(window.__wvdParts || {}).length,
              mse: (window.__wvdMse || []).length,
              videos: Array.from(document.querySelectorAll('video')).map((v) => ({
                r: v.readyState,
                d: v.duration,
                src: String(v.currentSrc || v.src || '').slice(0, 80)
              })),
              seen: window.__wvdSeen || [],
              ifr,
              perf: perf.map((n) => String(n).slice(0, 80))
            });
          })()`,
          true
        );
      } catch (e) {
        diag = String(e && e.message);
      }
      if (onLog) {
        onLog(
          `No HLS parts from fetch yet (MSE video ${mseMedia.video.length}, audio ${mseMedia.audio.length}); diag=${diag}`
        );
      }
    }
    duration = (await playPlayerVideo(wc, null)) || duration;
    await new Promise((r) => setTimeout(r, duration ? 400 : 500));
    await drain();
    report();
    const gettingHls = written.size > lastWritten;
    const gettingMse = mseMedia.video.length > lastVideo;
    lastWritten = written.size;
    if (gettingMse) {
      lastVideo = mseMedia.video.length;
      stagnant = 0;
    } else if (gettingHls) {
      stagnant = 0;
    } else {
      stagnant += 1;
    }
    if (gettingHls || gettingMse) lastGainAt = Date.now();
    if (written.size === 0 && mseCount() === 0 && Date.now() - lastGainAt > idleLimitMs) {
      if (onLog) {
        onLog(
          `Player produced nothing in ${Math.round(idleLimitMs / 1000)}s; its stream token looks expired. Giving up so this episode can be resolved again.`
        );
      }
      break;
    }
    const frac = jobs.length ? written.size / jobs.length : 0;
    if (stagnant >= 12 && frac >= 0.98) break;
    if (duration) {
      const segs = jobs.filter((j) => /^seg\d+\.ts$/i.test(j.name));
      let nextIdx = 0;
      while (nextIdx < segs.length && written.has(segs[nextIdx].name)) nextIdx += 1;
      if (nextIdx < segs.length && stagnant >= (prefetchRemaining ? 4 : 10)) {
        const t = nextIdx * (duration / Math.max(segs.length, 1)) + 0.05;
        if (lastSeekIdx !== nextIdx) {
          lastSeekIdx = nextIdx;
          if (onLog) {
            onLog(
              `Requesting player parts from ${nextIdx + 1}/${segs.length}` +
                (prefetchRemaining ? ' (HLS load).' : '.')
            );
          }
        }
        await playPlayerVideo(wc, Math.min(Math.max(0, duration - 0.25), t));
        if (prefetchRemaining) {
          try {
            await kickHlsLoad(wc, t);
          } catch (e) {
            // ignore
          }
        }
        stagnant = 0;
      }
    } else if (stagnant >= 45) {
      break;
    }
  }
  await drain();
  const stats = holeStats(jobs, dir);
  if (stats.have >= jobs.length) return;
  if (stats.internal === 0 && stats.have / Math.max(jobs.length, 1) >= 0.98) {
    if (onLog) onLog(`Player yielded ${stats.have}/${jobs.length} HLS parts (trailing only).`);
    return;
  }
  if (allowPartial || maxWatchMs) {
    if (onLog) {
      onLog(
        `Player snapshot ${stats.have}/${jobs.length} HLS parts; will fetch the rest from the live page.`
      );
    }
    return;
  }
  throw new Error(
    `player only yielded ${stats.have}/${jobs.length} HLS parts` +
      (stats.internal ? ` with ${stats.internal} hole(s) in the middle` : '') +
      (mseCount() ? ` and ${mseCount()} MSE fragment(s)` : '')
  );
}

function jobFileOk(dir, job) {
  try {
    const p = path.join(dir, job.name);
    return fs.existsSync(p) && fs.statSync(p).size > 200;
  } catch (e) {
    return false;
  }
}

function holeStats(jobs, dir) {
  const ok = jobs.map((job) => jobFileOk(dir, job));
  const have = ok.filter(Boolean).length;
  let lastHave = -1;
  for (let i = ok.length - 1; i >= 0; i--) {
    if (ok[i]) {
      lastHave = i;
      break;
    }
  }
  let internal = 0;
  for (let i = 0; i < lastHave; i++) {
    if (!ok[i]) internal += 1;
  }
  const trailing = lastHave < 0 ? ok.length : ok.length - 1 - lastHave;
  return { have, total: jobs.length, internal, trailing };
}

function writeLocalIndexPlaylist(lines, jobs, dir) {
  const have = new Set();
  for (const job of jobs) {
    if (jobFileOk(dir, job)) have.add(job.name);
  }
  const jobAt = new Map(jobs.map((job) => [job.i, job]));
  const out = [];
  let pendingExtinf = null;
  let emittedSeg = false;
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = String(raw).trim();
    if (/^#EXTINF/i.test(t)) {
      pendingExtinf = raw;
      continue;
    }
    const job = jobAt.get(i);
    if (job && !t.startsWith('#')) {
      if (have.has(job.name)) {
        if (pendingExtinf != null) out.push(pendingExtinf);
        out.push(job.name);
        emittedSeg = true;
        gap = false;
      } else if (emittedSeg) {
        gap = true;
      }
      pendingExtinf = null;
      continue;
    }
    pendingExtinf = null;
    if (/^#EXT-X-ENDLIST/i.test(t)) continue;
    out.push(raw);
  }
  out.push('#EXT-X-ENDLIST');
  const playlistPath = path.join(dir, 'index.m3u8');
  fs.writeFileSync(playlistPath, out.join('\n'), 'utf8');
  return { playlistPath, kept: have.size };
}

// Token CDNs sometimes never give Node an #EXTM3U body (one-shot /s/ URLs).
// Walk the live player anyway and remux whatever MSE already decoded.
async function captureLivePlayer(wc, dir, opts = {}) {
  if (!wc || wc.isDestroyed()) throw new Error('player window is gone');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [{ abs: 'https://mse.invalid/live', name: 'seg00000.ts', strip: true }];
  try {
    await watchPlayerSegments(wc, jobs, dir, opts);
  } catch (e) {
    const msePath = path.join(dir, 'mse-video.m3u8');
    if (fs.existsSync(msePath)) {
      if (opts.onLog) opts.onLog(`Player HLS capture failed (${e.message || e}); remuxing MSE fragments instead.`);
      return msePath;
    }
    throw e;
  }
  const msePath = path.join(dir, 'mse-video.m3u8');
  if (!fs.existsSync(msePath)) throw new Error('Player did not yield a video buffer');
  return msePath;
}

// Download every playlist URI through Chromium, unwrap PNG-disguised TS, and
// write a fully local playlist ffmpeg can remux without talking to the CDN.
async function localizePlaylist(text, base, dir, headers, { signal, onProgress, onLog, playerWebContentsId } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const jobs = [];
  let segN = 0;
  let keyN = 0;
  const out = lines.slice();

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const m = t.match(/URI=(["'])([^"']+)\1/i);
      if (!m) continue;
      let abs;
      try {
        abs = new URL(m[2], base).toString();
      } catch (e) {
        continue;
      }
      jobs.push({ i, abs, name: `key${keyN++}.bin`, strip: false, quote: m[1] });
      continue;
    }
    let abs;
    try {
      abs = new URL(t, base).toString();
    } catch (e) {
      continue;
    }
    jobs.push({ i, abs, name: `seg${String(segN++).padStart(5, '0')}.ts`, strip: true });
  }
  if (!jobs.length) throw new Error('HLS playlist has no segments');
  if (isMasterPlaylist(text)) {
    throw new Error('Got a master playlist instead of a media playlist');
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_source.m3u8'), String(text || ''), 'utf8');
  } catch (e) {
    // ignore
  }
  if (onLog) {
    const tags = {};
    for (const line of lines) {
      const m = String(line).match(/^(#EXT[^:\s]*)/);
      if (m) tags[m[1]] = (tags[m[1]] || 0) + 1;
    }
    onLog(`Playlist tags ${JSON.stringify(tags)}; ${segN} segment(s), ${keyN} key URI(s).`);
  }
  const viaPlayer = !!liveWebContents(playerWebContentsId);
  if (onLog) {
    onLog(
      viaPlayer
        ? `Downloading ${jobs.length} HLS part(s) from the open player page...`
        : `Downloading ${jobs.length} HLS part(s) through the browser session...`
    );
  }

  let done = 0;
  const bound = jobs.some((job) => isPlayerBoundCdn(job.abs, base));
  const oneShot = isOneShotHls(base) || jobs.some((job) => isOneShotHls(job.abs));
  const vod = bound && !oneShot;
  if (viaPlayer) {
    const wc = liveWebContents(playerWebContentsId);
    try {
      await watchPlayerSegments(wc, jobs, dir, {
        signal,
        onProgress,
        onLog,
        drainOnly: !bound,
        maxWatchMs: vod ? 12000 : 0,
        allowPartial: vod,
        prefetchRemaining: vod
      });
    } catch (e) {
      const msePath = [path.join(dir, 'mse-video.m3u8'), path.join(dir, 'mse-index.m3u8')].find((p) =>
        fs.existsSync(p)
      );
      const anyHls = jobs.some((job) => fs.existsSync(path.join(dir, job.name)));
      if (msePath && !anyHls) {
        throw e;
      }
      if (onLog) onLog(`Player capture skipped: ${e.message || e}`);
      if (oneShot) throw e;
    }
  }
  const msePath = [path.join(dir, 'mse-video.m3u8'), path.join(dir, 'mse-index.m3u8')].find((p) =>
    fs.existsSync(p)
  );
  let remaining = jobs.filter((job) => !jobFileOk(dir, job));
  if (remaining.length === jobs.length && fs.existsSync(msePath)) {
    throw new Error('Player did not yield HLS parts; not remuxing MSE/WebM');
  }
  if (remaining.length && remaining.length < jobs.length && onLog) {
    onLog(`Captured ${jobs.length - remaining.length} part(s) from the player; fetching ${remaining.length} more.`);
  }
  if (remaining.length && viaPlayer && vod) {
    const wc = liveWebContents(playerWebContentsId);
    if (wc) {
      if (onLog) {
        onLog(`Fetching ${remaining.length} remaining HLS part(s) through the player session (VOD).`);
      }
      await pullRemainingViaPlayer(wc, remaining, jobs, dir, {
        signal,
        onProgress,
        onLog,
        headers
      });
      remaining = jobs.filter((job) => !jobFileOk(dir, job));
    }
  }
  if (
    remaining.length === jobs.length &&
    isPlayerBoundCdn(base, '') &&
    jobs.some((job) => isPlayerBoundCdn(job.abs, ''))
  ) {
    throw new Error(
      'Player did not yield any HLS parts; peakstorm/vidfast segments cannot be fetched from the main process'
    );
  }
  if (remaining.length && bound) {
    const stats = holeStats(jobs, dir);
    if (stats.internal > 0 || stats.have / Math.max(jobs.length, 1) < 0.98) {
      throw new Error(
        `player only yielded ${stats.have}/${jobs.length} HLS parts` +
          (stats.internal ? ` with ${stats.internal} hole(s) in the middle` : '') +
          '; not remuxing a stuttering file'
      );
    }
    const { playlistPath, kept } = writeLocalIndexPlaylist(out, jobs, dir);
    if (onLog) onLog(`Remuxing ${kept}/${jobs.length} captured HLS part(s) to MP4.`);
    return playlistPath;
  }
  if (remaining.length) {
    const wc = liveWebContents(playerWebContentsId);
    await mapPool(remaining, 2, async (job) => {
      if (signal && signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      let buf;
      if (wc) {
        buf = await fetchViaWebContents(wc, job.abs, { timeoutMs: 20000, signal });
      } else {
        buf = await fetchBufferRetry(job.abs, headers, {
          timeoutMs: 20000,
          signal,
          playerWebContentsId,
          skipPageFetch: !wc
        });
      }
      if (job.strip) {
        const head = buf.toString('utf8', 0, 256);
        if (looksLikeHtml(head) || looksLikeJson(head)) {
          const err = new Error('CDN returned a webpage instead of a video segment');
          err.status = 0;
          throw err;
        }
        buf = stripPngWrapper(buf);
      }
      if (!buf || !buf.length) throw new Error('empty HLS part');
      fs.writeFileSync(path.join(dir, job.name), buf);
      done += 1;
      if (onProgress) {
        const already = jobs.length - remaining.length;
        onProgress({
          received: already + done,
          total: jobs.length,
          percent: Math.min(0.99, (already + done) / jobs.length)
        });
      }
    });
  }

  for (const job of jobs) {
    const t = out[job.i].trim();
    if (t.startsWith('#')) {
      out[job.i] = t.replace(/URI=(["'])([^"']+)\1/i, `URI=${job.quote}${job.name}${job.quote}`);
    } else {
      out[job.i] = job.name;
    }
  }
  const playlistPath = path.join(dir, 'index.m3u8');
  fs.writeFileSync(playlistPath, out.join('\n'), 'utf8');
  return playlistPath;
}

// Returns { ok, status, reason }. ok=true means "don't skip this server".
// A hung CDN must never block discovery: the whole probe shares one deadline,
// and a timeout is treated as "unknown, keep the stream" (same as a non-HLS body).
async function bodyReachableInner(url, headers, signal = null) {
  const deadline = Date.now() + PROBE_MS;
  const left = () => Math.max(250, deadline - Date.now());
  const h = { ...(headers || {}) };
  if (!Object.keys(h).some((k) => k.toLowerCase() === 'user-agent')) {
    h['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  }

  if (signal && signal.aborted) return { ok: true, status: 0, reason: 'cancelled' };

  const master = await request(url, h, { maxBytes: 16000, timeoutMs: left(), signal });
  if (master.status && master.status >= 400) {
    // Peakstorm/vidfast playlists 500 from Node while the in-page player still
    // holds a working copy. Treat that as "keep the stream".
    if (isTokenCdn(url, '')) return { ok: true, status: master.status, reason: 'token-cdn' };
    return { ok: false, status: master.status, reason: 'playlist' };
  }
  if (!looksLikePlaylist(master.body)) {
    // A .m3u8 URL that is actually HTML/JSON will make ffmpeg die with
    // "Invalid data found when processing input". Skip this server instead.
    if (/\.m3u8/i.test(url) && (looksLikeHtml(master.body) || looksLikeJson(master.body))) {
      return { ok: false, status: master.status, reason: 'not-playlist' };
    }
    return { ok: true, status: master.status }; // not HLS / timed out, leave it
  }

  let media = master.body;
  let mediaUrl = url;
  if (!/#EXTINF:/i.test(media)) {
    const variant = firstUri(media);
    if (!variant) return { ok: false, status: master.status, reason: 'no-variant' };
    mediaUrl = new URL(variant, url).toString();
    const v = await request(mediaUrl, h, { maxBytes: 32000, timeoutMs: left(), signal });
    if (v.status && v.status >= 400) return { ok: false, status: v.status, reason: 'variant' };
    if (!v.body) return { ok: true, status: v.status };
    media = v.body;
  }

  const segs = (media || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!segs.length) return { ok: false, status: 0, reason: 'no-segments' };

  const infs = [...(media || '').matchAll(/#EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const firstDur = infs[0] || 0;
  // Only probe when the playlist looks like a stub: one huge leading segment.
  if (firstDur < 60) return { ok: true, status: 200 };
  // Token CDNs 502 Node/net.request for segments while the in-page player still
  // plays. Skipping here would reject the only working server.
  if (isTokenCdn(url, mediaUrl)) return { ok: true, status: 200 };

  const segUrl = new URL(segs[0], mediaUrl).toString();
  const peek = await request(segUrl, { ...h, Range: 'bytes=0-1023' }, { maxBytes: 2048, timeoutMs: left(), signal });
  if (!peek.status || peek.status >= 400) {
    return { ok: false, status: peek.status, reason: 'segment' };
  }
  return { ok: true, status: peek.status };
}

async function bodyReachable(url, headers, signal = null) {
  return Promise.race([
    bodyReachableInner(url, headers, signal),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, status: 0, reason: 'timeout' }), PROBE_MS + 1000)
    )
  ]);
}

module.exports = {
  bodyReachable,
  materializePlaylist,
  loadMediaPlaylist,
  cachedPlaylist,
  localizePlaylist,
  captureLivePlayer,
  fetchBuffer,
  stripPngWrapper,
  isPng,
  isTokenCdn,
  isPlayerBoundCdn,
  isOneShotHls,
  streamIsDownloadable,
  harvestPlayerMse,
  firstUri,
  playlistMediaDuration,
  looksLikePlaylist,
  isMasterPlaylist,
  trimMasterToBest,
  describeMediaPlaylist,
  installPlayerFetchHook,
  playPlayerVideo
};
