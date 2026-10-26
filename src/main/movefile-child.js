'use strict';

// Child entry: the parent spawns  <node> movefile-child.js <json-params>.
// The whole move happens here so a hung network share blocks only THIS
// process, and the parent's timeout kills it (TerminateProcess on Windows)
// instead of freezing the engine. Output is one JSON line on stdout.

const { moveIntoPlace } = require('./movefile');

function main() {
  const params = JSON.parse(process.argv[2] || '{}');
  // Test hook: simulate a hung share so the parent's timeout path can be
  // exercised without a dead NAS.
  if (params.sleepMs > 0) {
    const until = Date.now() + params.sleepMs;
    while (Date.now() < until) {
      /* block */
    }
  }
  const res = moveIntoPlace(params);
  console.log(
    JSON.stringify({
      ok: true,
      finalPath: (res && res.finalPath) || params.finalPath,
      trashedTo: (res && res.trashedTo) || null
    })
  );
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exit(1);
}
