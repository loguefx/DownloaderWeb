'use strict';

// Token-based URL templates so episode URLs of any shape can be generated.
// Supported tokens: {episode} {season} {series} {slug} {id}
// Episode/season are zero-padding aware via {episode2} / {season2} (2-digit).

const TOKEN_RE = /\{(episode|season|series|slug|id)(\d+)?\}/gi;

function pad(value, width) {
  const s = String(value);
  return width && s.length < width ? '0'.repeat(width - s.length) + s : s;
}

function fill(template, vars) {
  return String(template).replace(TOKEN_RE, (m, name, width) => {
    const key = name.toLowerCase();
    const v = vars[key];
    if (v == null || v === '') return m;
    return pad(v, width ? parseInt(width, 10) : 0);
  });
}

function hasEpisodeToken(template) {
  return /\{episode\d*\}/i.test(String(template));
}

// Converts a pasted sample episode URL into a template by tokenizing the
// episode number (and a season marker if present). Handles common shapes:
//   .../ep-12  .../episode-12  .../ep_12  .../e12  .../12 (trailing)
// Returns { template, season } where season is parsed if found in the path.
function toTemplate(sampleUrl) {
  let t = String(sampleUrl || '').trim();
  let season = null;

  // Season markers like "3rd-season" or "season-3".
  const sOrdinal = t.match(/(\d+)(?:st|nd|rd|th)[-_\s]*season/i);
  const sPlain = t.match(/season[-_\s]*(\d+)/i);
  if (sOrdinal) season = parseInt(sOrdinal[1], 10);
  else if (sPlain) season = parseInt(sPlain[1], 10);

  // Episode as a query parameter: "?ep=8", "&episode=12", "?e=3". Checked first
  // because HiAnime-style sites (e.g. enma.lol) put the episode in the query while
  // the path carries an unrelated show id (".../the-ramparts-of-ice-186497?ep=8")
  // that the path heuristics below would otherwise mistake for the episode.
  const qMarker = /([?&](?:ep|episode|e)=)(\d+)/i;
  if (qMarker.test(t)) {
    t = t.replace(qMarker, (m, pre) => `${pre}{episode}`);
    return { template: t, season };
  }

  // Episode token: prefer an explicit ep/episode marker at the end.
  const epMarker = /(ep(?:isode)?|e)[-_]?(\d+)(\/?)((?:[?#].*)?)$/i;
  if (epMarker.test(t)) {
    t = t.replace(epMarker, (m, word, _num, slash, tail) => `${word}-{episode}${slash}${tail}`);
    return { template: t, season };
  }

  // Fallback: a bare trailing number in the path.
  const trailingNum = /(\/)(\d+)(\/?)((?:[?#].*)?)$/;
  if (trailingNum.test(t)) {
    t = t.replace(trailingNum, (m, slash1, _num, slash2, tail) => `${slash1}{episode}${slash2}${tail}`);
    return { template: t, season };
  }

  // No episode marker found; return as-is (caller will warn).
  return { template: t, season };
}

// Builds the episode URL for an entry. Prefers an explicit template; otherwise
// derives one from a pasted sample URL.
function buildEpisodeUrl(entry, episode) {
  let template = entry.template;
  if (!template && entry.baseUrl) template = toTemplate(entry.baseUrl).template;
  if (!template) return null;
  if (!hasEpisodeToken(template) && entry.baseUrl) {
    // baseUrl provided but couldn't be tokenized
    return null;
  }
  return fill(template, {
    episode,
    season: entry.season,
    series: entry.series,
    slug: entry.slug,
    id: entry.id
  });
}

module.exports = { fill, toTemplate, buildEpisodeUrl, hasEpisodeToken };
