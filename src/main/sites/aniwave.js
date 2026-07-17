'use strict';

// Site adapter for Aniwave (aniwaves.ru and common mirrors).
// Episode URL shape: https://aniwaves.ru/watch/{slug}/ep-{episode}
//   e.g. https://aniwaves.ru/watch/golden-kamuy-4th-season-79014/ep-13
//
// The dubbed providers seen on this site are Vidplay / BYFMS / DGHG (tried
// left-to-right). If a future layout change breaks detection, set the explicit
// CSS selectors below (dubSelector / subSelector / sourceSelector) - they take
// priority over the text heuristics, which remain as a fallback.
module.exports = {
  id: 'aniwave',
  name: 'Aniwave (aniwaves.ru)',
  match: [/aniwaves?\.ru/i, /\baniwave\b/i],
  dub: {
    dubLabelText: ['dub', 'dubbed', 'english dub'],
    subLabelText: ['sub', 'subbed', 'softsub'],
    knownSourceLabels: ['vidplay', 'byfms', 'dghg', 'filemoon', 'mp4upload', 'streamtape', 'streamwish'],
    // The DUB vs SUB server rows are read directly from the page labels, and the
    // first working DUB server (left-to-right) is used - so discovery is fast.
    sourceWaitMs: 11000,
    pageSettleMs: 2000,
    // This site serves the same provider's dub stream at the same URL with "-dub"
    // appended to the slug (".../show/3/master.m3u8" -> ".../show-dub/3/master.m3u8").
    // When only the bare-slug (sub) stream is detected, we derive this URL and
    // verify it exists over HTTP before downloading - so we never grab the sub.
    dubPathMarker: '-dub',
    // Fill these in once we confirm the exact DOM (optional):
    // dubSelector: '',
    // subSelector: '',
    // sourceSelector: ''
  },
  urlTemplates: ['https://aniwaves.ru/watch/{slug}/ep-{episode}']
};
