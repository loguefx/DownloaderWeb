'use strict';

// Anime Village (animevillage.org) - an anime source with real English dubs
// (each dubbed episode is its own file, audio tagged "eng"), resolved over
// its JSON API without a browser (see animevillage_api.js). The queue asks it
// FIRST for every anime episode, then Aniwave; Vidsrc is not used for anime.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const catalog = require('./animevillage_api');

// The subtitle host wants the same Referer as the CDN, which ffmpeg cannot
// send for a second input - so the chosen track is saved to a local file.
function saveSubtitle(url, headers) {
  return new Promise((resolve) => {
    const dir = path.join(os.tmpdir(), 'wvd-subs');
    const file = path.join(dir, crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.vtt');
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': catalog.UA }, headers), timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (body.length < 5000000) body += d;
      });
      res.on('end', () => {
        if (!/^﻿?WEBVTT/.test(body)) return resolve(null);
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, body, 'utf8');
          resolve(file);
        } catch (e) {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// The English track to embed: SUB mode -> the full English subtitles; DUB
// mode -> only "Forced" ones (on-screen signs/text the dub does not speak).
function pickSubtitle(subtitles, mode) {
  const en = (subtitles || []).filter((s) => s && s.url && (/^en(g|glish)?\b/i.test(String(s.lang || '')) || /^english/i.test(String(s.label || ''))));
  const forced = (s) => /forced/i.test(`${s.label || ''} ${s.url}`);
  if (mode === 'dub') return en.find(forced) || null;
  return en.find((s) => !forced(s) && !/sdh/i.test(String(s.label || ''))) || en.find((s) => !forced(s)) || null;
}

// { title, season, episode, mode } (the job's own numbering) ->
//   { status: 'resolved', detection } | { status: 'none', reason }
async function resolveForJob(ref = {}, { onLog = () => {} } = {}) {
  const mode = ref.mode === 'sub' ? 'sub' : 'dub';
  const tmdbSeason = Number(ref.season) > 0 ? Number(ref.season) : 1;
  const tmdbEpisode = Number(ref.episode);
  if (!ref.title || !(tmdbEpisode > 0)) return { status: 'none', reason: 'no title/episode' };
  // The job's numbers are TMDB's; Anime Village names seasons like Aniwave
  // ("<Title> Season 3"). Translate per episode. An arc Aniwave lists under
  // a name only (Link Click: Bridon Arc) is left to Aniwave.
  // An AniDB-numbered library already uses the anime sites' seasons.
  const src = ref.numbering === 'anime'
    ? await require('../tmdb').animeSourceForAnimeNumbering({ tmdb: ref.tmdb, title: ref.title, season: tmdbSeason, episode: tmdbEpisode })
    : await require('../anime-layout').animeSourceEpisode({
      tmdb: ref.tmdb, title: ref.title, season: tmdbSeason, episode: tmdbEpisode
    });
  if (src.entry) return { status: 'none', reason: `TMDB S${tmdbSeason} is "${src.entry.title}" - looked up on Aniwave` };
  const season = src.season != null ? src.season : tmdbSeason;
  const episode = src.episode;
  if (src.mapped && (season !== tmdbSeason || episode !== tmdbEpisode)) {
    onLog(`Anime Village: TMDB S${tmdbSeason}E${tmdbEpisode} is season ${season} episode ${episode} there.`);
  }
  onLog(`Anime Village: looking up "${ref.title}" S${season}E${episode} (${mode.toUpperCase()})...`);
  const r = await catalog.resolveEpisode({ title: ref.title, season, episode, mode, names: ref.names || [] });
  if (r.status !== 'resolved') {
    onLog(`Anime Village: ${r.reason}.`);
    return { status: 'none', reason: r.reason, notDubbed: r.status === 'no_dub' };
  }
  const st = r.stream;
  const cdn = Object.assign({}, st.headers);
  onLog(
    `Anime Village: using the ${r.category.toUpperCase()} stream of "${r.show.names[0]}" E${r.episode.number}` +
      (mode === 'dub' ? ' (its own English-dub file, not the sub file).' : '.')
  );
  let subtitleUrl;
  const sub = pickSubtitle(st.subtitles, mode);
  if (sub) {
    subtitleUrl = await saveSubtitle(sub.url, cdn);
    onLog(subtitleUrl ? `Embedding the ${sub.label || 'English'} subtitle track.` : `Could not fetch the ${sub.label || 'English'} subtitles; continuing without them.`);
  } else if (mode === 'sub') {
    onLog('Anime Village: no English subtitle track listed for this episode.');
  }
  return {
    status: 'resolved',
    detection: {
      url: st.url,
      type: 'hls',
      embedUrl: st.url,
      // The CDN wants the player's Referer/Origin and nothing from the
      // Electron session: the plain-HTTP segment path with these headers.
      headers: Object.assign({ 'User-Agent': catalog.UA }, cdn),
      plainHttp: true,
      sourceLabel: 'animevillage',
      release: `Anime Village ${r.category.toUpperCase()}: ${r.show.names[0]} E${r.episode.number}`,
      // Proof for the anime-DUB rule: a separate dub file, distinct from the
      // sub one (the post-download audio check still runs).
      dubEvidence: mode === 'dub' ? 'separate-dub-file' : undefined,
      embedSubs: !!subtitleUrl,
      subtitleUrl
    }
  };
}

module.exports = {
  id: 'animevillage',
  name: 'Anime Village',
  match: [/animevillage\./i],
  resolveForJob,
  pickSubtitle,
  _saveSubtitle: saveSubtitle
};
