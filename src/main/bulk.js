'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { BrowserWindow, session } = require('electron');
const config = require('./config');
const organizer = require('./organizer');
const dubselect = require('./dubselect');
const vpn = require('./vpn');
const library = require('./library');
const { createDiscoverWindow, destroyOwned, passCloudflare } = require('./discoverwindow');
const urltemplate = require('./urltemplate');
const manager = require('./queue');
const pending = require('./pending');
const sites = require('./sites');
const { episodeRefFromUrl } = require('./sites/findtitle');
const hlscheck = require('./hlscheck');
const { verifyFile, belowMinHeight } = require('./verify');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const range = (a, b) => {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
};

// A file that is already 1080p (or has no quality floor) counts as done.
// A shorter finished file is queued again so discovery can fetch 1080p.
//
// Part 11 rules:
//   - unreadable (NAS asleep, network blip) is treated as PRESENT so the
//     engine never downloads over a file it cannot inspect;
//   - a low-quality file the engine did not place is never queued for
//     replacement; it is listed for the manual quality check instead.
async function existingKeepsEpisode(outputRoot, meta, pageUrl, onLog) {
  const already = organizer.existingEpisodeFile(outputRoot, meta);
  if (!already) return null;
  const floor = (sites.resolve(pageUrl || '') || {}).minHeight || 0;
  if (!floor) return already;
  const probed = await verifyFile(already);
  if (!probed.probeOk) {
    onLog(
      `${path.basename(already)} could not be verified (${probed.reason}); ` +
        `treating it as present so it is not re-downloaded over it.`
    );
    return already;
  }
  if (!belowMinHeight(probed, floor)) return already;
  if (!library.isOurs(already)) {
    library.audit('skipped-foreign', already, `${probed.height}p below the ${floor}p floor, but not engine-owned`);
    onLog(
      `${path.basename(already)} is ${probed.height}p (below ${floor}p) but was not placed by this engine; ` +
        `it is left untouched. Use the quality check to replace it by hand.`
    );
    return already;
  }
  onLog(
    `${path.basename(already)} is ${probed.height}p, not ${floor}p. Added to the download list. ` +
      `The old file goes to the trash folder when the ${floor}p copy replaces it.`
  );
  return null;
}

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
const discoverGate = {
  active: 0,
  waiters: []
};

async function withDiscoverGate(fn) {
  const limit = Math.max(1, config.download.discoverConcurrency || 2);
  while (discoverGate.active >= limit) {
    await new Promise((r) => discoverGate.waiters.push(r));
  }
  discoverGate.active += 1;
  try {
    return await fn();
  } finally {
    discoverGate.active -= 1;
    const w = discoverGate.waiters.shift();
    if (w) w();
  }
}

function makeDiscover(url, onLog = () => {}, mode = 'dub', getOpts = () => ({})) {
  return async () =>
    withDiscoverGate(async () => {
      // Part 3: no outside request without a confirmed tunnel. Jobs accepted
      // while Mullvad is down stay queued (queue._gate holds them); this is the
      // discovery-side half of the same guarantee.
      await vpn.waitUntilConnected();
      const win = createDiscoverWindow();
      const ownerId = win.webContents.id;
      const controller = new AbortController();
      let attempt = new AbortController();
      const followParent = () => {
        try {
          attempt.abort();
        } catch (e) {
          // ignore
        }
      };
      if (controller.signal.aborted) followParent();
      else controller.signal.addEventListener('abort', followParent, { once: true });
      const freshAttempt = () => {
        attempt = new AbortController();
        if (controller.signal.aborted) followParent();
      };
      // Backstop so a hung page/player can never leave the queue stuck on
      // "resolving". It watches for a STALL (no reported progress) rather than
      // capping total time: dubselect budgets itself per server, and how long it
      // legitimately needs depends on how many servers the page lists. The fixed
      // total this replaced was smaller than that budget, so it killed runs
      // partway down the server list - and because every retry replayed the same
      // sequence, the episode timed out forever with later servers never tried.
      const stallMs = dubselect.discoveryStallMs(url);
      let stallTimer = null;
      let onStall = () => {};
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => onStall(), stallMs);
      };
      const log = (msg) => {
        try {
          console.log(`[discover] ${msg}`);
        } catch (e) {
          // ignore
        }
        armStall(); // any progress report resets the watchdog
        onLog(msg);
      };
      const onFail = (_e, _code, desc, failedUrl) => {
        if (/:\/\/undefined\b/i.test(failedUrl || '')) {
          log(`Player embed failed to load (missing host): ${desc}`);
        }
      };
      let holdWindows = false;
      try {
        win.webContents.on('did-fail-load', onFail);
        const profile = sites.resolve(url);
        const pages = (profile.mirrorUrls && profile.mirrorUrls(url)) || [url];
        const triedHosts = new Set();
        const extra = typeof getOpts === 'function' ? getOpts() || {} : {};
        let outcome = null;
        // One attempt at the dubselect resolve, under the stall watchdog. The
        // watchdog measures SILENCE, so the CF-wait loops in dubselect/discover
        // window keep it alive by logging; a true stall aborts this attempt and
        // the caller moves to the next site/server.
        const runResolve = async (pageUrl) => {
          try {
            return await Promise.race([
              dubselect.selectDubAndResolve(win.webContents, pageUrl, log, mode, {
                signal: attempt.signal,
                skipSources: extra.skipSources || []
              }),
              new Promise((_, reject) => {
                onStall = () => {
                  followParent();
                  reject(new Error(`Discovery stalled for ${Math.round(stallMs / 1000)}s with no progress`));
                };
                armStall();
              })
            ]);
          } catch (e) {
            if (!/stalled/i.test((e && e.message) || '')) throw e;
            log(`${e.message}; leaving this site and trying the same episode elsewhere.`);
            freshAttempt();
            return { status: 'failed', reason: e.message };
          }
        };
        for (const pageUrl of pages) {
          let host = '';
          try {
            host = new URL(pageUrl).host;
          } catch (e) {
            host = '';
          }
          if (host && triedHosts.has(host)) continue;
          log(pageUrl === url ? `Loading ${pageUrl}` : `No 1080p yet; trying ${pageUrl}`);
          await loadWithTimeout(win, pageUrl, 30000);
          if (!(await passCloudflare(win, pageUrl, log))) {
            outcome = { status: 'failed', reason: 'Cloudflare check did not clear' };
            continue;
          }
          let landed = host;
          try {
            landed = new URL(win.webContents.getURL()).host;
          } catch (e) {
            // ignore
          }
          if (landed && triedHosts.has(landed)) {
            log(`${host || pageUrl} is the same site already checked.`);
            continue;
          }
          if (host) triedHosts.add(host);
          if (landed) triedHosts.add(landed);
          outcome = await runResolve(pageUrl);
          if (outcome && (outcome.status === 'resolved' || outcome.status === 'unavailable')) break;
        }
        let altGuard = 0;
        while (
          (!outcome || (outcome.status !== 'resolved' && outcome.status !== 'unavailable')) &&
          altGuard < 3 &&
          profile &&
          typeof profile.openAlternate === 'function'
        ) {
          const next = await profile.openAlternate(win.webContents, url, log, triedHosts, {
            load: (page) => loadWithTimeout(win, page, 30000),
            cloudflare: (page) => passCloudflare(win, page, log)
          });
          if (!next) break;
          altGuard += 1;
          log(`No 1080p on the last site; opening ${next}`);
          await loadWithTimeout(win, next, 30000);
          if (!(await passCloudflare(win, next, log))) {
            outcome = { status: 'failed', reason: 'Cloudflare check did not clear' };
            continue;
          }
          try {
            const landed = new URL(win.webContents.getURL()).host;
            if (landed) triedHosts.add(landed);
          } catch (e) {
            // ignore
          }
          outcome = await runResolve(next);
        }
        // Cross-site 1080p discovery. The catalog the user started on (all its
        // mirrors and alternates included) has no 1080p copy, so walk the rest
        // of the site registry in order and ask each for the same title. First
        // site that resolves a 1080p stream wins; only that one is downloaded.
        if (
          (!outcome || (outcome.status !== 'resolved' && outcome.status !== 'unavailable')) &&
          !controller.signal.aborted
        ) {
          const ref = episodeRefFromUrl(url);
          if (ref.title) {
            const want = ref.title + (ref.season ? ` S${ref.season}E${ref.episode || 1}` : '');
            log(`No 1080p on this catalog; searching other sites for ${want}.`);
            const hooks = {
              wc: win.webContents,
              load: (page) => loadWithTimeout(win, page, 30000),
              cloudflare: (page) => passCloudflare(win, page, log)
            };
            // Order the fallbacks by fallbackRank (non-Cloudflare first) so the
            // common 1080p path avoids a CF challenge. Sites without a rank are
            // tried last (anime/region adapters). This was alphabetical before,
            // which burned through irrelevant catalogs and hit Cloudflare early.
            const rank = (c) => (c && c.fallbackRank != null ? c.fallbackRank : 99);
            const cands = sites.profiles
              .filter((c) => c && c.id !== (profile && profile.id) && typeof c.findTitle === 'function')
              .sort((a, b) => rank(a) - rank(b));
            for (const cand of cands) {
              if (controller.signal.aborted) break;
              if (outcome && (outcome.status === 'resolved' || outcome.status === 'unavailable')) break;
              let pageUrl = null;
              try {
                pageUrl = await cand.findTitle(ref, hooks, log);
              } catch (e) {
                pageUrl = null;
                log(`Search on ${cand.name || cand.id} failed: ${(e && e.message) || e}`);
              }
              if (!pageUrl) continue;
              let host = '';
              try {
                host = new URL(pageUrl).host;
              } catch (e) {
                host = '';
              }
              if (host) triedHosts.add(host);
              log(`Found it on ${cand.name || cand.id}; loading ${pageUrl}`);
              try {
                await loadWithTimeout(win, pageUrl, 30000);
              } catch (e) {
                log(`Could not load ${pageUrl}: ${(e && e.message) || e}`);
                continue;
              }
              if (!(await passCloudflare(win, pageUrl, log))) {
                outcome = { status: 'failed', reason: 'Cloudflare check did not clear' };
                continue;
              }
              try {
                const landed = new URL(win.webContents.getURL()).host;
                if (landed) triedHosts.add(landed);
              } catch (e) {
                // ignore
              }
              outcome = await runResolve(pageUrl);
            }
          }
        }
        if (!outcome) outcome = { status: 'failed', reason: 'No 1080p stream on this site' };
        // Token CDNs (vidfast/peakstorm/embedmaster) only serve segments while
        // the player page is still open. Destroying it here made download fail
        // in ~1s with an empty playlist / net::ERR_FAILED.
        if (outcome && outcome.status === 'resolved' && outcome.detection) {
          const det = outcome.detection;
          const embed = det.embedUrl || '';
          const keep = hlscheck.isPlayerBoundCdn(det.url, embed);
          if (keep) {
            holdWindows = true;
            log('Keeping the player open until this episode finishes downloading.');
            det.releaseDiscover = () => {
              try {
                destroyOwned(ownerId);
              } catch (e) {
                // ignore
              }
            };
          }
        }
        return outcome;
      } catch (e) {
        log(`Discovery error for ${url}: ${e.message || e}`);
        return { status: 'failed', reason: e.message || 'Discovery failed' };
      } finally {
        // Abort leftover in-page waits. Do not destroy token-CDN player windows
        // on success: download still needs them.
        controller.abort();
        if (stallTimer) clearTimeout(stallTimer);
        try {
          win.webContents.removeListener('did-fail-load', onFail);
        } catch (e) {
          // ignore
        }
        if (!holdWindows) destroyOwned(ownerId);
      }
    });
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
      // Defense in depth: this fetches remote HTML, so it needs the tunnel
      // even though its callers already gate on the VPN.
      await vpn.waitUntilConnected();
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
async function detectEpisodes(url, onLog = () => {}, opts = {}) {
  // Part 3: episode detection goes online (page HTML, live DOM scans). Never
  // run it without a confirmed tunnel; the caller holds until it is back.
  await vpn.waitUntilConnected();
  const profile = sites.resolve(url);
  const scanJs =
    typeof profile.episodeScan === 'function'
      ? profile.episodeScan({ season: opts.season, url })
      : (profile && profile.episodeScan) || episodeScanScript();

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
    return { list, max: list.length ? list[list.length - 1] : 0, aired: fast.aired, total: fast.total, urls: {} };
      }
    } catch (e) {
      // fall through to the window-based scan
    }
  }

  // Live-DOM scans (SFlix season tabs, FilmeHD in-page buttons) need the same
  // session and JS privileges as discovery. A sandboxed hidden window often
  // never hydrates the episode list, then bulk invents fake Watch URLs.
  const useDiscover = !!(profile && profile.episodeScan);
  const ownerId = `detect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const win = useDiscover
    ? createDiscoverWindow(ownerId)
    : new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        webPreferences: { partition: config.sessionPartition, backgroundThrottling: false, sandbox: true }
      });
  try {
    await loadWithTimeout(win, url, 30000);
    let res = { list: [], max: 0, aired: 0, total: 0 };
    const tries = useDiscover ? 12 : 8;
    const waitMs = useDiscover ? 2000 : 1500;
    let followedCatalog = false;
    for (let i = 0; i < tries; i++) {
      res = await win.webContents
        .executeJavaScript(scanJs, true)
        .catch(() => ({ list: [], max: 0, aired: 0, total: 0 }));
      if (
        !followedCatalog &&
        res.catalog &&
        res.catalog !== url &&
        !(res.list && res.list.length > 1)
      ) {
        onLog(`Opening series page ${res.catalog}`);
        followedCatalog = true;
        await loadWithTimeout(win, res.catalog, 30000);
        continue;
      }
      // A single current Watch URL is not a season list. Keep waiting / follow
      // the series page so bulk does not queue only episode 1.
      if (res.list && res.list.length > 1) break;
      if (res.aired > 1) break;
      await delay(waitMs);
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
      onLog(
        useDiscover
          ? `Detected only the current episode (${list[0]}) — the season list did not load.`
          : 'Detected 1 episode from the page.'
      );
    } else {
      list = [];
      onLog('Could not detect episode count from the page.');
    }
    return {
      list,
      max: list.length ? list[list.length - 1] : 0,
      aired: res.aired,
      total: res.total,
      urls: res.urls || {},
      season: res.season
    };
  } finally {
    if (useDiscover) destroyOwned(ownerId);
    else if (!win.isDestroyed()) win.destroy();
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
    const { template, season: seasonFromEntry } = entryTemplate(entry);
    let season = seasonFromEntry;

    if (!template) {
      onLog(`Skipping "${series}": no usable URL/template.`);
      continue;
    }
    onLog(`"${series}" - audio: ${mode.toUpperCase()}${mode === 'sub' ? ' (subtitles embedded)' : ''}`);

    // Determine which episodes to queue.
    let episodes;
    let episodeUrls = {};
    const endRaw = String(entry.endEp == null ? '' : entry.endEp).trim().toLowerCase();
    const endNum = parseInt(endRaw, 10);
    const profile = sites.resolve(entry.baseUrl || template);
    const needDetect =
      !endRaw ||
      endRaw === 'auto' ||
      isNaN(endNum) ||
      !urltemplate.hasEpisodeToken(template) ||
      !!(profile && profile.episodeScan);
    if (endRaw && endRaw !== 'auto' && !isNaN(endNum) && !needDetect) {
      episodes = range(start, endNum);
    } else {
      onLog(`Auto-detecting episode count for "${series}"...`);
      let probeUrl = entry.catalogUrl || entry.baseUrl || template;
      if (!entry.catalogUrl && typeof profile.catalogUrl === 'function') {
        probeUrl = profile.catalogUrl(entry.baseUrl || template) || probeUrl;
      } else if (!entry.catalogUrl) {
        probeUrl =
          urltemplate.buildEpisodeUrl({ template, baseUrl: entry.baseUrl, season, series }, start) ||
          entry.baseUrl;
      }
      if (probeUrl && probeUrl !== entry.baseUrl) {
        onLog(`Scanning episode list at ${probeUrl}`);
      }
      const det = await detectEpisodes(probeUrl, onLog, { season });
      episodeUrls = det.urls || {};
      if (season == null && det.season) season = det.season;
      if (det.season) {
        onLog(`Scanning season ${det.season} for "${series}".`);
      }
      if (det.list && det.list.length) {
        episodes = det.list.filter((e) => e >= start);
        if (endRaw && endRaw !== 'auto' && !isNaN(endNum)) {
          episodes = episodes.filter((e) => e <= endNum);
        }
      } else if (det.max > 0) {
        episodes = range(start, endNum && !isNaN(endNum) ? endNum : det.max);
      } else if (profile && profile.inventEpisodeUrls === false) {
        const current = entry.baseUrl && /\/episodes\//i.test(entry.baseUrl) ? entry.baseUrl : null;
        const titleUrl = entry.baseUrl || template;
        if (current) {
          const n = urltemplate.parseEpisodeFromUrl(current) || start;
          episodes = [n];
          episodeUrls[n] = current;
          onLog(`Could not detect the episode list for "${series}"; queuing only episode ${n} from the current page.`);
        } else if (typeof profile.singleTitle === 'function' && profile.singleTitle(titleUrl)) {
          // A movie or one-off special: no episode list to find, so the page
          // itself is the download. Season/episode stay unset so the file is
          // named "<Title>.mp4" the way media servers expect a movie.
          onLog(`No episode list for "${series}" - treating it as a single title.`);
          const one = await queueOne(
            { url: titleUrl, series, season: null, episode: null, mode, outputRoot, group },
            onLog
          );
          queued += one.queued;
          skipped += one.skipped;
          continue;
        } else {
          episodes = [];
          onLog(`Could not detect the episode list for "${series}"; not inventing Watch URLs.`);
        }
      } else {
        onLog(`Could not detect episode count for "${series}"; defaulting to ${start}-12.`);
        episodes = range(start, 12);
      }
    }

    for (const ep of episodes) {
      let url = episodeUrls[ep] || episodeUrls[String(ep)];
      if (!url && !(profile && profile.inventEpisodeUrls === false)) {
        url = urltemplate.buildEpisodeUrl({ template, baseUrl: entry.baseUrl, season, series }, ep);
      }
      if (!url) {
        onLog(
          profile && profile.inventEpisodeUrls === false
            ? `Skipping "${series}" episode ${ep}: no Watch URL from the episode list.`
            : `Skipping "${series}": template has no {episode}/ep-N to substitute.`
        );
        if (profile && profile.inventEpisodeUrls === false) continue;
        break;
      }

      // Prefer the season in the episode's real Watch URL. Without this a
      // batch whose season never got detected names every file S1, so season 3
      // would land on top of season 1 in a media server.
      const epSeason = season != null ? season : organizer.parseSeasonFromUrl(url);
      const meta = { series, season: epSeason, episode: ep };
      const already = await existingKeepsEpisode(outputRoot, meta, url, onLog);
      if (already) {
        skipped += 1;
        onLog(`Already exists, skipping: ${path.basename(already)}`);
        continue;
      }

      const label = organizer.buildBaseName(meta) + (mode === 'sub' ? ' [SUB]' : '');
      const spec = {
        label,
        series,
        season: epSeason,
        episode: ep,
        outputRoot,
        template,
        baseUrl: entry.baseUrl,
        mode,
        library: opts.library || null,
        minHeight: Number(opts.minHeight) || 0
      };
      const rec = {
        label,
        series,
        season: epSeason,
        episode: ep,
        mode,
        group,
        outputRoot,
        stopRunOnFail,
        library: opts.library || null,
        minHeight: Number(opts.minHeight) || 0,
        jobId: opts.jobId || null,
        url,
        template,
        baseUrl: entry.baseUrl,
        key: pending.constructor.key(spec),
        skipSources: [],
        onUnavailable: () => pending.add(spec)
      };
      rec.discover = makeDiscover(url, onLog, mode, () => ({ skipSources: rec.skipSources }));
      const added = manager.add(rec);
      if (added) queued += 1;
    }
  }

  onLog(`Batch queued: ${queued} item(s), ${skipped} skipped (already present).`);
  return { queued, skipped };
}

// One episode, same discovery path as Aniwave bulk items. Used for "Download
// this episode" on SFlix (sniffed playlists there are usually not fetchable).
async function queueOne(entry, onLog = () => {}) {
  const url = String((entry && entry.url) || '').trim();
  const series = (entry && entry.series) || 'Video';
  const asked = entry && entry.season != null && entry.season !== '' ? entry.season : null;
  const episode = entry && entry.episode;
  // Same reason as the batch path: fall back to the season in the Watch URL so
  // an undetected season does not name the file S1. A movie passes season
  // null with episode null and must stay unnumbered.
  const season = asked != null || episode == null ? asked : organizer.parseSeasonFromUrl(url);
  const mode = entry && entry.mode === 'sub' ? 'sub' : 'dub';
  const outputRoot = entry && entry.outputRoot;
  if (!url) {
    onLog(`Skipping "${series}": no episode URL.`);
    return { queued: 0, skipped: 0 };
  }
  if (outputRoot) organizer.ensureDir(outputRoot);
  const meta = { series, season, episode };
  const already = outputRoot ? await existingKeepsEpisode(outputRoot, meta, url, onLog) : null;
  if (already) {
    onLog(`Already exists, skipping: ${path.basename(already)}`);
    return { queued: 0, skipped: 1 };
  }
  const label = organizer.buildBaseName(meta) + (mode === 'sub' ? ' [SUB]' : '');
  const spec = {
    label,
    series,
    season,
    episode,
    outputRoot,
    baseUrl: url,
    mode,
    library: (entry && entry.library) || null,
    minHeight: Number((entry && entry.minHeight) || 0)
  };
  const rec = {
    label,
    series,
    season,
    episode,
    mode,
    group: (entry && entry.group) || `single-${Date.now().toString(36)}`,
    outputRoot,
    stopRunOnFail: false,
    library: (entry && entry.library) || null,
    minHeight: Number((entry && entry.minHeight) || 0),
    jobId: (entry && entry.jobId) || null,
    url,
    baseUrl: url,
    key: pending.constructor.key(spec),
    skipSources: [],
    onUnavailable: () => pending.add(spec)
  };
  rec.discover = makeDiscover(url, onLog, mode, () => ({ skipSources: rec.skipSources }));
  const noun = episode != null && episode !== '' ? 'episode' : 'title';
  const added = manager.add(rec);
  if (added) {
    onLog(`Queued ${noun}: ${label}`);
    return { queued: 1, skipped: 0 };
  }
  onLog(`${noun === 'episode' ? 'Episode' : 'Title'} already in the queue: ${label}`);
  return { queued: 0, skipped: 0 };
}

module.exports = { startBatch, queueOne, makeDiscover, entryTemplate, detectEpisodes };
