'use strict';

// Shared profile builder for the 123movies-family catalogs (Desistream,
// FMovies, Superfly, Akwatch, SolarMovie, ...). They all share one DOM:
//   search   /search/{query}/
//   series   /title/{slug}/
//   episode  /title/{slug}-s1e5/
//   movies   /movie/{slug}/
// and they all serve 1080p through the "Server 1..N" embed tabs, so one
// findTitle pipeline (findtitle.genericFindTitle) and one dub config cover
// every host. Each site file is a thin call to buildProfile with its own
// host family — when one TLD dies, mirrorUrls falls over the rest.
//
// This module exports no `id`, so the registry (index.js) does not register
// it as a site; it only exists to keep the five adapters DRY.

const findtitle = require('./findtitle');

const SERVER_LABELS = [
  'server 1', 'server 2', 'server 3', 'server 4', 'server 5',
  'server 6', 'server 7', 'server 8',
  'vidsrc', 'filemoon', 'superembed', 'multiembed', 'doodstream',
  'streamtape', 'upstream', 'vidcloud'
];

function buildProfile({ id, name, match, mirrorHosts, searchUrls, episodeFromShowPage }) {
  const origins = (mirrorHosts || []).map((h) => String(h).replace(/\/$/, ''));

  return {
    id,
    name,
    match,
    minHeight: 1080,
    mirrorUrls(pageUrl) {
      let path = '/';
      let current = '';
      try {
        const u = new URL(String(pageUrl || ''));
        path = `${u.pathname || '/'}${u.search || ''}${u.hash || ''}`;
        current = u.origin;
      } catch (e) {
        return [String(pageUrl || '')];
      }
      const out = [];
      const seen = new Set();
      const add = (origin) => {
        if (!origin) return;
        const abs = `${origin.replace(/\/$/, '')}${path}`;
        if (seen.has(abs)) return;
        seen.add(abs);
        out.push(abs);
      };
      if (current) add(current);
      for (const origin of origins) add(origin);
      return out;
    },
    dub: {
      knownSourceLabels: SERVER_LABELS,
      sourceWaitMs: 14000,
      maxSources: 6
    },
    urlTemplates: [
      'https:///{host}/title/{slug}/',
      'https:///{host}/title/{slug}-s{season}e{episode}/',
      'https:///{host}/movie/{slug}/'
    ],
    async findTitle(args, hooks, onLog) {
      return findtitle.genericFindTitle(
        { searchUrls, episodeFromShowPage },
        args,
        hooks,
        onLog
      );
    }
  };
}

module.exports = { buildProfile };
