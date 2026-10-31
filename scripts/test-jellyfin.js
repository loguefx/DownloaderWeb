'use strict';

// Tests for the engine's Jellyfin calls (src/main/jellyfin.js + placer):
//   1. catalog search hits /Items?searchTerm=... with the current
//      Authorization: MediaBrowser Token="..." header (legacy X-Emby-* headers
//      are off by default since Jellyfin 10.11);
//   2. the library refresh POSTs /Library/Media/Updated with an
//      { Updates: [{ Path, UpdateType }] } body, using the path JELLYFIN sees;
//   3. toJellyfinPath is the inverse of toEnginePath.
//
// A local HTTP server stands in for Jellyfin. No network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-jf-'));
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => DATA_DIR } };
  return origLoad.apply(this, arguments);
};

const REPO = path.join(__dirname, '..');
const M = (p) => require(path.join(REPO, 'src/main', p));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`);
  }
}

async function main() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', legacy: req.headers['x-emby-token'] || '', body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/Items?')) {
        res.end(JSON.stringify({
          Items: [
            { Id: 'a1', Name: 'Test Show', Type: 'Series', ProductionYear: 2019, ProviderIds: { Tmdb: '123', Imdb: 'tt1' }, ImageTags: { Primary: 'tag1' } }
          ]
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/Library/Media/Updated') {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const engineconfig = M('engineconfig');
  engineconfig.dataDir = DATA_DIR;
  engineconfig.set({
    jellyfin: { baseUrl: base + '/', apiKey: 'k3y' },
    pathMappings: [{ jellyfin: '/mnt/disk1/anime', engine: path.join(DATA_DIR, 'anime') }]
  });
  const jellyfin = M('jellyfin');
  const placer = M('placer');

  console.log('\n[1] Catalog search');
  const items = await jellyfin.searchItems('Test Show', ['Series']);
  const q = seen.find((x) => x.method === 'GET');
  check('search uses /Items with searchTerm + Recursive', q && /^\/Items\?searchTerm=Test%20Show&Recursive=true/.test(q.url), q && q.url);
  check('search asks for ProviderIds', q && /Fields=ProviderIds/.test(q.url), q && q.url);
  check('search sends Authorization: MediaBrowser Token', q && /^MediaBrowser .*Token="k3y"/.test(q.auth), q && q.auth);
  check('no legacy X-Emby-Token header', q && !q.legacy);
  check('items come back with provider ids', items.length === 1 && items[0].ProviderIds.Tmdb === '123', JSON.stringify(items));

  console.log('\n[2] Library refresh after placement');
  const engineFile = path.join(DATA_DIR, 'anime', 'Test Show', 'Season 1', 'Test Show S1E1.mp4');
  const ok = await placer.refreshJellyfin(engineconfig.get(), engineFile);
  const p = seen.find((x) => x.method === 'POST');
  let body = null;
  try { body = JSON.parse(p.body); } catch (e) { body = null; }
  check('refresh POSTs /Library/Media/Updated', !!p, JSON.stringify(seen.map((x) => x.method + ' ' + x.url)));
  check('body is { Updates: [{ Path, UpdateType: "Created" }] }',
    body && Array.isArray(body.Updates) && body.Updates[0].UpdateType === 'Created', p && p.body);
  check('Path is the folder as JELLYFIN sees it', body && body.Updates[0].Path === '/mnt/disk1/anime/Test Show/Season 1', body && body.Updates[0].Path);
  check('refresh reports success on 204', ok === true);

  console.log('\n[3] Path mapping round trip');
  const maps = [{ jellyfin: 'D:\\Media', engine: '/srv/media' }, { jellyfin: '/mnt/a', engine: '/srv' }];
  check('Windows-style Jellyfin path keeps backslashes',
    placer.toJellyfinPath('/srv/media/Show/Specials', maps) === 'D:\\Media\\Show\\Specials', placer.toJellyfinPath('/srv/media/Show/Specials', maps));
  check('longest engine prefix wins', placer.toJellyfinPath('/srv/other', maps) === '/mnt/a/other');
  check('a prefix must end at a folder boundary', placer.toJellyfinPath('/srvx/y', maps) === '/srvx/y');
  check('unmapped path is unchanged', placer.toJellyfinPath('/home/x', maps) === '/home/x');

  srv.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(1);
});
