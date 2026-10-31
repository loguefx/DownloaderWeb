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
      const s = streams[key] || (streams[key] = { type, index: Number(idx), n: 0, first: t, last: t, end: t, steps: [], backwards: 0, backAt: [], prevDur: 0 });
      if (s.n) {
        // The hole is either a jump to this packet or folded into the
        // previous packet's duration by the muxer: take the larger.
        const step = Math.max(t - s.last, s.prevDur || 0);
        if (step > 0) s.steps.push({ at: s.last, len: step });
        if (t < s.last - 0.001) {
          s.backwards += 1;
          if (s.backAt.length < 10) s.backAt.push(t);
        }
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
  const skipList = (st, min) => (st ? st.steps.filter((g) => g.len > min).slice(0, 25).map((g) => ({ at: +g.at.toFixed(3), len: +g.len.toFixed(3) })) : []);
  const details = {
    videoSkips: skipList(v, L.videoGap),
    audioSkips: skipList(a, L.audioGap),
    videoBackwardsAt: v ? v.backAt.map((t) => +t.toFixed(3)) : [],
    audioBackwardsAt: a ? a.backAt.map((t) => +t.toFixed(3)) : []
  };
  let decodeErr = null;
  if (decode && !problems.length) {
    decodeErr = await decodeErrors(file);
    if (decodeErr && decodeErr.length > L.decodeErrors) {
      problems.push(`${decodeErr.length} decode error(s) - damaged frames (e.g. "${decodeErr[0].slice(0, 90)}")`);
    }
  }
  if (decodeErr && decodeErr.length) details.decodeErrors = decodeErr.slice(0, 15);
  return {
    ok: problems.length === 0,
    problems,
    details,
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

// Which playlist segment a time on the output timeline falls in, counted
// from 0 like ffmpeg ("Failed to open segment 4") and the engine's part
// files (seg00004.ts).
function segmentAt(t, starts) {
  if (!Array.isArray(starts) || !starts.length) return null;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Log lines for one check. ctx: { label, source, release, segmentStarts,
// remuxWarnings, elapsedMs, attempt }. Always one summary line; on a failure
// every problem, every skip (with its segment), and ffmpeg's warnings.
function report(result, ctx = {}) {
  const lines = [];
  const st = result.stats || {};
  const name = ctx.label || 'file';
  const segs = Array.isArray(ctx.segmentStarts) ? ctx.segmentStarts : null;
  // A hole starts at the stretched frame BEFORE it, so locate its middle:
  // that is the segment that is missing.
  const segNote = (t, len = 0) => {
    const n = segmentAt(t + len / 2, segs);
    return n != null ? ` (segment #${n} of 0-${segs.length - 1}, part seg${String(n).padStart(5, '0')})` : '';
  };
  const summary =
    `length ${fmt(st.duration || 0)}, A/V start ${st.startSkewMs != null ? st.startSkewMs + ' ms' : 'n/a'}, ` +
    `end ${st.endSkewMs != null ? st.endSkewMs + ' ms' : 'n/a'}, decode errors ${st.decodeErrors != null ? st.decodeErrors : 'not checked'}` +
    (ctx.elapsedMs != null ? `, checked in ${Math.round(ctx.elapsedMs / 1000)} s` : '');
  if (result.ok) {
    lines.push(`Playback check OK: "${name}" - ${summary}.`);
  } else {
    lines.push(`Playback check FAILED: "${name}"${ctx.attempt ? ` (attempt ${ctx.attempt})` : ''} - ${summary}.`);
    for (const p of result.problems) lines.push(`  problem: ${p}`);
    const d = result.details || {};
    for (const g of d.videoSkips || []) lines.push(`  video skip at ${fmt(g.at)} (${g.at.toFixed(2)} s), ${g.len.toFixed(2)} s${segNote(g.at, g.len)}`);
    for (const g of d.audioSkips || []) lines.push(`  audio dropout at ${fmt(g.at)} (${g.at.toFixed(2)} s), ${g.len.toFixed(2)} s${segNote(g.at, g.len)}`);
    for (const t of d.videoBackwardsAt || []) lines.push(`  video timestamps jump back at ${t.toFixed(2)} s${segNote(t)}`);
    for (const e of d.decodeErrors || []) lines.push(`  decoder: ${e.slice(0, 160)}`);
    if (ctx.source || ctx.release) lines.push(`  source: ${[ctx.source, ctx.release].filter(Boolean).join(' - ')}`);
  }
  // ffmpeg's own remux warnings explain WHY (a segment it skipped, corrupt
  // packets...). Logged on success too: a warning on a passing file is an
  // early sign of a flaky source.
  for (const w of ctx.remuxWarnings || []) {
    lines.push(`  ffmpeg: ${w.first}${w.count > 1 ? ` (x${w.count})` : ''}`);
  }
  return lines;
}

// Permanent record: one JSON line per checked file in <data>/integrity.log
// (rotated at 5 MB to integrity.log.1), so a skip found weeks later can be
// matched to what the engine saw when it downloaded the file.
const RECORD_MAX = 5 * 1024 * 1024;
function record(file, result, ctx = {}, dir = null) {
  try {
    const fs = require('fs');
    const path = require('path');
    let base = dir;
    if (!base) {
      try {
        base = require('electron').app.getPath('userData');
      } catch (e) {
        base = require('./engineconfig').defaultDataDir();
      }
    }
    fs.mkdirSync(base, { recursive: true });
    const p = path.join(base, 'integrity.log');
    try {
      if (fs.statSync(p).size > RECORD_MAX) fs.renameSync(p, p + '.1');
    } catch (e) {
      /* no log yet */
    }
    const row = {
      at: new Date().toISOString(),
      ok: result.ok,
      label: ctx.label || '',
      file,
      source: ctx.source || '',
      release: ctx.release || '',
      attempt: ctx.attempt || null,
      expectedDuration: ctx.expectedDuration || null,
      segments: Array.isArray(ctx.segmentStarts) ? ctx.segmentStarts.length : null,
      problems: result.problems,
      stats: result.stats,
      details: result.details,
      remuxWarnings: (ctx.remuxWarnings || []).map((w) => ({ line: w.first, count: w.count }))
    };
    fs.appendFileSync(p, JSON.stringify(row) + '\n');
    return p;
  } catch (e) {
    return null; // logging must never break a download
  }
}

module.exports = { checkIntegrity, scanPackets, report, record, segmentAt, LIMITS };
