'use strict';
// Integration test (build plan Part 4): plugin outbox worker <-> REAL engine.
//
// Boots the actual engine HTTP API under plain Node (same electron shim the
// smoke test uses), then runs the C# plugin test harness against it and
// independently asserts the engine side of the exactly-once guarantee:
//   - a delivered jobId is queued EXACTLY once, even if the plugin resends it
//   - a rejected (4xx) job is never queued
//
// Usage:  node scripts/test-plugin-outbox.js
// (Needs the .NET 8 SDK; defaults to ~/.dotnet/dotnet, override with $DOTNET.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wvd-itg-'));
const PORT = 17879;

// ---- electron shim (must be in place before any app module loads) ----------
const shim = {
  app: {
    getPath: () => DATA_DIR,
    on: () => {}, once: () => {}, whenReady: () => Promise.resolve(),
    quit: () => process.exit(0), setLoginItemSettings: () => {},
    getName: () => 'webvideodownloader'
  },
  BrowserWindow: class { constructor() { throw new Error('no BrowserWindow in ITG'); } },
  session: { fromPartition: () => ({ setUserAgent() {}, setPermissionRequestHandler() {}, webRequest: { onBeforeSendHeaders() {} }, clearCache: () => Promise.resolve() }) },
  ipcMain: { handle() {}, on() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  nativeTheme: { on() {} }, Menu: { setApplicationMenu() {} }, shell: { openExternal() {} },
  clipboard: { readText: () => '', writeText() {} },
  globalShortcut: { on() {}, register() {}, unregister() {} }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return shim;
  return origLoad.apply(this, arguments);
};

const M = (p) => require(path.join(REPO, 'src/main', p));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${extra ? ' -- ' + extra : ''}`); }
}

// Async so the Node event loop (and the in-process engine) keeps running
// while the dotnet child executes. Streams child output live.
function runDotnet(dotnet, args, opts) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(dotnet, args, opts);
    } catch (e) {
      reject(e);
      return;
    }
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const timer = setTimeout(() => {
      console.error('\n[driver] harness timed out, killing');
      child.kill('SIGKILL');
    }, 90000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const engineconfig = M('engineconfig');
  engineconfig.dataDir = path.join(DATA_DIR, 'cfg');
  const library = M('library');
  library.dataDir = path.join(DATA_DIR, 'libdata');
  const placer = M('placer');
  const vpn = M('vpn');
  const manager = M('queue');
  const service = M('service');
  const api = M('api');

  // A real library folder with a marker so jobs can be accepted & placed.
  const libA = path.join(DATA_DIR, 'lib', 'anime');
  fs.mkdirSync(libA, { recursive: true });
  engineconfig.set({
    port: PORT,
    bind: '127.0.0.1',
    reserveBytes: 0,
    fillMode: 'order',
    pathMappings: [{ jellyfin: '\\\\nas\\anime', engine: libA }]
  });
  placer.ensureMarkers([libA]);

  // Make discovery pass so accepted jobs are not held.
  vpn._setStatus(true, 'itg', 'test');

  await api.start();
  const KEY = engineconfig.get().apiKey;
  const ENGINE_URL = `http://127.0.0.1:${PORT}`;
  console.log(`\n[engine] real HTTP API up at ${ENGINE_URL}`);

  // ---- build + run the C# plugin harness -----------------------------------
  const dotnet = process.env.DOTNET || path.join(os.homedir(), '.dotnet', 'dotnet');
  const tfm = process.env.TFM || 'net8.0'; // net8.0=10.10  net9.0=10.11  net10.0=12.1
  const testsDir = path.join(REPO, 'Jellyfin.Plugin.MediaDownloader.Tests');
  const dll = path.join(testsDir, 'bin', 'Debug', tfm, 'Jellyfin.Plugin.MediaDownloader.Tests.dll');

  console.log(`\n[build] dotnet build (plugin + harness, target ${tfm})`);
  const build = spawnSync(dotnet, ['build', '-v', 'q', '--nologo', '-f', tfm], { cwd: testsDir, encoding: 'utf8' });
  if (build.status !== 0) {
    console.log(build.stdout || '');
    console.log(build.stderr || '');
    throw new Error('dotnet build failed (exit ' + build.status + ')');
  }

  console.log('\n[run] C# plugin outbox harness');
  // MUST be async spawn: the engine HTTP server lives on this Node event loop.
  // spawnSync would block it, so the engine could never answer the C# client.
  const harnessCode = await runDotnet(dotnet, [dll], {
    cwd: testsDir,
    env: Object.assign({}, process.env, {
      DOTNET_ROOT: path.join(os.homedir(), '.dotnet'),
      ENGINE_URL,
      ENGINE_KEY: KEY
    })
  });
  check('C# harness exited 0', harnessCode === 0, 'exit=' + harnessCode);

  // ---- engine-side exactly-once assertion ----------------------------------
  // Use the full internal items (manager.items), not service.queueSnapshot(),
  // which returns a reduced shape that omits jobId/library.
  const items = manager.items || [];
  const byJob = (id) => items.filter((x) => x.jobId === id);
  check('engine: delivered job "itg-1" queued EXACTLY once', byJob('itg-1').length === 1, 'count=' + byJob('itg-1').length);
  check('engine: rejected job "itg-bad" NOT queued', byJob('itg-bad').length === 0, 'count=' + byJob('itg-bad').length);
  check('engine: queued item stamped with library', byJob('itg-1')[0] && byJob('itg-1')[0].library && byJob('itg-1')[0].library.name === 'Anime');

  // ---- summary --------------------------------------------------------------
  manager.stopAll('itg done');
  await api.stop();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:', failures); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('ITG driver error:', e);
  process.exitCode = 1;
  process.exit(1);
});
