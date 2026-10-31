'use strict';

// CDN classification: token CDNs, player-bound CDNs, one-shot playlists,
// VOD (pure). Moved out of hlscheck.js unchanged; hlscheck re-exports every name.

const CDN_PATH_RE = /\/r6\/|\/r2\/|\/vd\//i;

function isTokenCdn(url, embedUrl) {
  const s = `${url || ''} ${embedUrl || ''}`;
  if (/peakstorm\.|vidfast\.|megacloud\.|rabbitstream\.|vidcloud/i.test(s)) return true;
  // SFlix/vidspark route their HLS through a Cloudflare Worker proxy that 403s
  // the bare/FFmpeg client but 200s the in-browser session. netoda (playlist)
  // and voxzer (segments) are the real hosts behind it, so pull them through
  // the same Chromium "localize" download path as the token CDNs.
  return /netoda\.|voxzer\.|\.workers\.dev\/\?url=/i.test(s);
}

// Vidfast/peakstorm playlists resolve, but Node/net.request cannot pull the
// parts (partitioned cookies). The live player can. One-shot `/s/` tokens die
// if anything besides playback fetches them. `/vd/` and `/r2/` are VOD: the
// player page/worker can fetch remaining segments without burning a token.
function isPlayerBoundCdn(url, embedUrl) {
  const s = `${url || ''} ${embedUrl || ''}`;
  if (CDN_PATH_RE.test(s)) return true;
  return /peakstorm\.|vidfast\.|ashencloud\.|ashenlion\.|orbitnorth\.|hiddenmesa\.|solidbear\.|primecomet\.|calmcanvas\.|nobleember\.|plainorbit\.|nobletrail\.|rapidtree\.|metaldisk\.|thunderpencil\.|pearlmaple\.|novaoak\.|netocdn\./i.test(
    s
  );
}

// `/s/` tokens are spent by the first non-playback request. They are not always
// hex: `/r6/s/ma9yIsUHLd1o…` is base64url, and treating those as VOD made the
// main process refetch a spent token and get 400 on every segment.
function isOneShotHls(url) {
  const s = String(url || '');
  if (/\/vd\/|\/r2\//i.test(s)) return false;
  // Vidfast now serves these from moon.zenoak.top (and similar), not only
  // peakstorm. Any /s/ token dies if something other than playback fetches it.
  return /\/s\/[A-Za-z0-9_-]{6,}/.test(s);
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

module.exports = {
  CDN_PATH_RE,
  isTokenCdn,
  isPlayerBoundCdn,
  isOneShotHls,
  isVodHls
};
