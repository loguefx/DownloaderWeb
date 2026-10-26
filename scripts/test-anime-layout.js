'use strict';

// Tests for the anime season-layout resolver (anime-layout.js).
//
// Covers:
//   1. mapEpisode - the pure Aniwave/AniList -> TMDB number mapping
//      (identity, exact cumulative mapping, and the "never guess" guards);
//   2. aniwaveSeasons - season probing, the season-param-ignored guard,
//      and negative caching;
//   3. anilistSeasons - season split from relations, the title-match guard;
//   4. resolveLayout / urlMapFor - tiering with mocked network;
//   5. static guarantee: this module never touches the disk (add-only).
//
// No network: every fetcher is mocked.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'test-key';

const mod = require(path.join(__dirname, '..', 'src', 'main', 'anime-layout.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail != null ? ' -- ' + JSON.stringify(detail) : ''));
  }
}
const mk = (season, n) => ({ season, episodes: Array.from({ length: n }, (_, i) => ({ episode: i + 1, name: '' })), year: '' });

(async () => {
  console.log('\n[1] mapEpisode: identity cases (never guess)');
  {
    const aw = [mk(1, 12), mk(2, 10)];
    const m = mod.mapEpisode(aw, aw, 2, 7);
    check('identical layout -> identity', m.season === 2 && m.episode === 7 && m.mapped === false, m);
    const t = [{ season: 1, episodes: 12 }, { season: 2, episodes: 10 }];
    const m2 = mod.mapEpisode(aw, t, 1, 3);
    check('identical shape (array vs count) -> identity', m2.season === 1 && m2.episode === 3 && m2.mapped === false, m2);
  }
  {
    check('no authoritative data -> identity', (() => { const m = mod.mapEpisode(null, [{ season: 1, episodes: 12 }], 1, 3); return m.season === 1 && m.episode === 3 && !m.mapped; })());
    check('no TMDB data -> identity', (() => { const m = mod.mapEpisode([mk(1, 12)], null, 1, 3); return m.season === 1 && m.episode === 3 && !m.mapped; })());
    check('out of range -> identity', (() => { const m = mod.mapEpisode([mk(1, 12)], [{ season: 1, episodes: 12 }], 9, 3); return m.season === 9 && m.episode === 3; })());
    check('totals differ -> identity (never invent)', (() => {
      const m = mod.mapEpisode([mk(1, 12), mk(2, 10)], [{ season: 1, episodes: 24 }], 2, 1);
      return m.season === 2 && m.episode === 1 && !m.mapped;
    })());
  }

  console.log('\n[2] mapEpisode: exact cumulative mapping (same total, different split)');
  {
    // Aniwave: S1=12, S2=10   TMDB: S1=22 (one merged season)
    const aw = [mk(1, 12), mk(2, 10)];
    const tm = [{ season: 1, episodes: 22 }];
    const a = mod.mapEpisode(aw, tm, 1, 5);
    check('S1E5 stays S1E5', a.season === 1 && a.episode === 5, a);
    const b = mod.mapEpisode(aw, tm, 2, 1);
    check('S2E1 -> S1E13', b.season === 1 && b.episode === 13 && b.mapped === true, b);
    const c = mod.mapEpisode(aw, tm, 2, 10);
    check('S2E10 -> S1E22', c.season === 1 && c.episode === 22, c);
  }
  {
    // Jujutsu-kaisen shape: Aniwave 13+12+13, TMDB 25+13
    const aw = [mk(1, 13), mk(2, 12), mk(3, 13)];
    const tm = [{ season: 1, episodes: 25 }, { season: 2, episodes: 13 }];
    const a = mod.mapEpisode(aw, tm, 2, 1);
    check('S2E1 -> S1E14', a.season === 1 && a.episode === 14 && a.mapped === true, a);
    const b = mod.mapEpisode(aw, tm, 3, 1);
    check('S3E1 -> S2E1', b.season === 2 && b.episode === 1, b);
    const c = mod.mapEpisode(aw, tm, 3, 13);
    check('S3E13 -> S2E13', c.season === 2 && c.episode === 13, c);
  }

  console.log('\n[2b] addMissingSeasons: never override a TMDB count');
  {
    // The real-world failure: AniList says 24 for both seasons; TMDB says 12/12.
    const tmdb = [{ season: 1, episodes: 12 }, { season: 2, episodes: 12 }];
    const anilist = [mk(1, 24), mk(2, 24)];
    const out = mod.addMissingSeasons(tmdb, anilist);
    check('TMDB counts survive AniList inflation', out.length === 2 && out[0].episodes === 12 && out[1].episodes === 12, out);

    // The case AniList still earns: a season TMDB does not list yet.
    const out2 = mod.addMissingSeasons([{ season: 1, episodes: 12 }], [mk(1, 12), mk(2, 12)]);
    check('missing season is added', out2.length === 2 && out2[1].season === 2 && out2[1].episodes === 12, out2);

    // Empty base takes whatever the other source knows.
    const out3 = mod.addMissingSeasons([], [mk(1, 25)]);
    check('empty base takes the extra', out3.length === 1 && out3[0].episodes === 25, out3);
  }

  console.log('\n[2c] TV / live-action protection');
  {
    // Netflix-style live-action "One Piece": TMDB lists 1 season (10 eps);
    // the same-titled anime is one giant entry. The TV season must NOT be
    // inflated by the anime.
    const out = mod.addMissingSeasons([{ season: 1, episodes: 10 }], [mk(1, 1100)]);
    check('live-action count not inflated by a same-titled anime', out.length === 1 && out[0].episodes === 10, out);

    // A multi-season TV show keeps every count even if an anime with the
    // same name exists.
    const out2 = mod.addMissingSeasons(
      [{ season: 1, episodes: 10 }, { season: 2, episodes: 10 }],
      [mk(1, 1100), mk(2, 500)]
    );
    check('multi-season TV layout survives a same-titled anime', out2.length === 2 && out2[0].episodes === 10 && out2[1].episodes === 10, out2);
  }

  console.log('\n[3] aniwaveSeasons: probing, repeat guard, negative cache');
  {
    const calls = [];
    const fetcher = async (u) => {
      calls.push(u);
      const m = String(u).match(/season=(\d+)/);
      const n = m ? Number(m[1]) : 1;
      if (n === 1) return { result: [{ ep: 1, name: 'First' }, { ep: 2, name: 'Second' }] };
      if (n === 2) return { result: [{ ep: 1, name: 'Cour2-1' }] };
      return null; // season 3 does not exist
    };
    mod._resetCache();
    const out = await mod.aniwaveSeasons('123456', { fetcher });
    check('two seasons returned', out && out.length === 2, out && out.length);
    check('season 1 episodes normalized', out && out[0].season === 1 && out[0].episodes.length === 2 && out[0].episodes[0].name === 'First');
    check('season 2 normalized', out && out[1].season === 2 && out[1].episodes.length === 1);

    // season parameter ignored by the build: same list every time -> 1 season
    mod._resetCache();
    const repeat = await mod.aniwaveSeasons('654321', { fetcher: async () => ({ result: [{ ep: 1 }, { ep: 2 }] }) });
    check('repeating season list is not 12 fake seasons', repeat && repeat.length === 1, repeat && repeat.length);

    // negative cache: total failure caches null, second call makes no HTTP
    mod._resetCache();
    let hits = 0;
    const dead = async (u) => { hits++; return null; };
    const r1 = await mod.aniwaveSeasons('999999', { fetcher: dead });
    const firstHits = hits;
    const r2 = await mod.aniwaveSeasons('999999', { fetcher: dead });
    check('unknown title -> null', r1 === null && r2 === null);
    check('negative cache stops re-probing', hits === firstHits, { firstHits, hits });
  }

  console.log('\n[4] anilistSeasons: split, title guard, best-match, miss');
  {
    // Search surfaces a spinoff FIRST; the strict guard must pick the real work.
    const gql = async (q, v) => {
      if (q.includes('search')) {
        return { data: { Media: [
          { id: 77, title: { english: 'Golden Kamuy: The Sequel Saga', romaji: '' }, episodes: 12, seasonYear: 2024 },
          { id: 1, title: { english: 'Golden Kamuy', romaji: '' }, episodes: 12, seasonYear: 2018 }
        ] } };
      }
      return { data: { Media: { relations: { edges: [
        { relationType: 'SEQUEL', node: { id: 2, episodes: 12, seasonYear: 2020, title: { english: 'Golden Kamuy Season 2', romaji: '' } } },
        { relationType: 'CHARACTER', node: { id: 9, episodes: 12, seasonYear: 2018, title: { english: 'someone', romaji: '' } } }
      ] } } } };
    };
    mod._resetCache();
    const out = await mod.anilistSeasons('Golden Kamuy', { fetcher: gql });
    check('best match wins over a spinoff listed first', out && out[0].episodes.length === 12 && out.length === 2, out && out.length);
    check('episodes synthesized 1..count', out && out[0].episodes.length === 12 && out[0].episodes[11].episode === 12);

    // "Succession" TV show: only a different work matches -> rejected.
    mod._resetCache();
    const mismatch = await mod.anilistSeasons('Succession', { fetcher: async (q) => q.includes('search') ? { data: { Media: [
      { id: 3, title: { english: 'B: The Beginning: Succession', romaji: '' }, episodes: 6, seasonYear: 2021 }
    ] } } : { data: { Media: { relations: { edges: [] } } } } });
    check('similar-name different work is rejected', mismatch === null);

    // "Jujutsu Kaisen": a later same-prefix work must not win.
    mod._resetCache();
    const jk = await mod.anilistSeasons('Jujutsu Kaisen', { fetcher: async (q) => q.includes('search') ? { data: { Media: [
      { id: 5, title: { english: null, romaji: 'Jujutsu Kaisen: Shimetsu Kaiyuu - Kouhen' }, episodes: 12, seasonYear: 2026 },
      { id: 6, title: { english: 'Jujutsu Kaisen', romaji: '' }, episodes: 24, seasonYear: 2020 }
    ] } } : { data: { Media: { relations: { edges: [] } } } } });
    check('exact-title work beats the same-prefix spinoff', jk && jk[0].episodes.length === 24, jk && jk[0] && jk[0].episodes.length);

    mod._resetCache();
    const miss = await mod.anilistSeasons('No Such Anime Title', { fetcher: async () => ({ data: { Media: [] } }) });
    check('search miss -> null', miss === null);

    // Direct-id path: with a known AniList id, NO search is performed at all.
    mod._resetCache();
    const byId = await mod.anilistSeasons('Whatever The Title Says', {
      anilistId: '16498',
      fetcher: async (q) => {
        if (q.includes('relations')) return { data: { Media: { relations: { edges: [] } } } };
        if (q.includes('Media(id: $id')) return { data: { Media: { id: 16498, title: { english: 'Attack on Titan', romaji: '' }, episodes: 25, seasonYear: 2013 } } };
        throw new Error('search must not be called when anilistId is given');
      }
    });
    check('direct id path skips the search entirely', byId && byId[0].episodes.length === 25, byId && byId.length);
  }

  console.log('\n[5] resolveLayout: tiering (Aniwave -> AniList -> null)');
  {
    const both = async (a, b) => {
      if (typeof a === 'string' && a.startsWith('http')) {
        // Aniwave tier
        if (a.includes('season=1')) return { result: [{ ep: 1, name: 'x' }, { ep: 2, name: 'y' }] };
        if (a.includes('season=2')) return { result: [{ ep: 1, name: 'z' }] };
        return null;
      }
      // AniList tier
      if (a.includes('search')) return { data: { Media: null } };
      return { data: { Media: { relations: { edges: [] } } } };
    };
    mod._resetCache();
    const r1 = await mod.resolveLayout('555555', 'Some Anime', { anime: true, fetcher: both });
    check('Aniwave wins when it answers', r1 && r1.source === 'aniwave' && r1.seasons.length === 2, r1 && r1.source);

    const awDead = async (a, b) => {
      if (typeof a === 'string' && a.startsWith('http')) return null;
      if (a.includes('search')) return { data: { Media: [{ id: 1, title: { english: 'Some Anime', romaji: '' }, episodes: 12, seasonYear: 2020 }] } };
      return { data: { Media: { relations: { edges: [{ relationType: 'SEQUEL', node: { id: 2, episodes: 12, seasonYear: 2021, title: { english: 'x', romaji: '' } } }] } } } };
    };
    mod._resetCache();
    const r2 = await mod.resolveLayout('555556', 'Some Anime', { anime: true, fetcher: awDead });
    check('AniList wins when Aniwave is dead (anime flag)', r2 && r2.source === 'anilist' && r2.seasons.length === 2, r2 && r2.source);
    mod._resetCache();
    const r3 = await mod.resolveLayout('555556', 'Some Anime', { anime: false, fetcher: awDead });
    check('no anime flag + AniList dead -> null (TMDB fallback)', r3 === null);
  }

  console.log('\n[6] urlMapFor: mapper or identity');
  {
    // Aniwave split differs from TMDB, SAME total -> real mapper
    // (Aniwave S1:2 + S2:3; TMDB one merged S1:5)
    const fetcher = async (a, b) => {
      if (typeof a === 'string' && a.startsWith('http')) {
        if (a.includes('api.themoviedb.org')) {
          return { id: 111111, seasons: [{ season_number: 1, episode_count: 5, air_date: '2020-01-01' }] };
        }
        if (a.includes('season=1')) return { result: [{ ep: 1 }, { ep: 2 }] };
        if (a.includes('season=2')) return { result: [{ ep: 1 }, { ep: 2 }, { ep: 3 }] };
        return null;
      }
      if (a.includes('search')) return { data: { Media: null } };
      return { data: { Media: { relations: { edges: [] } } } };
    };
    mod._resetCache();
    const map = await mod.urlMapFor('111111', 'Map Test Anime', { anime: true, fetcher });
    check('mapper exists when layouts differ', typeof map === 'function');
    const m = map(2, 2);
    check('mapped pair points at TMDB numbers (S2E2 -> S1E4)', m.season === 1 && m.episode === 4 && m.mapped === true, m);
    const m1 = map(2, 1);
    check('S2E1 -> S1E3', m1.season === 1 && m1.episode === 3, m1);
    const m0 = map(1, 1);
    check('season 1 pair unchanged', m0.season === 1 && m0.episode === 1, m0);

    // Layouts agree -> no mapper (identity)
    const same = async (a, b) => {
      if (typeof a === 'string' && a.startsWith('http')) {
        if (a.includes('api.themoviedb.org')) {
          return { id: 222222, seasons: [{ season_number: 1, episode_count: 3, air_date: '2020-01-01' }, { season_number: 2, episode_count: 2, air_date: '2021-01-01' }] };
        }
        if (a.includes('season=1')) return { result: [{ ep: 1 }, { ep: 2 }, { ep: 3 }] };
        if (a.includes('season=2')) return { result: [{ ep: 1 }, { ep: 2 }] };
        return null;
      }
      if (a.includes('search')) return { data: { Media: null } };
      return { data: { Media: { relations: { edges: [] } } } };
    };
    mod._resetCache();
    const map2 = await mod.urlMapFor('222222', 'Same Layout Anime', { anime: true, fetcher: same });
    check('no mapper when layouts already agree', map2 === null);
  }

  console.log('\n[8] TV shows: AniList is never consulted without the anime flag');
  {
    mod._resetCache();
    let anilistCalls = 0;
    const fetcher = async (a, b) => {
      if (typeof a === 'string' && a.startsWith('http')) return null; // Aniwave dead
      anilistCalls++; // any GraphQL call = AniList was consulted
      return { data: { Media: [] } };
    };
    const r = await mod.resolveLayout('79541', 'Succession', { anime: false, allowAnilist: false, fetcher });
    check('unflagged multi-season title falls through to TMDB', r === null);
    check('AniList never consulted for an unflagged TV show', anilistCalls === 0, anilistCalls);
  }

  console.log('\n[7] add-only: anime-layout.js never touches the disk');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'anime-layout.js'), 'utf8');
    const banned = ["require('fs')", 'require("fs")', 'writeFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'appendFileSync'];
    let clean = true;
    for (const b of banned) {
      if (src.includes(b)) { clean = false; console.log('        banned token found: ' + b); }
    }
    check('no disk I/O calls in the layout module', clean);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
