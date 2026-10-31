'use strict';

// Anime Village as an anime source (sites/animevillage_api.js + the
// sites/animevillage.js resolver). Fixtures are shaped like the live API
// (Oct 2026); no network:
//   1. search: the site's catalog answers (slug ids) are waited for, AniList
//      answers (numeric ids) only lend their names;
//   2. the right entry per title + season (roman numerals, "Season 2: ...",
//      no specials / movies / [Mini]);
//   3. "dubbed" = the dub stream is a DIFFERENT file from the sub stream;
//   4. the resolver: DUB proof, CDN headers, subtitles (forced only for DUB).

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const av = require(path.join(REPO, 'src/main/sites/animevillage_api'));
const site = require(path.join(REPO, 'src/main/sites/animevillage'));
const animenames = require(path.join(REPO, 'src/main/animenames'));

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

const media = (id, romaji, english, format = 'TV') => ({ id, title: { romaji, english, native: romaji }, synonyms: [], format });
const page = (list, fallback) => Object.assign({ data: { Page: { media: list } } }, fallback ? { _fallback: 'hianime-search' } : {});
const eps = (slug, n) => ({ animeId: slug, totalEpisodes: n, episodes: Array.from({ length: n }, (_, i) => ({ id: `${slug}?ep=${1000 + i + 1}`, number: i + 1 })) });
const stream = (show, file, subs = []) => ({
  headers: { Referer: 'https://megaplay.buzz/', Origin: 'https://megaplay.buzz' },
  sources: [{ url: `https://cdn.example/anime/${show}/${file}/master.m3u8`, isM3U8: true }],
  subtitles: subs
});

// Link Click S3: E1-E10 dubbed (own dub file), E11-E12 dub == sub file.
const LC3 = 'shiguang-dailiren-iii-8854';
const SB = 'smoking-behind-the-supermarket-with-you-e086a-8950';
let searchCalls = 0;
let flaky = 0; // the first N searches answer like a busy AniList (empty)
const API = (p) => {
  const u = new URL('https://x' + p);
  if (u.pathname === '/api/search') {
    searchCalls += 1;
    if (flaky > 0) { flaky -= 1; return page([]); }
    const q = (u.searchParams.get('search') || '').toLowerCase();
    if (q.startsWith('link click')) {
      // AniList answers with English names but numeric ids.
      return page([media(126403, 'Shiguang Dailiren', 'Link Click', 'ONA'), media(191832, 'Shiguang Dailiren III Part 1', 'Link Click Season 3 Part 1', 'ONA'), media(136145, 'Shiguang Dailiren Special', 'LINK CLICK Episode 5.5', 'SPECIAL')]);
    }
    if (q.startsWith('shiguang dailiren')) {
      return page([media('link-click-2e0jm-6769', 'Shiguang Daili Ren', 'Shiguang Daili Ren', 'ONA'), media(LC3, 'Shiguang Dailiren III', 'Shiguang Dailiren III', 'ONA'), media('mini-link-click-nmgts-8758', 'Shiguang Xiao Juchang', 'Shiguang Xiao Juchang', 'ONA')], true);
    }
    if (q.startsWith('smoking behind')) {
      return page([media(SB, 'Super no Ura de Yani Suu Futari', 'Super no Ura de Yani Suu Futari'), media('smoking-behind-the-supermarket-with-you-8851', '[Mini] Super no Ura de Yani Suu Futari', '[Mini] Super no Ura de Yani Suu Futari', 'TV_SHORT')], true);
    }
    if (q.startsWith('the girl downstairs')) {
      return page([media('the-girl-downstairs-9eddv-6483', 'Aishang Ta de Liyou', 'Aishang Ta de Liyou', 'ONA')], true);
    }
    if (q.startsWith('solo leveling')) {
      return page([media('solo-leveling-ilh08-6224', 'Ore dake Level Up na Ken', 'Ore dake Level Up na Ken'), media('solo-leveling-specials-701ip-5972', 'Ore dake Level Up na Ken: Specials', 'x', 'SPECIAL'), media('solo-leveling-season-2-arise-from-the-shadow-3eukp-7457', 'Ore dake Level Up na Ken Season 2: Arise from the Shadow', 'x')], true);
    }
    return page([], true);
  }
  if (u.pathname === '/api/episodes/the-girl-downstairs-9eddv-6483') return { error: 'Anime not found', episodes: [] };
  if (u.pathname === '/api/episodes/the-girl-downstairs-9eddv-6483/info') return { id: 'the-girl-downstairs-9eddv-6483', totalEpisodes: 22, hasDub: false, hasSub: true };
  let m = u.pathname.match(/^\/api\/episodes\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (id === LC3) return eps(LC3, 12);
    if (id === SB) {
      const e = eps(SB, 12);
      e.episodes.splice(10, 0, { id: `${SB}?ep=1999`, number: 10.5 }); // a recap
      return e;
    }
    if (/^\d+$/.test(id)) return { error: 'Failed to fetch episodes' };
    return eps(id, 12);
  }
  m = u.pathname.match(/^\/api\/stream\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const ep = Number(u.searchParams.get('ep')) - 1000;
    const cat = u.searchParams.get('category');
    if (id === LC3) {
      if (ep === 7 && u.searchParams.get('server') === 'hd-1') return { error: 'Streaming server down' };
      const file = cat === 'dub' && ep <= 10 ? `dub${ep}` : `sub${ep}`;
      return stream('lc3', file, cat === 'sub' ? [{ url: 'https://subs.example/eng.vtt', lang: 'en', label: 'English' }] : [{ url: 'https://subs.example/sdh.vtt', lang: 'en', label: 'English (SDH)' }]);
    }
    if (id === SB) {
      return stream('sb', `${cat}${ep}`, cat === 'dub'
        ? [{ url: 'https://subs.example/forced.vtt', lang: 'en', label: 'English (Forced)' }, { url: 'https://subs.example/chi.vtt', lang: 'chinese', label: 'Chinese' }]
        : [{ url: 'https://subs.example/cr.vtt', lang: 'en', label: 'English (CR)' }]);
    }
  }
  return null;
};

async function main() {
  av._setGetForTests(async (p) => API(p));

  console.log('\n[1] Names, seasons');
  check('roman numeral season', av.seasonOfTitle('Shiguang Dailiren III') === 3 && av.baseName('Shiguang Dailiren III') === 'shiguang dailiren');
  check('"Part 1" is not a season', av.seasonOfTitle('Link Click Season 3 Part 1') === 3 && av.baseName('Link Click Season 3 Part 1') === 'link click');
  check('slug with a season subtitle', av.baseName('solo leveling season 2 arise from the shadow') === 'solo leveling' && av.seasonOfTitle('solo leveling season 2 arise from the shadow') === 2);

  console.log('\n[2] The right entry per title + season');
  let show = await av.findShow('Smoking Behind the Supermarket with You', 1);
  check('Smoking Behind -> the series (not the [Mini] shorts)', show && show.id === SB, show && show.id);
  show = await av.findShow('Link Click', 3);
  check('Link Click S3 -> the catalog entry, found via AniList\'s romaji name', show && show.id === LC3, show && show.id);
  show = await av.findShow('Solo Leveling', 2);
  check('Solo Leveling S2 -> "Season 2: Arise from the Shadow"', show && show.id === 'solo-leveling-season-2-arise-from-the-shadow-3eukp-7457', show && show.id);
  show = await av.findShow('Solo Leveling', 1);
  check('Solo Leveling S1 -> the base entry (not Specials)', show && show.id === 'solo-leveling-ilh08-6224', show && show.id);
  check('a show that is not there -> null', (await av.findShow('Nowhere Show', 1)) === null);
  av._clearCache();
  flaky = 2;
  searchCalls = 0;
  show = await av.findShow('Smoking Behind the Supermarket with You', 1);
  check('a busy search (empty answers) is retried', show && show.id === SB && searchCalls === 3, 'calls=' + searchCalls);

  console.log('\n[3] Dubbed = its own dub file');
  const map = await av.dubMap('Link Click', 3);
  check('Link Click S3: E1-E10 dubbed, E11-E12 not', map && [...map].filter(([, d]) => d).length === 10 && map.get(11) === false && map.get(12) === false, map && JSON.stringify([...map]));
  check('a server that is down (hd-1) falls back to hd-2', map && map.get(7) === true);
  let r = await av.resolveEpisode({ title: 'Link Click', season: 3, episode: 12, mode: 'dub' });
  check('DUB of an undubbed episode -> no_dub (the sub file is never taken)', r.status === 'no_dub', r.status);
  let dm = await av.dubMap('Nowhere Show', 1, { only: [1, 2] });
  check('a show the catalog does not list -> no dub here (false), not unknown', dm && dm.get(1) === false && dm.get(2) === false, dm && JSON.stringify([...dm]));
  dm = await av.dubMap('Link Click', 3, { only: [12, 13] });
  check('an episode not listed yet -> false', dm && dm.get(12) === false && dm.get(13) === false, dm && JSON.stringify([...dm]));
  av._clearCache();
  flaky = 99; // the search never answers usefully
  dm = await av.dubMap('Smoking Behind the Supermarket with You', 1, { only: [1] });
  flaky = 0;
  check('search never answered -> unknown (null), never "not dubbed"', dm === null, dm && JSON.stringify([...dm]));
  r = await av.resolveEpisode({ title: 'Link Click', season: 3, episode: 13, mode: 'dub' });
  check('an episode that is not out -> no_episode', r.status === 'no_episode', r.status);

  console.log('\n[3b] Recaps and shows without a dub');
  const sbEps = await av.episodes(SB);
  check('a "10.5" recap is not an episode', sbEps && sbEps.length === 12 && !sbEps.some((e) => !Number.isInteger(e.number)));
  dm = await av.dubMap('The Girl Downstairs', 1, { only: [1, 2] });
  check('episode list broken but the show says hasDub:false -> not dubbed', dm && dm.get(1) === false && dm.get(2) === false, dm && JSON.stringify([...dm]));
  r = await av.resolveEpisode({ title: 'The Girl Downstairs', season: 1, episode: 3, mode: 'dub' });
  check('...and a DUB request says no dub (not "unreachable")', r.status === 'no_dub', r.status);

  console.log('\n[4] The resolver');
  const saved = [];
  const logs = [];
  let out = await site.resolveForJob({ title: 'Link Click', season: 3, episode: 12, mode: 'dub' }, { onLog: (m) => logs.push(m) });
  check('no dub -> none, says why', out.status === 'none' && out.notDubbed && logs.some((m) => /no English dub of "Shiguang Dailiren III" E12/.test(m)), logs.join(' | '));
  const pick = site.pickSubtitle;
  check('DUB: only the Forced English track', (pick([{ url: 'a', lang: 'en', label: 'English (Forced)' }, { url: 'b', lang: 'en', label: 'English' }], 'dub') || {}).url === 'a');
  check('DUB: no forced track -> no subtitles (not the full ones)', pick([{ url: 'b', lang: 'en', label: 'English (SDH)' }], 'dub') === null);
  check('SUB: the full English track, not Forced/SDH', (pick([{ url: 'a', lang: 'en', label: 'English (Forced)' }, { url: 's', lang: 'en', label: 'English (SDH)' }, { url: 'b', lang: 'en', label: 'English (CR)' }], 'sub') || {}).url === 'b');
  // Resolve without touching the network for the subtitle file.
  const https = require('https');
  const realGet = https.get;
  https.get = (url, opts, cb) => {
    saved.push({ url, referer: opts && opts.headers && opts.headers.Referer });
    const { PassThrough } = require('stream');
    const res = new PassThrough();
    res.statusCode = 200;
    res.setEncoding = () => {};
    process.nextTick(() => { cb(res); res.end('WEBVTT\n\n00:00.000 --> 00:01.000\nSign\n'); });
    return { on() { return this; }, destroy() {} };
  };
  try {
    out = await site.resolveForJob({ title: 'Smoking Behind the Supermarket with You', season: 1, episode: 4, mode: 'dub' }, { onLog: () => {} });
  } finally {
    https.get = realGet;
  }
  const d = out.detection || {};
  check('DUB resolved with proof of the dub file', out.status === 'resolved' && d.dubEvidence === 'separate-dub-file' && /\/dub4\/master\.m3u8$/.test(d.url), JSON.stringify(d).slice(0, 200));
  check('CDN headers: Referer + Origin, plain HTTP (no session cookies)', d.headers && d.headers.Referer === 'https://megaplay.buzz/' && d.headers.Origin && d.plainHttp === true);
  check('forced English subtitles fetched with the Referer and embedded', d.embedSubs && d.subtitleUrl && fs.existsSync(d.subtitleUrl) && saved[0] && saved[0].url === 'https://subs.example/forced.vtt' && saved[0].referer === 'https://megaplay.buzz/', JSON.stringify(saved));
  check('labelled for the logs and the skip list', d.sourceLabel === 'animevillage' && /Anime Village DUB/.test(d.release || ''));

  console.log('\n[5] Original-language names (AniList) when the English title is not listed');
  // AniList: "Time Agent" is Link Click's alternate English name; its romaji
  // is how the catalog lists it. Season 3's own entry names the season.
  const gqlCalls = [];
  animenames._setForTests(async (q, v) => {
    gqlCalls.push(v.t);
    const m = (id, format, english, romaji, syn = []) => ({ id, format, title: { english, romaji, native: '时光代理人' }, synonyms: syn });
    if (/season 3/i.test(v.t)) return { data: { Page: { media: [m(3, 'ONA', 'Link Click Season 3 Part 1', 'Shiguang Dailiren III Part 1'), m(9, 'MOVIE', 'Link Click Movie', 'Shiguang Dailiren Movie')] } } };
    if (/time agent/i.test(v.t)) return { data: { Page: { media: [m(7, 'SPECIAL', 'x', 'Shiguang Dailiren Special', ['Time Agent']), m(1, 'ONA', 'Link Click', 'Shiguang Dailiren', ['Time Agent'])] } } };
    return { data: { Page: { media: [] } } };
  });
  const nm = await animenames.namesFor('Time Agent', 3);
  check('AniList: the work found by an alternate name, season 3 entry first', nm[0] === 'Link Click Season 3 Part 1' && nm.includes('Shiguang Dailiren') && !nm.includes('Time Agent'), JSON.stringify(nm));
  check('...movies/specials are never taken as the work', !nm.some((n) => /Movie|Special/.test(n)), JSON.stringify(nm));
  const callsBefore = gqlCalls.length;
  await animenames.namesFor('Time Agent', 3);
  check('...cached', gqlCalls.length === callsBefore);
  av._clearCache();
  show = await av.findShow('Time Agent', 3);
  check('Anime Village: "Time Agent" S3 found through its romaji name', show && show.id === LC3, show && show.id);
  animenames._setForTests(async () => null); // AniList unreachable
  check('AniList unreachable -> no names, nothing cached', (await animenames.namesFor('Nowhere', 1)).length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  process.exit(1);
});
