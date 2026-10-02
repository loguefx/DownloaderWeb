'use strict';

// Live test for the cross-site 1080p discovery pipeline.
//
//   npx electron scripts/test-findtitle.js ["show title" [S [E]]]
//
// Defaults to "According to Jim" S1E5. For every registered site adapter that
// implements findTitle, this loads its search page in a hidden Electron window
// and runs the exact same pickShowLink/pickEpisodeLink pipeline bulk.js uses.
// Prints the resolved episode URL (or why it failed) per site, so we can see
// which catalogs are actually reachable and which have the episode.

const { app, BrowserWindow } = require('electron');
const path = require('path');

const args = process.argv.slice(2);
const TITLE = (args[0] || 'According to Jim').trim();
const SEASON = parseInt(args[1] || '1', 10);
const EPISODE = parseInt(args[2] || '5', 10);

const sites = require('../src/main/sites');
const { episodeRefFromUrl } = require('../src/main/sites/findtitle');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function summarize(err) {
  return err ? String((err && err.message) || err).slice(0, 120) : 'ok';
}

async function main() {
  sites.init(app.getPath('userData'));
  console.log(`\n=== Cross-site findTitle test: ${TITLE} S${SEASON}E${EPISODE} ===`);
  console.log(`Profiles registered: ${sites.profiles.map((p) => p.id).join(', ')}`);

  // Sanity: the ref extractor bulk.js feeds into findTitle.
  const ref = episodeRefFromUrl(
    `https://sflix.soap2day.day/episodes/according-to-jim-season-${SEASON}-episode-${EPISODE}/`
  );
  console.log(`episodeRefFromUrl -> ${JSON.stringify(ref)}`);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      partition: 'persist:web',
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true
    }
  });
  const wc = win.webContents;

  const loadWithTimeout = (url, ms = 25000) =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      const t = setTimeout(finish, ms);
      wc.once('did-finish-load', () => {
        clearTimeout(t);
        finish();
      });
      wc.loadURL(url).catch((e) => {
        clearTimeout(t);
        finish();
      });
    });

  const hooks = {
    wc,
    load: (page) => loadWithTimeout(page),
    // Hidden window: a Turnstile never finishes here, so just report what the
    // page shows after the load.
    cloudflare: async (page) => {
      let info = '';
      try {
        info = await wc.executeJavaScript(
          `(() => (document.title || '') + ' | ' + ((document.body && document.body.innerText) || '').slice(0, 120).replace(/\\s+/g, ' '))()`,
          true
        );
      } catch (e) {
        info = 'eval failed: ' + e.message;
      }
      const blocked =
        /sorry,? you (?:have been|are) blocked|access denied|just a moment|attention required|cf-error|challenge/i.test(
          info
        );
      if (blocked) console.log(`      [cf?] ${info.slice(0, 160)}`);
      return !blocked;
    },
    onLog: (m) => console.log(`      ${m}`)
  };

  const query = { title: TITLE, season: SEASON, episode: EPISODE };
  for (const p of sites.profiles) {
    if (p.id === 'generic') continue;
    const t0 = Date.now();
    if (typeof p.findTitle !== 'function') {
      console.log(`-- ${p.id}: (no findTitle; reachable via SFlix alternate walk)`);
      continue;
    }
    let url = null;
    let err = '';
    try {
      url = await p.findTitle(query, hooks, (m) => console.log(`      ${m}`));
    } catch (e) {
      err = summarize(e);
    }
    const ms = Date.now() - t0;
    const row = { id: p.id, url, err, ms };
    results.push(row);
    console.log(`-- ${p.id}: ${url ? url : `NOT FOUND (${err || 'no match'})`}`);
    if (!url && err) console.log(`     error: ${err}`);
    await delay(1500); // be polite between sites
  }

  // Mirror sanity: every profile should produce a deduped mirror list.
  for (const p of sites.profiles) {
    if (p.id === 'generic' || typeof p.mirrorUrls !== 'function') continue;
    let m = [];
    try {
      m = p.mirrorUrls(`https://example.invalid/title/test-s1e5/`);
    } catch (e) {
      m = [];
    }
    console.log(`mirrorUrls ${p.id}: ${m.length} host(s) -> ${m.map((u) => new URL(u).host).join(', ')}`);
  }

  const found = results.filter((r) => r.url).length;
  console.log(
    `\n=== RESULT: ${found}/${results.length} site adapters found ${TITLE} S${SEASON}E${EPISODE} ===\n`
  );
  try {
    win.destroy();
  } catch (e) {
    // ignore
  }
  app.quit();
}

app.whenReady().then(() => {
  main().catch((e) => {
    console.error('Test crashed:', e);
    app.quit(1);
  });
});
app.on('window-all-closed', () => app.quit());
setTimeout(() => {
  console.error('\nHard timeout (6 min); forcing exit.');
  process.exit(2);
}, 360000);
