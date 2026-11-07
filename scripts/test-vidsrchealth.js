'use strict';

// The engine's own Vidsrc check (Overview > Sources): each step is reported,
// the first broken one is named, and a server without 1080p shows as such.

const path = require('path');
const h = require(path.join(__dirname, '..', 'src', 'main', 'vidsrchealth.js'));
const real = require(path.join(__dirname, '..', 'src', 'main', 'sites', 'vidsrc_dl.js'));

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

function fake(over = {}) {
  return Object.assign({
    isBlocked: () => false,
    getApiToken: async () => 'tok',
    tokenFailure: () => 'vidsrc.sh: player page has no apiToken (the site changed its page)',
    fetchStreamUrls: async () => ({ urls: ['https://cdn.example/a/master.m3u8'], meta: {} }),
    fetchHostToken: async () => 'srv',
    genVariant: () => 'api_token',
    request: async () => ({ status: 200, body: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=1920x1080\n1080.m3u8\n') }),
    parseMaster: real.parseMaster,
    meetsFloor: real.meetsFloor
  }, over);
}

async function main() {
  console.log('\n[1] Everything works');
  h._setForTests(fake());
  let r = await h.run();
  check('status ok, four steps', r.status === 'ok' && r.steps.length === 4 && r.steps.every((s) => s.ok), JSON.stringify(r));
  check('summary names the token form and the best quality', /Qualities best 1920x1080/.test(r.summary), r.summary);

  console.log('\n[2] No API token (the site changed its page)');
  h._setForTests(fake({ getApiToken: async () => '' }));
  r = await h.run();
  check('down, and the broken step is named', r.status === 'down' && /API token: .*player page has no apiToken/.test(r.summary), r.summary);

  console.log('\n[3] The video server refuses (403)');
  h._setForTests(fake({ fetchHostToken: async () => { throw Object.assign(new Error('HTTP 403'), { status: 403 }); } }));
  r = await h.run();
  check('refusing, named', r.status === 'blocked' && /Video server: .*403/.test(r.summary), r.summary);

  console.log('\n[4] Up, but only 720p on this server');
  h._setForTests(fake({ request: async () => ({ status: 200, body: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=1280x720\n720.m3u8\n') }) }));
  r = await h.run();
  check('"limited", not down', r.status === 'limited' && r.ok === true && /no 1080p on this server/.test(JSON.stringify(r.steps)), JSON.stringify(r));

  console.log('\n[5] Real downloads');
  h._setForTests(fake());
  h.noteLocked(1280, 720);
  let g = h.get();
  check('a 720p download is noted, not as 1080p', g.lastLockedHeight === 720 && !g.last1080At);
  h.noteLocked(1920, 960);
  g = h.get();
  check('a widescreen 1080p download counts as 1080p', g.last1080At > 0);
  check('get() starts a check when there is none', g.checking === true || g.at > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', (e && e.stack) || e);
  process.exit(1);
});
