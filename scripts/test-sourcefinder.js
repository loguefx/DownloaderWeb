'use strict';
// "Find more sources": what counts as a working player, and the run itself.
const path = require('path');
const f = require(path.join(__dirname, '..', 'src', 'main', 'sourcefinder.js'));

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`); }
};

async function main() {
  console.log('\n[1] Verdicts');
  check('a resolved stream at the floor = 1080p', f.verdictOf({ status: 'resolved', reason: '' }) === '1080p');
  check('relay below the floor = below 1080p', f.verdictOf({ status: 'failed', reason: 'Relay stream is 720p, not 1080p' }) === 'below 1080p');
  check('server buttons all smaller = below 1080p', f.verdictOf({ status: 'failed', reason: 'No 1080p stream on this site' }) === 'below 1080p');
  check('no stream = none', f.verdictOf({ status: 'failed', reason: 'No video sources found on the page' }) === 'none');
  check('Cloudflare = none', f.verdictOf({ status: 'failed', reason: 'Cloudflare check did not clear' }) === 'none');

  console.log('\n[2] A run');
  const asked = [];
  f._setForTests({
    tryFn: async (url) => {
      asked.push(url);
      if (/good\.example/.test(url)) return { status: 'resolved', reason: '', height: 1080 };
      if (/small\.example/.test(url)) return { status: 'failed', reason: 'Relay stream is 720p, not 1080p', height: 720 };
      return { status: 'failed', reason: 'No video sources found on the page', height: 0 };
    }
  });
  const cands = [
    { id: 'good', name: 'Good', tv: 'https://good.example/tv/{tmdb}/{season}/{episode}', movie: 'https://good.example/movie/{tmdb}' },
    { id: 'small', name: 'Small', tv: 'https://small.example/tv/{tmdb}/{season}/{episode}', movie: 'https://small.example/movie/{tmdb}' },
    { id: 'dead', name: 'Dead', tv: 'https://dead.example/tv/{tmdb}/{season}/{episode}', movie: 'https://dead.example/movie/{tmdb}' }
  ];
  f.run({ candidates: cands, doInstall: false });
  for (let i = 0; i < 100 && f.status().running; i++) await new Promise((r) => setTimeout(r, 20));
  const r = f.status().results;
  const by = (id) => r.find((x) => x.id === id) || {};
  check('each player asked for one episode and one film', asked.length === 6 && asked.includes('https://good.example/tv/1396/1/1') && asked.includes('https://good.example/movie/27205'), JSON.stringify(asked));
  check('the working one: 1080p', by('good').best === '1080p');
  check('the smaller one: below 1080p (still usable for the 720p fallback)', by('small').best === 'below 1080p');
  check('the dead one: none', by('dead').best === 'none');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR:', (e && e.stack) || e); process.exit(1); });
