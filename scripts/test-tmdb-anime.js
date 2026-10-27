'use strict';

// Regression test: TMDB info/season merge for anime titles.
//
// Root cause pinned here: tmdb.js declared `const seasons = ...` and then
// REASSIGNED it in the anime-layout merge (`seasons = resolved.seasons...` /
// `seasons = animelayout.addMissingSeasons(...)`). That is a runtime
// `TypeError: Assignment to constant variable` - thrown ONLY when Aniwave or
// AniList knows the title, i.e. exactly the anime case. TV shows (resolved
// = null) and movies never hit the merge, which is why they worked.
//
// The TMDB API is faked (no key needed); the anime-layout answers come from
// its cache, so the merge logic - the part that was broken - runs for real.

const assert = require('assert');
const path = require('path');

process.env.TMDB_API_KEY = 'test-key';

const REPO = path.join(__dirname, '..');
const tmdb = require(path.join(REPO, 'src/main/tmdb.js'));
const animelayout = require(path.join(REPO, 'src/main/anime-layout.js'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`);
  }
}

// ---- fake TMDB API ----------------------------------------------------------
const TV = {
  // 123: anime AniList knows (S1, 12 eps) - Aniwave does not.
  123: {
    id: 123, name: 'Test Anime', first_air_date: '2026-01-10', poster_path: null, overview: 'x',
    seasons: [{ season_number: 1, episode_count: 12, air_date: '2026-01-10' }]
  },
  // 456: anime Aniwave knows (S1, 10 eps) - Aniwave wins wholesale.
  456: {
    id: 456, name: 'Aniwave Anime', first_air_date: '2025-01-10', poster_path: null, overview: 'x',
    seasons: [{ season_number: 1, episode_count: 12, air_date: '2025-01-10' }]
  },
  // 555: anime where AniList has a season TMDB is missing (S2) - add-only.
  555: {
    id: 555, name: 'Missing Season Anime', first_air_date: '2025-01-10', poster_path: null, overview: 'x',
    seasons: [{ season_number: 1, episode_count: 12, air_date: '2025-01-10' }]
  },
  // 789: a plain TV show (2 seasons) - the anime tiers must not touch it.
  789: {
    id: 789, name: 'Plain TV Show', first_air_date: '2020-01-10', poster_path: null, overview: 'x',
    seasons: [
      { season_number: 1, episode_count: 12, air_date: '2020-01-10' },
      { season_number: 2, episode_count: 10, air_date: '2021-01-10' }
    ]
  }
};
const WATCH_PROVIDERS = {
  '218038': [{ provider_name: 'Netflix' }],
  '555': [{ provider_name: 'Netflix' }, { provider_name: 'Apple TV+' }]
};
global.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/\/tv\/(\d+)/);
  if (!m) return { ok: false, status: 404 };
  if (u.includes('watch/providers')) {
    const wp = WATCH_PROVIDERS[m[1]];
    if (!wp) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ results: [wp], flatrate: wp }) };
  }
  if (!TV[m[1]]) return { ok: false, status: 404 };
  if (u.includes('external_ids')) {
    return {
      ok: true,
      json: async () => ({
        imdb_id: 'tt' + m[1],
        anilist_id: m[1] === '123' ? 999 : m[1] === '555' ? 777 : null
      })
    };
  }
  return { ok: true, json: async () => TV[m[1]] };
};

// ---- seed the anime-layout cache (no network, deterministic) -----------------
animelayout._resetCache();
const eps = (n) => Array.from({ length: n }, (_, i) => ({ episode: i + 1, name: '' }));
animelayout._internals.cacheSet('aniwave:123', null); // Aniwave does not know it
animelayout._internals.cacheSet('anilistid:999', [{ season: 1, episodes: eps(12), year: '2026' }]);
animelayout._internals.cacheSet('aniwave:456', [{ season: 1, episodes: eps(10), dub: true, sub: false, year: '2025' }]);
animelayout._internals.cacheSet('aniwave:555', null);
animelayout._internals.cacheSet('anilistid:777', [
  { season: 1, episodes: eps(12), year: '2025' },
  { season: 2, episodes: eps(12), year: '2026' }
]);
animelayout._internals.cacheSet('aniwave:789', null);

(async () => {
  console.log('\n[1] Anime known only to AniList (the user\'s failing case)');
  try {
    const info = await tmdb.tmdbInfo('123', 'tv', { anime: true });
    check('tmdbInfo did not throw', !!info, 'returned null');
    check('seasons came back', info && info.seasons.length === 1, JSON.stringify(info && info.seasons));
    check('S1 keeps its 12 episodes', info && info.seasons[0].episodes === 12, JSON.stringify(info && info.seasons[0]));
  } catch (e) {
    check('tmdbInfo did not throw', false, e.constructor.name + ': ' + e.message);
  }

  console.log('\n[2] Anime known to Aniwave (Aniwave layout wins)');
  try {
    const info = await tmdb.tmdbInfo('456', 'tv', { anime: true });
    check('tmdbInfo did not throw', !!info, 'returned null');
    check('layout is aniwave', info && info.layout === 'aniwave', info && info.layout);
    check('Aniwave\'s 10 episodes win over TMDB\'s 12', info && info.seasons[0].episodes === 10, JSON.stringify(info && info.seasons[0]));
  } catch (e) {
    check('tmdbInfo did not throw', false, e.constructor.name + ': ' + e.message);
  }

  console.log('\n[3] AniList ADDS the season TMDB is missing (add-only)');
  try {
    const info = await tmdb.tmdbInfo('555', 'tv', { anime: true });
    check('tmdbInfo did not throw', !!info, 'returned null');
    check('both seasons present', info && info.seasons.length === 2, JSON.stringify(info && info.seasons));
    check('TMDB\'s S1 count (12) is NOT overridden', info && info.seasons[0].episodes === 12, JSON.stringify(info && info.seasons[0]));
    check('layout marked tmdb+anilist', info && info.layout === 'tmdb+anilist', info && info.layout);
  } catch (e) {
    check('tmdbInfo did not throw', false, e.constructor.name + ': ' + e.message);
  }

  console.log('\n[4] Plain TV show is untouched (why TV worked while anime broke)');
  try {
    const info = await tmdb.tmdbInfo('789', 'tv', { anime: false });
    check('tmdbInfo did not throw', !!info, 'returned null');
    check('layout stays tmdb', info && info.layout === 'tmdb', info && info.layout);
    check('both TMDB seasons intact', info && info.seasons.length === 2 && info.seasons[1].episodes === 10, JSON.stringify(info && info.seasons));
  } catch (e) {
    check('tmdbInfo did not throw', false, e.constructor.name + ': ' + e.message);
  }

  console.log('\n[5] Total-failure diagnostic (licensed-exclusive explanation)');
  const provs = await tmdb.watchProviders('218038', 'tv');
  check('watchProviders reads the TMDB flatrate list', JSON.stringify(provs) === JSON.stringify(['Netflix']), JSON.stringify(provs));
  const multi = await tmdb.watchProviders('555', 'tv');
  check('watchProviders handles multiple providers', JSON.stringify(multi) === JSON.stringify(['Netflix', 'Apple TV+']), JSON.stringify(multi));
  const none = await tmdb.watchProviders('789', 'tv');
  check('watchProviders returns null when TMDB has no data', none === null, JSON.stringify(none));
  const hint = tmdb.exclusiveHint(provs);
  check('hint names the exclusive', /Netflix exclusive/.test(hint), hint);
  check('hint points at the solver unlock', /Cloudflare solver/i.test(hint), hint);
  check('hint is empty with no providers', tmdb.exclusiveHint(none) === '', tmdb.exclusiveHint(none));
  check('multi-provider hint uses licensed-on wording', /licensed on Netflix, Apple TV\+/.test(tmdb.exclusiveHint(multi)), tmdb.exclusiveHint(multi));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
