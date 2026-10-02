#!/usr/bin/env node
'use strict';
/**
 * Build the plugin for each supported Jellyfin line, versioned per line.
 *
 * Versioning follows the Jellyfin plugin-catalog convention: the version is
 * "<targetAbi>.<build>" (e.g. 10.11.0.2), so one repository manifest can serve
 * every server line and the catalog picks the highest compatible version:
 *
 *   net8.0  -> 10.10 line -> 10.10.0.<build>
 *   net9.0  -> 10.11 line -> 10.11.0.<build>
 *   net10.0 -> 12 line    -> 12.0.0.<build>
 *
 * The assembly version is stamped to match (so the version shown in the
 * dashboard equals the catalog version), and the bundled meta.json carries the
 * same version + targetAbi + autoUpdate=true.
 *
 * Zip layout: files at the ZIP ROOT (dll + meta.json), no top-level folder —
 * that is exactly what the server's catalog installer expects
 * (InstallationManager extracts into plugins/<name>/) and matches the
 * official catalog zips. For manual installs, create the folder first and
 * extract the contents into it.
 *
 * Output: dist/plugins/MediaDownloader.<version>.zip
 *
 * Needs the .NET SDK (>= 10.0.100 to build all three targets). Defaults to
 * ~/.dotnet/dotnet; override with $DOTNET. Build number: $BUILD (default 1).
 *
 * `npm run build:plugin-zips -- 2` or `BUILD=2 npm run build:plugin-zips`
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const dotnet = process.env.DOTNET || path.join(os.homedir(), '.dotnet', 'dotnet');

const PLUGIN_DIR = path.join(REPO, 'Jellyfin.Plugin.MediaDownloader');
const DLL_NAME = 'Jellyfin.Plugin.MediaDownloader.dll';
const PLUGIN_GUID = 'c86748fd-475a-4cf0-bae0-83b0c8bc9273'; // Plugin.cs
const NAME = 'Media Downloader';
const OVERVIEW = 'Queues movies, series and anime for the DownloaderWeb engine and shows its health and queue.';
const DESCRIPTION =
  'Browser-side bridge between Jellyfin and the DownloaderWeb engine: the ' +
  'plugin keeps the engine key server-side, queues download jobs exactly once ' +
  '(outbox), and surfaces engine health/queue in the dashboard.';
const OWNER = 'loguefx';
const CATEGORY = 'General';

// One row per server line: TFM, the ABI base used for versioning + gating.
const TARGETS = [
  { tfm: 'net8.0', abi: '10.10.0', targetAbi: '10.10.0.0' },
  { tfm: 'net9.0', abi: '10.11.0', targetAbi: '10.11.0.0' },
  { tfm: 'net10.0', abi: '12.0.0', targetAbi: '12.0.0.0' },
];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    console.error(`FAILED: ${cmd} ${args.join(' ')}`);
    console.error(res.stdout || '');
    console.error(res.stderr || '');
    process.exit(1);
  }
  return res;
}

/**
 * Zip the files in <dir> (root-level entries) into <out.zip> using whichever
 * of zip / python3 / 7z is available.
 */
function makeZip(dir, files, outZip) {
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0) {
    run('zip', ['-q', outZip, ...files], { cwd: dir });
    return;
  }
  if (spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0) {
    run('python3', ['-m', 'zipfile', '-c', outZip, ...files], { cwd: dir });
    return;
  }
  if (spawnSync('7z', ['i'], { stdio: 'ignore' }).status === 0) {
    run('7z', ['a', outZip, ...files], { cwd: dir });
    return;
  }
  console.error('No zip tool found (tried zip, python3, 7z).');
  process.exit(1);
}

function metaJson({ version, targetAbi }) {
  // Property names are the server's [JsonPropertyName] values
  // (MediaBrowser.Common.Plugins.PluginManifest); camelCase.
  return JSON.stringify(
    {
      category: CATEGORY,
      changelog: '',
      description: DESCRIPTION,
      guid: PLUGIN_GUID,
      name: NAME,
      overview: OVERVIEW,
      owner: OWNER,
      targetAbi,
      timestamp: new Date().toISOString(),
      version,
      status: 0, // Active
      autoUpdate: true,
      imagePath: null,
      assemblies: [DLL_NAME],
    },
    null,
    2
  ) + '\n';
}

/**
 * Build + stage + zip every target. Returns [{ tfm, abi, version, targetAbi, zip }].
 */
function buildZips({ build = '1', changelog = '' } = {}) {
  if (!/^\d+$/.test(build)) {
    console.error('BUILD must be a positive integer (e.g. 2).');
    process.exit(1);
  }
  const outRoot = path.join(REPO, 'dist', 'plugins');
  fs.mkdirSync(outRoot, { recursive: true });
  const built = [];

  for (const { tfm, abi, targetAbi } of TARGETS) {
    const version = `${abi}.${build}`;
    console.log(`\n=== ${abi} line (${tfm}) -> ${version} ===`);

    console.log('[build] dotnet build -c Release -f ' + tfm + ' -p:Version=' + version);
    run(dotnet, [
      'build', PLUGIN_DIR,
      '-c', 'Release', '-f', tfm, '-v', 'q', '--nologo',
      '-p:Version=' + version,
      '-p:AssemblyVersion=' + version,
      '-p:FileVersion=' + version,
    ]);

    const srcDll = path.join(PLUGIN_DIR, 'bin', 'Release', tfm, DLL_NAME);
    if (!fs.existsSync(srcDll)) {
      console.error(`Missing built dll: ${srcDll}`);
      process.exit(1);
    }

    // Stage with ROOT-LEVEL entries (no top folder): dist/plugins-build/<version>/...
    const staged = path.join(REPO, 'dist', 'plugins-build', version);
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });
    fs.copyFileSync(srcDll, path.join(staged, DLL_NAME));
    fs.writeFileSync(path.join(staged, 'meta.json'), metaJson({ version, targetAbi }));

    const outZip = path.join(outRoot, `MediaDownloader.${version}.zip`);
    fs.rmSync(outZip, { force: true });
    makeZip(staged, [DLL_NAME, 'meta.json'], outZip);
    console.log(`[ok] ${path.relative(REPO, outZip)}`);
    built.push({ tfm, abi, version, targetAbi, zip: outZip, changelog });
  }

  console.log('\nAll plugin zips built.');
  return built;
}

if (require.main === module) {
  const build = process.argv[2] || process.env.BUILD || '1';
  buildZips({ build });
  console.log('Install (manual): mkdir the plugin folder, unzip the contents into it, restart Jellyfin.');
  console.log('Or add the plugin repository in the dashboard for automatic updates (see docs/engine-windows.md).');
}

module.exports = { buildZips, TARGETS, NAME, OVERVIEW, DESCRIPTION, OWNER, CATEGORY, PLUGIN_GUID, DLL_NAME };
