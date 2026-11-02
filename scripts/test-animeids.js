'use strict';

// Anime-tab cards -> TMDB series, without depending on AniList answering.
//   [1] the Anime-Lists mapping (both file formats), cached on disk, a failed
//       fetch keeps the copy on disk
//   [2] tmdbForAnilist answers from the mapping with NO AniList request, and
//       places later seasons by the TMDB season that aired in the card's year
//   [3] AniList "429 too many requests" is waited out and retried (it used to
//       come back as "no answer" -> "This title has no TMDB id")

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TMDB_API_KEY = 'test-key';
const SRC = path.join(__dirname, '..', 'src', 'main');
const ids = require(path.join(SRC, 'animeids.js'));
const layout = require(path.join(SRC, 'anime-layout.js'));

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

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeids-'));
  const LIST = [
    { anilist_id: 97986, themoviedb_id: { tv: 73223 }, type: 'TV' }, // Black Clover (object form)
    { anilist_id: 136430, themoviedb_id: 126437, type: 'TV' }, // Aoashi (number form)
    { anilist_id: 175914, themoviedb_id: { tv: 126437 }, type: 'TV', season: { tvdb: 2, tmdb: 2 } }, // Aoashi S2, season given
    { anilist_id: 999001, themoviedb_id: { movie: 5555 }, type: 'MOVIE' },
    { anilist_id: 999002, type: 'TV' } // no TMDB id
  ];
  let fetches = 0;
  ids._setFetchForTests(async () => { fetches += 1; return LIST; }, dir);

  console.log('\n[1] The Anime-Lists mapping');
  check('object form {tv}', JSON.stringify(await ids.tmdbFor(97986)) === JSON.stringify({ tmdb: '73223', type: 'tv', season: null }));
  check('number form', (await ids.tmdbFor(136430)).tmdb === '126437');
  check('season from the full list', (await ids.tmdbFor(175914)).season === 2);
  check('movie entries are typed movie', (await ids.tmdbFor(999001)).type === 'movie');
  check('no TMDB id -> null', (await ids.tmdbFor(999002)) === null && (await ids.tmdbFor(1)) === null);
  check('fetched once for all lookups', fetches === 1, String(fetches));
  check('kept on disk', fs.existsSync(path.join(dir, 'anime-ids.json')));
  // A fresh process whose fetch fails still answers from the disk copy.
  ids._setFetchForTests(async () => { throw new Error('offline'); }, dir);
  check('a failed fetch keeps answering from the disk copy', (await ids.tmdbFor(97986)) && (await ids.tmdbFor(97986)).tmdb === '73223');
  check('peek answers without the network', ids.peek(136430) && ids.peek(136430).tmdb === '126437');
  ids._setFetchForTests(async () => LIST, dir);

  console.log('\n[2] Anime-tab card -> TMDB series from the mapping, no AniList request');
  let anilistCalls = 0;
  const noAnilist = async () => { anilistCalls += 1; return null; };
  const tmdbDetails = async (u) => {
    if (/\/tv\/73223/.test(u)) return { id: 73223, name: 'Black Clover', first_air_date: '2017-10-03', seasons: [{ season_number: 1, air_date: '2017-10-03' }] };
    if (/\/tv\/126437/.test(u)) return { id: 126437, name: 'Aoashi', first_air_date: '2022-04-09', seasons: [{ season_number: 0, air_date: '2022-01-01' }, { season_number: 1, air_date: '2022-04-09' }, { season_number: 2, air_date: '2026-01-10' }] };
    return null;
  };
  layout._resetCache();
  let r = await layout.tmdbForAnilist(97986, { fetcher: noAnilist, tmdbFetcher: tmdbDetails, year: 2017, title: 'Black Clover' });
  check('Black Clover -> TMDB 73223, season 1, named', r && r.tmdb === '73223' && r.season === 1 && r.name === 'Black Clover' && r.matchedBy === 'anime-lists', JSON.stringify(r));
  check('...AniList was not asked at all', anilistCalls === 0, String(anilistCalls));
  r = await layout.tmdbForAnilist(175914, { fetcher: noAnilist, tmdbFetcher: tmdbDetails, year: 2026 });
  check('Aoashi Season 2 -> TMDB 126437, season 2 (from the list)', r && r.tmdb === '126437' && r.season === 2, JSON.stringify(r));
  // No season in the list: the TMDB season that aired in the card's year.
  ids._setFetchForTests(async () => [{ anilist_id: 175914, themoviedb_id: { tv: 126437 } }], fs.mkdtempSync(path.join(os.tmpdir(), 'animeids-')));
  layout._resetCache();
  r = await layout.tmdbForAnilist(175914, { fetcher: noAnilist, tmdbFetcher: tmdbDetails, year: 2026 });
  check('season not in the list -> the season that aired in 2026 (S2)', r && r.tmdb === '126437' && r.season === 2, JSON.stringify(r));
  check('...still without asking AniList', anilistCalls === 0, String(anilistCalls));
  // Not in the mapping and AniList down: the reason is said.
  layout._resetCache();
  layout.tmdbForAnilist.lastReason = '';
  r = await layout.tmdbForAnilist(424242, { fetcher: noAnilist, tmdbFetcher: tmdbDetails });
  check('unknown to the mapping + AniList down -> null with the reason', r === null && /AniList did not answer/.test(layout.tmdbForAnilist.lastReason), layout.tmdbForAnilist.lastReason);

  console.log('\n[3] AniList 429 is waited out and retried');
  let n = 0;
  layout._setAnilistRequestForTests(async () => {
    n += 1;
    return n === 1 ? { status: 429, retryAfter: '1', body: null } : { status: 200, body: { data: { Media: { id: 1 } } } };
  });
  const t0 = Date.now();
  const body = await layout.anilistGql('query', {});
  check('429 then 200 -> the answer, not null', body && body.data && body.data.Media.id === 1, JSON.stringify(body));
  check('...after waiting the Retry-After (~1 s)', Date.now() - t0 >= 900, String(Date.now() - t0));
  layout._setAnilistRequestForTests(async () => ({ status: 429, retryAfter: '1', body: null }));
  check('still refused after the retries -> null (never an exception)', (await layout.anilistGql('query', {})) === null);
  layout._setAnilistRequestForTests(null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  process.exit(1);
});
