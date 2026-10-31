'use strict';

// Playback integrity of a finished download: the last gate before a file is
// placed. Verification (verify.js) proves the file opens and is roughly the
// right length; this proves it PLAYS cleanly:
//   - no skip: no gap in the video or audio timeline. NOTE: after the MP4
//     remux a lost or cut-short segment is NOT a timestamp gap - the muxer
//     stretches the last frame before the hole over it (measured: one video
//     packet lasting 2.04 s instead of 0.04 s; one lasting 1.2 s for a
//     segment cut at 45%). So each packet's own length counts as well as
//     the step to the next one: either one spanning the threshold is a skip;
//   - nothing repeated: a duplicated segment leaves a smooth timeline and
//     only shows as a file LONGER than the source playlist;
//   - no timestamps going backwards (a duplicated or reordered segment);
//   - audio in sync: audio and video start together and end together;
//   - nothing missing at the end (against the playlist's own duration);
//   - optionally, a full decode with no decoder errors (damaged frames inside
//     a segment keep the timestamps intact but show as glitches / skips).
// Measured cost: the packet scan is ~9 s for a 19 GB, 2 h 49 min movie; the
// decode is ~0.5-1.5 s per minute of 1080p.

const { spawn } = require('child_process');
const { ffprobePath, ffmpegPath } = require('./downloader');

const LIMITS = {
  videoGap: 0.5, // s: a hole this long is a visible skip
  audioGap: 0.3, // s: an audible dropout
  startSkew: 0.2, // s: audio starting this far from the video is out of sync
  endSkew: 1.5, // s: audio ending this far from the video drifted / was cut
  // Length vs. the source playlist: playlists are exact (measured: 1420 s
  // playlist -> 1420.06 s file), so allow 1 s, or 0.1% of long titles, at
  // most 3 s - one lost or repeated 5 s segment is always outside that.
  lengthTolerance: 0.001,
  lengthToleranceMin: 1,
  lengthToleranceMax: 3,
  decodeErrors: 0 // decoder error lines allowed (after the known-harmless ones)
};

const fmt = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// One pass over every packet: per stream first/last time, gaps, backwards.
function scanPackets(file) {
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobePath(),
      ['-v', 'error', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,codec_type', '-of', 'csv=p=0', file],
      { windowsHide: true }
    );
    const streams = {};
    let buf = '';
    const feed = (line) => {
      const [type, idx, pts, dts, dur] = line.split(',');
      if (type !== 'video' && type !== 'audio') return;
      const t = Number(dts !== 'N/A' ? dts : pts);
      if (!Number.isFinite(t)) return;
      const d = Number(dur);
      const key = `${type}${idx}`;
      const s = streams[key] || (streams[key] = { type, index: Number(idx), n: 0, first: t, last: t, end: t, steps: [], backwards: 0, prevDur: 0 });
      if (s.n) {
        // The hole is either a jump to this packet or folded into the
        // previous packet's duration by the muxer: take the larger.
        const step = Math.max(t - s.last, s.prevDur || 0);
        if (step > 0) s.steps.push({ at: s.last, len: step });
        if (t < s.last - 0.001) s.backwards += 1;
      }
      s.prevDur = Number.isFinite(d) && d > 0 ? d : 0;
      s.n += 1;
      s.last = t;
      s.end = Math.max(s.end, t + (Number.isFinite(d) && d > 0 ? d : 0));
    };
    proc.stdout.on('data', (c) => {
      buf += c;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        feed(buf.slice(0, k).trim());
        buf = buf.slice(k + 1);
      }
    });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (buf.trim()) feed(buf.trim());
      resolve(code === 0 ? Object.values(streams) : null);
    });
  });
}

// Full decode; returns the decoder's error lines (known-harmless ones removed).
function decodeErrors(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-nostdin', '-v', 'error', '-threads', '0', '-i', file, '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (c) => {
      if (err.length < 200000) err += c;
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const lines = err
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        // Reference-frame notices on the very first GOP of a cut stream are
        // harmless and do not show on screen.
        .filter((l) => !/co located POCs unavailable|mmco: unref short failure/i.test(l));
      resolve(lines);
    });
  });
}

// -> { ok, problems: [string], stats }
//   expectedDuration: seconds the source playlist says the title runs (0 = unknown)
//   decode: run the full decode check
async function checkIntegrity(file, { expectedDuration = 0, decode = true, limits = {} } = {}) {
  const L = Object.assign({}, LIMITS, limits);
  const problems = [];
  const streams = await scanPackets(file);
  if (!streams) return { ok: false, problems: ['could not read the packets'], stats: null };
  const v = streams.find((s) => s.type === 'video');
  const a = streams.find((s) => s.type === 'audio');
  if (!v) problems.push('no video stream');
  if (!a) problems.push('no audio stream');

  // Gaps longer than a few frames / audio packets are holes in the media.
  if (v) {
    const big = v.steps.filter((g) => g.len > L.videoGap);
    if (big.length) {
      const total = big.reduce((x, g) => x + g.len, 0);
      problems.push(`video skips ${big.length}x (${total.toFixed(1)} s missing; first at ${fmt(big[0].at)})`);
    }
    if (v.backwards) problems.push(`video timestamps go backwards ${v.backwards}x (repeated or out-of-order segment)`);
  }
  if (a) {
    const big = a.steps.filter((g) => g.len > L.audioGap);
    if (big.length) {
      const total = big.reduce((x, g) => x + g.len, 0);
      problems.push(`audio drops out ${big.length}x (${total.toFixed(1)} s; first at ${fmt(big[0].at)})`);
    }
    if (a.backwards) problems.push(`audio timestamps go backwards ${a.backwards}x`);
  }
  if (v && a) {
    const startSkew = a.first - v.first;
    if (Math.abs(startSkew) > L.startSkew) {
      problems.push(`audio ${startSkew > 0 ? 'starts late' : 'starts early'} by ${Math.round(Math.abs(startSkew) * 1000)} ms (out of sync)`);
    }
    const endSkew = a.end - v.end;
    if (Math.abs(endSkew) > L.endSkew) {
      problems.push(`audio ${endSkew > 0 ? 'runs past' : 'stops before'} the video by ${Math.abs(endSkew).toFixed(1)} s`);
    }
  }
  const span = v ? v.end - v.first : 0;
  if (expectedDuration > 0 && v) {
    const allowed = Math.min(L.lengthToleranceMax, Math.max(L.lengthToleranceMin, expectedDuration * L.lengthTolerance));
    if (span < expectedDuration - allowed) {
      problems.push(`${(expectedDuration - span).toFixed(1)} s missing (file ${fmt(span)}, source ${fmt(expectedDuration)})`);
    } else if (span > expectedDuration + allowed) {
      problems.push(`plays ${(span - expectedDuration).toFixed(1)} s longer than the source (a repeated segment)`);
    }
  }
  let decodeErr = null;
  if (decode && !problems.length) {
    decodeErr = await decodeErrors(file);
    if (decodeErr && decodeErr.length > L.decodeErrors) {
      problems.push(`${decodeErr.length} decode error(s) - damaged frames (e.g. "${decodeErr[0].slice(0, 90)}")`);
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    stats: {
      duration: span,
      videoPackets: v ? v.n : 0,
      audioPackets: a ? a.n : 0,
      startSkewMs: v && a ? Math.round((a.first - v.first) * 1000) : null,
      endSkewMs: v && a ? Math.round((a.end - v.end) * 1000) : null,
      decodeErrors: decodeErr ? decodeErr.length : null
    }
  };
}

module.exports = { checkIntegrity, scanPackets, LIMITS };
