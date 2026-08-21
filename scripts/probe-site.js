'use strict';

// Diagnostic harness: loads a page and dumps the structures a site profile needs
// - server/player buttons, season + episode lists, breadcrumb links - plus the
// API calls and media requests it makes. Used when adding a new site adapter.
//
//   $env:PAGE_URL="https://host/episodes/..."; npx electron scripts/probe-site.js

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = process.env.PROBE_LOG || path.join(require('os').tmpdir(), 'probe-site.log');
const t0 = Date.now();
const log = (m) => {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch (e) {
    /* ignore */
  }
};
try {
  fs.writeFileSync(LOG, '');
} catch (e) {
  /* ignore */
}

const PAGE = process.env.PAGE_URL;
const CLICK = process.env.PAGE_CLICK ? Number(process.env.PAGE_CLICK) : null; // server index to click
const WAIT = Number(process.env.PAGE_WAIT || 8000);

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,ThirdPartyCookiePhaseout,TrackingProtection3pcd'
);
const CHROME = process.versions.chrome || '124.0.0.0';
app.userAgentFallback =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const DUMP = `(() => {
  const txt = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const attrs = (el) => {
    const out = {};
    for (const a of el.attributes || []) if (/^data-|^id$|^class$/.test(a.name)) out[a.name] = a.value.slice(0, 60);
    return out;
  };
  // Player / server switcher candidates.
  const playerSel = '#playeroptionsul li, .playeroptionsul li, ul[id*="player"] li, [class*="server"] li, li[data-nume], li[data-post], .servers li, #servers li, [id*="server"] button, [class*="server"] button, [class*="server"] a';
  const players = Array.from(document.querySelectorAll(playerSel)).slice(0, 20).map((el) => ({
    tag: el.tagName.toLowerCase(), text: txt(el), attrs: attrs(el)
  }));
  // Season blocks and episode links.
  const seasonBlocks = Array.from(document.querySelectorAll('#seasons .se-c, .se-c, [class*="season"]')).slice(0, 12).map((el) => ({
    tag: el.tagName.toLowerCase(), text: txt(el), attrs: attrs(el)
  }));
  const epLinks = Array.from(document.querySelectorAll('.episodios a, [class*="episodi"] a, a[href*="/episode"], a[href*="/episodes/"]'))
    .slice(0, 25).map((a) => ({ href: a.getAttribute('href'), text: txt(a) }));
  const numerando = Array.from(document.querySelectorAll('.numerando, [class*="numerando"]')).slice(0, 25).map(txt);
  const crumbs = Array.from(document.querySelectorAll('#single .sgeneros a, .breadcrumb a, [class*="breadcrumb"] a, .data a, h1 a'))
    .slice(0, 12).map((a) => ({ href: a.getAttribute('href'), text: txt(a) }));
  const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => (f.src || f.getAttribute('src') || '').slice(0, 160));
  return {
    url: location.href,
    title: (document.title || '').slice(0, 120),
    players,
    seasonBlocks,
    epLinks,
    numerando,
    crumbs,
    iframes,
    h1: txt(document.querySelector('h1'))
  };
})()`;

app.whenReady().then(async () => {
  const partition = process.env.PROBE_PARTITION || 'probe-site';
  const sess = session.fromPartition(partition);
  const interesting = (u) => /admin-ajax|\/ajax|\.m3u8|\.mp4|embed|player|api\//i.test(u);
  sess.webRequest.onCompleted((d) => {
    if (interesting(d.url)) log(`HTTP ${d.statusCode} ${d.method} ${d.url.slice(0, 180)}`);
  });

  const win = new BrowserWindow({
    show: false,
    x: -32000,
    y: -32000,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { partition, backgroundThrottling: false, sandbox: false }
  });
  win.showInactive();
  const wc = win.webContents;

  log(`Loading ${PAGE}`);
  await wc.loadURL(PAGE).catch((e) => log(`LOAD ${e && e.message}`));
  await delay(4000);

  const info = await wc.executeJavaScript(DUMP, true).catch((e) => ({ error: String(e) }));
  log(`DUMP ${JSON.stringify(info, null, 1)}`);

  // Find elements by visible text (e.g. "Server 1") and show how they're wired.
  if (process.env.PAGE_TEXT) {
    const found = await wc
      .executeJavaScript(
        `(() => {
          const re = new RegExp(${JSON.stringify(process.env.PAGE_TEXT)}, 'i');
          const out = [];
          for (const el of document.querySelectorAll('*')) {
            if (el.children.length > 2) continue;
            const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!t || t.length > 40 || !re.test(t)) continue;
            const at = {};
            for (const a of el.attributes || []) at[a.name] = (a.value || '').slice(0, 120);
            out.push({
              text: t,
              tag: el.tagName.toLowerCase(),
              attrs: at,
              parent: el.parentElement
                ? {
                    tag: el.parentElement.tagName.toLowerCase(),
                    id: el.parentElement.id,
                    cls: (el.parentElement.className || '').toString().slice(0, 80)
                  }
                : null,
              outer: el.outerHTML.slice(0, 300)
            });
            if (out.length >= 12) break;
          }
          return out;
        })()`,
        true
      )
      .catch((e) => ({ error: String(e) }));
    log(`TEXT MATCHES ${JSON.stringify(found, null, 1)}`);
  }

  if (CLICK != null) {
    const clicked = await wc
      .executeJavaScript(
        `(() => {
          const sel = '#playeroptionsul li, .playeroptionsul li, li[data-nume], [class*="server"] li, [class*="server"] button, [class*="server"] a';
          const els = Array.from(document.querySelectorAll(sel));
          const el = els[${CLICK}];
          if (!el) return { ok: false, count: els.length };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, count: els.length, text: (el.textContent || '').trim().slice(0, 40) };
        })()`,
        true
      )
      .catch((e) => ({ error: String(e) }));
    log(`CLICK ${JSON.stringify(clicked)}`);
    await delay(WAIT);
    const after = await wc
      .executeJavaScript(
        `Array.from(document.querySelectorAll('iframe')).map((f) => (f.src || f.getAttribute('src') || '').slice(0, 200))`,
        true
      )
      .catch(() => []);
    log(`IFRAMES ${JSON.stringify(after)}`);
  }

  setTimeout(() => app.exit(0), 300);
});
