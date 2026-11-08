'use strict';
// The plugin page's EXPECTED_ENGINE_BUILD and the engine's ENGINE_BUILD move
// together: a plugin expecting a newer engine than exists would warn forever,
// one expecting an older one would never warn.
const fs = require('fs');
const path = require('path');
const { ENGINE_BUILD } = require(path.join(__dirname, '..', 'src', 'main', 'build.js'));
const page = fs.readFileSync(path.join(__dirname, '..', 'Jellyfin.Plugin.MediaDownloader', 'Web', 'overview.html'), 'utf8');
const m = page.match(/EXPECTED_ENGINE_BUILD = (\d+)/);
const expected = m ? Number(m[1]) : NaN;
const ok = expected === ENGINE_BUILD;
console.log(`  ${ok ? 'ok  ' : 'FAIL'}  plugin expects engine build ${expected}, engine is build ${ENGINE_BUILD}`);
console.log(`\n${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
