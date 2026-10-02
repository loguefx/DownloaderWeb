'use strict';

// Non-Cloudflare 123movies-family catalogs — the preferred 1080p fallback.
//
// They serve the SAME DOM the FMovies adapter targets (search /search/{q},
// series /title/{slug}/, episode /title/{slug}-s1e5/) but sit behind ordinary
// web servers (Apache / nginx / Cowboy) instead of Cloudflare, so the app's
// real Chromium renders them with NO challenge at all — no checkbox, no
// "Just a moment", no hard block. That is the "no Cloudflare friction" path.
//
// Verified alive + non-CF at the time of writing:
//   solarmovie.com  (Apache)  123movies.asia (nginx, FHD)
//   solarmovie.cc   (Cowboy)  desistream.com (200, content)
// TLDs rotate and go dead, so mirrorUrls falls over the live ones; a dead TLD
// is just skipped, never fatal.
//
// fallbackRank 2 = the cross-site walker in bulk.js tries the real 1080p source
// (FMovies/movienow, rank 1) BEFORE this family. Verified THIS session that
// every TLD below is currently dead/parked/origin-down:
//   solarmovie.com -> redirects to parked watchmovies.to
//   123movies.asia -> redirects to empty ww1.123movies.asia
//   solarmovie.cc  -> 200 shell, no results
//   desistream.com -> ERR_CONNECTION_CLOSED
//   fmoviehd.tv    -> no response
// The slot is kept so a live 123movies-family TLD can be dropped in here the
// moment one is found (use scripts/probe-search.js to verify one is live
// before trusting it). Ranked AFTER the known-1080p source so a dead TLD
// never wastes the fallback before movienow is reached.
const { buildProfile } = require('./tmovies');

const profile = buildProfile({
  id: 'solarmovie',
  name: 'SolarMovie/123movies',
  match: [/solarmovie\./i, /\b123movies\b/i, /desistream/i, /fmoviehd/i],
  mirrorHosts: [
    'https://solarmovie.com',
    'https://123movies.asia',
    'https://solarmovie.cc',
    'https://desistream.com',
    'https://fmoviehd.tv'
  ],
  searchUrls: [
    'https://solarmovie.com/search/{q}',
    'https://123movies.asia/search/{q}',
    'https://solarmovie.cc/search/{q}',
    'https://desistream.com/search/{q}'
  ]
});

profile.fallbackRank = 4; // behind Vidsrc (0), FMovies (1), NontonGo (2) and Flixtor (3)
module.exports = profile;
