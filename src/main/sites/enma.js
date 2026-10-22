'use strict';

// Site adapter for Enma (enma.lol) and other HiAnime / AniWatch-style players.
// Episode URL shape: https://www.enma.lol/watch/{slug}?ep={episode}
//   e.g. https://www.enma.lol/watch/the-ramparts-of-ice-186497?ep=8
//
// Enma is a React SPA (Vite bundle, <div id="root">). The server list is NOT
// in the static HTML - it is fetched client-side (servers: [{serverName,
// type, data_id}]) and rendered like this (verified from the live bundle):
//
//   div.sv
//     div.sv__groups
//       div#sv-row-sub.sv__group   <- one per audio type (raw/sub/dub/hsub)
//         div.sv__label            <- row label ("SUB" / "DUB" / ...)
//         div.sv__pills
//           button.sv__pill        <- "ENMA-1" .. "ENMA-5" (per server)
//
// There is NO .server-item and NO data-type="sub|dub" attribute anywhere, so
// the old selector list matched nothing and the scan reported "No video
// sources found on the page". We now target the real markup explicitly and
// keep the generic HiAnime selectors as a fallback for other sites in this
// family. Buttons are named ENMA-1..N (serverName in the bundle), so
// knownSourceLabels carries "enma" for the text-heuristic fallback path.
module.exports = {
  id: 'enma',
  name: 'Enma (enma.lol / HiAnime-style)',
  match: [/\benma\.lol\b/i, /\benma\b/i],
  dub: {
    dubLabelText: ['dub', 'dubbed', 'english dub'],
    subLabelText: ['sub', 'subbed', 'softsub', 'raw'],
    knownSourceLabels: ['enma', 'hd-1', 'hd-2', 'hd-3', 'megacloud', 'vidstreaming', 'vidcloud', 'streamtape', 'streamsb', 'vidplay'],
    // The actual server buttons (ENMA-1..N). Explicit selectors take priority
    // over the text heuristics in the scanner.
    sourceSelector: '.sv__pill, .sv__pills button, .server-item, [data-type="sub"], [data-type="dub"]',
    // IMPORTANT: no dubSelector/subSelector here. The row wrapper's id
    // (sv-row-sub / sv-row-dub) is passed to a framer-motion LayoutGroup - a
    // React context provider that renders NO DOM node - so #sv-row-* matches
    // nothing in the page. With a selector set the scanner skips its text-label
    // fallback, every pill landed in the "DUB" row, and a SUB-row stream was
    // accepted for a DUB request. Leaving both empty makes the scanner anchor
    // the rows on the exact "SUB" / "DUB" label text in each .sv__label and
    // classify pills by vertical proximity.
    // SPA: server list hydrates after the initial paint; give it a moment and
    // let the scanner's re-scan cover slower API responses.
    sourceWaitMs: 15000,
    pageSettleMs: 4000
    // No dubPathMarker: streams are tokenised per data_id (e.g. sub-enma-1 /
    // dub-enma-1); the ROW the button came from proves the audio, not the URL.
  },
  urlTemplates: ['https://www.enma.lol/watch/{slug}?ep={episode}']
};
