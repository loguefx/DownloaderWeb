'use strict';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const catalog = require('./aniwave_api');

// Site adapter for Aniwave (aniwaves.ru and common mirrors).
// Episode URL shape: https://aniwaves.ru/watch/{slug}/ep-{episode}
//   e.g. https://aniwaves.ru/watch/golden-kamuy-4th-season-79014/ep-13
//
// The dubbed providers seen on this site are Vidplay / BYFMS / DGHG (tried
// left-to-right). If a future layout change breaks detection, set the explicit
// CSS selectors below (dubSelector / subSelector / sourceSelector) - they take
// priority over the text heuristics, which remain as a fallback.
//
// Player load path (from site JS): click li[data-link-id] ->
//   GET /ajax/sources?id=<link-id> -> iframe.src = result.url
// The sniffer must capture that ajax/sources call. A DUB also exists at
//   /watch/{slug}/episode/{n}?source=dub  (and servers are tagged data-type=dub).
module.exports = {
  id: 'aniwave',
  name: 'Aniwave (aniwaves.ru)',
  match: [/aniwaves?\.ru/i, /\baniwave\b/i],
  dub: {
    dubLabelText: ['dub', 'dubbed', 'english dub'],
    subLabelText: ['sub', 'subbed', 'softsub'],
    knownSourceLabels: ['vidplay', 'byfms', 'dghg', 'filemoon', 'mp4upload', 'streamtape', 'streamwish'],
    // Measured live (Link Click S3, Oct 2026): "MyCloud" sits in the DUB row
    // but streams the ORIGINAL audio (tagged chi); Vidplay/BYFMS/DGHG serve
    // the real "-dub" stream. Try it last.
    deferEmbedHosts: [/mycloud/i],
    // Authoritative: each provider is an <li> under .servers .type[data-type=sub|dub].
    sourceSelector: '.servers .type li, #w-servers li[data-link-id], #w-servers li[data-sv-id]',
    sourceWaitMs: 14000,
    pageSettleMs: 3500,
    // This site serves the same provider's dub stream at the same URL with "-dub"
    // appended to the slug (".../show/3/master.m3u8" -> ".../show-dub/3/master.m3u8").
    // When only the bare-slug (sub) stream is detected, we derive this URL and
    // verify it exists over HTTP before downloading - so we never grab the sub.
    dubPathMarker: '-dub'
  },
  urlTemplates: ['https://aniwaves.ru/watch/{slug}/ep-{episode}'],
  // Cross-site fallback for ANIME: tried right after Vidsrc (rank 0). It is
  // the source that actually has English dubs where Vidsrc only streams the
  // Japanese track (e.g. Solo Leveling S1: Vidsrc dub E1-E2, Aniwave E1-E12).
  fallbackRank: 1,

  // Finds the episode page through Aniwave's own catalog (plain HTTP, no
  // browser). Anime only. In DUB mode only an episode Aniwave flags as
  // dubbed is returned (and SUB mode needs a sub); the page's DUB server row
  // is then picked by beforeResolve + the scanner as usual.
  async findTitle(ref, _hooks, onLog = () => {}) {
    if (!ref || !ref.anime || !ref.title) return null;
    const season = Number(ref.displaySeason != null ? ref.displaySeason : ref.season) || 1;
    const episode = Number(ref.displayEpisode != null ? ref.displayEpisode : ref.episode);
    if (!(episode > 0)) return null;
    const info = await catalog.seasonInfo(ref.title, season);
    if (!info) {
      onLog(`No Aniwave entry for "${ref.title}" season ${season}.`);
      return null;
    }
    const ep = info.episodes.find((e) => e.episode === episode);
    if (!ep) {
      onLog(`Aniwave's "${info.show.title}" has no episode ${episode} (yet).`);
      return null;
    }
    const wantDub = ref.mode !== 'sub';
    if (wantDub && !ep.dub) {
      onLog(`Aniwave has no English dub for "${info.show.title}" E${episode} yet.`);
      return null;
    }
    if (!wantDub && !ep.sub) {
      onLog(`Aniwave has no subbed copy of "${info.show.title}" E${episode} yet.`);
      return null;
    }
    return catalog.episodeUrl(info.show, episode);
  },
  // Anime uses flat episode numbers (season is baked into the slug). When the
  // episode list can't be detected, never invent a 1-12 range: that would
  // queue episodes that may not exist (or re-queue ones already on disk) and
  // is exactly the "duplicate / re-adjusted" failure we must not produce. A
  // failed detection logs and queues nothing instead.
  inventEpisodeUrls: false,

  async beforeResolve(wc, { mode, onLog }) {
    const want = mode === 'sub' ? 'sub' : 'dub';
    for (let i = 0; i < 12; i++) {
      const info = await Promise.race([
        wc.executeJavaScript(
          `(() => {
            try { document.cookie = 'prefered_server_type=${want};path=/;max-age=86400'; } catch (e) {}
            const row = document.querySelector('.servers .type[data-type="${want}"], #w-servers .type[data-type="${want}"]');
            const otherType = '${want}' === 'dub' ? 'sub' : 'dub';
            const other = document.querySelector('.servers .type[data-type="' + otherType + '"], #w-servers .type[data-type="' + otherType + '"]');
            const lis = row ? row.querySelectorAll('li[data-link-id], li') : [];
            return { hasRow: !!row, servers: lis.length, otherRow: !!other, otherType };
          })()`,
          true
        ),
        delay(2000).then(() => null)
      ]).catch(() => null);
      if (info && info.hasRow && info.servers > 0) {
        onLog(`Aniwave ${want.toUpperCase()} servers ready (${info.servers} button(s)).`);
        return;
      }
      if (info && !info.hasRow && info.otherRow && i >= 5) {
        onLog(`Aniwave has no ${want.toUpperCase()} row (only ${String(info.otherType || 'other').toUpperCase()} servers).`);
        return;
      }
      await delay(400);
    }
    onLog(`Aniwave ${want.toUpperCase()} server row still empty after wait; scanner will retry.`);
  }
};
