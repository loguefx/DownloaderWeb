'use strict';

// Diagnostic harness: for a provider whose HLS copy is broken, look for another
// way to the same file - the host's /d/ (download) page, and the same segment on
// sibling CDN edges.
//
//   $env:ALT_HOST="https://gn1r5n.org"; $env:ALT_ID="6xyp19d8dcya"; npx electron scripts/probe-alt.js

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = process.env.PROBE_LOG || path.join(require('os').tmpdir(), 'probe-alt.log');
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

const HOST = process.env.ALT_HOST || 'https://gn1r5n.org';
const ID = process.env.ALT_ID;
const SEG = process.env.ALT_SEG; // optional: a full seg-1 URL to retry on other edges

app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,ThirdPartyCookiePhaseout,TrackingProtection3pcd'
);
const CHROME = process.versions.chrome || '124.0.0.0';
app.userAgentFallback =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;

app.whenReady().then(async () => {
  const partition = process.env.PROBE_PARTITION || 'probe-alt';
  const sess = session.fromPartition(partition);

  // 1) The host's own download page, if it has one.
  for (const p of ['/d/', '/f/', '/download/']) {
    const u = `${HOST}${p}${ID}`;
    try {
      const r = await sess.fetch(u, { headers: { Referer: HOST + '/' } });
      const body = r.status === 200 ? await r.text() : '';
      const links = [...body.matchAll(/href="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((h) => /download|\.mp4|dl\b|\/d\//i.test(h))
        .slice(0, 10);
      log(`page ${p}${ID} HTTP ${r.status} bytes=${body.length} links=${JSON.stringify(links)}`);
      const forms = [...body.matchAll(/name="(op|id|rand|referer|method_free|down_direct)"[^>]*value="([^"]*)"/g)].map(
        (m) => `${m[1]}=${m[2]}`
      );
      if (forms.length) log(`  form: ${forms.join(' ')}`);
      if (process.env.ALT_DUMP && body) log(`  body: ${body.slice(0, 1200).replace(/\s+/g, ' ')}`);
    } catch (e) {
      log(`page ${p}${ID} FAILED ${e && e.message}`);
    }
  }

  // 2) The broken segment on sibling edges.
  if (SEG) {
    const url = new URL(SEG);
    const hosts = [
      url.host,
      url.host.replace(/^edge1-/, 'edge2-'),
      url.host.replace(/^edge1-/, 'edge3-'),
      url.host.replace(/^edge1-moscow-/, 'edge1-'),
      url.host.replace(/^edge1-moscow-/, ''),
      url.host.replace(/^edge1-moscow-sprintcdn/, 'sprintcdn')
    ].filter((h, i, a) => a.indexOf(h) === i);
    for (const h of hosts) {
      const u = new URL(SEG);
      u.host = h;
      try {
        const r = await sess.fetch(u.toString(), {
          headers: { Referer: HOST + '/', Origin: HOST, Range: 'bytes=0-65535' }
        });
        const buf = await r.arrayBuffer();
        log(`edge ${h} HTTP ${r.status} bytes=${buf.byteLength}`);
      } catch (e) {
        log(`edge ${h} FAILED ${e && e.message}`);
      }
    }
  }

  setTimeout(() => app.exit(0), 200);
});
