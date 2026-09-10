'use strict';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Site adapter for SFlix on soap2day.day (and the sflixz.day mirror).
//
// This is a WordPress/DooPlay catalog, NOT the old PHP sflix.to clone:
//   series  https://sflix.soap2day.day/series/{slug}/
//   episode https://sflix.soap2day.day/episodes/{slug}-season-{season}-episode-{episode}/
//   movie   https://sflix.soap2day.day/{slug}/
//
// There are no SUB/DUB rows. Servers are ".player-tab-btn" buttons labelled
// Server 1..N, each carrying data-player-url to a third-party embed
// (vidapi / vidfast / embedmaster / multiembed / nontongo). Clicking the
// play poster (or a server tab) points #main-player at that URL.
//
// Existing Aniwave/Enma/FilmeHD profiles are untouched; this file is picked
// up automatically by sites/index.js.

module.exports = {
  id: 'sflix',
  name: 'SFlix (sflix.soap2day.day)',
  match: [/sflix\.soap2day\.day/i, /soap2day\.day/i, /\bsflixz\.day\b/i],

  dub: {
    // No audio-row toggles — empty so the scanner does not invent SUB/DUB.
    dubLabelText: [],
    subLabelText: [],
    knownSourceLabels: [
      'server 1',
      'server 2',
      'server 3',
      'server 4',
      'server 5',
      'server 6',
      'server 7',
      'server 8',
      'vidapi',
      'vidfast',
      'embedmaster',
      'multiembed',
      'nontongo',
      'filemoon',
      'streamtape',
      'doodstream'
    ],
    sourceSelector: '.player-tab-btn',
    sourceWaitMs: 14000,
    pageSettleMs: 3000,
    // vidapi never yields a playlist. embedmaster is blob/Turnstile offscreen;
    // multiembed is Cloudflare. Windows skips vidfast (segments are not
    // fetchable from Node) and uses NontonGo progressive MP4 at 5-wide.
    // Linux NontonGo/EmbedFlix never requests /_stream (nested Cloudflare
    // iframe), so skip it and capture Vidfast. Each episode gets its own
    // Chromium partition so five live players can run without sharing tokens.
    maxSources: 5,
    skipEmbedHosts: [
      /vidapi\./i,
      ...(process.platform === 'win32' ? [/vidfast\./i] : [/nontongo/i]),
      /embedmaster\.|embdmstrplayer/i,
      /multiembed\.|streamingnow\.mov/i
    ],
    preferEmbedHosts: process.platform === 'win32' ? [/nontongo/i] : [],
    deferEmbedHosts: []
  },

  // NontonGo MP4 downloads like Windows: 5 files at once, prefetch the next
  // episode. Vidfast token-CDN capture is serialized in the queue so overlapping
  // live players cannot spend one-shot /s/ tokens.
  download: {
    concurrency: 5,
    prefetchDiscover: 1
  },

  urlTemplates: [
    'https://sflix.soap2day.day/series/{slug}/#ep-{episode}',
    'https://sflix.soap2day.day/episodes/{slug}-season-{season}-episode-{episode}/',
    'https://sflix.soap2day.day/episodes/{slug}-s{season2}e{episode2}/',
    'https://sflix.soap2day.day/{slug}/#ep-{episode}'
  ],

  // Never invent /episodes/{slug}-s01e02-{other-episode-title}/ URLs. Those
  // pages have no player. Bulk must use the real Watch hrefs from this scan.
  inventEpisodeUrls: false,

  // Keep a real /series/{slug}/ URL. Do not invent one from an episode slug:
  // Watch paths omit the random series suffix (…-8knav), and
  // /series/the-epic-tales-of-captain-underpants/ is the wrong page (Cloudflare).
  // detectEpisodes follows the on-page series breadcrumb instead.
  catalogUrl(pageUrl) {
    try {
      const u = new URL(String(pageUrl || ''));
      if (/\/series\//i.test(u.pathname) && !/\/series\/?$/i.test(u.pathname)) {
        return `${u.origin}${u.pathname.replace(/\/?$/, '/')}`;
      }
    } catch (e) {
      // ignore
    }
    return pageUrl;
  },

  // Collects the real Watch hrefs. SFlix uses two path shapes on the same site
  // (`season-1-episode-12` AND `s01e01-title-slug`). Season tabs are clicked
  // first; detectEpisodes retries while the list hydrates.
  episodeScan({ season } = {}) {
    const prefer = season != null && season !== '' && !isNaN(parseInt(season, 10))
      ? String(parseInt(season, 10))
      : '';
    return `(() => {
    const add = (set, v) => { const n = parseInt(v, 10); if (n > 0 && n < 100000) set.add(n); };
    const seasonOf = (v) => { const n = parseInt(v, 10); return n > 0 ? String(n) : ''; };
    const href = location.href || '';
    const fromSeasonPath = href.match(/season[-_](\\d+)/i);
    const fromSxe = href.match(/[sS](\\d{1,2})[eE]\\d{1,3}/);
    const activeTab = document.querySelector('.season-tab-btn.active, [data-season].active');
    // Never use the hero player poster season. On this show the poster stays
    // on Season 3 even while the Season 1 tab is selected, which made Season 1
    // batches scan (or skip) Season 3 instead.
    const want = ${JSON.stringify(prefer)} ||
      seasonOf(fromSeasonPath && fromSeasonPath[1]) ||
      seasonOf(fromSxe && fromSxe[1]) ||
      seasonOf(activeTab && activeTab.getAttribute('data-season')) ||
      '1';
    const tab = document.querySelector(
      '.season-tab-btn[data-season="' + want + '"], a.season-tab-btn[data-season="' + want + '"]'
    );
    if (tab && !/\\bactive\\b/.test(tab.className || '')) {
      try { tab.click(); } catch (e) {}
    } else if (!tab) {
      const reTab = new RegExp('^(season|sezonul)?\\\\s*' + want + '$', 'i');
      const nodes = document.querySelectorAll('.season-tab-btn, [data-season], .se-q, #seasons a, button');
      for (const el of nodes) {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!reTab.test(t)) continue;
        try { el.click(); } catch (e) {}
        break;
      }
    }
    const nums = new Set();
    const urls = {};
    const wantPad = want.length < 2 ? ('0' + want) : want;
    const reSeason = new RegExp('season[-_]' + want + '[-_]episode[-_](\\\\d+)', 'i');
    const reSxe = new RegExp('[sS](?:' + want + '|' + wantPad + ')[eE](\\\\d{1,3})');
    const consider = (h) => {
      if (!h || /\\/episodes\\/?$/i.test(h)) return;
      let abs = h;
      try { abs = new URL(h, location.href).href; } catch (e) {}
      const m = abs.match(reSeason) || abs.match(reSxe);
      if (!m) return;
      const ep = parseInt(m[1], 10);
      if (!ep) return;
      add(nums, ep);
      if (!urls[ep]) urls[ep] = abs;
    };
    document.querySelectorAll(
      'a[href*="/episodes/"], .episodios a, [class*="episodi"] a, #seasons a, .se-c a, [data-link*="/episodes/"]'
    ).forEach((a) => {
      consider(a.href || a.getAttribute('href') || a.getAttribute('data-link') || '');
    });
    const html = (document.documentElement && document.documentElement.innerHTML) || '';
    const hrefRe = /(?:https?:\\/\\/[^"'\\s]+)?\\/episodes\\/[^"'\\s<>]+/gi;
    let hm;
    while ((hm = hrefRe.exec(html))) consider(hm[0]);
    document.querySelectorAll('[data-episode], [data-nume]').forEach((el) => {
      const s = seasonOf(el.getAttribute('data-season'));
      if (s && s !== want) return;
      const ep = parseInt(el.getAttribute('data-episode') || el.getAttribute('data-nume'), 10);
      if (!ep) return;
      const a = el.closest('a') || el.querySelector('a');
      const h = (a && (a.href || a.getAttribute('href'))) || '';
      add(nums, ep);
      if (h) consider(h);
    });
    // Do not add the current Watch URL until the series list is empty. A single
    // s01e01 match used to set aired=1 and stop bulk after episode 1.
    const currentOnly = !nums.size;
    if (currentOnly) {
      const curSxe = href.match(/[sS](\\d{1,2})[eE](\\d{1,3})/);
      const curSe = href.match(/season[-_](\\d+)[-_]episode[-_](\\d+)/i);
      if (curSxe && seasonOf(curSxe[1]) === want) {
        add(nums, curSxe[2]);
        urls[parseInt(curSxe[2], 10)] = href;
      } else if (curSe && seasonOf(curSe[1]) === want) {
        add(nums, curSe[2]);
        urls[parseInt(curSe[2], 10)] = href;
      }
    }
    let catalog = '';
    if (/\\/series\\/[^/]+/i.test(href) && !/\\/series\\/?$/i.test(href)) {
      catalog = href;
    } else {
      const canon = document.querySelector('link[rel="canonical"], meta[property="og:url"]');
      const extra = canon && (canon.href || canon.getAttribute('href') || canon.getAttribute('content'));
      const seriesLinks = document.querySelectorAll(
        'a[href*="/series/"], .breadcrumb a, #single .data a, h1 a, .sbox a, .poster a, .film-poster a'
      );
      const candidates = extra ? [extra] : [];
      seriesLinks.forEach((a) => candidates.push(a.href || a.getAttribute('href') || ''));
      for (const h of candidates) {
        if (!/\\/series\\/[^/?#]+/i.test(h) || /\\/series\\/?(?:[?#]|$)/i.test(h)) continue;
        try { catalog = new URL(h, location.href).href; } catch (e) { catalog = h; }
        break;
      }
    }
    const list = Array.from(nums).sort((a, b) => a - b);
    return {
      list,
      max: list.length ? list[list.length - 1] : 0,
      aired: list.length > 1 ? list.length : 0,
      total: list.length > 1 ? list.length : 0,
      urls,
      season: parseInt(want, 10),
      catalog,
      currentOnly
    };
  })()`;
  },

  async beforeResolve(wc, { onLog }) {
    const info = await wc
      .executeJavaScript(
        `(() => {
          const poster = document.querySelector('#player-poster, .player-poster');
          const tabs = Array.from(document.querySelectorAll('.player-tab-btn'));
          const iframe = document.querySelector('#main-player, .player-frame__iframe, iframe');
          const src = (iframe && (iframe.src || iframe.getAttribute('src'))) || '';
          const firstUrl = (tabs[0] && tabs[0].getAttribute('data-player-url')) ||
            (poster && poster.getAttribute('data-player-url')) || '';
          if (poster) {
            try { poster.click(); } catch (e) {}
          }
          if (iframe && firstUrl && (!src || src.indexOf(location.hostname) !== -1)) {
            iframe.src = firstUrl;
          }
          return {
            servers: tabs.length,
            poster: !!poster,
            embed: firstUrl
          };
        })()`,
        true
      )
      .catch(() => null);

    if (info && info.servers) {
      onLog(
        `SFlix: ${info.servers} server tab(s)` +
          (info.embed ? `; primed player ${info.embed}` : '') +
          '.'
      );
      await delay(800);
    } else {
      onLog('SFlix: no server tabs yet; scanner will retry.');
    }
  }
};
