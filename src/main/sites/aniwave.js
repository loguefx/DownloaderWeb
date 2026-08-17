'use strict';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async beforeResolve(wc, { mode, onLog }) {
    const want = mode === 'sub' ? 'sub' : 'dub';
    for (let i = 0; i < 12; i++) {
      const info = await wc
        .executeJavaScript(
          `(() => {
            try { document.cookie = 'prefered_server_type=${want};path=/;max-age=86400'; } catch (e) {}
            const row = document.querySelector('.servers .type[data-type="${want}"], #w-servers .type[data-type="${want}"]');
            const lis = document.querySelectorAll('#w-servers li[data-link-id], .servers .type li');
            return { hasRow: !!row, servers: lis.length };
          })()`,
          true
        )
        .catch(() => null);
      if (info && info.servers > 0) {
        onLog(`Aniwave ${want.toUpperCase()} servers ready (${info.servers} button(s), row=${info.hasRow ? 'yes' : 'no'}).`);
        return;
      }
      await delay(400);
    }
    onLog(`Aniwave ${want.toUpperCase()} server row still empty after wait; scanner will retry.`);
  }
};
