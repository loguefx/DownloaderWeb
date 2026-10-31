'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { session, webContents } = require('electron');
const config = require('./config');
const hlscheck = require('./hlscheck');

class AbortError extends Error {
  constructor(msg = 'Aborted') {
    super(msg);
    this.name = 'AbortError';
  }
}

// On Linux/macOS a bundled static binary is useless without the executable bit.
// ffprobe-static in particular often ships without it, so downloads fail with
// EACCES ("Permission denied") even though the identical setup works on Windows
// (where the exec bit is irrelevant). Best-effort chmod fixes writable installs
// (npm start / AppImage); read-only installs (pacman) rely on the postinstall
// chmod instead, so a failure here is non-fatal.
function ensureExecutable(p) {
  if (!p || process.platform === 'win32') return p;
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch (e) {
    try {
      fs.chmodSync(p, 0o755);
    } catch (e2) {
      // read-only location or not owner; leave as-is and let spawn surface it
    }
  }
  return p;
}

function findOnPath(name) {
  // `which` is Unix-only; Windows needs `where`. execFile bypasses the shell so
  // PowerShell's `where` alias is not a problem.
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    });
    const first = String(out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    return first || null;
  } catch (e) {
    return null;
  }
}

function unpackAsar(p) {
  if (p && p.includes('app.asar')) return p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function ffmpegPath() {
  // Prefer a system ffmpeg when present. The ffmpeg-static binary SIGSEGVs on
  // some newer distros (e.g. CachyOS), and system builds understand current HLS
  // demuxer flags we need for extensionless CDN segments.
  const fromPath = findOnPath('ffmpeg');
  if (fromPath) return fromPath;
  let p = require('ffmpeg-static');
  return ensureExecutable(unpackAsar(p));
}

function ffprobePath() {
  const fromPath = findOnPath('ffprobe');
  if (fromPath) return fromPath;
  try {
    const ffprobeStatic = require('ffprobe-static');
    let p = ffprobeStatic && ffprobeStatic.path;
    return ensureExecutable(unpackAsar(p));
  } catch (e) {
    return null;
  }
}

// ffmpeg-static on Windows is 6.1.1 (no -extension_picky / -allowed_segment_extensions).
// Linux distro ffmpeg is often 7+, which defaults extension_picky=1 and *needs* those
// flags for extensionless CDN segments. Always passing the FFmpeg 7 flags makes every
// Windows download die at argument parsing: "Unrecognized option 'extension_picky'".
// Probe once, silently (do not attach this to a download's stderr log).
let cachedHlsRelaxArgs = null;
function hlsRelaxArgs() {
  if (cachedHlsRelaxArgs) return cachedHlsRelaxArgs;
  const probed = spawnSync(ffmpegPath(), ['-hide_banner', '-h', 'demuxer=hls'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  const help = `${probed.stdout || ''}${probed.stderr || ''}${probed.error ? probed.error.message : ''}`;
  const args = [];
  if (/extension_picky/i.test(help)) args.push('-extension_picky', '0');
  if (/allowed_extensions/i.test(help)) args.push('-allowed_extensions', 'ALL');
  if (/allowed_segment_extensions/i.test(help)) args.push('-allowed_segment_extensions', 'ALL');
  // Without this the demuxer skips a segment the CDN failed on and exits 0,
  // leaving a file minutes short of the episode.
  if (/seg_max_retry/i.test(help)) args.push('-seg_max_retry', '8');
  cachedHlsRelaxArgs = args;
  return args;
}

let cachedHttpReconnectArgs = null;
function httpReconnectArgs() {
  if (cachedHttpReconnectArgs) return cachedHttpReconnectArgs;
  const probed = spawnSync(ffmpegPath(), ['-hide_banner', '-h', 'protocol=https'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  const help = `${probed.stdout || ''}${probed.stderr || ''}${probed.error ? probed.error.message : ''}`;
  const args = [];
  if (/-reconnect\s/m.test(help)) args.push('-reconnect', '1');
  if (/reconnect_streamed/i.test(help)) args.push('-reconnect_streamed', '1');
  if (/reconnect_on_network_error/i.test(help)) args.push('-reconnect_on_network_error', '1');
  // Do NOT reconnect on 429: immediate retries deepen the rate limit. Queue +
  // cooldown below wait it out instead.
  if (/reconnect_on_http_error/i.test(help)) args.push('-reconnect_on_http_error', '500,502,503,504');
  if (/reconnect_delay_max/i.test(help)) args.push('-reconnect_delay_max', '15');
  if (/reconnect_max_retries/i.test(help)) args.push('-reconnect_max_retries', '4');
  // Windows errno 138 is ETIMEDOUT. ffmpeg's default socket wait is short enough
  // that Mullvad + a slow token CDN fails to open the input at all.
  if (/\brw_timeout\b/i.test(help)) args.push('-rw_timeout', '60000000');
  if (/\b-timeout\b/m.test(help) || /timeout\s+timeout/i.test(help)) {
    args.push('-timeout', '60000000');
  }
  cachedHttpReconnectArgs = args;
  return args;
}

function isRateLimited(err) {
  return /429|too many requests/i.test(String((err && err.message) || err || ''));
}

// ---- Stall watchdog ---------------------------------------------------------
// The long-running phases (ffmpeg pulling segments, the final remux) run with
// no outer timeout: ffmpeg's -rw_timeout only fires on a FULLY idle socket,
// so a CDN that keeps the connection alive but stops delivering (or slows to a
// crawl) never trips it. Without this, one stuck download sits at e.g. 82%
// forever, holds the single download slot, and the queue's retry logic never
// gets a chance to run.
//
// Rule: STALL_MS of silence on the process output (progress lines) is a stall
// -> caller kills the process and rejects. The rejection flows into the
// queue's normal retry path (backoff, then "gave up" so the rest of the queue
// can run). An absolute wall-time backstop (6x the media duration, never under
// 15 min) catches the slow-drip case where output still trickles in.
const STALL_MS = 120000;
const WATCH_TICK_MS = 5000;

// st = { startedAt, lastActivity, lastProgress, durationSec }
function watchForStall(st, onStall) {
  st.stopWatch = () => clearInterval(st.watchTimer);
  st.watchTimer = setInterval(() => {
    const idle = Date.now() - st.lastActivity;
    let reason = null;
    if (idle > STALL_MS) {
      reason =
        `no progress for ${Math.round(idle / 1000)}s` +
        (st.lastProgress ? ` (last seen ${st.lastProgress})` : '');
    } else if (
      st.durationSec >= 60 &&
      Date.now() - st.startedAt > Math.max(15 * 60000, st.durationSec * 6 * 1000)
    ) {
      reason = `took ${Math.round((Date.now() - st.startedAt) / 60000)} min for a ${Math.round(
        st.durationSec / 60
      )} min episode`;
    }
    if (!reason) return;
    st.stopWatch();
    onStall(reason);
  }, WATCH_TICK_MS);
}

const hlsGate = { active: 0, waiters: [], cooldownUntil: 0, cooldownTimer: null };

function wakeHlsWaiters() {
  const w = hlsGate.waiters;
  hlsGate.waiters = [];
  w.forEach((fn) => fn());
}

function tripRateLimit() {
  const ms = Math.max(5000, config.download.rateLimitCooldownMs || 30000);
  hlsGate.cooldownUntil = Date.now() + ms;
  if (hlsGate.cooldownTimer) clearTimeout(hlsGate.cooldownTimer);
  hlsGate.cooldownTimer = setTimeout(() => {
    hlsGate.cooldownTimer = null;
    wakeHlsWaiters();
  }, ms);
}

async function withHlsGate(fn) {
  const limit = Math.max(1, config.download.hlsConcurrency || 1);
  while (hlsGate.active >= limit || Date.now() < hlsGate.cooldownUntil) {
    const wait = Math.max(50, hlsGate.cooldownUntil - Date.now());
    await new Promise((r) => {
      hlsGate.waiters.push(r);
      if (Date.now() < hlsGate.cooldownUntil) setTimeout(r, Math.min(wait, 5000));
    });
  }
  hlsGate.active += 1;
  try {
    return await fn();
  } catch (err) {
    if (isRateLimited(err)) tripRateLimit();
    throw err;
  } finally {
    hlsGate.active -= 1;
    wakeHlsWaiters();
  }
}

function headerLines(headers, ua) {
  const lines = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === 'user-agent') continue; // passed via -user_agent
    if (v) lines.push(`${k}: ${v}`);
  }
  return lines;
}

function headerKey(headers, name) {
  return Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
}

async function cookieHeaderFor(urls) {
  let ses;
  try {
    ses = session.fromPartition(config.sessionPartition);
    if (!ses || !ses.cookies) return '';
  } catch (e) {
    return '';
  }
  const parts = [];
  const seen = new Set();
  const hosts = [];
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    let href = raw;
    try {
      const u = new URL(raw);
      hosts.push(u.hostname);
      href = u.href;
    } catch (e) {
      continue;
    }
    try {
      const list = await ses.cookies.get({ url: href });
      for (const c of list) {
        const k = `${c.name}=${c.value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        parts.push(k);
      }
    } catch (e) {
      // ignore
    }
  }
  if (!parts.length) {
    try {
      const all = await ses.cookies.get({});
      for (const c of all) {
        const domain = String(c.domain || '').replace(/^\./, '');
        if (!domain || !hosts.some((h) => h === domain || h.endsWith('.' + domain))) continue;
        const k = `${c.name}=${c.value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        parts.push(k);
      }
    } catch (e) {
      // ignore
    }
  }
  return parts.join('; ');
}

// Headers Chromium already used when the sniffer saw the playlist. Do not inject
// extra Cookie values from the jar: session.fetch sends those itself, and a
// duplicate Cookie header makes some token CDNs return garbage.
function browserHeaders(detection) {
  const headers = Object.assign({}, detection.headers || {});
  if (!headerKey(headers, 'user-agent')) {
    headers['User-Agent'] = config.download.userAgent;
  }
  // plainHttp (Vidsrc headless path): the CDN rejects session cookies and extra
  // Referer/Origin headers with 403. Only User-Agent goes out — same as the
  // vidsrc_dl.js verification which works reliably.
  if (detection.plainHttp) return headers;
  // Never overwrite a sniffed Referer/Origin. Vidfast redirects .pro -> .vc and
  // the CDN 502s if we send the pre-redirect host.
  if (!headerKey(headers, 'referer') && detection.embedUrl) {
    try {
      headers['Referer'] = new URL(detection.embedUrl).origin + '/';
    } catch (e) {
      // ignore
    }
  }
  const refererKey = headerKey(headers, 'referer');
  const referer = refererKey ? headers[refererKey] : '';
  if (!headerKey(headers, 'origin') && referer) {
    try {
      headers['Origin'] = new URL(referer).origin;
    } catch (e) {
      // ignore
    }
  }
  return headers;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}

// Segment cache used while ffmpeg remuxes to MP4. Keep it out of Downloads.
// Delete it after a successful remux; keep it on failure so the next try
// does not re-download hundreds of parts from scratch.
function hlsWorkDir(partPath) {
  const id = crypto.createHash('sha1').update(String(partPath || '')).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `wvd-hls-${id}`);
}

// Segment caches are kept after a failed attempt so the retry resumes. One
// whose episode was then removed or gave up is never touched again, and on
// Windows nothing empties %TEMP%. Remove caches idle for maxAgeMs (default 3
// days - well past any retry or restart-resume). Returns the number removed.
async function sweepStaleHlsCaches(maxAgeMs = 3 * 24 * 3600 * 1000, dir = os.tmpdir()) {
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch (e) {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const n of names) {
    if (!/^wvd-hls-[0-9a-f]{16}$/.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const st = await fs.promises.stat(p);
      if (st.mtimeMs > cutoff) continue;
      await fs.promises.rm(p, { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      // in use or already gone
    }
  }
  return removed;
}

// ---- Plain-HTTP segment localizer (Vidsrc headless path) --------------------
// Vidsrc's CDNs reject Electron session traffic (403 on cookies/Referer), so
// their segments must be pulled with bare Node HTTP. Doing it here (instead of
// letting ffmpeg pull remote segments) buys the future-proofing:
//   - RESUME: parts are written to the (preserved) work dir as segNNNNN.ts,
//     so a killed/retried download skips every part already on disk;
//   - FAIL-FAST on a 403: the CDN's signed segment URLs are short-lived and a
//     long download can outlive its own token. A 403 aborts the run quickly
//     (instead of ffmpeg churning for 30 minutes); the queue re-resolves a
//     FRESH token and the next pass resumes from the last saved part;
//   - per-segment timeouts, so a wedged socket errors in ~60s, not forever.
function plainHttpBuffer(url, ua, timeoutMs, { signal = null, deadlineMs = 0 } = {}) {
  // timeoutMs  - socket-IDLE timeout (fires when the wire goes fully silent).
  // deadlineMs - ABSOLUTE cap for the whole fetch: it fires even if bytes keep
  //              trickling. Without it, a CDN that holds the connection open
  //              but never finishes (or a VPN path that drips) pins this
  //              worker forever - which made a killed download un-killable
  //              (the 12:53-01:13 "killed every 30s, never retries" loop).
  const abs = deadlineMs || timeoutMs * 2;
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http:') ? require('http') : require('https');
    let settled = false;
    let idleTimer = null;
    let deadlineTimer = null;
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const ok = (buf) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };
    const onAbort = () => {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      try {
        rq.destroy();
      } catch (err) {
        /* already gone */
      }
      fail(e);
    };
    const rq = lib.get(url, { headers: { 'User-Agent': ua || 'webvideodownloader' }, timeout: timeoutMs }, (rs) => {
      const code = rs.statusCode || 0;
      if (code >= 400) {
        const e = new Error('HTTP ' + code);
        e.status = code;
        const ra = Number(rs.headers && rs.headers['retry-after']);
        if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = Math.min(ra, 30) * 1000;
        rs.resume();
        return fail(e);
      }
      const c = [];
      let received = 0;
      // Integrity: the CDN announces the exact body size. Under rate-limit
      // pressure it sometimes sends 200 then closes the connection EARLY;
      // without this check a truncated segment would be written to disk,
      // pass the resume's size>0 test, and mux into a glitch/skip in the
      // final MP4 (the "skipping" episodes). Fail so the part is refetched.
      const expectedLen = Number((rs.headers && rs.headers['content-length']) || 0) || 0;
      const truncationErr = (got) =>
        new Error(`segment truncated: got ${got} of ${expectedLen} bytes (CDN closed early); will refetch`);
      rs.on('data', (d) => {
        received += d.length;
        c.push(d);
        // Any byte resets the idle timer; the absolute deadline still bounds it.
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            rq.destroy();
          } catch (err) {
            /* ignore */
          }
          fail(new Error('timeout'));
        }, timeoutMs);
      });
      rs.on('error', (e) => {
        // A hard reset mid-body also counts: some bytes + short of the
        // announced length = the same truncated segment, named as such.
        if (expectedLen && received > 0 && received < expectedLen) return fail(truncationErr(received));
        fail(e);
      });
      rs.on('end', () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (expectedLen && received !== expectedLen) {
          fail(truncationErr(received));
          return;
        }
        ok(Buffer.concat(c));
      });
    });
    rq.on('error', (e) => fail(e));
    rq.setTimeout(timeoutMs, () => {
      try {
        rq.destroy();
      } catch (err) {
        /* ignore */
      }
      fail(new Error('timeout'));
    });
    deadlineTimer = setTimeout(() => {
      try {
        rq.destroy();
      } catch (err) {
        /* ignore */
      }
      fail(new Error('segment deadline exceeded'));
    }, abs);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function localizePlainSegments(text, base, dir, ua, { signal, onProgress, onLog } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const jobs = [];
  let segN = 0;
  let keyN = 0;
  const out = lines.slice();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const m = t.match(/URI=(["'])([^"']+)\1/i);
      if (!m) continue;
      let abs;
      try {
        abs = new URL(m[2], base).toString();
      } catch (e) {
        continue;
      }
      jobs.push({ i, abs, name: `key${keyN++}.bin`, quote: m[1] });
      continue;
    }
    let abs;
    try {
      abs = new URL(t, base).toString();
    } catch (e) {
      continue;
    }
    jobs.push({ i, abs, name: `seg${String(segN++).padStart(5, '0')}.ts` });
  }
  if (!jobs.length) throw new Error('HLS playlist has no segments');
  fs.mkdirSync(dir, { recursive: true });

  // Resume: parts saved by a previous (killed) attempt stay valid.
  let have = 0;
  for (const job of jobs) {
    const p = path.join(dir, job.name);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) have += 1;
  }
  let done = 0; // parts fetched THIS run (resumed parts are already in `have`)
  const report = () => {
    const n = Math.min(have + done, jobs.length);
    if (onProgress) {
      onProgress({
        received: n,
        total: jobs.length,
        percent: Math.min(0.999, n / Math.max(1, jobs.length))
      });
    }
    // Visible progress: a long download must show life in the log, and a HUNG
    // one must be obvious from where the counting stopped.
    if (onLog && (n % 10 === 0 || n === jobs.length)) {
      onLog(`Downloaded ${n}/${jobs.length} part(s)...`);
    }
  };

  // Run-scoped cancellation: when one part fails (or the queue aborts), EVERY
  // other in-flight part is torn down too. Without this the sibling workers
  // keep fetching after the run is already dead - double bandwidth, two runs
  // writing the same dir with interleaved progress, and extra 429 pressure
  // exactly while the CDN is cooling down.
  const runCtrl = new AbortController();
  if (signal) {
    if (signal.aborted) runCtrl.abort();
    else signal.addEventListener('abort', () => runCtrl.abort(), { once: true });
  }
  if (onLog) {
    onLog(
      have
        ? `Resuming download: ${have}/${jobs.length} part(s) already on disk.`
        : `Downloading ${jobs.length} part(s) through plain HTTP...`
    );
  }

  const SEG_IDLE_MS = Number(config.download.segmentIdleMs) || 60000;
  const SEG_DEADLINE_MS = Number(config.download.segmentDeadlineMs) || 120000;
  const SEG_RETRIES = 3;
  // The Vidsrc CDNs allow roughly 2-3 requests a second per IP and answer the
  // excess with 429 (measured live: 8 parts at once -> 10 of 16 rejected;
  // the same parts retried 1 s later -> all accepted). A 429 is a "slow
  // down", not a failure: the part waits and retries, and every worker pauses
  // until the shared slow-down window has passed so they do not stampede.
  const SEG_429_RETRIES = Number.isFinite(Number(config.download.segment429Retries)) ? Number(config.download.segment429Retries) : 8;
  let slowUntil = 0;
  const waitAbortable = (ms) =>
    new Promise((resolve, reject) => {
      if (runCtrl.signal.aborted) return reject(abortErr());
      const t = setTimeout(() => {
        runCtrl.signal.removeEventListener('abort', onA);
        resolve();
      }, ms);
      const onA = () => {
        clearTimeout(t);
        reject(abortErr());
      };
      runCtrl.signal.addEventListener('abort', onA, { once: true });
    });
  let first403 = null;
  const abortErr = () => {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  };
  const fetchOne = async (job) => {
    if (runCtrl.signal.aborted) throw abortErr();
    const p = path.join(dir, job.name);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
      // Already counted in `have` - do NOT double-count it in `done`.
      report();
      return;
    }
    let lastErr = null;
    let n429 = 0;
    for (let a = 0; a < SEG_RETRIES; a++) {
      if (runCtrl.signal.aborted) throw abortErr();
      const pause = slowUntil - Date.now();
      if (pause > 0) await waitAbortable(pause);
      try {
        const buf = await plainHttpBuffer(job.abs, ua, SEG_IDLE_MS, {
          signal: runCtrl.signal,
          deadlineMs: SEG_DEADLINE_MS
        });
        if (!buf || !buf.length) throw new Error('empty part');
        if (hlscheck.bufferTsTruncated(buf)) throw new Error('part cut short (partial TS packet); will refetch');
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, p);
        done += 1;
        report();
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = e;
        if (e && e.status === 429 && n429 < SEG_429_RETRIES) {
          // Rate-limited: back off (Retry-After when given), then retry this
          // part. Does not use up the ordinary retries.
          n429 += 1;
          const backoff = e.retryAfterMs || Math.min(8000, 800 * n429) + Math.floor(Math.random() * 400);
          slowUntil = Math.max(slowUntil, Date.now() + backoff);
          a -= 1;
          continue;
        }
        if (e && (e.status === 403 || e.status === 429)) {
          // 403 = signed token expired mid-download: fail fast so the queue
          // re-resolves a fresh token and resumes from the saved parts.
          // A 429 that outlasted every backoff: let the queue's cooldown
          // take over (the parts already saved are kept).
          if (e.status === 403) first403 = first403 || job;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000 * (a + 1)));
      }
    }
    if (first403) {
      const err = new Error(
        `CDN rejected ${first403.name} with 403 - its signed token expired mid-download. ` +
          `The retry will get a fresh token and resume from ${Math.min(have + done, jobs.length)}/${jobs.length} part(s).`
      );
      err.tokenExpired = true;
      throw err;
    }
    throw lastErr || new Error('segment fetch failed');
  };

  // Bounded concurrency. Measured live: 3 at once runs at ~5 MB/s with an
  // occasional 429 (absorbed by the backoff above); more just collects 429s.
  const CONC = Math.max(1, Number(config.download.segmentConcurrency) || 3);
  let idx = 0;
  let firstErr = null;
  const workers = Array.from({ length: Math.max(1, Math.min(CONC, jobs.length)) }, async () => {
    for (;;) {
      if (runCtrl.signal.aborted) break;
      const i = idx;
      idx += 1;
      if (i >= jobs.length) break;
      try {
        await fetchOne(jobs[i]);
      } catch (e) {
        // This part failed: tear the WHOLE run down (siblings included) so no
        // orphan workers keep fetching after the run is dead.
        if (!firstErr) firstErr = e;
        runCtrl.abort();
        throw e;
      }
    }
  });
  let runErr = null;
  try {
    await Promise.all(workers);
  } catch (e) {
    runErr = e;
  }
  if (runErr) {
    // Prefer the first REAL error over a sibling's AbortError (that one is
    // just the teardown signal, not the cause - unless the QUEUE aborted us).
    const queueAborted = !!(signal && signal.aborted);
    const real = firstErr && !queueAborted && firstErr.name !== 'AbortError' ? firstErr : runErr;
    throw real;
  }

  for (const job of jobs) {
    const t = out[job.i].trim();
    if (t.startsWith('#')) {
      out[job.i] = t.replace(/URI=(["'])([^"']+)\1/i, `URI=${job.quote}${job.name}${job.quote}`);
    } else {
      out[job.i] = job.name;
    }
  }
  const playlistPath = path.join(dir, 'index.m3u8');
  fs.writeFileSync(playlistPath, out.join('\n'), 'utf8');
  return playlistPath;
}

function ffmpegFileArg(p) {
  const norm = String(p).replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(norm)) return `file:${norm}`;
  return norm;
}

async function prepareDownloadHeaders(detection) {
  const headers = Object.assign({}, browserHeaders(detection));
  // plainHttp (Vidsrc headless path): no session cookies — the CDN 403s on
  // requests that carry Electron session cookies.
  if (detection.plainHttp) return headers;
  if (!headerKey(headers, 'cookie')) {
    const refererKey = headerKey(headers, 'referer');
    const referer = refererKey ? headers[refererKey] : '';
    const cookie = await cookieHeaderFor([detection.url, detection.embedUrl, referer]);
    if (cookie) headers['Cookie'] = cookie;
  }
  return headers;
}

function unlinkPart(partPath) {
  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch (e) {
    // ignore
  }
  rmrf(`${partPath}.hls`);
  try {
    fs.unlinkSync(`${partPath}.m3u8`);
  } catch (e) {
    // ignore
  }
}

function mp4Headers(detection) {
  const headers = Object.assign({}, detection.headers || {});
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = config.download.userAgent;
  }
  return headers;
}

function writeStreamWithProgress(readable, partPath, total, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partPath);
    let received = 0;
    // Body-stall guard: a CDN can hold the connection open and stop sending.
    // req.setTimeout only covers the initial request, so without this the body
    // (and the whole queue) hangs here forever. 90s of no data is a stall.
    const IDLE_MS = 90000;
    let idle = null;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        try {
          readable.destroy();
        } catch (e) {
          /* ignore */
        }
        try {
          out.destroy();
        } catch (e) {
          /* ignore */
        }
        reject(new Error(`no data for ${Math.round(IDLE_MS / 1000)}s - the download stalled, so it was aborted; will retry`));
      }, IDLE_MS);
    };
    const disarmIdle = () => {
      if (idle) {
        clearTimeout(idle);
        idle = null;
      }
    };
    armIdle();
    const onAbort = () => {
      try {
        readable.destroy();
      } catch (e) {
        /* ignore */
      }
      try {
        out.destroy();
      } catch (e) {
        /* ignore */
      }
      reject(new AbortError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    readable.on('data', (chunk) => {
      received += chunk.length;
      armIdle();
      if (onProgress) onProgress({ received, total, percent: total ? received / total : null });
    });
    // Body fully received: what remains is disk I/O, not the network - drop
    // the guard so a slow final flush cannot be misread as a stall.
    readable.on('end', disarmIdle);
    readable.pipe(out);
    out.on('finish', () => {
      disarmIdle();
      if (signal) signal.removeEventListener('abort', onAbort);
      // The server announced the size: anything short of it is a connection
      // that closed early. A faststart MP4 cut off this way still probes with
      // the full duration (its index is at the front), so verification alone
      // would accept a file missing its ending.
      if (total > 0 && received < total) {
        out.close(() =>
          reject(new Error(`download truncated: got ${received} of ${total} bytes (the server closed early); will retry`))
        );
        return;
      }
      out.close(() => resolve({ bytes: received }));
    });
    out.on('error', (e) => {
      disarmIdle();
      reject(e);
    });
    readable.on('error', (e) => {
      disarmIdle();
      reject(e);
    });
  });
}

// Token CDNs (cloudatacdn) hang or 403 Node's https client, and a leftover .part
// from a previous HLS attempt cannot be Range-resumed onto a new MP4 URL.
async function downloadMp4(detection, partPath, opts = {}) {
  unlinkPart(partPath);
  const headers = mp4Headers(detection);
  try {
    const sess = session.fromPartition(detection.sessionPartition || config.sessionPartition);
    if (sess && typeof sess.fetch === 'function') {
      const res = await sess.fetch(detection.url, { headers, signal: opts.signal });
      const code = res.status || 0;
      if (code >= 400) throw new Error(`HTTP ${code} for ${detection.url}`);
      const total =
        parseInt(
          (typeof res.headers.get === 'function'
            ? res.headers.get('content-length')
            : res.headers['content-length']) || '0',
          10
        ) || 0;
      const webBody = res.body;
      const readable =
        webBody && typeof webBody.getReader === 'function'
          ? Readable.fromWeb(webBody)
          : webBody;
      if (!readable) throw new Error('empty MP4 body');
      return await writeStreamWithProgress(readable, partPath, total, opts);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    unlinkPart(partPath);
    try {
      return await downloadMp4Node(detection, partPath, opts, 5, headers);
    } catch (err2) {
      if (err2 && err2.name === 'AbortError') throw err2;
      unlinkPart(partPath);
      return withHlsGate(() => downloadHls({ ...detection, type: 'mp4' }, partPath, opts));
    }
  }
  return downloadMp4Node(detection, partPath, opts, 5, headers);
}

function downloadMp4Node(detection, partPath, { signal, onProgress } = {}, redirectsLeft = 5, headers) {
  return new Promise((resolve, reject) => {
    const lib = detection.url.startsWith('https:') ? https : http;
    const h = headers || mp4Headers(detection);
    const left = redirectsLeft == null ? 5 : redirectsLeft;

    const req = lib.get(detection.url, { headers: h, timeout: 60000 }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && left > 0) {
        res.resume();
        const next = new URL(res.headers.location, detection.url).toString();
        return downloadMp4Node({ ...detection, url: next }, partPath, { signal, onProgress }, left - 1, h).then(
          resolve,
          reject
        );
      }
      if (code === 429) {
        res.resume();
        return reject(new Error(`HTTP 429 Too Many Requests for ${detection.url}`));
      }
      if (code >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${code} for ${detection.url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      return writeStreamWithProgress(res, partPath, total, { signal, onProgress }).then(resolve, reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CDN connection timed out; will retry with a fresh stream URL'));
    });
    req.on('error', (err) => {
      if (signal && signal.aborted) return reject(new AbortError());
      reject(err);
    });

    if (signal) {
      const onAbort = () => {
        req.destroy();
        reject(new AbortError());
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// HLS (or DASH/mp4) -> mp4 using ffmpeg with -c copy (lossless remux).
// In Sub mode (detection.embedSubs) subtitles are embedded as a soft mov_text
// track: from a separate sniffed subtitle file when available, otherwise from a
// subtitle stream inside the HLS master playlist.
async function downloadHls(detection, partPath, opts = {}) {
  const { signal, onProgress, onLog } = opts;
  const headers = browserHeaders(detection);
  const ffmpegHeaders = await prepareDownloadHeaders(detection);
  const ua =
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1] ||
    config.download.userAgent;

  const treatAsHls =
    detection.type !== 'mp4' &&
    (detection.type === 'hls' || /\.m3u8|\/hls\d*\//i.test(detection.url || ''));
  // Some token CDNs (SFlix netoda behind a worker proxy) serve the playlist at
  // a URL with no .m3u8 in it. FFmpeg 403s on that URL, but the player already
  // handed us the media playlist body - run the localize path instead of
  // handing the raw URL to FFmpeg.
  const hasUsableCaptured = !!(
    detection.playlistText &&
    /#EXTM3U/i.test(detection.playlistText) &&
    /#EXTINF:/i.test(detection.playlistText) &&
    !hlscheck.isMasterPlaylist(detection.playlistText)
  );
  if ((!treatAsHls || !/\.m3u8/i.test(detection.url || '')) && !hasUsableCaptured) {
    return spawnFfmpegHls(detection.url, ffmpegHeaders, ua, detection, partPath, opts, false);
  }

  const dir = hlsWorkDir(partPath);
  let localPlaylist = null;
  let allLocal = false;
  let keepCache = false;
  try {
    let loaded = null;
    const boundPlayer =
      hlscheck.isPlayerBoundCdn(detection.url, detection.embedUrl) &&
      detection.playerWebContentsId != null;
    if (boundPlayer) {
      const wc =
        detection.playerWebContentsId != null
          ? webContents.fromId(detection.playerWebContentsId)
          : null;
      const nPl = wc && wc._cdpPlaylists ? wc._cdpPlaylists.size : 0;
      const nParts = wc && wc._cdpParts ? wc._cdpParts.size : 0;
      if (onLog) {
        onLog(
          `Player debugger has ${nPl} playlist body(ies), ${nParts} part(s), ${
            (wc && wc._cdpMsgs) || 0
          } CDP events.`
        );
      }
    }
    const startUrl = detection.url;
    const startText =
      detection.playlistText && !hlscheck.isMasterPlaylist(detection.playlistText)
        ? { text: detection.playlistText, base: detection.playlistBase || detection.url }
        : null;
    if (startText) loaded = startText;
    if (!loaded || hlscheck.isMasterPlaylist(loaded.text)) {
      try {
        loaded = await hlscheck.loadMediaPlaylist(
          startUrl,
          headers,
          signal,
          detection.playerWebContentsId
        );
        if (onLog) {
          onLog(
            'Using media playlist: ' + hlscheck.describeMediaPlaylist(loaded.base, loaded.text)
          );
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (onLog) onLog(`Player playlist fetch failed (${e.message || e}); will retry.`);
        throw e;
      }
    }
    const firstSeg = hlscheck.firstUri(loaded.text);
    if (loaded.text) {
      detection.playlistDuration = hlscheck.playlistMediaDuration(loaded.text);
    }
    let disguised = hlscheck.isTokenCdn(detection.url, detection.embedUrl);
    let pngSeen = false;
    if (loaded.mseOnly || !firstSeg) {
      if (hlscheck.isPlayerBoundCdn(detection.url, detection.embedUrl)) {
        throw new Error('Player did not yield a complete HLS playlist; not capturing MSE/WebM');
      }
      const wc =
        detection.playerWebContentsId != null ? webContents.fromId(detection.playerWebContentsId) : null;
      if (!wc || wc.isDestroyed()) {
        throw new Error('CDN playlist unavailable and the player window is gone');
      }
      allLocal = true;
      if (onLog) onLog('Capturing the live player buffer (no CDN playlist).');
      fs.mkdirSync(dir, { recursive: true });
      localPlaylist = await hlscheck.captureLivePlayer(wc, dir, { signal, onProgress, onLog });
    } else {
      if (firstSeg && !detection.playerWebContentsId) {
        try {
          let buf;
          if (detection.plainHttp) {
            // Vidsrc CDN: use plain Node.js HTTP (no Electron session cookies).
            // Same approach as vidsrc_dl.js verification which works reliably.
            buf = await new Promise((resolve, reject) => {
              const lib = firstSeg.startsWith('http:') ? require('http') : require('https');
              const rq = lib.get(firstSeg, { headers: { 'User-Agent': ua }, timeout: 20000 }, (rs) => {
                const c = [];
                rs.on('data', (d) => c.push(d));
                rs.on('end', () => resolve(Buffer.concat(c)));
              });
              rq.on('error', reject);
              rq.setTimeout(20000, () => { rq.destroy(); reject(new Error('timeout')); });
            });
          } else {
            buf = await hlscheck.fetchBuffer(firstSeg, headers, {
              timeoutMs: 20000,
              signal,
              playerWebContentsId: detection.playerWebContentsId
            });
          }
          pngSeen = hlscheck.isPng(buf);
          if (pngSeen) disguised = true;
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          if (onLog) onLog(`Could not peek the first segment (${e.message || e}); will still pull parts via the browser session.`);
        }
      }
      if (disguised) {
        allLocal = true;
        // Player-bound CDNs (peakstorm/vidfast, partitioned cookies) MUST go
        // through the live player page. Token CDNs whose segments are plain
        // HTTPS (SFlix voxzer) fetch fine from Node and CANNOT be fetched
        // from a page (no CORS headers) - keep them on the Node path.
        const boundPlayer = hlscheck.isPlayerBoundCdn(detection.url, detection.embedUrl);
        const viaPlayer = boundPlayer && detection.playerWebContentsId != null;
        if (onLog) {
          onLog(
            pngSeen
              ? 'Stream segments are disguised (PNG-wrapped); downloading them through Chromium, then remuxing.'
              : 'Token CDN stream; downloading segments, then remuxing.'
          );
          if (viaPlayer) onLog('Using the live player page to fetch segments (same origin as playback).');
          else onLog('Fetching segments through Node (CDN not player-bound).');
        }
        fs.mkdirSync(dir, { recursive: true });
        localPlaylist = await hlscheck.localizePlaylist(loaded.text, loaded.base, dir, headers, {
          signal,
          onProgress,
          onLog,
          playerWebContentsId: viaPlayer ? detection.playerWebContentsId : undefined
        });
      } else if (detection.plainHttp) {
        // Vidsrc headless: the CDN 403s Electron session traffic, so pull the
        // parts ourselves with plain HTTP into the (preserved) work dir and
        // remux locally. Resume-safe and fail-fast on an expired CDN token -
        // see localizePlainSegments.
        allLocal = true;
        fs.mkdirSync(dir, { recursive: true });
        localPlaylist = await localizePlainSegments(loaded.text, loaded.base, dir, ua, {
          signal,
          onProgress,
          onLog
        });
        // The master listed the audio as a separate track (#EXT-X-MEDIA with
        // a URI): the video segments carry no sound, so fetch the chosen
        // audio track too and mux it in as the second input.
        if (detection.audioUrl) {
          const audioDir = path.join(dir, 'audio');
          fs.mkdirSync(audioDir, { recursive: true });
          const audioText = (await plainHttpBuffer(detection.audioUrl, ua, 30000, { signal, deadlineMs: 60000 })).toString('utf8');
          if (!/#EXTINF:/i.test(audioText)) throw new Error('audio track playlist is empty or not HLS');
          if (onLog) onLog(`Fetching the separate ${detection.audioLabel || 'audio'} track.`);
          detection._localAudioPlaylist = await localizePlainSegments(audioText, detection.audioUrl, audioDir, ua, { signal, onLog });
        }
      } else {
        fs.mkdirSync(dir, { recursive: true });
        localPlaylist = path.join(dir, 'playlist.m3u8');
        fs.writeFileSync(localPlaylist, loaded.text, 'utf8');
      }
    }
    const inputUrl = ffmpegFileArg(localPlaylist);
    return await spawnFfmpegHls(
      inputUrl,
      ffmpegHeaders,
      ua,
      detection,
      partPath,
      opts,
      true,
      allLocal
    );
  } catch (err) {
    keepCache = !!(err && err.name !== 'AbortError');
    if (err && err.name === 'AbortError') throw err;
    if (err && (err.kind === 'html' || err.kind === 'json')) throw err;
    if (allLocal || hlscheck.isTokenCdn(detection.url, detection.embedUrl)) throw err;
    keepCache = false;
    return spawnFfmpegHls(detection.url, ffmpegHeaders, ua, detection, partPath, opts, false);
  } finally {
    if (!keepCache) rmrf(dir);
    rmrf(`${partPath}.hls`);
    try {
      fs.unlinkSync(`${partPath}.m3u8`);
    } catch (e) {
      // ignore
    }
  }
}

// Most recent ffmpeg stderr output (shared by the copy + HLS spawns), kept so
// an upstream watchdog kill can log WHY the download was stuck (403s? segment
// retries? a slow drip?) instead of only "stuck in downloading for 30 min".
let lastFfmpegTail = '';
let lastFfmpegAt = 0;
function noteFfmpegTail(tail) {
  lastFfmpegTail = String(tail || '');
  lastFfmpegAt = Date.now();
}
function lastFfmpegStderr() {
  return { tail: lastFfmpegTail, at: lastFfmpegAt };
}

function spawnFfmpegCopy(inputPath, partPath, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      inputPath,
      '-map',
      '0:v?',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-dn',
      '-sn',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      partPath
    ];
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let durationSec = 0;
    let stderrTail = '';
    const st = { startedAt: Date.now(), lastActivity: Date.now(), lastProgress: '', durationSec: 0 };
    proc.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      noteFfmpegTail(stderrTail);
      st.lastActivity = Date.now();
      if (!durationSec) {
        const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (d) durationSec = +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]);
      }
      st.durationSec = durationSec;
      const t = text.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) {
        st.lastProgress = t[0].replace(/^time=/, '').trim();
      }
      if (t && onProgress) {
        const cur = +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]);
        onProgress({
          received: cur,
          total: durationSec,
          percent: durationSec ? Math.min(cur / durationSec, 0.999) : null
        });
      }
    });
    watchForStall(st, (reason) => {
      // First rejection wins; the kill makes the 'close' handler's AbortError
      // a no-op. The queue treats this as a retryable failure.
      reject(new Error(reason + ' - the download stalled, so it was killed; will retry'));
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        /* already dead */
      }
    });
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        // ignore
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    proc.on('error', (err) => {
      st.stopWatch();
      reject(describeBinaryError(err, ffmpegPath()));
    });
    proc.on('close', (code) => {
      st.stopWatch();
      if (aborted) return reject(new AbortError());
      if (code === 0) return resolve(partPath);
      reject(new Error((stderrTail || `ffmpeg exited ${code}`).trim().slice(-500)));
    });
  });
}

function spawnFfmpegHls(inputUrl, headers, ua, detection, partPath, { signal, onProgress } = {}, localPlaylist, allLocal) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'info'];
    if (!allLocal) {
      const hLines = headerLines(headers, ua);
      if (hLines.length) args.push('-headers', hLines.join('\r\n') + '\r\n');
      args.push('-user_agent', ua);
      args.push(...httpReconnectArgs());
    }
    const playlist =
      localPlaylist ||
      detection.type === 'hls' ||
      /\.m3u8|\/hls\d*\//i.test(detection.url || '');
    if (playlist) {
      args.push(...hlsRelaxArgs());
      if (localPlaylist || allLocal) {
        args.push('-protocol_whitelist', allLocal ? 'file,crypto,data' : 'file,http,https,tcp,tls,crypto,data');
      }
      if (localPlaylist || allLocal || /\.m3u8/i.test(detection.url || '')) args.push('-f', 'hls');
    }
    args.push('-fflags', '+genpts', '-avoid_negative_ts', 'make_zero');
    args.push('-i', ffmpegFileArg(inputUrl));

    const audioPl = detection._localAudioPlaylist
      ? ffmpegFileArg(detection._localAudioPlaylist)
      : /mse-video\.m3u8$/i.test(String(inputUrl || ''))
        ? String(inputUrl).replace(/mse-video\.m3u8$/i, 'mse-audio.m3u8')
        : '';
    const hasMseAudio = !!(audioPl && fs.existsSync(String(audioPl).replace(/^file:/, '')));
    if (hasMseAudio) {
      args.push('-f', 'hls', '-i', ffmpegFileArg(audioPl));
    }

    const hasExternalSub = detection.embedSubs && detection.subtitleUrl;
    if (hasExternalSub) args.push('-i', detection.subtitleUrl);
    // Input order: 0 = video (+ muxed audio), [1 = separate audio], [next = subtitles].
    const subInput = hasMseAudio ? 2 : 1;
    const fmp4Hls = /mse-(index|video)\.m3u8$/i.test(String(inputUrl || ''));

    if (hasMseAudio && hasExternalSub) {
      // Separate audio track AND an English subtitle track (SUB mode).
      args.push('-map', '0:v?', '-map', '1:a?', '-map', `${subInput}:0`);
      args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text', '-dn');
      args.push('-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default');
    } else if (hasMseAudio) {
      args.push('-map', '0:v?', '-map', '1:a?', '-c', 'copy', '-dn', '-sn');
    } else if (detection.embedSubs) {
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      args.push('-map', hasExternalSub ? `${subInput}:0` : '0:s:0?');
      args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text');
      if (!fmp4Hls) args.push('-bsf:a', 'aac_adtstoasc');
      args.push('-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default');
    } else if (detection.type === 'mp4') {
      args.push('-c', 'copy', '-dn', '-sn');
    } else {
      args.push('-map', '0:v?', '-map', '0:a?');
      args.push('-c', 'copy', '-dn', '-sn');
      if (!fmp4Hls) args.push('-bsf:a', 'aac_adtstoasc');
    }
    args.push('-f', 'mp4', partPath);

    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let durationSec = 0;
    let writtenSec = 0;
    let stderrTail = '';
    const st = { startedAt: Date.now(), lastActivity: Date.now(), lastProgress: '', durationSec: 0 };

    proc.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      noteFfmpegTail(stderrTail);
      st.lastActivity = Date.now();

      if (!durationSec) {
        const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (d) durationSec = +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]);
      }
      st.durationSec = durationSec;
      const t = text.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) {
        st.lastProgress = t[0].replace(/^time=/, '').trim();
        writtenSec = Math.max(writtenSec, +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]));
      }
      if (t && onProgress) {
        const cur = +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]);
        onProgress({
          received: cur,
          total: durationSec,
          percent: durationSec ? Math.min(cur / durationSec, 0.999) : null
        });
      }
    });
    watchForStall(st, (reason) => {
      // First rejection wins; the kill makes the 'close' handler's AbortError
      // a no-op. The queue treats this as a retryable failure.
      reject(new Error(reason + ' - the download stalled, so it was killed; will retry'));
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        /* already dead */
      }
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        // ignore
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('error', (err) => {
      st.stopWatch();
      reject(describeBinaryError(err, ffmpegPath()));
    });
    proc.on('close', (code) => {
      st.stopWatch();
      if (aborted) return reject(new AbortError());
      if (code === 0) {
        // Some CDNs serve the episode body as one huge segment and 502 on it. The
        // HLS demuxer moves on to the next segment and still exits 0, so without
        // this check a 45-second file would pass as a finished episode.
        // MSE playlists invent EXTINF from player duration / fragment count, so
        // ffmpeg's Duration line is not the real media length — don't reject a
        // complete remux just because that estimate was high.
        const shortfall =
          !fmp4Hls && durationSec > 60 && writtenSec > 0 && writtenSec < durationSec * 0.9;
        if (shortfall) {
          const mins = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
          return reject(
            new Error(
              `stream truncated: wrote ${mins(writtenSec)} of ${mins(durationSec)} ` +
                `(${stderrTail.split('\n').slice(-2).join(' ').trim()})`
            )
          );
        }
        return resolve({ bytes: safeSize(partPath) });
      }
      reject(new Error(describeFfmpegExit(code, stderrTail)));
    });
  });
}

// Turns cryptic spawn errors for the bundled binaries into an actionable
// message (these are commonly mistaken for "video is protected/DRM" errors).
function describeFfmpegExit(code, stderrTail) {
  const tail = (stderrTail || '').split('\n').slice(-4).join(' ').trim();
  // Windows maps ETIMEDOUT to errno 138; unsigned that is 4294967158.
  if (
    code === 4294967158 ||
    code === -138 ||
    /-138\b/.test(tail) ||
    /ETIMEDOUT|connection timed out|Error number -138/i.test(tail)
  ) {
    return 'CDN connection timed out; will retry with a fresh stream URL';
  }
  if (/403|forbidden|401|unauthorized/i.test(tail)) {
    return 'CDN rejected the stream (expired token or missing headers); will retry';
  }
  if (/Video: png/i.test(tail)) {
    return 'CDN disguised the video as PNG images; will retry with a fresh stream';
  }
  if (/Invalid data found when processing input/i.test(tail)) {
    return 'Captured video parts could not be remuxed; will retry with a fresh stream';
  }
  return `ffmpeg exited with code ${code}: ${tail}`;
}

function describeBinaryError(err, binPath) {
  if (err && err.code === 'EACCES') {
    return new Error(
      `Cannot run bundled ffmpeg (permission denied): ${binPath}. ` +
        'The binary is missing its executable bit - run "chmod +x" on it or reinstall dependencies.'
    );
  }
  if (err && err.code === 'ENOENT') {
    return new Error(
      `Bundled ffmpeg not found at: ${binPath}. ` +
        'Reinstall dependencies on this machine (do not copy node_modules across OSes).'
    );
  }
  return err;
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

// Dispatches based on detection type.
function download(detection, partPath, opts) {
  const u = detection.url || '';
  const progressive =
    detection.type === 'mp4' ||
    (/cloudatacdn\.com/i.test(u) && !/\.m3u8/i.test(u));
  if (progressive) return downloadMp4(detection, partPath, opts);
  return withHlsGate(() => downloadHls(detection, partPath, opts));
}

module.exports = {
  download,
  sweepStaleHlsCaches,
  downloadMp4,
  downloadHls,
  AbortError,
  ffmpegPath,
  ffprobePath,
  // Exported for the stall-watchdog tests (and engine diagnostics).
  watchForStall,
  STALL_MS,
  WATCH_TICK_MS,
  // Engine diagnostics: what ffmpeg was saying when a download got stuck.
  lastFfmpegStderr,
  // Exported for the Vidsrc resume tests.
  localizePlainSegments,
  plainHttpBuffer
};
