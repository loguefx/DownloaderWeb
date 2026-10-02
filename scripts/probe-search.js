'use strict';

// Visible-window probe for a catalog's SEARCH page. A hidden window can't
// render the JS search results (and can't pass a Cloudflare JS challenge), so
// this shows the window on screen, waits for hydration, and dumps exactly what
// a findTitle pipeline would see: the final URL, CF state, and the /title/ (or
// show) links it could pick.
//
//   npx electron scripts/probe-search.js "https://host/search/according-to-jim" ["according to jim" [s [e]]]
//
// Run it for each catalog you want in the pool and read the result line.

const { app, BrowserWindow, session } = require('electron');

const URL0 = process.argv[2] || 'https://solarmovie.com/search/according-to-jim';
const TITLE = process.argv[3] || 'according to jim';
const SEASON = process.argv[4] || '1';
const EPISODE = process.argv[5] || '5';

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const DUMP = (title, s, e) => `(() => {
  const want = ${JSON.stringify(title)}.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const norm = (x) => String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const cf =
    /just a moment|attention required|cf-turnstile|challenge-platform|you have been blocked|access denied/i.test(
      ((document.title||'')+' '+((document.body&&document.body.innerText)||'').slice(0,400))
    );
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => ({ h: a.getAttribute('href'), t: norm(a.textContent) }))
    .filter((x) => x.h && !x.h.startsWith('javascript') && !/\\/(category|genre|country|language|quality|years?|home|search|page|top|trending|genres?|wp-)(\\/|$)/i.test(x.h));
  const show = links.filter((x) => norm(x.t) === want || norm(x.t).indexOf(want) === 0).slice(0, 8);
  const ep = links.filter((x) => new RegExp('[sS]'+${JSON.stringify(s)}+'[eE]'+${JSON.stringify(e)}+'|season[-_]'+${JSON.stringify(s)}+'[-_]episode[-_]'+${JSON.stringify(e)}+'|'+${JSON.stringify(s)}+'-'+${JSON.stringify(e)}, 'i').test(x.h+' '+x.t)).slice(0, 8);
  return {
    finalUrl: location.href,
    docTitle: (document.title||'').slice(0,80),
    cloudflare: cf,
    totalLinks: links.length,
    showLinks: show,
    episodeLinks: ep,
    mentionsTitle: norm(document.body && document.body.innerText).indexOf(want) !== -1
  };
})()`;

app.whenReady().then(async () => {
  session.fromPartition('persist:probe-search');
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { partition: 'persist:probe-search', backgroundThrottling: false, sandbox: false, contextIsolation: false }
  });
  win.showInactive(); // visible so the SPA hydrates + any CF JS challenge runs
  const wc = win.webContents;
  process.stdout.write(`\n=== probe-search ${URL0} ===\n`);
  await wc.loadURL(URL0).catch((e) => process.stdout.write(`load: ${e.message}\n`));
  for (const wait of [3500, 2500, 2500]) {
    await delay(wait);
    let d = null;
    try { d = await wc.executeJavaScript(DUMP(TITLE, SEASON, EPISODE), true); } catch (e) {}
    if (d && d.finalUrl && d.totalLinks > 0 && !d.cloudflare) break;
  }
  let d = null;
  try { d = await wc.executeJavaScript(DUMP(TITLE, SEASON, EPISODE), true); } catch (e) { d = { error: String(e) }; }
  process.stdout.write(JSON.stringify(d, null, 1) + '\n');
  try { win.destroy(); } catch (e) {}
  app.quit();
});
app.on('window-all-closed', () => app.quit());
setTimeout(() => process.exit(3), 90000);
