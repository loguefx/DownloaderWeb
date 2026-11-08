'use strict';
// The engine's build number. The plugin page carries the build it was made
// for (EXPECTED_ENGINE_BUILD in Web/overview.html) and warns when the engine
// is older ("Engine is older than this plugin - update it"): several bugs
// were chased that an engine update had already fixed.
// Raise BOTH together whenever the plugin needs the matching engine
// (scripts/test-build-match.js keeps them equal).
module.exports = { ENGINE_BUILD: 54 };
