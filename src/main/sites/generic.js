'use strict';

// Fallback profile used when no site-specific adapter matches. It relies purely
// on the heuristics in dubselect (text matching + on-page order), so unknown
// sites still work out of the box. Copy this shape to add a real site adapter.
module.exports = {
  id: 'generic',
  name: 'Generic (heuristic)',
  // Matched against the full URL. Generic matches everything and is always
  // tried last by the resolver.
  match: [/.*/],
  // Per-site overrides merged over config.dub (leave empty to use defaults).
  dub: {
    // dubLabelText: ['dub'],
    // subLabelText: ['sub'],
    // knownSourceLabels: ['vidplay', 'byfms', 'dghg'],
    // sourceWaitMs: 12000
  },
  // Optional: known URL templates for this site, used when a series entry does
  // not provide its own template. Tokens: {episode} {season} {series} {slug} {id}
  urlTemplates: []
};
