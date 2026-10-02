'use strict';

const findtitle = require('./findtitle');

// Flixtor — large free watch catalog (series + movies) with a plain search box.
//   search   https://flixtor.to/search?query={title}
//   series   /title/{slug}/
//   episode  /title/{slug}-s1e5/
// Episodes resolve through the generic dubselect heuristics (Server 1..N tabs
// over third-party embeds), same as the SFlix profile.
module.exports = {
  id: 'flixtor',
  name: 'Flixtor',
  match: [/flixtor\./i],
  minHeight: 1080,
  // Pool order: Vidsrc 0 (CF-free primary), FMovies 1 (CF checkbox),
  // NontonGo 2 (CF-free, proven quality), Flixtor 3, SolarMovie 4. Flixtor is
  // CF-gated (403 challenge verified 2026), so it sits behind the CF-free
  // sources.
  fallbackRank: 3,
  mirrorUrls(pageUrl) {
    // flixtor.la was hijacked by a parked-domain news page (verified live),
    // so flixtor.to is the only usable host right now.
    const origins = ['https://flixtor.to'];
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
      const abs = `${String(origin).replace(/\/$/, '')}${path}`;
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    };
    if (current) add(current);
    for (const origin of origins) add(origin);
    return out;
  },
  dub: {
    knownSourceLabels: [
      'server 1', 'server 2', 'server 3', 'server 4', 'server 5',
      'server 6', 'server 7', 'server 8',
      'vidsrc', 'filemoon', 'superembed', 'multiembed', 'doodstream', 'streamtape'
    ],
    sourceWaitMs: 14000,
    maxSources: 6
  },
  download: {
    concurrency: 5,
    prefetchDiscover: 1
  },
  urlTemplates: [
    'https://flixtor.to/title/{slug}/',
    'https://flixtor.to/title/{slug}-s{season}e{episode}/'
  ],
  async findTitle(args, hooks, onLog) {
    return findtitle.genericFindTitle(
      { searchUrls: ['https://flixtor.to/search?query={q}'] },
      args,
      hooks,
      onLog
    );
  }
};
