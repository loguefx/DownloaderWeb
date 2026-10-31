'use strict';

// Every name an anime season goes by, from AniList: the English title the
// plugin sends (TMDB's) is often not the name the anime sites list a season
// under - Link Click S3 is "Shiguang Dailiren III" (Chinese romanization),
// many shows are listed by their Japanese romaji. Given (title, season):
//   1. find the work on AniList by any of its names (English, romaji, native,
//      synonyms) - TV/ONA entries only, never a movie or special;
//   2. for a later season, the entry whose own title names that season
//      ("Link Click Season 3 Part 1"). AniList's sequel chain is NOT used:
//      it counts every split cour and side arc as a season (Link Click's
//      "Bridon Arc", Attack on Titan "Season 3 Part 2" as season 4);
//   3. return that season's names, then the work's own names. The sites
//      match "<work name> + season number" anyway ("Shiguang Dailiren III"),
//      so the work's names alone are enough when no season entry is found.
// Cached for 24 h (also misses). Network errors -> [] (callers keep the
// title they already have).

const layout = require('./anime-layout');
const { seasonOfTitle, baseName } = require('./sites/animevillage_api');

const TTL = 24 * 3600 * 1000;
const cache = new Map(); // "title|season" -> { at, names }
let gql = (q, v) => layout.anilistGql(q, v);

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const SERIES = new Set(['TV', 'TV_SHORT', 'ONA']);

const SEARCH =
  'query($t: String) { Page(perPage: 10) { media(search: $t, type: ANIME) { id format title { english romaji native } synonyms } } }';

function namesOf(m) {
  const t = (m && m.title) || {};
  return [t.english, t.romaji, t.native, ...((m && m.synonyms) || [])].filter(Boolean);
}

async function namesFor(title, season = 1) {
  const t = String(title || '').trim();
  const sn = Number(season) > 0 ? Number(season) : 1;
  if (t.length < 2) return [];
  const key = `${norm(t)}|${sn}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.names;
  let names = [];
  let answered = false;
  try {
    const r = await gql(SEARCH, { t });
    answered = !!(r && r.data);
    const list = (r && r.data && r.data.Page && r.data.Page.media) || [];
    const want = norm(t);
    // The work itself: a series entry one of whose names IS the title (the
    // first season - its sequels name a season in the title).
    const work = list.find((m) => SERIES.has(m.format) && namesOf(m).some((n) => norm(n) === want));
    if (work) {
      let entry = null;
      if (sn > 1) {
        const bases = new Set(namesOf(work).map(baseName).filter(Boolean));
        const r2 = await gql(SEARCH, { t: `${t} season ${sn}` });
        const list2 = (r2 && r2.data && r2.data.Page && r2.data.Page.media) || [];
        entry = list2.find((m) => SERIES.has(m.format) && namesOf(m).some((n) => bases.has(baseName(n)) && seasonOfTitle(n) === sn)) || null;
      }
      names = [...new Set([...(entry ? namesOf(entry) : []), ...namesOf(work)])].filter((n) => norm(n) !== want);
    }
  } catch (e) {
    names = [];
  }
  // A network failure is not "no other names": ask again next time.
  if (answered) cache.set(key, { at: Date.now(), names });
  return names;
}

module.exports = {
  namesFor,
  _setForTests(g) {
    gql = g;
    cache.clear();
  }
};
