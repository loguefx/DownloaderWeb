'use strict';

const findtitle = require('./findtitle');

// 9anime — anime (and some movies) watch site.
//   search   https://9anime.to/search?keyword={title}
//   anime    /anime/{code}/   episode  /anime/{code}/episode-1/
// Anime episodes are a flat number (no season), so cross-site requests for an
// anime pass the episode number through as-is; the picker matches /episode-N/.
module.exports = {
  id: 'anime9',
  name: '9anime',
  match: [/9anime\./i],
  minHeight: 1080,
  mirrorUrls(pageUrl) {
    const origins = ['https://9anime.to'];
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
      'server 1', 'server 2', 'server 3', 'server 4', 'server 5', 'server 6',
      'megacloud', 'vidcloud', 'streamwish', 'filemoon', 'doodstream'
    ],
    sourceWaitMs: 14000,
    maxSources: 6
  },
  download: {
    concurrency: 5,
    prefetchDiscover: 1
  },
  urlTemplates: [
    'https://9anime.to/anime/{slug}/',
    'https://9anime.to/anime/{slug}/episode-{episode}/'
  ],
  async findTitle(args, hooks, onLog) {
    return findtitle.genericFindTitle(
      { searchUrls: ['https://9anime.to/search?keyword={q}'] },
      args,
      hooks,
      onLog
    );
  }
};
