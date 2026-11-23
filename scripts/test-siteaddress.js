'use strict';
// Source sites move; the engine keeps up: a followed redirect / a healed
// address / the user's choice is kept, and the other known addresses are
// tried when one stops answering.
const path = require('path');
const sa = require(path.join(__dirname, '..', 'src', 'main', 'siteaddress.js'));

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`); }
};

async function main() {
  let data = {};
  sa._setConfigForTests({ get: () => data, set: (p) => { data = Object.assign({}, data, p); return data; } });

  console.log('\n[1] Addresses');
  check('built-in address when none is set', sa.current('aniwave') === 'https://aniwaves.tv');
  data = { aniwaveBase: 'https://old-setting.example' };
  check('the earlier aniwaveBase setting still counts', sa.current('aniwave') === 'https://old-setting.example');
  sa.adopt('aniwave', 'https://new.example/');
  check('adopted address is used (and kept in both settings)', sa.current('aniwave') === 'https://new.example' && data.aniwaveBase === 'https://new.example');
  check('a path is never an address', sa.adopt('aniwave', 'https://x.example/watch') === false && sa.current('aniwave') === 'https://new.example');
  sa.adopt('aniwave', '');
  check('"--default" goes back to the built-in one', sa.current('aniwave') === 'https://aniwaves.tv');

  console.log('\n[2] Heal: the current address stopped answering');
  data = { siteAddresses: { animevillage: 'https://dead.example' } };
  const tried = [];
  const h = await sa.heal('animevillage', async (b) => { tried.push(b); return b === 'https://animevillage.org'; });
  check('the other known addresses are tried, in order', JSON.stringify(tried) === JSON.stringify(['https://dead.example', 'https://www.animevillage.org', 'https://animevillage.org']), JSON.stringify(tried));
  check('the first that answers is used from now on', h.ok && sa.current('animevillage') === 'https://animevillage.org');
  const h2 = await sa.heal('nontongo', async () => false);
  check('none answers: nothing changes, says so', h2.ok === false && sa.current('nontongo') === 'https://sv2.nontongo.day');
  const before = sa.current('animevillage');
  await sa.heal('animevillage', async () => true);
  check('the current one answering: kept', sa.current('animevillage') === before);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR:', (e && e.stack) || e); process.exit(1); });
