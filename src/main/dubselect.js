'use strict';

const https = require('https');
const http = require('http');
const config = require('./config');
const sniffer = require('./sniffer');
const sites = require('./sites');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Builds the DUB variant of a detected (sub) stream URL by inserting the site's
// audio marker into the slug segment that precedes the episode number, e.g.
//   ".../seihantai-na-kimi-to-boku/3/master.m3u8"
//     -> ".../seihantai-na-kimi-to-boku-dub/3/master.m3u8"
// Returns null if the URL doesn't fit the pattern or already contains the marker.
function dubVariantUrl(url, marker) {
  if (!url || !marker) return null;
  if (url.toLowerCase().includes(marker.toLowerCase())) return url;
  const re = /\/([a-z0-9][a-z0-9-]*?)\/(\d+)\//i;
  if (!re.test(url)) return null;
  return url.replace(re, (m, slug, ep) => `/${slug}${marker}/${ep}/`);
}

// Verifies a *constructed* stream URL (e.g. slug + "-dub") actually exists
// before we commit to it. Uses the original request headers so the CDN doesn't
// 403 us. Hard-capped so a stalled CDN can never leave an episode stuck in
// "resolving". Accepts HLS playlists and direct MP4/DASH (HTTP 2xx).
function urlIsPlayable(url, headers, redirectsLeft = 3) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      resolve(v);
    };
    const hardTimer = setTimeout(() => fin(false), 8000);
    let mod;
    let parsed;
    try {
      parsed = new URL(url);
      mod = parsed.protocol === 'https:' ? https : http;
    } catch (e) {
      return fin(false);
    }
    const h = {};
    for (const k of Object.keys(headers || {})) {
      if (k.toLowerCase() !== 'host') h[k] = headers[k];
    }
    let req;
    try {
      req = mod.get(url, { headers: h, timeout: 7000 }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return urlIsPlayable(new URL(res.headers.location, url).toString(), headers, redirectsLeft - 1).then(fin);
        }
        if (code < 200 || code >= 300) {
          res.resume();
          return fin(false);
        }
        // Direct media files: a live 2xx is enough (no playlist body to inspect).
        if (/\.(mp4|mpd)(\?|$)/i.test(url) || /video\//i.test(res.headers['content-type'] || '')) {
          res.resume();
          return fin(true);
        }
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          if (buf.length > 8192) {
            try {
              req.destroy();
            } catch (e) {
              /* ignore */
            }
            fin(/#EXTM3U/i.test(buf) || /#EXT-X-/i.test(buf) || /<MPD[\s>]/i.test(buf));
          }
        });
        res.on('end', () =>
          fin(/#EXTM3U/i.test(buf) || /#EXT-X-/i.test(buf) || /<MPD[\s>]/i.test(buf) || buf.length > 0)
        );
      });
    } catch (e) {
      return fin(false);
    }
    req.on('error', () => fin(false));
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch (e) {
        /* ignore */
      }
      fin(false);
    });
  });
}

// In-page scan. Finds the DUB and SUB toggles, then classifies each provider
// button (Vidplay/BYFMS/DGHG/...) into the DUB row or the SUB row by vertical
// proximity to each toggle. This is what prevents grabbing a SUB stream when we
// asked for DUB (the page shows both rows at once). Explicit CSS selectors from
// the site profile take priority, with heuristics as fallback.
function scanScript(opts) {
  return `(() => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const dubLabels = ${JSON.stringify(opts.dubLabelText || [])};
    const subLabels = ${JSON.stringify(opts.subLabelText || [])};
    const known = ${JSON.stringify(opts.knownSourceLabels || [])};
    const dubSelector = ${JSON.stringify(opts.dubSelector || '')};
    const subSelector = ${JSON.stringify(opts.subSelector || '')};
    const sourceSelector = ${JSON.stringify(opts.sourceSelector || '')};

    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const text = (el) => norm(el.textContent).slice(0, 40);
    const matchesAny = (t, arr) => arr.some((w) => t === w || t.includes(w));
    const q = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };
    const top = (el) => el.getBoundingClientRect().top;
    const left = (el) => el.getBoundingClientRect().left;
    const clickable = Array.from(document.querySelectorAll('button, a, li, div, span, [role="button"], [onclick]'));

    // A row label is an element whose text - ignoring emoji/icons - is exactly
    // "sub"/"dub". This avoids matching a big container or a "Sub & Dub" filter
    // dropdown that merely contains the word.
    const isLabel = (el, labels) => {
      const t = text(el).replace(/[^a-z ]/g, '').replace(/\\s+/g, ' ').trim();
      return labels.some((w) => t === w);
    };
    // The SUB / DUB row labels can be ANY element (span, b, label, div...), not
    // just clickable ones, so search all elements for one whose own short text is
    // exactly "sub"/"dub" (icons/emoji stripped).
    const allEls = Array.from(document.querySelectorAll('*'));
    const labelsOf = (words) => allEls.filter((el) => isLabel(el, words) && visible(el) && !matchesAny(text(el), known));
    let dub = dubSelector ? q(dubSelector).find(visible) : labelsOf(dubLabels)[0];
    let sub = subSelector ? q(subSelector).find(visible) : labelsOf(subLabels)[0];

    // The audio a button belongs to, read from an explicit data-type="sub|dub"
    // on the button or an ancestor (HiAnime-style sites like enma.lol tag every
    // .server-item this way). This is authoritative when present - no geometry.
    const dataMode = (el) => {
      const h = el.closest ? el.closest('[data-type]') : null;
      const v = h ? norm(h.getAttribute('data-type')) : '';
      return v === 'sub' || v === 'dub' ? v : '';
    };

    // Provider/server candidates.
    let cands = [];
    if (sourceSelector) cands = q(sourceSelector).filter(visible);
    if (!cands.length) {
      cands = clickable.filter((el) => visible(el) && (
        matchesAny(text(el), known) || el.dataset.provider || el.dataset.server ||
        el.dataset.serverId || el.dataset.linkId || dataMode(el)
      ));
    }
    // Drop the toggles themselves and pure label chips.
    cands = cands.filter((el) => {
      const t = text(el);
      const isLabelOnly = (matchesAny(t, dubLabels) || matchesAny(t, subLabels)) && !matchesAny(t, known);
      return !isLabelOnly;
    });
    // Keep only the leaf-most candidates: drop any wrapper that contains another
    // candidate (e.g. the whole "sub/dub" block or a row container), which would
    // otherwise be misread as an extra source button.
    cands = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    // A real provider button has short text (~one known label), not the
    // concatenated text of a container.
    cands = cands.filter((el) => text(el).replace(/\\s+/g, '').length <= 24);

    // Classify each candidate button by the SUB/DUB label whose ROW (vertical
    // center) is nearest. The page shows "SUB <servers>" and "DUB <servers>" as
    // two horizontal rows, so the closest label vertically is the right audio.
    const midY = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    const subY = sub ? midY(sub) : null;
    const dubY = dub ? midY(dub) : null;
    let dubSources = [], subSources = [];
    for (const el of cands) {
      const y = midY(el);
      const dm = dataMode(el);
      let isSubRow;
      if (dm) isSubRow = dm === 'sub'; // explicit data-type wins over geometry
      else if (subY != null && dubY != null) isSubRow = Math.abs(y - subY) < Math.abs(y - dubY);
      else if (dubY != null) isSubRow = Math.abs(y - dubY) > 80; // far from the dub row -> sub
      else if (subY != null) isSubRow = Math.abs(y - subY) < 80; // near the sub row -> sub
      else isSubRow = false; // no labels found -> assume dub (we still try every button)
      (isSubRow ? subSources : dubSources).push(el);
    }

    // Sort row-by-row (top), then left-to-right. Dedup by text+row so the SAME
    // provider in TWO different rows (e.g. a sub-row Vidplay AND a dub-row Vidplay)
    // are BOTH kept and tried - only a genuinely duplicated element at the same
    // spot is dropped. This is what lets us fall through to servers 2 and 3 (and
    // the other row) when the first one is broken.
    const order = (arr) => arr.sort((a, b) => top(a) - top(b) || left(a) - left(b));
    const dedup = (arr) => {
      const seen = new Set();
      return arr.filter((el) => {
        const k = text(el) + '@' + Math.round(top(el) / 8);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    dubSources = dedup(order(dubSources));
    subSources = dedup(order(subSources));

    dubSources.forEach((el, i) => el.setAttribute('data-wvd-source', 'dub-' + i));
    subSources.forEach((el, i) => el.setAttribute('data-wvd-source', 'sub-' + i));
    if (dub) dub.setAttribute('data-wvd-toggle', 'dub');
    if (sub) sub.setAttribute('data-wvd-toggle', 'sub');

    return {
      hasDub: !!dub,
      hasSub: !!sub,
      dubSources: dubSources.map((el, i) => ({ index: i, label: text(el) })),
      subSources: subSources.map((el, i) => ({ index: i, label: text(el) }))
    };
  })()`;
}

function clickScript(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`;
}

// Synthesizes a real mouse click at the centre of the player area. Third-party
// embeds (e.g. BYFMS/DGHG) often won't start from a programmatic .click(), so a
// true input event is needed to kick playback and make their stream requests
// fire so the sniffer can capture them.
async function clickPlayerArea(wc) {
  let pt = null;
  try {
    pt = await wc.executeJavaScript(
      `(() => {
        const els = Array.from(document.querySelectorAll('video, iframe'));
        let best = null, area = 0;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          const a = r.width * r.height;
          if (a > area && r.width > 200 && r.height > 150) { area = a; best = r; }
        }
        return best ? { x: Math.round(best.left + best.width / 2), y: Math.round(best.top + best.height / 2) } : null;
      })()`,
      true
    );
  } catch (e) {
    pt = null;
  }
  if (!pt) return;
  try {
    wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  } catch (e) {
    // ignore
  }
}

// Resolves a stream for the page in `wc`, for the requested mode.
//   mode 'dub' (default): selects DUB and tries the DUB-row sources.
//   mode 'sub': selects SUB, tries the SUB-row sources, and captures a subtitle
//               track so it can be embedded into the .mp4.
// Returns { status: 'resolved'|'unavailable'|'failed', detection?, reason? }.
async function selectDubAndResolve(wc, url, onLog = () => {}, mode = 'dub') {
  const id = wc.id;
  const profile = sites.resolve(url || '');
  const dub = sites.dubConfig(profile);
  if (profile.id !== 'generic') onLog(`Using site profile: ${profile.name}`);

  await delay(dub.pageSettleMs);

  // Optional per-site prep (e.g. FilmeHD clicks the in-page episode button).
  if (typeof profile.beforeResolve === 'function') {
    const epMatch = String(url || '').match(/[#&?]ep[=-]?(\d+)/i);
    const episode = epMatch ? parseInt(epMatch[1], 10) : null;
    try {
      await profile.beforeResolve(wc, { episode, mode, url, onLog });
    } catch (e) {
      onLog(`Site beforeResolve error: ${e.message || e}`);
    }
  }

  const wantSub = mode === 'sub';
  const MODE = wantSub ? 'SUB' : 'DUB';
  const OTHER = wantSub ? 'DUB' : 'SUB';
  const hints = dub.modeHints;

  // Classifies a URL's audio from the site's path hints (e.g. "-dub"/"-sub").
  const urlMode = (u) => {
    const lo = (u || '').toLowerCase();
    const isDub = ((hints && hints.dub) || []).some((re) => re.test(lo));
    const isSub = ((hints && hints.sub) || []).some((re) => re.test(lo));
    return isDub && !isSub ? 'dub' : isSub && !isDub ? 'sub' : null;
  };

  let dubUnplayable = false;

  // For sites that tag audio in the path (e.g. ".../show-dub/3/..."): derive the
  // dub URL from a bare-slug stream and verify it over HTTP. Deterministic - it
  // can never download the sub. Only meaningful for same-host providers (Vidplay);
  // tokenised foreign CDNs (BYFMS/DGHG) just produce a 404 here and fall through.
  const tryDubVariant = async (any) => {
    if (!dub.dubPathMarker || !any) return null;
    const dubUrl = dubVariantUrl(any.url, dub.dubPathMarker);
    if (!dubUrl || dubUrl === any.url) return null;
    onLog(`Probing DUB variant: ${dubUrl}`);
    if (!(await urlIsPlayable(dubUrl, any.headers))) {
      // Constructed -dub URL isn't live - often means still encoding.
      dubUnplayable = true;
      return null;
    }
    onLog('Confirmed DUB variant exists.');
    return { url: dubUrl, type: any.type || 'hls', headers: any.headers, webContentsId: id, ts: Date.now() };
  };

  // Decides the DUB detection to use from a stream a server produced:
  //   - explicit "-sub" URL -> never dub (reject)
  //   - explicit "-dub" URL  -> trust it (sniffer only records 2xx now)
  //   - unmarked URL         -> prefer a verified "-dub" variant (same-host
  //                             providers like Vidplay); else, if the button came
  //                             from the DUB row, TRUST the row and use the stream
  //                             as-is (tokenised BYFMS/DGHG/playmogo CDNs carry
  //                             no "-dub" marker and usually block Node probes).
  // IMPORTANT: never re-probe sniffed streams with Node http. Those CDNs often
  // 403/challenge outside Chromium, which used to reject every server, burn the
  // full sourceWaitMs on each, and leave the UI stuck on "resolving".
  const resolveDub = async (s, fromRow) => {
    if (!s) return null;
    const m = urlMode(s.url);
    if (m === 'sub') return null;
    if (m === 'dub') return s;
    const variant = await tryDubVariant(s);
    if (variant) return variant;
    if (fromRow === 'DUB') {
      onLog(`Stream has no -dub/-sub marker; trusting DUB row for ${s.url}`);
      return s;
    }
    return null;
  };

  // SUB mode accepts an unmarked or "-sub" stream, never a "-dub" one.
  const resolveSub = (s) => (s && urlMode(s.url) !== 'dub' ? s : null);

  // 0) The page auto-plays a default server on load. If that already produced the
  //    audio we want (verified live), we're done - no clicking needed.
  await waitForMedia(id, 5000);
  if (wantSub) {
    const d = resolveSub(sniffer.bestForMode(id, 'sub', hints, false));
    if (d) {
      onLog('Auto-played default is a SUB stream.');
      return finalize(d, id, true, onLog);
    }
  } else {
    // Don't trust the autoplay row (unknown) - only accept a marked/verified dub.
    const d = await resolveDub(sniffer.best(id), null);
    if (d) {
      onLog('Auto-played default resolved a DUB stream.');
      return finalize(d, id, false, onLog);
    }
  }

  // 1) Scan for server buttons and try them left-to-right.
  const logScan = (scan) => {
    const fmt = (arr) => (arr && arr.length ? arr.map((s) => `"${s.label || s.index}"`).join(', ') : 'none');
    onLog(
      `Scan: DUB toggle=${scan.hasDub ? 'yes' : 'NO'}, SUB toggle=${scan.hasSub ? 'yes' : 'NO'}; ` +
        `DUB servers=[${fmt(scan.dubSources)}]; SUB servers=[${fmt(scan.subSources)}]`
    );
  };

  let scan = await wc.executeJavaScript(scanScript(dub), true).catch(() => null);
  if (!scan) return { status: 'failed', reason: 'Could not scan the page (did it load?)' };

  // Diagnostics: show exactly how the page's servers were split into rows. If the
  // rows are swapped/empty this is where a DUB request ends up grabbing a SUB.
  logScan(scan);

  // Cold first loads (especially episode 1 under bulk concurrency) often paint
  // the player before the SUB/DUB server row hydrates. Re-scan once so we don't
  // misread an empty row as "dub not released".
  if (!(scan.dubSources || []).length && !(scan.subSources || []).length) {
    onLog('No server buttons yet; waiting for the page to finish rendering...');
    await delay(Math.max(1500, dub.pageSettleMs));
    const again = await wc.executeJavaScript(scanScript(dub), true).catch(() => null);
    if (again) {
      scan = again;
      logScan(scan);
    }
  }

  const reqAttr = wantSub ? 'sub' : 'dub';
  const otherAttr = wantSub ? 'dub' : 'sub';
  const primary = (wantSub ? scan.subSources : scan.dubSources).map((s) => ({ ...s, attr: reqAttr, from: MODE }));
  const fallback = (wantSub ? scan.dubSources : scan.subSources).map((s) => ({ ...s, attr: otherAttr, from: OTHER }));
  // When the requested-audio row has servers, only try those. Falling through
  // every SUB server after DUB timeouts made bulk runs look "stuck resolving"
  // for minutes under concurrency (6 × sourceWaitMs per episode).
  const tryList = primary.length ? primary : fallback;

  if (!tryList.length) {
    return { status: 'failed', reason: 'No video sources found on the page' };
  }

  onLog(
    `Found ${primary.length} ${MODE} + ${fallback.length} ${OTHER} server(s); ` +
      `trying ${primary.length ? MODE : OTHER} left-to-right` +
      (primary.length ? '' : ` (${MODE} row empty)`) +
      '.'
  );

  let sawStream = false;
  let primaryGotStream = false;
  for (const src of tryList) {
    const isPrimary = src.from === MODE;
    sniffer.clear(id); // only count streams produced by THIS click
    onLog(`Trying ${src.from} server "${src.label || src.index}"...`);
    const clicked = await wc
      .executeJavaScript(clickScript(`[data-wvd-source="${src.attr}-${src.index}"]`), true)
      .catch(() => false);
    if (!clicked) continue;

    // Many providers are third-party iframes that won't start from a programmatic
    // click - send a real mouse click into the player to trigger playback.
    await delay(700);
    await clickPlayerArea(wc);

    const arrived = await waitForMedia(id, dub.sourceWaitMs);
    if (!arrived) {
      onLog(`"${src.label || src.index}" gave no stream; trying next.`);
      continue;
    }
    const s = sniffer.best(id);
    if (s) {
      sawStream = true;
      if (isPrimary) primaryGotStream = true;
    }
    const det = wantSub
      ? resolveSub(sniffer.bestForMode(id, 'sub', hints, false))
      : await resolveDub(s, src.from);
    if (det) {
      onLog(`Using ${MODE} stream from "${src.label || src.index}": ${det.url}`);
      return finalize(det, id, wantSub, onLog);
    }
    onLog(`"${src.label || src.index}" produced ${s ? s.url : 'no usable stream'} (not a playable ${MODE}); trying next.`);
  }

  // Classify carefully:
  //   unavailable = the requested audio truly isn't out yet (watcher retries later)
  //   failed      = transient (timeouts / load) so the queue retries this episode
  //
  // Under bulk concurrency, episode 1 often times out on every DUB server while
  // a SUB fallback still produces a stream. The old `sawStream` check treated
  // that as "dub not released" and skipped retries — the intermittent first-ep
  // failure. Only park on the waiting list when we have real evidence.
  if (primary.length > 0 && !primaryGotStream && !dubUnplayable) {
    onLog(
      `All ${MODE} servers timed out or produced no stream (likely transient under load); will retry.`
    );
    return {
      status: 'failed',
      reason: `No ${MODE} server produced a stream (timeout/load)`
    };
  }

  // A MODE URL existed but 404'd (still encoding), or primary/fallback produced
  // only the other audio -> not out yet.
  if (dubUnplayable || sawStream) {
    onLog(`No playable ${MODE} stream yet - ${MODE} not out/still encoding; adding to the waiting list.`);
    return { status: 'unavailable', reason: `${MODE} not released yet` };
  }
  return { status: 'failed', reason: 'No server produced a playable stream' };
}

// Attaches subtitle info for Sub mode so the downloader can embed it.
function finalize(detection, id, wantSub, onLog) {
  onLog(`Resolved stream: ${detection.url}`);
  if (wantSub) {
    detection.embedSubs = true;
    const sub = sniffer.latestSub(id);
    if (sub) {
      detection.subtitleUrl = sub.url;
      detection.subtitleHeaders = sub.headers;
      onLog('Captured subtitle track for embedding.');
    } else {
      onLog('No separate subtitle file detected; will embed subtitles from the stream if present.');
    }
  }
  return { status: 'resolved', detection };
}

// Waits for media, then a short grace period to capture sibling streams
// (master + variants), returning the single best one. Null on timeout.
function waitForMedia(webContentsId, timeoutMs, graceMs = 1800) {
  return new Promise((resolve) => {
    let done = false;
    let graceTimer = null;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      sniffer.removeListener('detected', onDetected);
      resolve(sniffer.best(webContentsId));
    };
    const arm = () => {
      if (!graceTimer) graceTimer = setTimeout(settle, graceMs);
    };
    const onDetected = (d) => {
      if (done) return;
      if (d.webContentsId === webContentsId && ['hls', 'mp4', 'dash'].includes(d.type)) arm();
    };
    if (sniffer.best(webContentsId)) arm();
    const timer = setTimeout(settle, timeoutMs);
    sniffer.on('detected', onDetected);
  });
}

module.exports = { selectDubAndResolve, waitForMedia };
