'use strict';

// Audio-language evidence for the DUB / SUB toggle.
//
// DUB means English audio. SUB means the original audio with English
// subtitles (an English-language title needs no subtitles to qualify).
//
// Sources that serve ONE fixed file per episode (Vidsrc and friends) have no
// dub/sub switch, so the engine has to look at what it is about to download.
// Evidence, strongest first:
//   1. language tags on the audio streams themselves (ffprobe);
//   2. the HLS master playlist's #EXT-X-MEDIA renditions (LANGUAGE=...);
//   3. the release name ("... Dual Audio ...", "... JPN ...") - a guess.
// With no evidence the verdict is 'unknown', and callers keep their old
// behaviour: nothing is rejected on a guess.

// ISO 639 / common spellings -> 'en' or the code itself.
function normLang(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t || t === 'und' || t === 'unk' || t === 'mul' || t === 'zxx') return '';
  if (/^(en|eng|english)([-_].*)?$/.test(t)) return 'en';
  if (/^(ja|jp|jpn|japanese)([-_].*)?$/.test(t)) return 'ja';
  return t.split(/[-_]/)[0];
}

// #EXT-X-MEDIA entries of a master playlist.
//   -> { audio: [{ lang, name, uri, isDefault }], subtitles: [{ lang, name, uri, forced }] }
// `base` resolves relative URIs.
function parseHlsMedia(masterText, base) {
  const out = { audio: [], subtitles: [] };
  for (const line of String(masterText || '').split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/i.test(line.trim())) continue;
    const attrs = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
    let m;
    while ((m = re.exec(line))) attrs[m[1].toUpperCase()] = m[3] != null ? m[3] : m[2];
    const type = String(attrs.TYPE || '').toUpperCase();
    let uri = attrs.URI || '';
    if (uri && base) {
      try {
        uri = new URL(uri, base).toString();
      } catch (e) {
        /* keep as-is */
      }
    }
    const entry = {
      lang: normLang(attrs.LANGUAGE || ''),
      name: attrs.NAME || '',
      uri
    };
    // A NAME like "English" / "Japanese" is a usable language hint too.
    if (!entry.lang) entry.lang = normLang(entry.name);
    if (type === 'AUDIO') {
      entry.isDefault = /^yes$/i.test(attrs.DEFAULT || '');
      out.audio.push(entry);
    } else if (type === 'SUBTITLES') {
      entry.forced = /^yes$/i.test(attrs.FORCED || '');
      out.subtitles.push(entry);
    }
  }
  return out;
}

// Release-name guess. Store names (Crunchyroll, Netflix, Hulu, HIDIVE) are
// NOT dub evidence: their WEB-DLs are usually the original audio. "CR" alone
// is Crunchyroll, i.e. Japanese audio unless the name also says dub/dual.
// A bare "English"/"Eng" in a release name is the audio language
// ("... AAC 2.0 English - HONE"), except as part of "English subs".
const NAME_DUB = /\b(dub|dubbed|english|eng)\b/i;
const NAME_ENGLISH_SUBS = /\b(english|eng)[ ._-]?(sub|subs|subbed|subtitles?|softsubs?|hardsubs?)\b/gi;
const NAME_MULTI = /\b(dual[ ._-]?audio|multi[ ._-]?audio|multi|dual)\b/i;
const NAME_ORIGINAL = /\b(jpn|jap|japanese|raw|cr|vostfr|kor|korean|chi|chinese)\b/i;

function classifyFileName(name) {
  const n = String(name || '');
  if (!n) return 'unknown';
  if (NAME_MULTI.test(n)) return 'multi';
  if (NAME_DUB.test(n.replace(NAME_ENGLISH_SUBS, ' '))) return 'english';
  if (NAME_ORIGINAL.test(n)) return 'foreign';
  return 'unknown';
}

// Verdict from a set of audio languages ('' = untagged).
function verdictFromLangs(langs) {
  const tagged = (langs || []).filter(Boolean);
  if (!tagged.length) return null;
  const hasEn = tagged.includes('en');
  const hasOther = tagged.some((l) => l !== 'en');
  if (hasEn && hasOther) return 'multi';
  return hasEn ? 'english' : 'foreign';
}

// -> { verdict: 'english'|'foreign'|'multi'|'unknown', evidence, langs }
//   streamLangs - audio language tags probed from the media ('' = untagged);
//                 its LENGTH is the number of audio tracks actually in the
//                 stream (pass null when the stream was not probed)
//   media       - parseHlsMedia() result (or null)
//   fileName    - release name (or '')
function audioVerdict({ streamLangs = [], media = null, fileName = '' } = {}) {
  const fromStreams = verdictFromLangs(streamLangs);
  if (fromStreams) return { verdict: fromStreams, evidence: 'audio stream tags', langs: streamLangs.filter(Boolean) };
  const mediaLangs = media ? media.audio.map((a) => a.lang) : [];
  const fromMedia = verdictFromLangs(mediaLangs);
  if (fromMedia) return { verdict: fromMedia, evidence: 'playlist audio tracks', langs: mediaLangs.filter(Boolean) };
  const fromName = classifyFileName(fileName);
  // A "DUAL"/"Multi" RELEASE says the original file had Japanese + English.
  // The STREAM may not: Vidsrc converts such a release to HLS with ONE
  // untagged audio track - the first, Japanese one (live: Smoking Behind the
  // Supermarket S01E04 "...DUAL-BiOMA.mkv" streams a single Japanese track).
  // So a dual release only counts as having English when the stream really
  // carries more than one track (or the playlist lists an English one).
  const streamTracks = Array.isArray(streamLangs) ? streamLangs.length : null;
  const separateAudio = media ? media.audio.filter((x) => x.uri).length : 0;
  if (fromName === 'multi' && streamTracks === 1 && separateAudio === 0) {
    return { verdict: 'unknown', evidence: 'dual-audio release, but the stream carries ONE untagged audio track (the second language was dropped by the source)', langs: [] };
  }
  if (fromName !== 'unknown') return { verdict: fromName, evidence: 'release name', langs: [] };
  return { verdict: 'unknown', evidence: 'no language information', langs: [] };
}

function langLabel(langs) {
  const names = { en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German' };
  const list = [...new Set((langs || []).filter(Boolean))].map((l) => names[l] || l);
  return list.length ? list.join(' + ') : 'non-English';
}

// Does this copy satisfy the requested mode?
//   -> { ok, reason, englishSub } (englishSub = the subtitle rendition to
//      embed in SUB mode, or null)
// Rejects only on positive evidence. Release-name guesses never reject in
// SUB mode (a name cannot tell whether subtitles are burned in).
// strictDub (anime): DUB needs POSITIVE English evidence. Anime release
// groups always mark a dub ("DUBBED", "Dual Audio", "English"); an unmarked
// anime release is the Japanese one (live: Solo Leveling S1 on Vidsrc is
// "...dubbed..." for E1-E2 and an unmarked Japanese release for E3-E12).
function checkMode({ mode, audio, media = null, strictDub = false }) {
  const subs = (media && media.subtitles) || [];
  const englishSub = subs.find((s) => s.lang === 'en' && !s.forced && s.uri) || subs.find((s) => s.lang === 'en' && s.uri) || null;
  const v = (audio && audio.verdict) || 'unknown';
  if (mode === 'sub') {
    if (v === 'english') return { ok: true, reason: 'English audio', englishSub };
    if (englishSub) return { ok: true, reason: 'original audio + English subtitles', englishSub };
    // The playlist lists subtitle tracks, none English, over non-English audio:
    // not watchable as "English subbed".
    if (v === 'foreign' && subs.length && audio.evidence !== 'release name') {
      return { ok: false, reason: `${langLabel(audio.langs)} audio and no English subtitle track (only ${subs.map((s) => s.lang || s.name || '?').join(', ')})`, englishSub: null };
    }
    return { ok: true, reason: v === 'foreign' ? 'original audio (subtitles may be burned in)' : 'audio language unknown', englishSub: null };
  }
  // DUB (default)
  if (v === 'english' || v === 'multi') return { ok: true, reason: v === 'multi' ? 'includes an English audio track' : 'English audio', englishSub: null };
  if (v === 'foreign') {
    return { ok: false, reason: `audio is ${langLabel(audio.langs)} (${audio.evidence}), not an English dub`, englishSub: null };
  }
  if (strictDub) {
    const why = audio && audio.evidence && audio.evidence !== 'no language information'
      ? audio.evidence
      : 'no English-dub marker on this release (anime releases always mark dubs)';
    return { ok: false, reason: why, englishSub: null };
  }
  return { ok: true, reason: 'audio language unknown', englishSub: null };
}

// Is this episode's release an English dub? true / false / null (no name).
// From the release name alone, only an explicit dub ("DUBBED", "English")
// counts: a "DUAL"/"Multi" release is usually streamed with just its first,
// Japanese track (see audioVerdict), so it is NOT counted as dubbed.
function isEnglishDub(fileName, streamLangs = null) {
  const langs = Array.isArray(streamLangs) ? streamLangs : [];
  if (!fileName && !langs.some(Boolean)) return null;
  const a = audioVerdict({ streamLangs: langs.some(Boolean) ? langs : [], fileName });
  if (a.evidence === 'release name') return a.verdict === 'english';
  return a.verdict === 'english' || a.verdict === 'multi';
}

// Language named in a subtitle file URL ("/en/", "_eng.vtt", "english.srt",
// "?lang=es"): 'en', another code, or '' when the URL does not say.
const SUB_LANG_TOKEN = /(?:^|[\/_.\-=&?])(en|eng|english|ja|jp|jpn|japanese|es|spa|spanish|fr|fre|fra|french|de|ger|deu|german|pt|por|portuguese|it|ita|italian|ar|ara|arabic|ru|rus|russian|zh|chi|zho|chinese|ko|kor|korean|id|ind|indonesian|tr|tur|turkish|vi|vie|vietnamese|th|tha|thai|pl|pol|polish|nl|dut|nld|dutch)(?=$|[\/_.\-=&?#])/gi;
function subtitleUrlLang(url) {
  let path = String(url || '');
  try {
    const u = new URL(path);
    path = decodeURIComponent(u.pathname + u.search);
  } catch (e) {
    /* not a full URL */
  }
  const found = [];
  let m;
  SUB_LANG_TOKEN.lastIndex = 0;
  while ((m = SUB_LANG_TOKEN.exec(path))) found.push(normLang(m[1]));
  if (!found.length) return '';
  return found.includes('en') ? 'en' : found[found.length - 1];
}

// Best subtitle capture for an English SUB download: one whose URL names
// English, else the newest one that does not name another language, else
// the newest (the old behaviour).
function pickEnglishSubtitle(captures) {
  const list = (captures || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!list.length) return null;
  return (
    list.find((c) => subtitleUrlLang(c.url) === 'en') ||
    list.find((c) => subtitleUrlLang(c.url) === '') ||
    list[0]
  );
}

module.exports = { normLang, parseHlsMedia, classifyFileName, audioVerdict, checkMode, langLabel, subtitleUrlLang, pickEnglishSubtitle, isEnglishDub };
