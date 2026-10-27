'use strict';

// READ-ONLY NAS inventory.
//
// Walks the NAS shares over SMB (anonymous, read-only) and builds:
//   1. a local SKELETON MIRROR (directories + zero-byte files, video files
//      only) so the project's own fs-based recognition code
//      (organizer.existingEpisodeFile) can run against the real library
//      without a Windows mount and without ever writing to the NAS;
//   2. an inventory.json dataset: per title -> category, drives, seasons,
//      file names - the "what is actually on disk" truth.
//
// The ONLY writes are inside the local mirror directory. Nothing is created,
// renamed, or deleted on the NAS.
//
// Usage:
//   node scripts/audit/nas-inventory.js <mirrorRoot> <outJson>
//
// The share/category spec is configurable at the top; the defaults match the
// user's NAS (192.168.0.74, shares SelfHost1/2/3) and the drive letters the
// engine uses on Windows (A:/S:/T:).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAS = '192.168.0.74';
const SHARES = [
  { share: 'SelfHost3', drive: 'S:', categories: ['Anime', 'Tv Shows', 'Animations', 'Kids Shows & Movies'] },
  { share: 'SelfHost2', drive: 'T:', categories: ['Anime', 'Tv Shows', 'Animations', 'Adult Animiations & Cartoons', 'Documentaries', 'Kids Shows & Movies'] },
  { share: 'Selfhost1', drive: 'A:', categories: ['Anime', 'Tv Shows', 'Movies', 'Kids Shows & Movies'] }
];

// Categories the per-episode audit covers (type mapping for the auditor).
const TYPE_BY_CATEGORY = {
  'Anime': 'anime',
  'Tv Shows': 'tv',
  'Animations': 'tv',
  'Kids Shows & Movies': 'tv',
  'Adult Animiations & Cartoons': 'tv',
  'Documentaries': 'tv',
  'Movies': 'movie',
  'Asian Tv': 'tv',
  'Asian TV': 'tv',
  'Coming of Age': 'tv',
  'Stand Up': 'other',
  'Patreon': 'other',
  'Manga': 'skip',
  'Game_Roms': 'skip',
  'Twitch Vods': 'skip',
  'My Projects': 'skip'
};

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.m4v', '.ts', '.mov', '.wmv', '.mpg', '.mpeg']);
const SKIP_DIRS = new Set(['.mediadownloader-trash']);

// ---- smbclient -------------------------------------------------------------

// One `ls` of a NAS folder. Resolves to the parsed entries
// [{ name, type: 'D'|'F'|'A' }], or null on any failure. Spawns under load
// can be rejected (E2BIG/EAGAIN) - retry with backoff before giving up.
function smbLsOnce(share, dir, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cmd = `cd "${dir.replace(/"/g, '\\"')}"; ls`;
    let p;
    try {
      p = spawn('smbclient', [`//${NAS}/${share}`, '-N', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('smbclient exit ' + code));
      const entries = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^ {2}(.+?)\s{2,}(D|F|A)\s+/);
        if (m) entries.push({ name: m[1], type: m[2] });
      }
      resolve(entries);
    });
  });
}
async function smbLs(share, dir) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await smbLsOnce(share, dir);
    } catch (e) {
      if (attempt === 3) return null;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1) + Math.floor(Math.random() * 200)));
    }
  }
  return null;
}

// Small concurrency pool.
async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---- walk ------------------------------------------------------------------

async function walkCategory(share, drive, category, mirrorRoot, log) {
  const titles = await smbLs(share, category);
  if (!titles) { log(`! ${drive}${path.sep}${category}: list failed`); return []; }
  const titleEntries = titles.filter((e) => e.type === 'D' && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name));

  const results = [];
  // Concurrency is deliberately low: every folder listing is an SMB spawn,
  // and the recursive walk multiplies them - a spawn storm gets E2BIG'd.
  await pool(titleEntries, 4, async (t) => {
    const title = t.name;
    const rec = { title, category, drive, share, seasons: {}, flatFiles: [] };
    await walkTitle(share, `${category}/${title.replace(/"/g, '\\"')}`, mirrorRoot, category, rec);
    results.push(rec);
  });
  return results.filter(Boolean);
}

// Depth-limited recursive listing of one title, mirroring as it goes.
async function walkTitle(share, relPath, mirrorRoot, category, rec, depth = 0) {
  const listing = await smbLs(share, relPath);
  if (!listing) return;
  const vids = listing.filter((e) => e.type !== 'D' && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()));
  const subdirs = listing.filter((e) => e.type === 'D' && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name));
  if (vids.length) {
    const folder = relPath.split('/').pop();
    const key = (folder && folder !== category) ? folder : '(root)';
    rec.seasons[key] = (rec.seasons[key] || []).concat(vids.map((v) => v.name));
    fs.mkdirSync(path.join(mirrorRoot, relPath), { recursive: true });
    for (const v of vids) fs.writeFileSync(path.join(mirrorRoot, relPath, v.name), '');
  }
  if (depth >= 3) return; // category/title/sub/sub2 is the deepest sane layout
  for (const d of subdirs) {
    await walkTitle(share, `${relPath}/${d.name.replace(/"/g, '\\"')}`, mirrorRoot, category, rec, depth + 1);
  }
}

(async () => {
  const mirrorRoot = process.argv[2];
  const outJson = process.argv[3];
  if (!mirrorRoot || !outJson) {
    console.error('usage: node nas-inventory.js <mirrorRoot> <outJson>');
    process.exit(1);
  }
  fs.mkdirSync(mirrorRoot, { recursive: true });
  const t0 = Date.now();
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

  const inventory = {}; // titleKey -> { title, category, type, drives: [rec...] }
  let nTitles = 0;
  let nFiles = 0;

  for (const { share, drive, categories } of SHARES) {
    for (const category of categories) {
      const t1 = Date.now();
      const recs = await walkCategory(share, drive, category, mirrorRoot, log);
      let n = 0;
      for (const rec of recs) {
        n += 1;
        for (const files of Object.values(rec.seasons)) nFiles += files.length;
        nFiles += rec.flatFiles.length;
        const key = (category + '|' + rec.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!inventory[key]) {
          inventory[key] = {
            title: rec.title,
            category,
            type: TYPE_BY_CATEGORY[category] || 'other',
            locations: []
          };
        }
        inventory[key].locations.push({
          drive: rec.drive,
          share: rec.share,
          path: `${drive}${path.sep}${category}${path.sep}${rec.title}`,
          seasons: rec.seasons,
          flatFiles: rec.flatFiles
        });
      }
      log(`${drive}${path.sep}${category}: ${n} title(s) in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    }
  }

  const values = Object.values(inventory);
  nTitles = values.length;
  fs.writeFileSync(outJson, JSON.stringify({
    nas: NAS,
    generated: new Date().toISOString(),
    mirrorRoot,
    totalTitles: nTitles,
    totalVideoFiles: nFiles,
    titles: values
  }, null, 2));
  log(`DONE: ${nTitles} unique title(s), ${nFiles} video file(s) -> ${outJson}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
