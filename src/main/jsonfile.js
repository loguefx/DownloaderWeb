'use strict';

// Crash-safe JSON persistence for the small state files (schedule, pending,
// queue manifest). A plain writeFileSync interrupted mid-write leaves a
// truncated file; the next load then parses nothing, resets to [] and the next
// save overwrites the real data. Write to a temp file and rename instead, and
// set aside (never discard) a file that will not parse.

const fs = require('fs');

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Returns the parsed value, or `fallback` when the file is missing. A file that
// exists but does not parse is renamed to <file>.corrupt-<ts> so it can be
// recovered by hand, and `fallback` is returned.
function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return fallback;
  }
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      console.error(`[jsonfile] ${file} is unreadable; moved it to ${aside}`);
    } catch (err) {
      // leave it in place
    }
    return fallback;
  }
}

module.exports = { writeJsonAtomic, readJson };
