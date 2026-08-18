'use strict';

const http = require('http');
const https = require('https');

// BYFMS (and similar) will happily serve a master playlist whose first media
// segment is a 20-minute stub that 502s. ffmpeg then copies the leftover 45s of
// tail segments, exits 0, and we used to hand that to the queue as a "success"
// that immediately failed verification / truncation checks — download, then
// resolve, forever.

function request(url, headers, { method = 'GET', maxBytes = 0, timeoutMs = 8000, redirectsLeft = 4 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return resolve({ status: 0, body: '', url });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const h = { ...(headers || {}) };
    const req = lib.request(
      url,
      { method, headers: h, timeout: timeoutMs },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return request(new URL(res.headers.location, url).toString(), headers, {
            method,
            maxBytes,
            timeoutMs,
            redirectsLeft: redirectsLeft - 1
          }).then(resolve);
        }
        if (maxBytes <= 0) {
          res.resume();
          return resolve({ status: code, body: '', url });
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
            req.destroy();
          }
        });
        res.on('end', () => resolve({ status: code, body: Buffer.concat(chunks).toString('utf8'), url }));
        res.on('error', () => resolve({ status: code, body: Buffer.concat(chunks).toString('utf8'), url }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', url });
    });
    req.on('error', () => resolve({ status: 0, body: '', url }));
    req.end();
  });
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
async function bodyReachable(url, headers) {
  const h = { ...(headers || {}) };
  if (!Object.keys(h).some((k) => k.toLowerCase() === 'user-agent')) {
    h['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  }

  const master = await request(url, h, { maxBytes: 16000 });
  if (master.status && master.status >= 400) return { ok: false, status: master.status, reason: 'playlist' };
  if (!looksLikePlaylist(master.body)) return { ok: true, status: master.status }; // not HLS, leave it

  let media = master.body;
  let mediaUrl = url;
  if (!/#EXTINF:/i.test(media)) {
    const variant = firstUri(media);
    if (!variant) return { ok: false, status: master.status, reason: 'no-variant' };
    mediaUrl = new URL(variant, url).toString();
    const v = await request(mediaUrl, h, { maxBytes: 32000 });
    if (v.status && v.status >= 400) return { ok: false, status: v.status, reason: 'variant' };
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
  const peek = await request(segUrl, { ...h, Range: 'bytes=0-1023' }, { maxBytes: 2048 });
  if (!peek.status || peek.status >= 400) {
    return { ok: false, status: peek.status, reason: 'segment' };
  }
  return { ok: true, status: peek.status };
}

module.exports = { bodyReachable };
