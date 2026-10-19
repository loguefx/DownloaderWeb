'use strict';

// Optional Cloudflare solver (FlareSolverr-compatible API).
//
// When config.cloudflare.solverUrl is set, a challenged page is sent to the
// solver, which runs its own browser through the "Just a moment..." check and
// returns the clearance cookies. We import those cookies into the shared app
// session, then reload the page: from that point on the normal Electron flow
// is no longer challenged, and every later site in the pool reuses the
// clearance (cf_clearance is per-domain, so each domain is solved once).
//
// The solver is entirely OPTIONAL and off by default (solverUrl: ''). Run the
// official FlareSolverr (https://github.com/FlareSolverr/FlareSolverr)
// anywhere you like - Docker on a VM, a VPS, etc - and point solverUrl at its
// request endpoint, e.g. http://localhost:8191/v1/request
//
// When no solver is configured this module is inert: the existing behaviour
// (window on screen, wait for the checkbox / automatic pass, up to five
// minutes) is unchanged.

const https = require('https');
const http = require('http');
const { session } = require('electron');
const config = require('./config');

// The solver URL is a persisted engine setting (engineconfig.cloudflare.
// solverUrl, set from the Settings API or engine.json) with a fallback to the
// code default in config.js. Reading engineconfig lazily avoids a require cycle.
function solverBase() {
  let url = String((config.cloudflare && config.cloudflare.solverUrl) || '');
  if (!url) {
    try {
      const ec = require('./engineconfig');
      url = String((ec.get().cloudflare && ec.get().cloudflare.solverUrl) || '');
    } catch (e) {
      url = '';
    }
  }
  return url.replace(/\/+$/, '');
}

function enabled() {
  return !!solverBase();
}

// Best-effort reachability probe so the Settings UI / health endpoint can tell
// the user whether the solver is actually up. Tries the FlareSolverr
// healthcheck endpoint (sibling of .../v1/request) with a short timeout; a
// non-2xx or unreachable solver is reported as not reachable rather than
// erroring. Purely informational — it never blocks a download.
async function status() {
  const base = solverBase();
  const out = { configured: !!base, solverUrl: base || '' };
  if (!base) return out;
  let healthUrl = '';
  try {
    const u = new URL(base);
    // .../v1/request -> .../v1/healthcheck ; .../v1/solve -> .../v1/healthcheck
    u.pathname = u.pathname.replace(/\/(request|solve)\/?$/, '/healthcheck');
    healthUrl = u.toString();
  } catch (e) {
    out.reachable = false;
    out.error = 'invalid solver URL';
    return out;
  }
  const mod = healthUrl.startsWith('http:') ? http : https;
  out.reachable = false;
  try {
    const ok = await new Promise((resolve) => {
      const req = mod.get(healthUrl, { timeout: 4000 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    out.reachable = !!ok;
  } catch (e) {
    out.reachable = false;
  }
  return out;
}

// Sends `pageUrl` to the solver. On success the clearance cookies are set on
// the challenged window's own session (token-CDN player windows keep an
// isolated jar) AND on the shared app session, so both the reload that
// follows and every later site in the pool reuse the clearance. Returns true
// when the solver reported a clean pass.
async function trySolver(pageUrl, wc, onLog = () => {}) {
  const base = solverBase();
  if (!base || !pageUrl) return false;
  const body = JSON.stringify({
    cmd: 'reqget',
    url: pageUrl,
    maxTimeout: 60000,
    userAgent: config.download.userAgent
  });
  let u;
  try {
    u = new URL(base);
  } catch (e) {
    onLog(`Cloudflare solver URL is not valid (${base}); ignoring it.`);
    return false;
  }
  const mod = u.protocol === 'http:' ? http : https;
  try {
    const data = await new Promise((resolve, reject) => {
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: (config.cloudflare && config.cloudflare.timeoutMs) || 90000
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c;
            if (buf.length > 1000000) {
              try {
                res.destroy();
              } catch (e) {}
            }
          });
          res.on('end', () => resolve({ status: res.statusCode || 0, body: buf }));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('solver timed out')));
      req.write(body);
      req.end();
    });
    if (data.status !== 200) {
      onLog(`Cloudflare solver answered HTTP ${data.status}; falling back to the on-screen check.`);
      return false;
    }
    let out = {};
    try {
      out = JSON.parse(data.body || '{}');
    } catch (e) {
      onLog('Cloudflare solver returned an unreadable answer; falling back to the on-screen check.');
      return false;
    }
    if (out.status !== 'ok' || !out.data || !(out.data.cookies || []).length) {
      const status = (out.data && out.data.status) || out.status || 'unknown';
      onLog(`Cloudflare solver could not clear the challenge (${status}); falling back to the on-screen check.`);
      return false;
    }
    const targets = [session.fromPartition(config.sessionPartition)];
    try {
      if (wc && wc.session && wc.session !== targets[0]) targets.push(wc.session);
    } catch (e) {}
    const cookies = out.data.cookies || [];
    for (const c of cookies) {
      if (!c || !c.name || !c.value) continue;
      const spec = {
        url: pageUrl,
        name: c.name,
        value: c.value,
        domain: c.domain || undefined,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expirationDate: c.expirationDate || undefined
      };
      for (const ses of targets) {
        try {
          await ses.cookies.set(spec);
        } catch (e) {
          // A single malformed cookie must not sink the whole clearance.
        }
      }
    }
    onLog(`Cloudflare solver cleared the challenge (${cookies.length} cookie(s) imported).`);
    return true;
  } catch (e) {
    onLog(`Cloudflare solver failed: ${(e && e.message) || e}`);
    return false;
  }
}

module.exports = { enabled, trySolver, status, solverBase };
