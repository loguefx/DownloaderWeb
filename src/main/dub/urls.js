'use strict';

// URL helpers for dub/sub discovery: embed URLs, nested player pages, hop
// shells, server ranking, master-variant choice (pure). Moved out of
// dubselect.js unchanged.

// Builds the DUB variant of a detected (sub) stream URL by inserting the site's
// audio marker into the slug segment that precedes the episode number, e.g.
//   ".../seihantai-na-kimi-to-boku/3/master.m3u8"
//     -> ".../seihantai-na-kimi-to-boku-dub/3/master.m3u8"
// Returns null if the URL doesn't fit the pattern or already contains the marker.
function dubVariantUrl(url, marker) {
  if (!url || !marker) return null;
  if (url.toLowerCase().includes(marker.toLowerCase())) return url;
  const re = /\/([a-z0-9][a-z0-9-]*?)\/(\d+)\//i;
  if (!re.test(url)) return null;
  return url.replace(re, (m, slug, ep) => `/${slug}${marker}/${ep}/`);
}

function isBrokenEmbed(src) {
  return /https?:\/\/undefined\b/i.test(src || '');
}

// A real player embed lives on another host. Same-origin iframe src (SFlix
// parks #main-player on the episode URL until Play is clicked) is a placeholder
// and must not count as "the player loaded".
function isOffsiteEmbed(src, originHost) {
  if (!src || !/^https?:\/\//i.test(src) || isBrokenEmbed(src)) return false;
  try {
    const host = new URL(src).hostname;
    if (!host) return false;
    if (originHost && host === originHost) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function embedMatchesClick(embed, afterTs, linkId) {
  if (!embed || !embed.url) return false;
  if (linkId) {
    const api = String(embed.apiUrl || '');
    const m = api.match(/[?&]id=([^&]+)/i);
    if (!m) return false;
    try {
      return decodeURIComponent(m[1]) === String(linkId);
    } catch (e) {
      return m[1] === String(linkId);
    }
  }
  return !afterTs || (embed.ts && embed.ts >= afterTs - 80);
}

const NESTED_PLAYER_RE =
  /embedflix|videoplayback\.php|nextgencloudfabric|cloudfabric|videm\.xyz|filemoon|mixdrop|streamwish|megacloud|rabbitstream|vidcloud|upcloud|vidfast|vidplay|mcloud|streamtape|doodstream|filelions|voe\.sx|upstream|vtube|playerwish|vidsrc|2embed/i;

const NESTED_AD_RE =
  /youtube|youtu\.be|google|gstatic|facebook|doubleclick|adsco|adx|cloudflareinsights|googlesyndication|imasdk|adnxs|taboola|outbrain|challenges\.cloudflare/i;

function absolutizeUrl(u, base) {
  const s = String(u || '').trim();
  if (!s || /javascript:/i.test(s)) return '';
  try {
    return new URL(s, base || 'https://embedflix.win/').href;
  } catch (e) {
    return s;
  }
}

function pageKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch (e) {
    return String(url || '');
  }
}

function isRealPlayerPage(url) {
  const u = String(url || '');
  return /videoplayback\.php|player\.embedflix|nextgencloud|cloudfabric/i.test(u);
}

function pickNestedPlayerUrl(urls, currentUrl) {
  // videoplayback.php / player.embedflix already host the working iframe
  // (nextgencloudfabric 404s as a top-level page). Hopping one more time
  // dropped the referrer chain and Linux never saw /_stream.
  if (isRealPlayerPage(currentUrl)) return null;
  const here = pageKey(currentUrl);
  const httpsUrls = (urls || [])
    .map((u) => absolutizeUrl(u, currentUrl))
    .filter((u) => {
      if (!/^https?:/i.test(u) || /nontongo/i.test(u)) return false;
      if (/nextgencloudfabric|cloudfabric/i.test(u)) return false;
      return pageKey(u) !== here;
    });
  const ranked = [/videoplayback\.php/i, /player\.embedflix/i, NESTED_PLAYER_RE];
  for (const re of ranked) {
    const hit = httpsUrls.find((u) => re.test(u) && !NESTED_AD_RE.test(u));
    if (hit) return hit;
  }
  return httpsUrls.find((u) => !NESTED_AD_RE.test(u));
}

function isHopShell(url) {
  const u = String(url || '');
  if (isRealPlayerPage(u)) return false;
  return /nontongo/i.test(u) || /embedflix\.win\/embed\//i.test(u);
}

function isVidapiShell(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./i, '');
    return host === 'vidapi.xyz';
  } catch (e) {
    return false;
  }
}

function vidapiDownstream(dataSrc) {
  let u;
  try {
    u = new URL(String(dataSrc || ''));
  } catch (e) {
    return '';
  }
  const host = u.hostname.replace(/^www\./i, '');
  if (host !== 'stream.vidapi.xyz') {
    if (/embedmaster\.|embdmstrplayer|multiembed\.|streamingnow\.mov|nontongo/i.test(String(dataSrc || ''))) {
      return '';
    }
    return /^https?:/i.test(String(dataSrc || '')) ? String(dataSrc) : '';
  }
  const tmdb = u.searchParams.get('tmdb') || '';
  const season = u.searchParams.get('s') || '';
  const episode = u.searchParams.get('e') || '';
  if (!/^\d+$/.test(tmdb)) return '';
  const id = season && episode ? `${tmdb}/${season}/${episode}` : tmdb;
  const routes = [
    [/\/xps-tv\b/i, `https://videm.xyz/embed/tv/${id}`],
    [/\/vnest-tv\b/i, `https://cineby.hair/tv/${id}`],
    [/\/vcr-tv\b/i, `https://vidcore.net/tv/${id}`],
    [/\/vesy-tv\b/i, `https://player.videasy.to/tv/${id}`],
    [/\/vsrcc-tv\b/i, `https://vidsrc.cc/v2/embed/tv/${id}`],
    [/\/vsrc-tv\b/i, `https://vsembed.ru/embed/tv/${id}`],
    [/\/vpls-tv\b/i, `https://peachify.top/embed/tv/${id}`]
  ];
  const hit = routes.find(([re]) => re.test(u.pathname));
  return hit ? hit[1] : '';
}

function urlsHaveInPagePlayer(urls, base) {
  return (urls || []).some((u) =>
    /nextgencloudfabric|cloudfabric|player\.embedflix|videoplayback\.php/i.test(absolutizeUrl(u, base))
  );
}

function rankSource(src, dub) {
  const u = `${src.playerUrl || ''} ${src.label || ''}`;
  const prefer = dub.preferEmbedHosts || [];
  const defer = dub.deferEmbedHosts || [];
  if (prefer.some((re) => re && re.test(u))) return 0;
  if (defer.some((re) => re && re.test(u))) return 2;
  return 1;
}

function orderTryList(tryList, dub) {
  return [...tryList].sort((a, b) => rankSource(a, dub) - rankSource(b, dub));
}

// Highest-resolution variant of a master playlist, as an absolute URL.
function bestMasterVariant(text, base) {
  const lines = String(text).split(/\r?\n/);
  let best = null;
  let bestH = -1;
  let bestBw = -1;
  let pending = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (/^#EXT-X-STREAM-INF:/i.test(t)) {
      const res = t.match(/RESOLUTION=\d+x(\d+)/i);
      const bw = t.match(/BANDWIDTH=(\d+)/i);
      pending = { h: res ? parseInt(res[1], 10) : 0, bw: bw ? parseInt(bw[1], 10) : 0 };
    } else if (t && !t.startsWith('#') && pending) {
      if (pending.h > bestH || (pending.h === bestH && pending.bw > bestBw)) {
        bestH = pending.h;
        bestBw = pending.bw;
        best = t;
      }
      pending = null;
    }
  }
  if (!best) return null;
  try {
    return new URL(best, base).toString();
  } catch (e) {
    return best;
  }
}

module.exports = {
  dubVariantUrl,
  isBrokenEmbed,
  isOffsiteEmbed,
  embedMatchesClick,
  NESTED_PLAYER_RE,
  NESTED_AD_RE,
  absolutizeUrl,
  pageKey,
  isRealPlayerPage,
  pickNestedPlayerUrl,
  isHopShell,
  isVidapiShell,
  vidapiDownstream,
  urlsHaveInPagePlayer,
  rankSource,
  orderTryList,
  bestMasterVariant
};
