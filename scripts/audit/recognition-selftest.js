'use strict';

// Recognition self-test (READ-ONLY, no network).
//
// For every on-disk video file that carries an S/E marker, asks the project's
// REAL recognition function (organizer.existingEpisodeFile) to find it under
// the series it sits in. A "failure" means the file's own S/E marker is NOT
// recognized - the exact condition that would make the watcher re-download a
// file the user already has. Titles with unmarked files (flat anime, title-
// named files) are reported separately - those rely on the truth tier's
// episode-name match, which this test cannot exercise without a source.
//
// Usage: node scripts/audit/recognition-selftest.js <inventoryJson> [--types tv,anime,movie]

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const organizer = require(path.join(REPO, 'src/main/organizer.js'));

const argv = process.argv.slice(2);
const INVENTORY = argv[0];
const ti = argv.indexOf('--types');
const TYPES = new Set(((ti >= 0 ? argv[ti + 1] : null) || 'tv,anime,movie').split(',').map((s) => s.trim()).filter(Boolean));
const fi = argv.indexOf('--failures');
const FAIL_OUT = fi >= 0 ? argv[fi + 1] : null;
const allFailures = [];
if (!INVENTORY || !fs.existsSync(INVENTORY)) {
  console.error('usage: node recognition-selftest.js <inventoryJson> [--types tv,anime,movie]');
  process.exit(1);
}
const inv = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
const MIRROR = inv.mirrorRoot;

// The mirror is static for this whole run, so cache readdirSync results.
// Without this, every existingEpisodeFile call re-reads the (900-folder)
// category root, and 51k files make the pass take many minutes.
const realReaddirSync = fs.readdirSync;
const readdirCache = new Map();
fs.readdirSync = (p, opts) => {
  const key = String(p) + '|' + (opts ? 'ft' : '');
  if (!readdirCache.has(key)) readdirCache.set(key, realReaddirSync(p, opts));
  return readdirCache.get(key);
};

let judged = 0;
let passed = 0;
const perType = {};

for (const t of inv.titles) {
  if (!TYPES.has(t.type)) continue;
  const bucket = (perType[t.type] = perType[t.type] || { judged: 0, passed: 0, failed: 0, unmarked: 0, sampleFailures: [] });
  const root = path.join(MIRROR, t.category);
  for (const loc of t.locations) {
    const series = (loc.path || '').split('/').pop() || t.title;
    for (const [folder, files] of Object.entries(loc.seasons || {})) {
      const folderSeason = folder === series ? null : organizer.seasonFromName(folder);
      for (const f of files) {
        const base = f.replace(/\s*\(\d+\)\s*\.[A-Za-z0-9]+$/, '').replace(/\.[A-Za-z0-9]+$/, '');
        // NOTE: exactly TWO capture groups per regex (season, episode).
        // A stray outer group here made m[1] the whole "S02E05" match, so
        // season was parsed as NaN and every SxxEyy file was misjudged.
        let m = base.match(/(?:season\s*0*(\d{1,3})\s*-\s*episode\s*0*(\d{1,3})(?!\d))/i)
          || base.match(/(?<!\d)s0*(\d{1,3})e0*(\d{1,3})(?!\d)/i)
          || base.match(/(?<!\d)(\d{1,2})[xX](\d{2,3})(?!\d)/i);
        let season = null;
        let episode = null;
        if (m) {
          if (m[1] != null) { season = +m[1]; episode = +m[2]; }
          else if (m[3] != null) { season = +m[3]; episode = +m[4]; }
          else { season = +m[5]; episode = +m[6]; }
        } else if (folderSeason != null) {
          // Loose file (EP18 etc.) inside a season folder: judge it against
          // the folder's season.
          const lm = base.match(/(?<![a-z0-9])ep\.?\s*0*(\d{1,3})(?!\d)/i)
            || base.match(/(?<![a-z0-9sx])e\.?\s*0*(\d{1,3})(?!\d)/i)
            || base.match(/(?<![a-z0-9])episode\s*0*(\d{1,3})(?!\d)/i)
            || base.match(/(?<![\dxXsS])0*(\d{1,3})(?![\dxXpPeE])$/);
          if (lm) { season = folderSeason; episode = +lm[1]; }
        }
        if (season == null || episode == null) {
          bucket.unmarked++;
          continue;
        }
        bucket.judged++;
        judged++;
        const found = organizer.existingEpisodeFile(root, { series, season, episode }, null, '');
        if (found) {
          bucket.passed++;
          passed++;
        } else {
          bucket.failed++;
          if (bucket.sampleFailures.length < 5) bucket.sampleFailures.push(`${t.title} :: ${folder}/${f} (S${season}E${episode})`);
          allFailures.push({ type: t.type, title: t.title, series, category: t.category, folder, file: f, season, episode, flat: folder === series });
        }
      }
    }
  }
}

console.log('\n================ RECOGNITION SELF-TEST (read-only, offline) ================');
for (const [type, b] of Object.entries(perType)) {
  const pct = b.judged ? Math.round((100 * b.passed) / b.judged) : 0;
  console.log(`${type.toUpperCase().padEnd(6)}: ${b.passed}/${b.judged} S/E-marked files recognized (${pct}%) | ${b.unmarked} files rely on title/flat matching`);
  for (const s of b.sampleFailures) console.log(`   FAIL: ${s}`);
}
console.log(`TOTAL : ${passed}/${judged} marked files recognized`);
if (FAIL_OUT) {
  fs.writeFileSync(FAIL_OUT, JSON.stringify({ total: judged, passed, failed: judged - passed, failures: allFailures }, null, 1));
  console.log(`failures written to ${FAIL_OUT}`);
}
process.exit(passed === judged ? 0 : 1);
