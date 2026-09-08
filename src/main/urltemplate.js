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
//   ...#ep-12  (hash token used by sites with in-page episode buttons)
// Returns { template, season } where season is parsed if found in the path.
function toTemplate(sampleUrl) {
  let t = String(sampleUrl || '').trim();
  let season = null;

  // Season markers like "3rd-season", "season-3", or Romanian "sezonul-2".
  const sOrdinal = t.match(/(\d+)(?:st|nd|rd|th)[-_\s]*season/i);
  const sPlain = t.match(/season[-_\s]*(\d+)/i);
  const sRo = t.match(/sezonul[-_\s]*(\d+)/i);
  if (sOrdinal) season = parseInt(sOrdinal[1], 10);
  else if (sPlain) season = parseInt(sPlain[1], 10);
  else if (sRo) season = parseInt(sRo[1], 10);

  // Already has a hash episode token (e.g. FilmeHD season pages).
  if (/#ep[=-]?\{?episode\}?/i.test(t) || /#ep[=-]?\d+/i.test(t)) {
    t = t.replace(/#ep[=-]?\d+/i, '#ep-{episode}');
    return { template: t, season };
  }

  // Episode as a query parameter: "?ep=8", "&episode=12", "?e=3". Checked first
  // because HiAnime-style sites (e.g. enma.lol) put the episode in the query while
  // the path carries an unrelated show id (".../the-ramparts-of-ice-186497?ep=8")
  // that the path heuristics below would otherwise mistake for the episode.
  const qMarker = /([?&](?:ep|episode|e)=)(\d+)/i;
  if (qMarker.test(t)) {
    t = t.replace(qMarker, (m, pre) => `${pre}{episode}`);
    return { template: t, season };
  }

  // SFlix (sflix.soap2day.day) must run before the generic `episode-N` marker.
  // Two episode-URL shapes exist on the same site:
  //   /episodes/{slug}-season-1-episode-12/
  //   /episodes/{slug}-s01e01-{title-slug}/
  // Series pages have no episode number at all; hash-tokenize them like FilmeHD
  // so bulk can still probe the series page and then use the real Watch hrefs.
  if (/soap2day\.day|sflixz\.day/i.test(t)) {
    if (/\/episodes\//i.test(t) && /season[-_]\d+/i.test(t) && /episode[-_]\d+/i.test(t)) {
      t = t.replace(/season[-_]\d+/i, 'season-{season}').replace(/episode[-_]\d+/i, 'episode-{episode}');
      return { template: t, season };
    }
    const sxe = t.match(/[sS](\d{1,2})[eE](\d{1,3})/);
    if (/\/episodes\//i.test(t) && sxe) {
      season = parseInt(sxe[1], 10);
      // Drop the leftover episode title so e02 is not built with e01's slug.
      t = t.replace(/[sS]\d{1,2}[eE]\d{1,3}(?:-[^/?#]*)?/, 's{season2}e{episode2}');
      return { template: t, season };
    }
    const series = t.match(/^(https?:\/\/[^/]+)\/series\/([^/?#]+)/i);
    if (series) {
      const origin = series[1];
      const slug = series[2].replace(/\/$/, '');
      return { template: `${origin}/series/${slug}/#ep-{episode}`, season };
    }
    if (!/\/(movies|series|episodes|genre|country|top-imdb|years|release-year)\b/i.test(t)) {
      t = t.replace(/\/?(#.*)?$/, '/') + '#ep-{episode}';
      if (season == null) season = 1;
      return { template: t, season };
    }
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

  // FilmeHD (and similar): season page hosts all episodes as in-page buttons.
  // Encode the episode in the hash so bulk can still generate per-episode URLs
  // without inventing a fake path the site does not serve.
  if (/filmehd\.to/i.test(t) && /\/seriale\//i.test(t) && /sezonul[-_]?\d+/i.test(t)) {
    t = t.replace(/\/?(#.*)?$/, '') + '#ep-{episode}';
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

// Episode number from a Watch URL (Aniwave /ep-N, SFlix sXXeYY or episode-N).
function parseEpisodeFromUrl(url) {
  const s = String(url || '');
  const sxe = s.match(/[sS]\d{1,2}[eE](\d{1,3})/);
  if (sxe) return parseInt(sxe[1], 10);
  const se = s.match(/episode[-_](\d+)/i);
  if (se) return parseInt(se[1], 10);
  const ep = s.match(/\/ep-(\d+)/i);
  if (ep) return parseInt(ep[1], 10);
  return null;
}

module.exports = { fill, toTemplate, buildEpisodeUrl, hasEpisodeToken, parseEpisodeFromUrl };
