'use strict';

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
  if (!looksLikePlaylist(master.body)) return { ok: true, status: master.status }; // not HLS / timed out, leave it

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

module.exports = { bodyReachable };
