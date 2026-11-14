'use strict';
// Vidsrc, checked by the engine itself every few hours - the same steps as
// scripts/vidsrc-check.js, so a change on Vidsrc's side shows on the
// Overview's Sources row before downloads quietly start failing:
//   1. API token     (the player chain on the relay hosts)
//   2. stream list   (the data API, for a known episode)
//   3. video server  (its own token, generate.php - with the API token when it wants it)
//   4. qualities     (the best one its master playlist lists)
// No video is downloaded. Plus the last time a real download got 1080p from
// Vidsrc (noteLocked), which says more than any probe.

const PROBE = { type: 'tv', tmdb: '1396', season: 1, episode: 1, title: 'Breaking Bad' };
const EVERY_MS = 3 * 3600 * 1000;
const FIRST_MS = 60 * 1000;

let last = null; // { at, ok, status, steps: [{ name, ok, detail }], summary }
let running = null;
let timer = null;
let last1080At = 0;
let lastLockedAt = 0;
let lastLockedHeight = 0;

// Injectable for tests.
let dl = null;
const vs = () => dl || require('./sites/vidsrc_dl');

async function run() {
  if (running) return running;
  running = (async () => {
    const steps = [];
    const step = (name, ok, detail) => {
      steps.push({ name, ok, detail });
      return ok;
    };
    const v = vs();
    let status = 'ok';
    try {
      if (v.isBlocked()) {
        step('Vidsrc', false, 'paused: it refused this IP recently - switching the Mullvad server clears it');
        status = 'blocked';
      } else {
        let token = '';
        try { token = await v.getApiToken(PROBE, { fresh: true }); } catch (e) { token = ''; }
        const viaBrowser = !!token && typeof v.tokenVia === 'function' && v.tokenVia() === 'browser';
        if (!step('API token', !!token, token ? (viaBrowser ? 'OK (taken from the player in the browser - Vidsrc no longer shows it on its pages)' : 'OK') : (v.tokenFailure() || 'no token from any relay host'))) {
          status = 'down';
        } else {
          let list = null;
          try {
            list = await v.fetchStreamUrls(PROBE);
          } catch (e) {
            step('Stream list', false, (e && e.message) || String(e));
            status = e && e.code === 'VIDSRC_BLOCKED' ? 'blocked' : 'down';
          }
          if (list) {
            step('Stream list', true, `${list.urls.length} source(s)`);
            let origin = '';
            try { origin = new URL(list.urls[0]).origin; } catch (e) { origin = ''; }
            let serverToken = '';
            try {
              serverToken = await v.fetchHostToken(origin, { apiToken: token });
              step('Video server', true, `${origin.replace(/^https?:\/\//, '')} (token sent as ${v.genVariant()})`);
            } catch (e) {
              step('Video server', false, `${origin.replace(/^https?:\/\//, '')}: ${(e && e.message) || e}`);
              status = e && e.status === 403 ? 'blocked' : 'down';
            }
            if (serverToken) {
              try {
                const r = await v.request(list.urls[0] + '?token=' + encodeURIComponent(serverToken), {}, 15000);
                const variants = v.parseMaster(r.body.toString('utf8'), list.urls[0]).sort((a, b) => b.height - a.height);
                const top = variants[0];
                const is1080 = top && v.meetsFloor(top.width, top.height, 1080);
                step('Qualities', !!top, top ? `best ${top.width}x${top.height}${is1080 ? '' : ' (no 1080p on this server)'}` : `HTTP ${r.status}, no qualities listed`);
                if (!top) status = 'down';
                else if (!is1080 && status === 'ok') status = 'limited';
              } catch (e) {
                step('Qualities', false, (e && e.message) || String(e));
                status = 'down';
              }
            }
          }
        }
      }
    } catch (e) {
      step('Check', false, (e && e.message) || String(e));
      status = 'down';
    }
    const bad = steps.find((s) => !s.ok);
    last = {
      at: Date.now(),
      ok: status === 'ok' || status === 'limited',
      status,
      steps,
      summary: bad ? `${bad.name}: ${bad.detail}` : steps.map((s) => `${s.name} ${s.name === 'Qualities' ? s.detail : 'OK'}`).join(' · ')
    };
    return last;
  })().finally(() => {
    running = null;
  });
  return running;
}

// The latest result; starts a check when there is none or it is stale.
function get({ maxAgeMs = EVERY_MS } = {}) {
  if ((!last || Date.now() - last.at > maxAgeMs) && !running) run().catch(() => {});
  return Object.assign({}, last || { at: 0, ok: null, status: 'checking', steps: [], summary: 'checking...' }, {
    checking: !!running,
    last1080At,
    lastLockedAt,
    lastLockedHeight
  });
}

// A real download locked a Vidsrc stream (vidsrc.js directResolve).
function noteLocked(width, height) {
  lastLockedAt = Date.now();
  lastLockedHeight = Number(height) || 0;
  let full = false;
  try { full = vs().meetsFloor(Number(width) || 0, lastLockedHeight, 1080); } catch (e) { full = lastLockedHeight >= 1036; }
  if (full) last1080At = lastLockedAt;
}

function start() {
  if (timer) return;
  const first = setTimeout(() => run().catch(() => {}), FIRST_MS);
  if (first.unref) first.unref();
  timer = setInterval(() => run().catch(() => {}), EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  run,
  get,
  start,
  noteLocked,
  PROBE,
  _setForTests(fake) {
    dl = fake;
    last = null;
    running = null;
    last1080At = 0;
    lastLockedAt = 0;
    lastLockedHeight = 0;
  }
};
