'use strict';

// FMovies family — 123movies catalog. The TLDs rotate and several are
// dead/parked right now (verified live): fmovies.net serves a broken cert,
// fmovieshd.xyz 301s behind a Cloudflare challenge, and movienow.online is
// the live front door with NO challenge. Search -> show -> episode works:
//   search   /search/{query}
//   show     /shows/{tmdb}/{slug}/
//   episode  /shows/{tmdb}-{season}-{episode}/{slug}/
const { buildProfile } = require('./tmovies');

// The show page carries the TMDB id (/shows/1739/according-to-jim/), and the
// episode URL is the same id plus season-episode: /shows/1739-1-5/.... Only
// one season's episode list renders at a time, so build the URL directly.
function episodeFromShowPage(showUrl, season, episode) {
  try {
    const u = new URL(String(showUrl || ''));
    const m = u.pathname.match(/\/shows\/(\d+)(?:-\d+-\d+)?\/([^/]+)\/?/i);
    if (!m || !season || !episode) return '';
    return `${u.origin}/shows/${m[1]}-${season}-${episode}/${m[2]}/`;
  } catch (e) {
    return '';
  }
}

// fallbackRank 1 = the cross-site walker in bulk.js reaches this SECOND, right
// after Vidsrc (rank 0, the CF-free primary). movienow is the known 1080p
// catalog and its /play/ player page is the one interactive-Cloudflare
// checkbox in the pool, so it is the natural fallback when Vidsrc's relay has
// no 1080p copy.
const profile = buildProfile({
  id: 'fmovies',
  name: 'FMovies',
  match: [/fmovies\./i, /movienow\.online/i],
  mirrorHosts: [
    'https://movienow.online',
    'https://fmovieshd.xyz',
    'https://fmovies.net',
    'https://fmovies.cc'
  ],
  searchUrls: [
    'https://movienow.online/search/{q}',
    'https://fmovieshd.xyz/search/{q}',
    'https://fmovies.cc/search/{q}'
  ],
  episodeFromShowPage
});

// Cloudflare-gated: the /play/ player page sits behind an interactive CF
// checkbox. Bumped to rank 90 so CF-free sources (NontonGo, rank 2) are
// tried first. Skipped entirely when config.download.skipCloudflareSites
// is true (the default).
profile.fallbackRank = 90;
profile.cloudflare = true;
module.exports = profile;
