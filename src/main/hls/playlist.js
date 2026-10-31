'use strict';

// HLS playlist parsing (pure: no Electron, no network). Moved out of
// hlscheck.js unchanged; hlscheck re-exports every name.

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

function bestVariantInfo(playlist, base) {
  const lines = String(playlist || '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const wantAudio = bestAudioGroupId(playlist);
  let best = null;
  let bestScore = -1;
  let bestInfo = null;
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
      bestInfo = info;
    }
  }
  if (!best || !bestInfo) return null;
  let uri = best;
  try {
    uri = new URL(best, base).toString();
  } catch (e) {
    // keep the playlist-relative URI
  }
  return { h: bestInfo.h || 0, w: bestInfo.w || 0, uri };
}

function bestVariantUri(playlist, base) {
  const info = bestVariantInfo(playlist, base);
  const pick = (info && info.uri) || firstUri(playlist);
  if (!pick) return null;
  try {
    return new URL(pick, base).toString();
  } catch (e) {
    return pick;
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

module.exports = {
  firstUri,
  looksLikePlaylist,
  isMasterPlaylist,
  isMediaPlaylist,
  playlistPathname,
  playlistFromBuffer,
  looksLikeHtml,
  looksLikeJson,
  parseStreamInf,
  variantScore,
  bestAudioGroupId,
  bestVariantInfo,
  bestVariantUri,
  trimMasterToBest,
  playlistMediaDuration,
  mediaPlaylistScore,
  describeMediaPlaylist,
  rewritePlaylistUris,
  notPlaylistError
};
