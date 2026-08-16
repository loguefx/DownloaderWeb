'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');
const { BrowserWindow, session } = require('electron');
const config = require('./config');
const organizer = require('./organizer');
const dubselect = require('./dubselect');
const urltemplate = require('./urltemplate');
const manager = require('./queue');
const pending = require('./pending');
const sites = require('./sites');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const range = (a, b) => {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
};

function loadWithTimeout(win, url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Always wait pageSettleMs after load. Resolving on bare did-finish-load
    // races the SUB/DUB server-row JS (especially on cold first episodes) and
    // makes discovery look like timeouts / empty server lists.
    const afterLoad = () => setTimeout(done, config.dub.pageSettleMs);
    win.webContents.once('dom-ready', afterLoad);
    win.webContents.once('did-finish-load', afterLoad);
    win.loadURL(url).catch(() => {});
    setTimeout(done, timeoutMs);
  });
}

// Just-in-time discovery for one episode URL: opens a hidden window, loads the
// page, selects DUB, and tries each source. Returns the dubselect outcome
// ({ status: 'resolved'|'unavailable'|'failed', ... }). Runs fresh on each retry.
// Hard-capped so a hung page/player can never leave the queue stuck on "resolving".
const DISCOVER_TIMEOUT_MS = 90000;

function mainBrowserWindow() {
  return (
    BrowserWindow.getAllWindows().find((w) => {
      if (w.isDestroyed()) return false;
      const b = w.getBounds();
      return b.width >= 800 && b.height >= 500;
    }) || null
  );
}

// Off-screen but shown: fully hidden windows often never start JW Player
// playback, so getSources alone (via the sniffer) is what saves us — still
// keep the window "visible" to Chromium so embeds behave normally.
//
// Windows is stricter than Linux: opacity 0 / far off-screen windows are
// occluded and their media pipeline freezes, so discovery never resolves.
// Paint a nearly-invisible window behind the main UI instead.
function createDiscoverWindow() {
  const isWin = process.platform === 'win32';
  const main = mainBrowserWindow();
  const b = main && !main.isDestroyed() ? main.getBounds() : { x: 0, y: 0 };
  const win = new BrowserWindow({
    show: true,
    x: isWin ? b.x : -20000,
    y: isWin ? b.y : 0,
    width: 1280,
    height: 720,
    opacity: isWin ? 0.01 : 0,
    skipTaskbar: true,
    focusable: isWin,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: config.sessionPartition,
      backgroundThrottling: false,
      sandbox: true
    }
  });
  try {
    win.webContents.setBackgroundThrottling(false);
  } catch (e) {
    // ignore
  }
  if (isWin && main && !main.isDestroyed()) {
    try {
      main.moveTop();
    } catch (e) {
      // ignore
    }
  }
  return win;
}

function makeDiscover(url, onLog = () => {}, mode = 'dub') {
  return async () => {
    const win = createDiscoverWindow();
    let timer = null;
    try {
      onLog(`Loading ${url}`);
      await loadWithTimeout(win, url, 30000);
      const outcome = await Promise.race([
        dubselect.selectDubAndResolve(win.webContents, url, onLog, mode),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Discovery timed out')),
            DISCOVER_TIMEOUT_MS
          );
        })
      ]);
      return outcome;
    } catch (e) {
      onLog(`Discovery error for ${url}: ${e.message || e}`);
      return { status: 'failed', reason: e.message || 'Discovery failed' };
    } finally {
      if (timer) clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

// Fetches the raw (server-rendered) HTML for a page using the shared session's
// cookies + Chrome UA. This is far cheaper than opening a video-playing window,
// so episode-count detection stays fast even when many downloads are running.
function fetchPageHtml(url, redirectsLeft = 3) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const run = async () => {
      let cookieHeader = '';
      try {
        const ses = session.fromPartition(config.sessionPartition);
        const cookies = await ses.cookies.get({ url });
        cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      } catch (e) {
        /* ignore - try without cookies */
      }
      let mod, origin;
      try {
        const u = new URL(url);
        mod = u.protocol === 'https:' ? https : http;
        origin = u.origin;
      } catch (e) {
        return fin(null);
      }
      const headers = {
        'User-Agent': config.download.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: origin + '/'
      };
      if (cookieHeader) headers.Cookie = cookieHeader;
      let req;
      try {
        req = mod.get(url, { headers, timeout: 12000 }, (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return fetchPageHtml(next, redirectsLeft - 1).then(fin);
          }
          if (code !== 200) {
            res.resume();
            return fin(null);
          }
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString();
            if (buf.length > 3000000) {
              try {
                req.destroy();
              } catch (e) {
                /* ignore */
              }
              fin(buf);
            }
          });
          res.on('end', () => fin(buf));
        });
      } catch (e) {
        return fin(null);
      }
      req.on('error', () => fin(null));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch (e) {
          /* ignore */
        }
        fin(null);
      });
    };
    run();
  });
}

// Pulls episode numbers + the "Episodes: aired / total" count out of raw HTML.
// Episode links are read from href attributes; the count is read from the page
// text (tags stripped, so it survives markup between "Episodes:" and the number).
function parseEpisodesFromHtml(html) {
  if (!html) return null;
  const nums = new Set();
  const add = (v) => {
    const n = parseInt(v, 10);
    if (n > 0 && n < 100000) nums.add(n);
  };
  // Matches "ep-8", "episode_8", "ep8" and the query-param form "?ep=8" /
  // "episode=8" that HiAnime-style sites (enma.lol) use.
  const linkRe = /(?:ep|episode)[-_=]?(\d+)/gi;
  let m;
  while ((m = linkRe.exec(html))) add(m[1]);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  let aired = 0;
  let total = 0;
  // NOTE: the colon is required. Without it "Episode 1" in the page title/header
  // (e.g. "The Ramparts of Ice Episode 1 - ...") matches before the real
  // "Episodes: 14 / ?" info-box line, making auto-detect stop at episode 1.
  let t = text.match(/Episodes?\s*:\s*(\d+)\s*\/\s*(\d+)/i);
  if (t) {
    aired = parseInt(t[1], 10);
    total = parseInt(t[2], 10);
  } else {
    t = text.match(/Episodes?\s*:\s*(\d+)/i);
    if (t) aired = total = parseInt(t[1], 10);
  }
  const list = Array.from(nums).sort((a, b) => a - b);
  if (!list.length && !aired) return null;
  return { list, max: list.length ? list[list.length - 1] : 0, aired, total };
}

// Scans a loaded series/episode page for the available episode numbers. Uses
// three signals: episode-list anchors, data-number style attributes, and the
// "Episodes: <aired> / <total>" text the info box shows (most reliable when the
// list is lazy-loaded).
function episodeScanScript() {
  return `(() => {
    const nums = new Set();
    const add = (v) => { const n = parseInt(v, 10); if (n > 0 && n < 100000) nums.add(n); };
    document.querySelectorAll('a[href*="/ep-"], a[href*="/episode-"], a[href*="?ep="], a[href*="&ep="], a[href*="episode="]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/(?:ep|episode)[-_=]?(\\d+)/i);
      if (m) add(m[1]);
    });
    document.querySelectorAll('[data-number], [data-num], [data-episode], [data-slug-episode]').forEach((el) => {
      add(el.getAttribute('data-number') || el.getAttribute('data-num') || el.getAttribute('data-episode'));
    });
    const list = Array.from(nums).sort((a, b) => a - b);

    // Parse "Episodes: 13 / 13" (aired / total) or "Episodes: 13". The colon is
    // required so the "Episode 1" in the page title/header doesn't match first.
    let aired = 0, total = 0;
    const txt = (document.body ? document.body.innerText : '') || '';
    let m = txt.match(/Episodes?\\s*:\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
    if (m) { aired = parseInt(m[1], 10); total = parseInt(m[2], 10); }
    else { m = txt.match(/Episodes?\\s*:\\s*(\\d+)/i); if (m) { aired = total = parseInt(m[1], 10); } }

    return { list, max: list.length ? list[list.length - 1] : 0, aired, total };
  })()`;
}

// Opens the page and detects how many episodes exist (the list is often loaded
// by JS, so we retry a few times). Prefers the actual episode-link list; falls
// back to the aired-episode count from the info box. Site profiles may supply
// a custom episodeScan script (e.g. FilmeHD in-page episode buttons).
async function detectEpisodes(url, onLog = () => {}) {
  const profile = sites.resolve(url);
  const scanJs = (profile && profile.episodeScan) || episodeScanScript();

  // Fast path: read the server-rendered HTML directly (no heavy video window).
  // Skip when the site profile needs a live DOM scan (in-page episode buttons).
  if (!(profile && profile.episodeScan)) {
    try {
      const fast = parseEpisodesFromHtml(await fetchPageHtml(url));
      if (fast && ((fast.list && fast.list.length > 1) || fast.aired > 0)) {
        const listLen = fast.list ? fast.list.length : 0;
        let list;
        // Trust the "Episodes: N" count when it's at least as large as the number
        // of links we scraped (nav sometimes shows only a few links while N is the
        // real aired total); otherwise use the scraped episode-number list.
        if (fast.aired >= listLen && fast.aired > 0) {
          list = range(1, fast.aired);
          const note = fast.total && fast.total !== fast.aired ? ` (of ${fast.total} total)` : '';
          onLog(`Detected ${fast.aired} aired episode(s)${note} from the page info.`);
        } else {
          list = fast.list;
          onLog(`Detected ${list.length} episode(s) from the page.`);
        }
        return { list, max: list.length ? list[list.length - 1] : 0, aired: fast.aired, total: fast.total };
      }
    } catch (e) {
      // fall through to the window-based scan
    }
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { partition: config.sessionPartition, backgroundThrottling: false, sandbox: true }
  });
  try {
    await loadWithTimeout(win, url, 30000);
    let res = { list: [], max: 0, aired: 0, total: 0 };
    for (let i = 0; i < 8; i++) {
      res = await win.webContents
        .executeJavaScript(scanJs, true)
        .catch(() => ({ list: [], max: 0, aired: 0, total: 0 }));
      // Good enough once we have a real list (>1) or an aired count.
      if ((res.list && res.list.length > 1) || res.aired > 0) break;
      await delay(1500);
    }

    let list;
    if (res.list && res.list.length > 1) {
      list = res.list;
      onLog(`Detected ${list.length} episode(s) from the episode list.`);
    } else if (res.aired > 0) {
      list = range(1, res.aired);
      const note = res.total && res.total !== res.aired ? ` (of ${res.total} total)` : '';
      onLog(`Detected ${res.aired} aired episode(s)${note} from the page info.`);
    } else if (res.list && res.list.length === 1) {
      list = res.list;
      onLog(`Detected 1 episode from the page.`);
    } else {
      list = [];
      onLog('Could not detect episode count from the page.');
    }
    return { list, max: list.length ? list[list.length - 1] : 0, aired: res.aired, total: res.total };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// Resolves the template + season for a bulk entry.
function entryTemplate(entry) {
  let template = entry.template && entry.template.trim();
  let season = entry.season != null && entry.season !== '' ? entry.season : null;
  if (!template && entry.baseUrl) {
    const t = urltemplate.toTemplate(entry.baseUrl);
    template = t.template;
    if (season == null && t.season != null) season = t.season;
  }
  if (season == null && (entry.baseUrl || template)) {
    season = organizer.parseSeasonFromUrl(entry.baseUrl || template);
  }
  return { template, season };
}

// Queues a multi-entry batch. Entries run sequentially. Episodes whose dub is
// not out yet are routed to the pending list (the run continues); a genuine
// source failure stops the whole run. If an entry's end episode is left blank or
// "auto", the total episode count is detected from the page.
async function startBatch(entries, outputRoot, onLog = () => {}, opts = {}) {
  // Bulk runs stop the whole queue on a hard source failure; scheduled re-checks
  // pass stopRunOnFail:false so a single bad episode never nukes the queue.
  const stopRunOnFail = opts.stopRunOnFail !== false;
  organizer.ensureDir(outputRoot);
  let queued = 0;
  let skipped = 0;
  let entryIdx = 0;

  for (const entry of entries) {
    entryIdx += 1;
    // A stable group id so the UI can show one collapsible series block and so
    // the queue can drop a whole series once every episode of it is done.
    const group = entry.group || `g${Date.now().toString(36)}-${entryIdx}`;
    const { series } = entry;
    const mode = entry.mode === 'sub' ? 'sub' : 'dub';
    const start = parseInt(entry.startEp, 10) || 1;
    const { template, season } = entryTemplate(entry);

    if (!template) {
      onLog(`Skipping "${series}": no usable URL/template.`);
      continue;
    }
    onLog(`"${series}" - audio: ${mode.toUpperCase()}${mode === 'sub' ? ' (subtitles embedded)' : ''}`);

    // Determine which episodes to queue.
    let episodes;
    const endRaw = String(entry.endEp == null ? '' : entry.endEp).trim().toLowerCase();
    const endNum = parseInt(endRaw, 10);
    if (endRaw && endRaw !== 'auto' && !isNaN(endNum)) {
      episodes = range(start, endNum);
    } else {
      onLog(`Auto-detecting episode count for "${series}"...`);
      const probeUrl =
        urltemplate.buildEpisodeUrl({ template, baseUrl: entry.baseUrl, season, series }, start) || entry.baseUrl;
      const det = await detectEpisodes(probeUrl, onLog);
      if (det.list && det.list.length) {
        episodes = det.list.filter((e) => e >= start);
      } else if (det.max > 0) {
        episodes = range(start, det.max);
      } else {
        onLog(`Could not detect episode count for "${series}"; defaulting to ${start}-12.`);
        episodes = range(start, 12);
      }
    }

    for (const ep of episodes) {
      const url = urltemplate.buildEpisodeUrl({ template, baseUrl: entry.baseUrl, season, series }, ep);
      if (!url) {
        onLog(`Skipping "${series}": template has no {episode}/ep-N to substitute.`);
        break;
      }

      const meta = { series, season, episode: ep };
      const expected = organizer.expectedPath(outputRoot, meta, '.mp4');
      if (fs.existsSync(expected)) {
        skipped += 1;
        onLog(`Already exists, skipping: ${organizer.buildBaseName(meta)}.mp4`);
        continue;
      }

      const label = organizer.buildBaseName(meta) + (mode === 'sub' ? ' [SUB]' : '');
      const spec = { label, series, season, episode: ep, outputRoot, template, baseUrl: entry.baseUrl, mode };
      const added = manager.add({
        label,
        series,
        season,
        episode: ep,
        mode,
        group,
        outputRoot,
        stopRunOnFail,
        url,
        template,
        baseUrl: entry.baseUrl,
        key: pending.constructor.key(spec),
        discover: makeDiscover(url, onLog, mode),
        onUnavailable: () => pending.add(spec)
      });
      if (added) queued += 1;
    }
  }

  onLog(`Batch queued: ${queued} episode(s), ${skipped} skipped (already present).`);
  return { queued, skipped };
}

module.exports = { startBatch, makeDiscover, entryTemplate, detectEpisodes };
