'use strict';

// Site adapter for Enma (enma.lol) and other HiAnime / AniWatch-style players.
// Episode URL shape: https://www.enma.lol/watch/{slug}?ep={episode}
//   e.g. https://www.enma.lol/watch/the-ramparts-of-ice-186497?ep=8
//
// Unlike aniwave, the SUB/DUB servers here are rendered as ".server-item"
// buttons, each carrying an explicit data-type="sub" | "dub" attribute. The
// scanner in dubselect keys off that attribute (authoritative, no geometry), so
// the audio can never be mixed up. Server names are HD-1/HD-2/etc. rather than
// provider brands, so knownSourceLabels lists those too.
module.exports = {
  id: 'enma',
  name: 'Enma (enma.lol / HiAnime-style)',
  match: [/\benma\.lol\b/i, /\benma\b/i],
  dub: {
    dubLabelText: ['dub', 'dubbed', 'english dub'],
    subLabelText: ['sub', 'subbed', 'softsub', 'raw'],
    knownSourceLabels: ['hd-1', 'hd-2', 'hd-3', 'megacloud', 'vidstreaming', 'vidcloud', 'streamtape', 'streamsb', 'vidplay'],
    // The server buttons (each tagged with data-type="sub|dub"). If the markup
    // changes, dubselect still falls back to its text/geometry heuristics.
    sourceSelector: '.server-item, [data-type="sub"], [data-type="dub"]',
    sourceWaitMs: 12000,
    pageSettleMs: 2500
    // No dubPathMarker: streams are tokenised (megacloud); the data-type on the
    // clicked server button is what proves the audio, not the stream URL.
  },
  urlTemplates: ['https://www.enma.lol/watch/{slug}?ep={episode}']
};
