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
  // 600: Aniwave layout + TMDB Specials: Specials stay TMDB's.
  600: {
    id: 600, name: 'Aniwave With Specials', first_air_date: '2024-01-10', poster_path: null, overview: 'x',
    seasons: [
      { season_number: 0, episode_count: 3, air_date: '2024-06-01' },
      { season_number: 1, episode_count: 12, air_date: '2024-01-10' }
    ]
  },
  // 601: TMDB has no Specials; AniList knows OVAs + a missing S2.
  601: {
    id: 601, name: 'AniList Specials Anime', first_air_date: '2024-01-10', poster_path: null, overview: 'x',
    seasons: [{ season_number: 1, episode_count: 12, air_date: '2024-01-10' }]
  },
  // 602: plain TV with an EMPTY Specials season and a real one on 603.
  602: {
    id: 602, name: 'Empty Specials Show', first_air_date: '2020-01-10', poster_path: null, overview: 'x',
    seasons: [
      { season_number: 0, episode_count: 0, air_date: null },
      { season_number: 1, episode_count: 8, air_date: '2020-01-10' }
    ]
  },
  603: {
    id: 603, name: 'Specials Show', first_air_date: '2020-01-10', poster_path: null, overview: 'x',
    seasons: [
      { season_number: 0, episode_count: 5, air_date: '2021-12-24' },
      { season_number: 1, episode_count: 8, air_date: '2020-01-10' }
    ]
  },
  // 259140: Ranma ½ (2024) - TMDB lumps three 12-episode seasons into
  // "Season 1, 36 episodes"; season 3 is airing (only E1-E4 aired).
  259140: {
    id: 259140, name: 'Ranma1/2', first_air_date: '2024-10-05', poster_path: null, overview: 'x',
    genres: [{ id: 16 }], origin_country: ['JP'],
    seasons: [{ season_number: 1, episode_count: 36, air_date: '2024-10-05' }]
  },
  // 126318: Link Click (Chinese donghua). TMDB counts the 6-episode Bridon
  // Arc as Season 3 and the 2026 season as Season 4; Aniwave's catalog names
  // the 2026 season "Link Click Season 3" (the numbering downloads use).
  126318: {
    id: 126318, name: 'LINK CLICK', first_air_date: '2021-04-30', poster_path: null, overview: 'x',
    genres: [{ id: 16 }, { id: 18 }], origin_country: ['CN'],
    seasons: [
      { season_number: 0, episode_count: 28, air_date: '2021-06-01' },
      { season_number: 1, episode_count: 11, air_date: '2021-04-30' },
      { season_number: 2, episode_count: 12, air_date: '2023-07-14' },
      { season_number: 3, episode_count: 6, air_date: '2024-06-27' },
      { season_number: 4, episode_count: 12, air_date: '2026-08-14' },
      { season_number: 5, episode_count: 0, air_date: null }
    ]
  },
  // 127000: an anime whose Aniwave catalog AGREES with TMDB - unchanged.
  127000: {
    id: 127000, name: 'Agreeing Anime', first_air_date: '2022-01-01', poster_path: null, overview: 'x',
    genres: [{ id: 16 }], origin_country: ['JP'],
    seasons: [{ season_number: 1, episode_count: 12, air_date: '2022-01-01' }, { season_number: 2, episode_count: 12, air_date: '2023-01-01' }]
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
  const lcSeason = u.match(/\/tv\/126318\/season\/(\d+)/);
  if (lcSeason) {
    const counts = { 0: 28, 1: 11, 2: 12, 3: 6, 4: 12 };
    const n = Number(lcSeason[1]);
    if (!counts[n]) return { ok: false, status: 404 };
    const label = n === 3 ? 'Bridon' : 'LC S' + n;
    return { ok: true, json: async () => ({ name: 'Season ' + n, episodes: Array.from({ length: counts[n] }, (_, i) => ({
      episode_number: i + 1, name: label + 'E' + (i + 1), runtime: 20, air_date: '2025-01-01' })) }) };
  }
  const seasonPath = u.match(/\/tv\/259140\/season\/(\d+)/);
  if (seasonPath) {
    if (seasonPath[1] !== '1') return { ok: false, status: 404 };
    return {
      ok: true,
      json: async () => ({
        name: 'Season 1',
        episodes: Array.from({ length: 36 }, (_, i) => ({
          episode_number: i + 1,
          name: 'Ep ' + (i + 1),
          runtime: 24,
          // E1-E28 aired; E29-E36 (season 3 E5-E12) are in the future.
          air_date: i < 28 ? '2025-01-01' : '2099-01-01'
        }))
      })
    };
  }
  if (u.includes('external_ids')) {
    return {
      ok: true,
      json: async () => ({
        imdb_id: 'tt' + m[1],
        anilist_id: m[1] === '123' ? 999 : m[1] === '555' ? 777 : m[1] === '601' ? 6010 : null
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
animelayout._internals.cacheSet('aniwave:600', [{ season: 1, episodes: eps(10), dub: true, sub: false, year: '2024' }]);
animelayout._internals.cacheSet('aniwave:601', null);
animelayout._internals.cacheSet('anilistid:6010', [
  { season: 0, episodes: eps(2), year: '' },
  { season: 1, episodes: eps(12), year: '2024' },
  { season: 2, episodes: eps(11), year: '2025' }
]);
animelayout._internals.cacheSet('aniwave:602', null);
// Aniwave's catalog (title search) is never asked live in tests: every
// anime title here gets a seeded answer (null = the catalog does not know it).
for (const t of ['test anime', 'aniwave anime', 'missing season anime', 'aniwave with specials', 'anilist specials anime', 'ranma1/2']) {
  animelayout._internals.cacheSet('awcat:' + t, null);
}
animelayout._internals.cacheSet('aniwave:126318', null);
animelayout._internals.cacheSet('anilistid:126318', '');
animelayout._internals.cacheSet('anilist:link click|2021', null);
animelayout._internals.cacheSet('anilist:link click', null);
const awEps = (n, dub) => Array.from({ length: n }, (_, i) => ({ episode: i + 1, name: '' }));
animelayout._internals.cacheSet('awcat:link click', [
  { season: 1, episodes: awEps(11), dubEpisodes: 11, aniwaveId: '1', year: '' },
  { season: 2, episodes: awEps(12), dubEpisodes: 12, aniwaveId: '2', year: '' },
  { season: 3, episodes: awEps(12), dubEpisodes: 9, aniwaveId: '3', year: '' }
]);
animelayout._internals.cacheSet('aniwave:127000', null);
animelayout._internals.cacheSet('anilistid:127000', '');
animelayout._internals.cacheSet('anilist:agreeing anime|2022', null);
animelayout._internals.cacheSet('anilist:agreeing anime', null);
animelayout._internals.cacheSet('awcat:agreeing anime', [
  { season: 1, episodes: awEps(12), aniwaveId: 'a', year: '' },
  { season: 2, episodes: awEps(12), aniwaveId: 'b', year: '' }
]);
// A live-action show must never be looked up in the anime catalog: seed a
// WRONG answer for it and check it is ignored.
animelayout._internals.cacheSet('awcat:plain tv show', [
  { season: 1, episodes: awEps(99), aniwaveId: 'x', year: '' },
  { season: 2, episodes: awEps(99), aniwaveId: 'y', year: '' }
]);
animelayout._internals.cacheSet('aniwave:259140', null);
animelayout._internals.cacheSet('anilist:ranma1/2|2024', [
  { season: 1, episodes: eps(12), year: 2024 },
  { season: 2, episodes: eps(12), year: 2025 },
  { season: 3, episodes: [], year: 2026 } // airing: AniList count unknown
]);
animelayout._internals.cacheSet('aniwave:603', null);

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

  console.log('\n[2] Anime Aniwave knows: seasons still follow TMDB (Jellyfin numbering)');
  try {
    const info = await tmdb.tmdbInfo('456', 'tv', { anime: true });
    check('tmdbInfo did not throw', !!info, 'returned null');
    check('layout is TMDB\'s', info && info.layout === 'tmdb', info && info.layout);
    check('TMDB\'s 12 episodes kept (Aniwave\'s own layout never replaces them)', info && info.seasons[0].episodes === 12, JSON.stringify(info && info.seasons[0]));
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

  console.log('\n[6] Specials (Season 0) are listed, never renumber seasons');
  try {
    const a = await tmdb.tmdbInfo('600', 'tv', { anime: true });
    check('TMDB layout with TMDB\'s Specials (3) first, then S1=12',
      a && JSON.stringify(a.seasons.map((x) => x.season + ':' + x.episodes)) === '["0:3","1:12"]', JSON.stringify(a && a.seasons));
    const b = await tmdb.tmdbInfo('601', 'tv', { anime: true });
    check('AniList adds Specials (2) and the missing S2 (11); TMDB S1 stays 12',
      b && JSON.stringify(b.seasons.map((x) => x.season + ':' + x.episodes)) === '["0:2","1:12","2:11"]', JSON.stringify(b && b.seasons));
    const c = await tmdb.tmdbInfo('602', 'tv', { anime: false });
    check('an empty TMDB Specials season is not listed',
      c && JSON.stringify(c.seasons.map((x) => x.season)) === '[1]', JSON.stringify(c && c.seasons));
    const d = await tmdb.tmdbInfo('603', 'tv', { anime: false });
    check('a plain TV show lists its TMDB Specials too',
      d && d.layout === 'tmdb' && JSON.stringify(d.seasons.map((x) => x.season + ':' + x.episodes)) === '["0:5","1:8"]', JSON.stringify(d && d.seasons));
  } catch (e) {
    check('tmdbInfo did not throw', false, e.constructor.name + ': ' + e.message);
  }

  console.log('\n[4b] Ranma ½ (2024): TMDB\'s one 36-episode season, as Jellyfin shows it');
  for (const anime of [true, false]) {
    const info = await tmdb.tmdbInfo('259140', 'tv', { anime });
    const shape = info && info.seasons.map((x) => x.season + ':' + x.episodes).join('|');
    check(`one season of 36 (${anime ? 'Anime tab' : 'TV tab'})`, shape === '1:36' && info.layout === 'tmdb', shape + ' ' + (info && info.layout));
  }
  {
    const s1 = await tmdb.tmdbSeason('259140', 1, { anime: true });
    const e = (s1 && s1.episodes) || [];
    check('season 1 lists all 36 TMDB episodes with names + air dates', e.length === 36 && e[24].name === 'Ep 25' && e[28].airDate === '2099-01-01', e.length);
  }

  console.log('\n[4c] Link Click: TMDB numbering (S3 = Bridon Arc, S4 = the 2026 season)');
  for (const anime of [true, false]) {
    const info = await tmdb.tmdbInfo('126318', 'tv', { anime });
    const shape = info && info.seasons.map((x) => x.season + ':' + x.episodes).join('|');
    check(`TMDB seasons as Jellyfin shows them (${anime ? 'Anime tab' : 'TV tab'})`, shape === '0:28|1:11|2:12|3:6|4:12|5:0' && info.layout === 'tmdb', shape);
  }
  {
    const s3 = await tmdb.tmdbSeason('126318', 3, { anime: true });
    check('Season 3 is the Bridon Arc (6 episodes, its own names)', s3 && s3.episodes.length === 6 && s3.episodes[0].name === 'BridonE1', s3 && s3.episodes.length);
    const s4 = await tmdb.tmdbSeason('126318', 4, { anime: true });
    check('Season 4 is the 2026 season (12 episodes)', s4 && s4.episodes.length === 12 && s4.episodes[0].name === 'LC S4E1', s4 && s4.episodes.length);
  }
  console.log('\n[4d] Link Click in an AniDB-numbered library: the anime sites\' seasons');
  {
    // The plan (TMDB <-> Aniwave entries) is seeded; it is what the live
    // TMDB counts + Aniwave catalog produce for Link Click.
    animelayout._internals.cacheSet('tmdb:126318', [{ season: 1, episodes: 11, year: '2021' }, { season: 2, episodes: 12, year: '2023' }, { season: 3, episodes: 6, year: '2024' }, { season: 4, episodes: 12, year: '2026' }]);
    animelayout._internals.cacheSet('plan:126318|link click', animelayout.buildSourcePlan(
      [{ season: 1, episodes: 11 }, { season: 2, episodes: 12 }, { season: 3, episodes: 6 }, { season: 4, episodes: 12 }],
      [{ season: 1, episodes: 11 }, { season: 2, episodes: 12 }, { season: 3, episodes: 9 }],
      [{ entry: { id: 'b', title: 'Link Click: Bridon Arc' }, count: 6 }]));
    for (const anime of [true, false]) {
      const info = await tmdb.tmdbInfo('126318', 'tv', { anime, numbering: 'anime' });
      const shape = info && info.seasons.map((x) => x.season + ':' + x.episodes).join('|');
      check(`AniDB numbering: S1 11, S2 12, S3 12 - no Bridon Arc, no Specials (${anime ? 'Anime tab' : 'TV tab'})`, shape === '1:11|2:12|3:12' && info.numbering === 'anime', shape + ' ' + (info && info.numbering));
    }
    const s3 = await tmdb.tmdbSeason('126318', 3, { anime: true, numbering: 'anime' });
    check('AniDB S3 = the 2026 season: 12 episodes named from TMDB S4', s3 && s3.episodes.length === 12 && s3.episodes[0].name === 'LC S4E1' && s3.episodes[11].name === 'LC S4E12', s3 && s3.episodes.length + ' ' + (s3 && s3.episodes[0] && s3.episodes[0].name));
    const s1 = await tmdb.tmdbSeason('126318', 1, { anime: true, numbering: 'anime' });
    check('AniDB S1 = TMDB S1', s1 && s1.episodes.length === 11 && s1.episodes[0].name === 'LC S1E1');
    const tm = await tmdb.tmdbInfo('126318', 'tv', { anime: true, numbering: 'tmdb' });
    check('same title in a TMDB library: TMDB seasons (cache kept apart)', tm && tm.seasons.map((x) => x.season + ':' + x.episodes).join('|') === '0:28|1:11|2:12|3:6|4:12|5:0', tm && tm.seasons.map((x) => x.season).join(','));
    const tv = await tmdb.tmdbInfo('789', 'tv', { anime: false, numbering: 'anime' });
    check('live-action TV ignores AniDB numbering (TMDB seasons)', tv && tv.numbering === 'tmdb' && tv.seasons[0].episodes === 12, tv && tv.numbering);
  }

  try {
    const ag = await tmdb.tmdbInfo('127000', 'tv', { anime: true });
    check('anime with matching sources: TMDB seasons', ag && ag.layout === 'tmdb' && ag.seasons.map((s) => s.episodes).join(',') === '12,12', ag && ag.layout);
    const tv = await tmdb.tmdbInfo('789', 'tv', { anime: false });
    check('live-action TV keeps TMDB seasons', tv && tv.layout === 'tmdb' && tv.seasons[0].episodes === 12, tv && tv.layout);
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

  // Anime by TMDB: Animation from JP/CN/KR/TW, whichever tab it came from.
  const la = tmdb.looksAnime;
  check('Chinese donghua (The Girl Downstairs: Animation, CN) is anime', la({ genres: [{ id: 16 }, { id: 18 }], origin_country: ['CN'] }) === true);
  check('Japanese animation is anime', la({ genres: [{ id: 16 }], origin_country: ['JP'] }) === true);
  check('US animation is not', la({ genres: [{ id: 16 }], origin_country: ['US'] }) === false);
  check('live-action Japanese drama is not', la({ genres: [{ id: 18 }], origin_country: ['JP'] }) === false);
  check('search-result shape (genre_ids) works too', la({ genre_ids: [16], origin_country: ['KR'] }) === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
