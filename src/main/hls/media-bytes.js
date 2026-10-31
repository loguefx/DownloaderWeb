'use strict';

// Recognising media bytes: TS / fMP4 (ISO boxes) / PNG-wrapped segments,
// MSE buffer classification, TS truncation (pure). Moved out of hlscheck.js
// unchanged; hlscheck re-exports every name.

function isPng(buf) {
  return (
    buf &&
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

function isFmp4At(buf, i) {
  if (!buf || i + 8 > buf.length) return false;
  const typ = buf.toString('ascii', i + 4, i + 8);
  return typ === 'ftyp' || typ === 'moof' || typ === 'mdat' || typ === 'moov' || typ === 'sidx';
}

function isMediaAt(buf, i) {
  return (buf && buf[i] === 0x47) || isFmp4At(buf, i);
}

// Chromium's CDP returns binary as a JS string. Decoding that as UTF-8 inserts
// U+FFFD and ffmpeg then dies with "Invalid data found when processing input".
function bufferFromCdpString(data, base64Encoded) {
  const raw = data || '';
  if (!raw) return Buffer.alloc(0);
  if (base64Encoded) return Buffer.from(raw, 'base64');
  if (raw.indexOf('\uFFFD') !== -1) return Buffer.alloc(0);
  return Buffer.from(raw, 'latin1');
}

// Vidfast/peakstorm (and similar) prepend a 1x1 PNG so ffmpeg's HLS demuxer
// probes "png" and dies with "Invalid data found when processing input".
// The real media is MPEG-TS (0x47) or fMP4 after the PNG chunks.
function stripPngWrapper(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  if (!isPng(buf)) return buf;
  let i = 8;
  while (i + 12 <= buf.length) {
    if (isMediaAt(buf, i)) break;
    const len = buf.readUInt32BE(i);
    if (len > 10 * 1024 * 1024) break;
    const type = buf.toString('ascii', i + 4, i + 8);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  while (i < buf.length && !isMediaAt(buf, i)) i += 1;
  return i > 0 && i < buf.length ? buf.subarray(i) : buf;
}

function looksLikeSegment(buf) {
  if (!buf || buf.length < 200) return false;
  if (utf8ReplacementCount(buf, 4096) >= 3) return false;
  if (isPng(buf)) return true;
  if (buf[0] === 0x47) return true;
  if (isFmp4At(buf, 0)) return true;
  return false;
}

function utf8ReplacementCount(buf, limit) {
  let n = 0;
  const end = Math.min(buf.length - 2, limit || buf.length);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) n += 1;
  }
  return n;
}

function splitMp4Boxes(buf) {
  const boxes = [];
  if (!buf || buf.length < 8) return boxes;
  let i = 0;
  while (i + 8 <= buf.length) {
    let size = buf.readUInt32BE(i);
    if (size === 1 && i + 16 <= buf.length) {
      size = buf.readUInt32BE(i + 8) * 0x100000000 + buf.readUInt32BE(i + 12);
    }
    if (size < 8 || i + size > buf.length) {
      if (i < buf.length) boxes.push(buf.subarray(i));
      break;
    }
    boxes.push(buf.subarray(i, i + size));
    i += size;
  }
  return boxes;
}

function classifyMseBuffers(buf) {
  if (!buf || !buf.length) return [];
  if (buf[0] === 0x47) return [{ kind: 'ts', buf }];
  const parts = splitMp4Boxes(buf);
  if (!parts.length) return [{ kind: isFmp4At(buf, 0) ? 'init' : 'media', buf }];
  const out = [];
  let init = [];
  let frag = [];
  const flushInit = () => {
    if (!init.length) return;
    out.push({ kind: 'init', buf: Buffer.concat(init) });
    init = [];
  };
  const flushFrag = () => {
    if (!frag.length) return;
    out.push({ kind: 'media', buf: Buffer.concat(frag) });
    frag = [];
  };
  for (const box of parts) {
    if (box.length < 8) continue;
    const typ = box.toString('ascii', 4, 8);
    if (typ === 'ftyp' || typ === 'moov' || typ === 'mvex' || typ === 'sidx' || typ === 'styp') {
      flushFrag();
      init.push(box);
    } else if (typ === 'moof' || typ === 'mdat' || typ === 'emsg') {
      flushInit();
      frag.push(box);
    } else if (frag.length) {
      frag.push(box);
    } else {
      init.push(box);
    }
  }
  flushInit();
  flushFrag();
  return out.length ? out : [{ kind: 'media', buf }];
}

function forEachIsoBox(buf, fn, start = 0, end = buf.length) {
  let i = start;
  while (i + 8 <= end) {
    const size = buf.readUInt32BE(i);
    const typ = buf.toString('ascii', i + 4, i + 8);
    if (size < 8 || i + size > end) break;
    fn(typ, i, size);
    i += size;
  }
}

function tfhdTrackId(buf) {
  let id = 0;
  const visit = (from, to) => {
    forEachIsoBox(
      buf,
      (typ, i, size) => {
        if (typ === 'tfhd' && size >= 16) id = buf.readUInt32BE(i + 12);
        else if (typ === 'moof' || typ === 'traf') visit(i + 8, i + size);
      },
      from,
      to
    );
  };
  visit(0, buf.length);
  return id;
}

function tfdtBaseMediaDecodeTime(buf) {
  let t = null;
  const visit = (from, to) => {
    forEachIsoBox(
      buf,
      (typ, i, size) => {
        if (typ === 'tfdt' && size >= 16) {
          const ver = buf[i + 8];
          t =
            ver === 1 && size >= 24
              ? buf.readUInt32BE(i + 12) * 0x100000000 + buf.readUInt32BE(i + 16)
              : buf.readUInt32BE(i + 12);
        } else if (typ === 'moof' || typ === 'traf') visit(i + 8, i + size);
      },
      from,
      to
    );
  };
  visit(0, buf.length);
  return t;
}

function tkhdTrackId(buf) {
  let id = 0;
  const visit = (from, to) => {
    forEachIsoBox(
      buf,
      (typ, i, size) => {
        if (typ === 'tkhd' && size >= 24) {
          const ver = buf[i + 8];
          id = ver === 1 ? buf.readUInt32BE(i + 28) : buf.readUInt32BE(i + 20);
        } else if (typ === 'moov' || typ === 'trak') visit(i + 8, i + size);
      },
      from,
      to
    );
  };
  visit(0, buf.length);
  return id;
}

function initStreamKind(buf) {
  const s = buf.toString('latin1');
  if (s.indexOf('soun') !== -1 || s.indexOf('SoundHandler') !== -1) return 'audio';
  if (s.indexOf('vide') !== -1 || s.indexOf('VideoHandler') !== -1) return 'video';
  return 'video';
}

// A whole MPEG-TS segment is a run of 188-byte packets, each starting with
// the 0x47 sync byte; a part cut off mid-transfer ends in a partial packet,
// which plays as a glitch / skip. Only data that is clearly TS is judged
// (sync bytes at packets 0, 1 and 2): encrypted, fMP4 or wrapped segments
// get no opinion.
function tsLooksTruncated(head, size, lastPacketFirstByte) {
  if (!head || head.length < 377 || size < 377) return false;
  if (head[0] !== 0x47 || head[188] !== 0x47 || head[376] !== 0x47) return false;
  if (size % 188 !== 0) return true;
  return lastPacketFirstByte !== 0x47;
}

function bufferTsTruncated(buf) {
  if (!buf || buf.length < 377) return false;
  return tsLooksTruncated(buf, buf.length, buf.length >= 188 ? buf[buf.length - 188] : -1);
}

module.exports = {
  isPng,
  isFmp4At,
  isMediaAt,
  bufferFromCdpString,
  stripPngWrapper,
  looksLikeSegment,
  utf8ReplacementCount,
  splitMp4Boxes,
  classifyMseBuffers,
  forEachIsoBox,
  tfhdTrackId,
  tfdtBaseMediaDecodeTime,
  tkhdTrackId,
  initStreamKind,
  tsLooksTruncated,
  bufferTsTruncated
};
