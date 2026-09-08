'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// BYFMS (and similar) will happily serve a master playlist whose first media
// segment is a 20-minute stub that 502s. ffmpeg then copies the leftover 45s of
// tail segments, exits 0, and we used to hand that to the queue as a "success"
// that immediately failed verification / truncation checks — download, then
// resolve, forever.

// Whole-probe budget. Node's socket `timeout` only fires on idle sockets; a TLS
// hang through a VPN often never goes idle, so without this hard cap discovery
// sits silent until the stall watchdog kills the episode.
const PROBE_MS = 8000;

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

function bestVariantUri(playlist, base) {
  const lines = String(playlist || '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  let best = null;
  let bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/#EXT-X-STREAM-INF:.*?\bBANDWIDTH=(\d+)/i);
    if (!m) continue;
    const next = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!next) continue;
    const bw = parseInt(m[1], 10);
    if (bw >= bestBw) {
      bestBw = bw;
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
async function fetchPlaylist(url, headers, signal = null) {
  const h = { ...(headers || {}) };
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

async function loadMediaPlaylist(url, headers, signal = null) {
  const master = await fetchPlaylist(url, headers, signal);
  let text = master.body;
  let base = master.url || url;
  if (!/#EXTINF:/i.test(text)) {
    const variant = bestVariantUri(text, base);
    if (variant) {
      try {
        const v = await fetchPlaylist(variant, headers, signal);
        if (looksLikePlaylist(v.body) && /#EXTINF:/i.test(v.body)) {
          text = v.body;
          base = v.url || variant;
        }
      } catch (e) {
        if (e && e.code === 'not-playlist') throw e;
      }
    }
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

// Vidfast/peakstorm (and similar) prepend a 1x1 PNG so ffmpeg's HLS demuxer
// probes "png" and dies with "Invalid data found when processing input".
// The real MPEG-TS starts at the first 0x47 sync after the PNG chunks.
function stripPngWrapper(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  if (!isPng(buf)) return buf;
  let i = 8;
  while (i + 12 <= buf.length) {
    if (buf[i] === 0x47) break;
    const len = buf.readUInt32BE(i);
    if (len > 10 * 1024 * 1024) break;
    const type = buf.toString('ascii', i + 4, i + 8);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  while (i < buf.length && buf[i] !== 0x47) i += 1;
  return i > 0 && i < buf.length ? buf.subarray(i) : buf;
}

function isTokenCdn(url, embedUrl) {
  return /peakstorm\.|vidfast\.|megacloud\.|rabbitstream\.|vidcloud/i.test(
    `${url || ''} ${embedUrl || ''}`
  );
}

// Vidfast/peakstorm playlists resolve, but segments are bound to the live
// player (partitioned cookies + PNG wrapper). net.request / in-page fetch
// always 502 or CORS-fail. Do not treat these as downloadable unless the
// player hook already captured at least one part. Leave megacloud/Aniwave
// alone — those still download through the normal session path.
function isPlayerBoundCdn(url, embedUrl) {
  return /peakstorm\.|vidfast\./i.test(`${url || ''} ${embedUrl || ''}`);
}

function looksLikeSegment(buf) {
  if (!buf || buf.length < 200) return false;
  if (isPng(buf)) return true;
  return buf[0] === 0x47;
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
    const buf = Buffer.from(content || '', base64Encoded ? 'base64' : 'utf8');
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
  if (cdpSegmentCount(wc) > 0) return true;
  try {
    const n = await wc.executeJavaScript('Object.keys(window.__wvdParts || {}).length', true);
    if (Number(n) > 0) return true;
  } catch (e) {
    // ignore
  }
  if (onLog) {
    onLog('Token CDN playlist found, but segments cannot be downloaded from this app; trying next.');
  }
  return false;
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
      maxResourceBufferSize: 50 * 1024 * 1024,
      maxTotalBufferSize: 150 * 1024 * 1024
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
    if (data) chunks.push(part.base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8'));
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

function collectFrames(wc) {
  const out = [];
  const seen = new Set();
  const add = (frame) => {
    if (!frame || seen.has(frame)) return;
    seen.add(frame);
    out.push(frame);
  };
  try {
    add(wc.mainFrame);
    const sub = wc.mainFrame && wc.mainFrame.framesInSubtree;
    if (sub && sub.length) for (const f of sub) add(f);
  } catch (e) {
    // ignore
  }
  const walk = (frame) => {
    add(frame);
    try {
      for (const child of frame.frames || []) walk(child);
    } catch (e) {
      // ignore
    }
  };
  try {
    walk(wc.mainFrame);
  } catch (e) {
    // ignore
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

function fetchScript(url, timeoutMs) {
  return `(async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ${Math.max(4000, timeoutMs - 1000)});
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
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

async function runFetchScript(target, url, { timeoutMs = 60000, signal } = {}) {
  if (!target || (typeof target.isDestroyed === 'function' && target.isDestroyed())) {
    const err = new Error('player window is gone');
    err.status = 0;
    throw err;
  }
  const timeout = Math.max(8000, timeoutMs || 60000);
  let timer;
  const hard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('player fetch timed out')), timeout);
    if (signal) {
      const onAbort = () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    const result = await Promise.race([target.executeJavaScript(fetchScript(url, timeout), true), hard]);
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
  }
}

// Token CDNs (vidfast/peakstorm) bind segment access to the live player page:
// partitioned cookies, CORS, and a short-lived edge token. net.request from the
// main process still 502s even with the sniffed Referer. Fetch from the player
// document so origin + cookies match playback.
async function fetchViaWebContents(wc, url, opts = {}) {
  let last;
  const frames = collectFrames(wc);
  for (const frame of frames) {
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

// session.fetch is Chromium's Fetch API: it enforces CORS and silently drops
// Referer/Origin/User-Agent. Token CDNs (vidfast/peakstorm) then fail every
// segment with net::ERR_FAILED even though the same URL plays in the player.
// electron.net.request uses the session's cookies but is not a web fetch, so
// those headers actually go out.
function fetchBufferViaNet(url, headers, { timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let net;
    let ses;
    try {
      const electron = require('electron');
      const config = require('./config');
      net = electron.net;
      ses = electron.session.fromPartition(config.sessionPartition);
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
    const buf = await fetchBufferViaNet(url, headers, opts);
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
          if (bytes && bytes.length && window.__wvdMse.length < 4000) {
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
    if (window.__wvdHooked) return window.__wvdHooked;
    window.__wvdHooked = 'ok';
    window.__wvdParts = window.__wvdParts || {};
    window.__wvdSeen = window.__wvdSeen || [];
    const keep = (url, buf) => {
      if (url && window.__wvdSeen.length < 40) window.__wvdSeen.push(String(url).slice(0, 120));
      if (!url || !/peakstorm|\\/r6\\/s\\//i.test(String(url))) return;
      if (window.__wvdParts[url]) return;
      try {
        const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
        if (!bytes.length) return;
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
        if (/peakstorm|\\/r6\\/s\\//i.test(url)) {
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
  return /peakstorm|vidfast|\/r6\/|\.m3u8|\/hls\/|\.ts(\?|$)|mp2t|video\/mp4/i.test(String(url || ''));
}

function storeCdpPart(wc, url, buf) {
  if (!wc || !url || !looksLikeSegment(buf)) return;
  if (!wc._cdpParts) wc._cdpParts = new Map();
  wc._cdpParts.set(url, buf);
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
  dbg.on('message', async (_event, method, params) => {
    wc._cdpMsgs = (wc._cdpMsgs || 0) + 1;
    if (method === 'Target.attachedToTarget' && params && params.sessionId) {
      try {
        await dbg.sendCommand('Network.enable', {}, params.sessionId);
      } catch (e) {
        try {
          await dbg.sendCommand('Network.enable', { sessionId: params.sessionId });
        } catch (e2) {
          // ignore
        }
      }
      return;
    }
    if (method === 'Network.responseReceived') {
      const url = params.response && params.response.url;
      if (url && isCdnMediaUrl(url)) wc._cdpPending.set(params.requestId, url);
      return;
    }
    if (method === 'Network.loadingFinished') {
      const url = wc._cdpPending.get(params.requestId);
      if (!url) return;
      wc._cdpPending.delete(params.requestId);
      try {
        const body = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        storeCdpPart(
          wc,
          url,
          Buffer.from(body.body || '', body.base64Encoded ? 'base64' : 'utf8')
        );
      } catch (e) {
        // body already evicted
      }
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const requestId = params.requestId;
    const url = (params.request && params.request.url) || '';
    try {
      const code = params.responseStatusCode || 0;
      if (code >= 200 && code < 400 && isCdnMediaUrl(url)) {
        try {
          const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
          storeCdpPart(
            wc,
            url,
            Buffer.from(body.body || '', body.base64Encoded ? 'base64' : 'utf8')
          );
        } catch (e) {
          // ignore
        }
      }
    } finally {
      try {
        await dbg.sendCommand('Fetch.continueRequest', { requestId });
      } catch (e) {
        // ignore
      }
    }
  });
  try {
    const ready = (async () => {
      if (!dbg.isAttached()) await dbg.attach('1.3');
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Network.enable', {
        maxResourceBufferSize: 50 * 1024 * 1024,
        maxTotalBufferSize: 150 * 1024 * 1024
      });
      try {
        await dbg.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true
        });
      } catch (e) {
        // older Electron
      }
    })();
    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cdp attach timeout')), 2500))
    ]);
    return true;
  } catch (e) {
    wc._cdpTap = false;
    return false;
  }
}

async function installPlayerFetchHook(wc) {
  if (!wc || wc.isDestroyed()) return false;
  installPlayerCdpTap(wc).catch(() => {});
  const source = playerHookScript();
  const inject = () => {
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript(source, true).catch(() => {});
    wc.executeJavaScript(ensureMseHookScript(), true).catch(() => {});
    try {
      for (const frame of collectFrames(wc)) {
        frame.executeJavaScript(source, true).catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  };
  wc.on('dom-ready', inject);
  wc.on('did-finish-load', inject);
  wc.on('did-frame-finish-load', inject);
  return true;
}

async function findAndSeekVideo(wc, time) {
  const frames = collectFrames(wc);
  for (const frame of frames) {
    try {
      const dur = await frame.executeJavaScript(
        `(() => {
          const v = document.querySelector('video');
          if (!v) return null;
          v.muted = true;
          if (${JSON.stringify(time)} != null && ${JSON.stringify(time)} >= 0) v.currentTime = ${Number(time) || 0};
          v.play().catch(() => {});
          return v.duration || 0;
        })()`,
        true
      );
      if (dur != null) return Number(dur) || 0;
    } catch (e) {
      // ignore
    }
  }
  return 0;
}

async function drainMseChunks(wc) {
  const frames = collectFrames(wc);
  const out = [];
  for (const frame of frames) {
    try {
      const batch = await frame.executeJavaScript(
        `(function() {
          const all = window.__wvdMse || [];
          const take = all.splice(0, 20);
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
    const rawPath = path.join(dir, looksLikeSegment(early[0]) ? 'player.ts' : 'player.mp4');
    fs.writeFileSync(rawPath, Buffer.concat(early));
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
      win.setSkipTaskbar(false);
      win.setBounds({ x: 40, y: 40, width: 960, height: 540 });
      win.show();
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

async function watchPlayerSegments(wc, jobs, dir, { signal, onProgress, onLog, drainOnly } = {}) {
  if (!wc || wc.isDestroyed()) throw new Error('player window is gone');
  try {
    if (onLog) onLog(`Player page ${wc.getURL()}`);
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed()) {
      win.showInactive();
      try {
        wc.setBackgroundThrottling(false);
      } catch (e2) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }

  const remaining = new Map(jobs.map((j) => [j.abs, j]));
  const byPath = new Map();
  for (const job of jobs) {
    try {
      byPath.set(new URL(job.abs).pathname, job);
    } catch (e) {
      // ignore
    }
  }
  const written = new Set();
  let done = 0;
  const matchJob = (url) => {
    if (!url) return null;
    if (remaining.has(url)) return remaining.get(url);
    try {
      return byPath.get(new URL(url).pathname) || null;
    } catch (e) {
      return null;
    }
  };

  const hookJs = playerHookScript();

  const drainJs = `(function() {
    const out = window.__wvdParts || {};
    const keys = Object.keys(out);
    const batch = {};
    for (const k of keys.slice(0, 6)) {
      batch[k] = out[k];
      delete out[k];
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
    const dbg = wc.debugger;
    if (!dbg.isAttached()) {
      await Promise.race([
        dbg.attach('1.3'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('attach timeout')), 2000))
      ]);
    }
    if (!wc._cdpFetchOn) {
      dbg.on('message', async (_event, method, params) => {
        wc._cdpMsgs = (wc._cdpMsgs || 0) + 1;
        if (method !== 'Fetch.requestPaused') return;
        const requestId = params.requestId;
        const url = (params.request && params.request.url) || '';
        try {
          const code = params.responseStatusCode || 0;
          if (code >= 200 && code < 400 && isCdnMediaUrl(url)) {
            try {
              const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
              storeCdpPart(
                wc,
                url,
                Buffer.from(body.body || '', body.base64Encoded ? 'base64' : 'utf8')
              );
            } catch (e) {
              // ignore
            }
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
          patterns: [
            { urlPattern: '*peakstorm*', requestStage: 'Response' },
            { urlPattern: '*/r6/*', requestStage: 'Response' }
          ]
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

  const drain = async () => {
    drainCdp();
    await drainPageResources();
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
          if (!job && onLog && done === 0) onLog(`Unmatched player part ${String(url).slice(0, 100)}`);
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
        if (onProgress) onProgress({ received: done, total: jobs.length, percent: done / jobs.length });
      }
    }
  };

  const duration = await findAndSeekVideo(wc, 0);
  if (onLog) {
    onLog(
      `Waiting for the player to fetch ${jobs.length} part(s)` +
        (duration ? ` (video ${Math.round(duration)}s)` : '') +
        '...'
    );
  }

  await drain();
  if (done && onLog) onLog(`Already had ${done} HLS part(s) from the live player.`);
  if (drainOnly) return;

  const started = Date.now();
  let warned = false;
  const deadline = Date.now() + Math.max(180000, (duration || 600) * 400);
  let t = 0;
  const step = 5;
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
              parts: Object.keys(window.__wvdParts || {}).length,
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
      if (onLog) onLog(`No player CDN responses yet; diag=${diag}`);
    }
    await findAndSeekVideo(wc, t);
    await drain();
    t += step;
    if (duration && t > duration + 2) t = 0;
    await new Promise((r) => setTimeout(r, 350));
  }
  await drain();
  if (written.size < jobs.length) {
    throw new Error(`player only yielded ${written.size}/${jobs.length} HLS parts`);
  }
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
  if (viaPlayer) {
    const wc = liveWebContents(playerWebContentsId);
    try {
      await watchPlayerSegments(wc, jobs, dir, {
        signal,
        onProgress,
        onLog,
        drainOnly: !bound
      });
    } catch (e) {
      if (onLog) onLog(`Player capture skipped: ${e.message || e}`);
      if (bound) throw e;
    }
  }
  const remaining = jobs.filter((job) => !fs.existsSync(path.join(dir, job.name)));
  if (remaining.length && remaining.length < jobs.length && onLog) {
    onLog(`Captured ${jobs.length - remaining.length} part(s) from the player; fetching ${remaining.length} more.`);
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
  if (remaining.length) {
    await mapPool(remaining, 2, async (job) => {
      if (signal && signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      let buf = await fetchBufferRetry(job.abs, headers, {
        timeoutMs: 20000,
        signal,
        playerWebContentsId,
        skipPageFetch: true
      });
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
        onProgress({ received: done, total: jobs.length, percent: done / jobs.length });
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
  if (master.status && master.status >= 400) return { ok: false, status: master.status, reason: 'playlist' };
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
  localizePlaylist,
  fetchBuffer,
  stripPngWrapper,
  isPng,
  isTokenCdn,
  isPlayerBoundCdn,
  streamIsDownloadable,
  harvestPlayerMse,
  firstUri,
  looksLikePlaylist,
  installPlayerFetchHook
};
