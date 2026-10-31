'use strict';

// Playback integrity (src/main/integrity.js) against real media made with
// ffmpeg, remuxed exactly the way the engine remuxes HLS:
//   clean                 -> passes
//   a lost segment        -> "video skips"
//   a duplicated segment  -> "timestamps go backwards"
//   a segment cut short   -> caught (gap or decode errors)
//   audio 0.5 s late      -> "out of sync"
//   ending missing        -> "missing" (vs. the playlist duration)
// Needs ffmpeg/ffprobe on PATH.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-integ-'));
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => DATA_DIR, on() {} }, session: { fromPartition: () => ({}) }, webContents: { fromId: () => null } };
  return origLoad.apply(this, arguments);
};
const REPO = path.join(__dirname, '..');
const { checkIntegrity } = require(path.join(REPO, 'src/main/integrity.js'));

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

const ff = (args, cwd = DATA_DIR) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, encoding: 'utf8' });

// The engine's remux of a local HLS playlist (spawnFfmpegHls, -c copy).
function remux(playlist, out) {
  return ff(['-f', 'hls', '-allowed_extensions', 'ALL', '-fflags', '+genpts', '-avoid_negative_ts', 'make_zero', '-i', playlist,
    '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', out]);
}

function playlist(segs, name) {
  let t = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n';
  for (const s of segs) t += `#EXTINF:2.0,\n${s}\n`;
  t += '#EXT-X-ENDLIST\n';
  fs.writeFileSync(path.join(DATA_DIR, name), t);
  return path.join(DATA_DIR, name);
}

async function main() {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    check('ffmpeg available', false, 'ffmpeg not on PATH');
    return finish();
  }
  // 20 s source: moving test pattern + continuous tone, cut into 2 s TS segments.
  const made = ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '20', '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', 'seg%02d.ts', 'src.m3u8']);
  check('test media generated', made.status === 0, made.stderr);
  const segs = fs.readdirSync(DATA_DIR).filter((n) => /^seg\d+\.ts$/.test(n)).sort();
  check('10 segments', segs.length === 10, String(segs.length));

  console.log('\n[1] Clean file passes');
  remux(playlist(segs, 'clean.m3u8'), path.join(DATA_DIR, 'clean.mp4'));
  let r = await checkIntegrity(path.join(DATA_DIR, 'clean.mp4'), { expectedDuration: 20 });
  check('clean: ok', r.ok, JSON.stringify(r.problems));
  check('clean: audio/video start together (within one frame)', Math.abs(r.stats.startSkewMs) <= 80, String(r.stats.startSkewMs));

  console.log('\n[2] A lost segment is a skip');
  remux(playlist(segs.filter((s, i) => i !== 4), 'lost.m3u8'), path.join(DATA_DIR, 'lost.mp4'));
  r = await checkIntegrity(path.join(DATA_DIR, 'lost.mp4'), { expectedDuration: 20 });
  check('lost segment: rejected', !r.ok);
  check('...reported as a 2 s video skip at 0:07-0:08', r.problems.some((p) => /video skips 1x \(2\.\d s missing; first at 0:0[78]\)/.test(p)), JSON.stringify(r.problems));
  check('...and an audio dropout', r.problems.some((p) => /audio drops out/.test(p)), JSON.stringify(r.problems));

  console.log('\n[3] A duplicated segment is caught');
  const dup = segs.slice(0, 5).concat([segs[4]], segs.slice(5));
  remux(playlist(dup, 'dup.m3u8'), path.join(DATA_DIR, 'dup.mp4'));
  r = await checkIntegrity(path.join(DATA_DIR, 'dup.mp4'), { expectedDuration: 20 });
  check('duplicated segment: rejected', !r.ok, JSON.stringify(r.problems));
  check('...as longer than the source', r.problems.some((p) => /longer than the source/.test(p)), JSON.stringify(r.problems));

  console.log('\n[4] A segment cut short is caught');
  const cut = 'cut05.ts';
  const whole = fs.readFileSync(path.join(DATA_DIR, segs[5]));
  fs.writeFileSync(path.join(DATA_DIR, cut), whole.subarray(0, Math.floor(whole.length * 0.45)));
  remux(playlist(segs.slice(0, 5).concat([cut], segs.slice(6)), 'cut.m3u8'), path.join(DATA_DIR, 'cut.mp4'));
  r = await checkIntegrity(path.join(DATA_DIR, 'cut.mp4'), { expectedDuration: 20 });
  check('truncated segment: rejected', !r.ok, JSON.stringify(r.problems));

  console.log('\n[5] Audio out of sync is caught');
  ff(['-i', path.join(DATA_DIR, 'clean.mp4'), '-itsoffset', '0.5', '-i', path.join(DATA_DIR, 'clean.mp4'), '-map', '0:v', '-map', '1:a', '-c', 'copy', path.join(DATA_DIR, 'late.mp4')]);
  r = await checkIntegrity(path.join(DATA_DIR, 'late.mp4'), { expectedDuration: 20 });
  check('audio 0.5 s late: rejected', !r.ok);
  check('...reported as out of sync', r.problems.some((p) => /audio starts late by 5\d\d ms/.test(p)), JSON.stringify(r.problems));

  console.log('\n[6] A missing ending is caught');
  remux(playlist(segs.slice(0, 8), 'short.m3u8'), path.join(DATA_DIR, 'short.mp4'));
  r = await checkIntegrity(path.join(DATA_DIR, 'short.mp4'), { expectedDuration: 20 });
  check('last 4 s missing: rejected', !r.ok && r.problems.some((p) => /s missing/.test(p)), JSON.stringify(r.problems));
  r = await checkIntegrity(path.join(DATA_DIR, 'short.mp4'), { expectedDuration: 0 });
  check('...but a file is not judged on a length nobody announced', r.ok, JSON.stringify(r.problems));

  console.log('\n[7] A segment cut short is spotted before the remux');
  const hls = require(path.join(REPO, 'src/main/hlscheck.js'));
  const seg = fs.readFileSync(path.join(DATA_DIR, segs[3]));
  check('a whole TS segment is not truncated', !hls.bufferTsTruncated(seg));
  check('a segment cut mid-packet is truncated', hls.bufferTsTruncated(seg.subarray(0, Math.floor(seg.length * 0.45))));
  check('one byte short is truncated', hls.bufferTsTruncated(seg.subarray(0, seg.length - 1)));
  const rnd = Buffer.alloc(seg.length);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761) >>> 24;
  rnd[0] = 0x47; // encrypted data may start with 0x47 by chance
  check('encrypted / non-TS data gets no opinion', !hls.bufferTsTruncated(rnd));
  check('a cut exactly on a packet boundary is still a whole-looking part (caught later by the playback check)', !hls.bufferTsTruncated(seg.subarray(0, 188 * 20)));

  console.log('\n[8] The log explains a skip: ffmpeg warning, time, segment');
  {
    const integrity = require(path.join(REPO, 'src/main/integrity.js'));
    const dl = require(path.join(REPO, 'src/main/downloader.js'));
    // Segment 5 cannot be opened: ffmpeg skips it and still exits 0 - the
    // real-world cause of a skip.
    const broken = segs.slice();
    broken[4] = 'gone04.ts';
    const pl = playlist(broken, 'broken.m3u8');
    const out = path.join(DATA_DIR, 'broken.mp4');
    const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-y', '-f', 'hls', '-allowed_extensions', 'ALL', '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero', '-i', pl, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', out], { encoding: 'utf8' });
    check('ffmpeg exits 0 despite the missing segment (why skips slipped through)', res.status === 0, String(res.status));
    const det = {};
    dl.collectFfmpegWarnings(det, res.stderr);
    check('the "failed to open segment" warning is captured', (det.remuxWarnings || []).some((w) => /failed to open segment/i.test(w.first)), JSON.stringify(det.remuxWarnings));
    const starts = dl.segmentStartTimes(fs.readFileSync(pl, 'utf8'));
    check('segment start times read from the playlist', starts.length === 10 && starts[4] === 8, JSON.stringify(starts));
    const integ = await integrity.checkIntegrity(out, { expectedDuration: 20, decode: false });
    const lines = integrity.report(integ, { label: 'Test S1E1', source: 'cdn.example', release: 'Test.S01E01.DUBBED.mkv', segmentStarts: starts, remuxWarnings: det.remuxWarnings, elapsedMs: 1200 });
    const text = lines.join('\n');
    check('report: FAILED summary line', /^Playback check FAILED: "Test S1E1"/.test(lines[0]), lines[0]);
    check('report: names the missing segment as ffmpeg does (#4, seg00004)', /video skip at 0:07 .*\(segment #4 of 0-9, part seg00004\)/.test(text), text);
    check('report: names the source and release', /source: cdn\.example - Test\.S01E01\.DUBBED\.mkv/.test(text), text);
    check('report: includes the ffmpeg warning', /ffmpeg: .*[Ff]ailed to open segment/.test(text), text);
    const okLines = integrity.report(await integrity.checkIntegrity(path.join(DATA_DIR, 'clean.mp4'), { expectedDuration: 20, decode: false }), { label: 'Clean S1E1' });
    check('a passing file still gets a summary line', okLines.length === 1 && /^Playback check OK: "Clean S1E1" - length 0:20/.test(okLines[0]), okLines.join(' | '));
    const logFile = integrity.record(out, integ, { label: 'Test S1E1', segmentStarts: starts, remuxWarnings: det.remuxWarnings }, DATA_DIR);
    const rowLine = logFile ? fs.readFileSync(logFile, 'utf8').trim().split('\n').pop() : '';
    let row = null;
    try { row = JSON.parse(rowLine); } catch (e) { row = null; }
    check('permanent record written (integrity.log, one JSON line)', row && row.ok === false && row.segments === 10 && row.details.videoSkips.length === 1 && row.remuxWarnings.length >= 1, rowLine.slice(0, 200));
  }

  console.log('\n[9] A long still frame is not a skip; a corroborated one is');
  {
    const integrity = require(path.join(REPO, 'src/main/integrity.js'));
    // Variable frame rate: frame 100 is held for 2 s over continuous sound.
    const vfr = path.join(DATA_DIR, 'vfr.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12',
      '-filter_complex', "[0:v]setpts='if(gte(N,100),if(lt(N,101),PTS,PTS+2/TB),PTS)'[v]", '-map', '[v]', '-map', '1:a',
      '-fps_mode', 'vfr', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', vfr]);
    let r = await integrity.checkIntegrity(vfr, { decode: true });
    check('VFR still frame over continuous sound: passes', r.ok, JSON.stringify(r.problems));
    check('...noted as a long still, not a skip', (r.details.longStills || []).length === 1 && !(r.details.videoSkips || []).length, JSON.stringify(r.details));
    check('...and the log says why', integrity.report(r, { label: 'VFR' }).some((l) => /still frame at .* not counted as a skip/.test(l)));
    // The same long frame WITH a segment error from the remux (a video
    // segment lost while a separate audio track kept playing): a skip.
    r = await integrity.checkIntegrity(vfr, { decode: false, remuxWarnings: [{ first: '[in#0/hls] Failed to open segment 4 of playlist 0', count: 1 }] });
    check('the same hole + "Failed to open segment": a skip', !r.ok && r.problems.some((p) => /video skips 1x/.test(p)), JSON.stringify(r.problems));
  }

  return finish();
}

function finish() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(1);
});
