'use strict';

// DUB / SUB toggle (src/main/audiolang.js + the Vidsrc resolver + downloader):
//   1. language evidence: stream tags > playlist tracks > release name;
//   2. the mode check: DUB needs English audio, SUB needs English audio or an
//      English subtitle track; nothing is rejected on a guess;
//   3. the Vidsrc resolver: anime DUB never takes a non-English copy (it hands
//      over to the dub-aware sites), TV/movies only prefer a match, and the
//      job's quality floor is used;
//   4. English subtitle captures win over other languages;
//   5. end to end with real ffmpeg: an HLS stream whose audio and English
//      subtitles are SEPARATE tracks downloads with sound and subtitles.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { spawnSync } = require('child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-audio-'));
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA_DIR, on() {} },
      session: { fromPartition: () => ({}) },
      webContents: { fromId: () => null }
    };
  }
  return origLoad.apply(this, arguments);
};

const REPO = path.join(__dirname, '..');
const M = (p) => require(path.join(REPO, 'src/main', p));

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

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="jpn",NAME="Japanese",DEFAULT=YES,URI="audio_ja.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="eng",NAME="English",DEFAULT=NO,URI="audio_en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",URI="subs_en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="es",NAME="Español",URI="subs_es.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud",SUBTITLES="subs"',
  'video_1080.m3u8'
].join('\n');

async function main() {
  const al = M('audiolang');

  console.log('\n[1] Language evidence');
  check('eng / en-US / English -> en', al.normLang('eng') === 'en' && al.normLang('en-US') === 'en' && al.normLang('English') === 'en');
  check('und / empty -> untagged', al.normLang('und') === '' && al.normLang('') === '');
  const media = al.parseHlsMedia(MASTER, 'https://cdn.example/x/master.m3u8');
  check('master: 2 audio tracks (ja default, en)', media.audio.length === 2 && media.audio[0].lang === 'ja' && media.audio[0].isDefault && media.audio[1].lang === 'en');
  check('master: relative URIs resolved', media.audio[1].uri === 'https://cdn.example/x/audio_en.m3u8', media.audio[1].uri);
  check('master: 2 subtitle tracks (en, es)', media.subtitles.length === 2 && media.subtitles[0].lang === 'en' && media.subtitles[1].lang === 'es');
  const cr = 'Smoking Behind the Supermarket with You S01E03 Episode 3 1080p CR WEB-DL DDP2 0 H 264-Kitsune.mkv';
  const hulu = 'One Piece (1999) S01E01 (1080p HULU WEB-DL H264 SDR AAC 2.0 English - HONE).mkv';
  check('CR WEB-DL -> foreign (Crunchyroll = Japanese audio)', al.classifyFileName(cr) === 'foreign');
  check('"... AAC 2.0 English" -> english', al.classifyFileName(hulu) === 'english');
  check('"English Subs" is not English audio', al.classifyFileName('Show S01E01 1080p JPN English Subs') === 'foreign');
  check('"Dual Audio" -> multi', al.classifyFileName('Show S01E01 1080p Dual Audio') === 'multi');
  check('store name alone (Netflix) is not dub evidence', al.classifyFileName('Show S01E01 1080p NF WEB-DL Netflix') === 'unknown');
  const tagsWin = al.audioVerdict({ streamLangs: ['ja'], fileName: hulu });
  check('stream tags beat the release name', tagsWin.verdict === 'foreign' && tagsWin.evidence === 'audio stream tags');
  check('untagged stream falls back to playlist tracks', al.audioVerdict({ streamLangs: [''], media }).verdict === 'multi');
  check('no evidence -> unknown', al.audioVerdict({ streamLangs: [''], fileName: 'Show S01E01 1080p WEB-DL' }).verdict === 'unknown');

  console.log('\n[2] Mode check');
  const V = (verdict, evidence = 'audio stream tags', langs = []) => ({ verdict, evidence, langs });
  check('DUB + English audio -> ok', al.checkMode({ mode: 'dub', audio: V('english') }).ok);
  check('DUB + English among tracks -> ok', al.checkMode({ mode: 'dub', audio: V('multi') }).ok);
  check('DUB + Japanese audio -> rejected', !al.checkMode({ mode: 'dub', audio: V('foreign', 'audio stream tags', ['ja']) }).ok);
  check('DUB + unknown -> ok (never reject on a guess)', al.checkMode({ mode: 'dub', audio: V('unknown', 'no language information') }).ok);
  const subWithEn = al.checkMode({ mode: 'sub', audio: V('foreign', 'audio stream tags', ['ja']), media });
  check('SUB + Japanese + English subtitle track -> ok, embeds it', subWithEn.ok && subWithEn.englishSub && subWithEn.englishSub.lang === 'en');
  const esOnly = { audio: [], subtitles: [media.subtitles[1]] };
  check('SUB + Japanese + only Spanish subtitles -> rejected', !al.checkMode({ mode: 'sub', audio: V('foreign', 'audio stream tags', ['ja']), media: esOnly }).ok);
  check('SUB + Japanese + no subtitle info -> ok (may be burned in)', al.checkMode({ mode: 'sub', audio: V('foreign', 'audio stream tags', ['ja']) }).ok);
  check('SUB + English-language title -> ok without subtitles', al.checkMode({ mode: 'sub', audio: V('english') }).ok);

  console.log('\n[3] Vidsrc resolver honours the mode');
  const vidsrcDl = M('sites/vidsrc_dl');
  const vidsrc = M('sites/vidsrc');
  let lastMin = null;
  // Contract stand-in for pick1080: run accept() over fake sources in order.
  const fakeSources = (list) => async (ref, onLog, min, opts = {}) => {
    lastMin = min;
    let fb = null;
    for (const s of list) {
      const v = opts.accept ? opts.accept(s) : { ok: true };
      if (v && v.ok) return s;
      (opts.rejected || []).push({ host: s.host, reason: v.reason });
      if (!fb) fb = s;
    }
    return opts.preferOnly ? fb : null;
  };
  const src = (host, audio, extra = {}) => Object.assign({ url: `https://${host}/v.m3u8`, host, realWidth: 1280, realHeight: 720, meta: { fileName: '' }, audio, media: null }, extra);
  const jp = src('cdn-jp', V('foreign', 'audio stream tags', ['ja']));
  const en = src('cdn-en', V('english'));
  const logs = [];
  const run = (ref) => vidsrc.directResolve(Object.assign({ tmdb: '123', title: 'Show', season: 1, episode: 1 }, ref), { onLog: (m) => logs.push(m) });

  vidsrcDl.pick1080 = fakeSources([jp, en]);
  let out = await run({ anime: true, mode: 'dub' });
  check('anime DUB picks the English source over a Japanese one', out.status === 'resolved' && out.detection.url.includes('cdn-en'), JSON.stringify(out));

  vidsrcDl.pick1080 = fakeSources([jp]);
  out = await run({ anime: true, mode: 'dub' });
  check('anime DUB with only Japanese -> wrong_audio (not downloaded)', out.status === 'wrong_audio', JSON.stringify(out));

  out = await run({ anime: false, mode: 'dub' });
  check('TV/movie DUB with only original audio still downloads', out.status === 'resolved' && out.detection.url.includes('cdn-jp'));

  vidsrcDl.pick1080 = fakeSources([src('cdn-sub', V('foreign', 'audio stream tags', ['ja']), { media })]);
  out = await run({ anime: true, mode: 'sub' });
  check('SUB embeds the English subtitle track', out.status === 'resolved' && out.detection.embedSubs === true && /subs_en\.m3u8$/.test(out.detection.subtitleUrl || ''), JSON.stringify(out.detection));
  check('SUB picks the original (Japanese) audio track', /audio_ja\.m3u8$/.test(out.detection.audioUrl || ''), out.detection.audioUrl);

  vidsrcDl.pick1080 = fakeSources([src('cdn-multi', V('multi', 'playlist audio tracks', ['ja', 'en']), { media })]);
  out = await run({ anime: true, mode: 'dub' });
  check('DUB picks the English audio track of a multi-audio source', /audio_en\.m3u8$/.test(out.detection.audioUrl || ''), out.detection.audioUrl);
  check('DUB does not embed subtitles', !out.detection.embedSubs);

  vidsrcDl.pick1080 = fakeSources([en]);
  await run({ anime: false, mode: 'dub', minHeight: 720 });
  check("the job's quality floor reaches Vidsrc (720)", lastMin === 720, String(lastMin));
  await run({ anime: false, mode: 'dub' });
  check('no floor given: TV/movies still need 1080', lastMin === 1080, String(lastMin));

  console.log('\n[3b] IP block: Vidsrc pauses instead of hammering');
  {
    const realPick = Object.getPrototypeOf(vidsrcDl) && vidsrcDl.pick1080;
    const nginx403 = '<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body><center><h1>403 Forbidden</h1></center><hr><center>nginx</center></body></html>';
    check('nginx 403 page is a block page', vidsrcDl.isBlockPage(403, nginx403));
    check("the API's JSON 403 (bad token) is not", !vidsrcDl.isBlockPage(403, '{"status_code":"403","message":"invalid api token"}'));
    check('a 429 is not a block page', !vidsrcDl.isBlockPage(429, nginx403));
    // Trip the breaker: no request may leave while it is open.
    vidsrcDl._setBlockedUntilForTests(Date.now() + 60000);
    const https = require('https');
    const realGet = https.get;
    let sent = 0;
    https.get = function () { sent += 1; return realGet.apply(this, arguments); };
    let thrown = null;
    try { await vidsrcDl.fetchStreamUrls({ type: 'tv', tmdb: '1', season: 1, episode: 1 }); } catch (e) { thrown = e; }
    check('while blocked, a lookup fails at once with VIDSRC_BLOCKED', thrown && thrown.code === 'VIDSRC_BLOCKED', thrown && thrown.message);
    const rel = await vidsrcDl.episodeRelease({ type: 'tv', tmdb: '1', season: 1, episode: 1 }, {});
    check('...the dub check reports unreachable (keeps old answers)', rel.status === 'unreachable');
    https.get = realGet;
    check('...and nothing was sent', sent === 0, 'sent=' + sent);
    vidsrcDl._setBlockedUntilForTests(0);
  }

  console.log('\n[4] English subtitle captures win');
  const caps = [
    { url: 'https://x/subs/es/ep1.vtt', ts: 3 },
    { url: 'https://x/subs/en/ep1.vtt', ts: 1 },
    { url: 'https://x/subs/ep1_ja.vtt', ts: 2 }
  ];
  check('the English capture is chosen over newer ones', al.pickEnglishSubtitle(caps).url.includes('/en/'));
  check('a capture that names no language beats a foreign one', al.pickEnglishSubtitle([{ url: 'https://x/fr.vtt', ts: 2 }, { url: 'https://x/track1.vtt', ts: 1 }]).url.includes('track1'));
  check('"english.srt" reads as English', al.subtitleUrlLang('https://x/files/Show.S01E01.english.srt') === 'en');

  console.log('\n[5] End to end: separate audio + subtitle tracks (real ffmpeg)');
  const ok = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!ok) {
    check('ffmpeg available for the end-to-end test', false, 'ffmpeg not on PATH');
  } else {
    const hls = path.join(DATA_DIR, 'hls');
    fs.mkdirSync(hls, { recursive: true });
    const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: hls });
    ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '6', '-an', '-c:v', 'libx264', '-g', '50', '-f', 'hls', '-hls_time', '2', '-hls_segment_filename', 'v%02d.ts', 'video.m3u8']);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-vn', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-f', 'hls', '-hls_time', '2', '-hls_segment_filename', 'a%02d.ts', 'audio_en.m3u8']);
    fs.writeFileSync(path.join(hls, 'subs_en.vtt'), 'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello there\n\n00:00:03.000 --> 00:00:05.000\nGeneral Kenobi\n');
    fs.writeFileSync(path.join(hls, 'subs_en.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-VERSION:3\n#EXTINF:6.0,\nsubs_en.vtt\n#EXT-X-ENDLIST\n');
    const srv = http.createServer((req, res) => {
      const f = path.join(hls, path.basename(decodeURIComponent(req.url.split('?')[0])));
      if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
      const body = fs.readFileSync(f);
      res.setHeader('Content-Length', body.length);
      res.end(body);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const dl = M('downloader');
    const part = path.join(DATA_DIR, 'out', 'Show S1E1.mp4.part');
    fs.mkdirSync(path.dirname(part), { recursive: true });
    let err = null;
    try {
      await dl.downloadHls(
        {
          url: `${base}/video.m3u8`,
          type: 'hls',
          headers: { 'User-Agent': 'test' },
          plainHttp: true,
          audioUrl: `${base}/audio_en.m3u8`,
          audioLabel: 'English',
          embedSubs: true,
          subtitleUrl: `${base}/subs_en.m3u8`
        },
        part,
        { onLog: () => {} }
      );
    } catch (e) {
      err = e;
    }
    srv.close();
    check('download finished', !err, err && err.message);
    if (!err) {
      const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:stream_tags=language', '-of', 'json', part], { encoding: 'utf8' });
      const streams = (JSON.parse(pr.stdout || '{}').streams || []);
      const kinds = streams.map((s) => s.codec_type);
      check('output has video', kinds.includes('video'), JSON.stringify(streams));
      check('output has the separate audio track (not silent)', kinds.includes('audio'), JSON.stringify(streams));
      const sub = streams.find((s) => s.codec_type === 'subtitle');
      check('output has the English subtitle track (mov_text, eng)', sub && sub.codec_name === 'mov_text' && sub.tags && sub.tags.language === 'eng', JSON.stringify(streams));
    }
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(1);
});
