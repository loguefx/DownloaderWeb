'use strict';

// Central, tweakable configuration. Because the target sites and their
// dubbed-source providers change over time, the values most likely to need
// adjustment live here in one place.

module.exports = {
  // Persistent Chromium session shared by the visible browser, the offscreen
  // bulk windows, and the network sniffer (so cookies/logins persist).
  sessionPartition: 'persist:web',

  // URL/content patterns the sniffer treats as downloadable media.
  media: {
    // Matched against the request URL (case-insensitive).
    urlPatterns: [/\.m3u8(\?|$)/i, /\.mpd(\?|$)/i, /\.mp4(\?|$)/i],
    // Matched against the response Content-Type header.
    contentTypePatterns: [
      /application\/vnd\.apple\.mpegurl/i,
      /application\/x-mpegurl/i,
      /application\/dash\+xml/i,
      /video\/mp4/i
    ],
    // Subtitle files (used by Sub mode to embed subtitles into the .mp4).
    subtitlePatterns: [/\.vtt(\?|$)/i, /\.srt(\?|$)/i, /\.ass(\?|$)/i],
    // Hosts to ignore (ad/analytics media that is never the real video).
    ignoreHosts: [/doubleclick\.net/i, /googlesyndication\.com/i, /google-analytics\.com/i]
  },

  // In-page automation hints for selecting the DUB version and trying each
  // dubbed source provider in turn. These are heuristics with text fallbacks
  // so they survive most layout changes; adjust if a site differs.
  dub: {
    // Text shown on the DUB toggle.
    dubLabelText: ['dub', 'dubbed', 'english dub'],
    // Text shown on the SUB toggle (used to locate the toggle group).
    subLabelText: ['sub', 'subbed', 'subtitle'],
    // Known provider button labels (order here is only a hint; on-page,
    // left-to-right order is what actually decides priority).
    knownSourceLabels: ['vidplay', 'byfms', 'dghg', 'filemoon', 'mp4upload', 'streamtape'],
    // How long to wait (ms) for a source to produce a sniffable stream.
    sourceWaitMs: 12000,
    // How long to wait (ms) for the episode page itself to settle.
    pageSettleMs: 2500,
    // Many sites encode the audio in the stream URL path (e.g. ".../show-dub/"
    // vs ".../show-sub/"). These patterns let us VERIFY the resolved stream
    // actually matches the requested audio, and reject a mismatched one. A URL
    // matching neither is treated as neutral (accepted, trusting the click).
    modeHints: {
      dub: [/[-_/]dub([-_/.]|$)/i, /\bdubbed\b/i],
      sub: [/[-_/]sub([-_/.]|$)/i, /\bsubbed\b/i]
    }
  },

  // Mullvad VPN monitoring.
  vpn: {
    enabled: true,
    checkUrl: 'https://am.i.mullvad.net/json',
    pollIntervalMs: 4000,
    requestTimeoutMs: 6000,
    useCliFallback: true // try `mullvad status` if the HTTP check is inconclusive
  },

  // Download behaviour.
  download: {
    // How many episodes to download at the same time.
    concurrency: 5,
    maxRetries: 3,
    retryBaseDelayMs: 2000,
    // Minimum acceptable output size (bytes) before a file is considered real.
    minFileBytes: 64 * 1024,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  }
};
