#!/usr/bin/env node
'use strict';
/**
 * Build the installable plugin package for each supported Jellyfin line.
 *
 * The plugin multi-targets net8.0 (10.10) / net9.0 (10.11) / net10.0 (12);
 * this script builds each target in Release and packages exactly what a
 * server needs to load it: the plugin dll + a meta.json manifest, in a
 * folder named "MediaDownloader".
 *
 * Output:
 *   dist/plugins/MediaDownloader.10.10.zip
 *   dist/plugins/MediaDownloader.10.11.zip
 *   dist/plugins/MediaDownloader.12.zip
 *
 * Install (per jellyfin.org docs): put the unzipped folder into the server's
 * plugins/ directory (e.g. /var/lib/jellyfin/plugins/MediaDownloader/ or
 * %ProgramData%\Jellyfin\Server\plugins\MediaDownloader\) and restart
 * Jellyfin. Pick the zip that matches the server's major line — a 10.x build
 * will not load on a 12 server and vice versa.
 *
 * Needs the .NET SDK (>= 10.0.100 to build all three targets). Defaults to
 * ~/.dotnet/dotnet; override with $DOTNET.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const dotnet = process.env.DOTNET || path.join(os.homedir(), '.dotnet', 'dotnet');

const PLUGIN_DIR = path.join(REPO, 'Jellyfin.Plugin.MediaDownloader');
const DLL_NAME = 'Jellyfin.Plugin.MediaDownloader.dll';
const FOLDER = 'MediaDownloader';
const PLUGIN_GUID = 'c86748fd-475a-4cf0-bae0-83b0c8bc9273'; // Plugin.cs
const PLUGIN_VERSION = '1.0.0.0'; // AssemblyVersion in the csproj
const NAME = 'Media Downloader';
const OVERVIEW = 'Queues movies, series and anime for the DownloaderWeb engine and shows its health and queue.';
const DESCRIPTION =
  'Browser-side bridge between Jellyfin and the DownloaderWeb engine: the ' +
  'plugin keeps the engine key server-side, queues download jobs exactly once ' +
  '(outbox), and surfaces engine health/queue in the dashboard.';

// One row per server line. targetAbi gates the server's "supported" check
// (server version >= targetAbi); the dll itself must match the line.
const TARGETS = [
  { tfm: 'net8.0', line: '10.10', targetAbi: '10.10.0.0' },
  { tfm: 'net9.0', line: '10.11', targetAbi: '10.11.0.0' },
  { tfm: 'net10.0', line: '12', targetAbi: '12.0.0.0' },
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
 * Zip <dir> (with its top-level folder as the zip root) into <out.zip>,
 * using whichever of zip / python3 / 7z is available.
 */
function makeZip(dir, outZip) {
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0) {
    run('zip', ['-q', '-r', outZip, path.basename(dir)], { cwd: path.dirname(dir) });
    return;
  }
  if (spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0) {
    // python zipfile: cwd = parent of dir so the zip root is the folder name.
    run('python3', ['-m', 'zipfile', '-c', outZip, path.basename(dir)], { cwd: path.dirname(dir) });
    return;
  }
  if (spawnSync('7z', ['i'], { stdio: 'ignore' }).status === 0) {
    run('7z', ['a', '-r', outZip, path.basename(dir)], { cwd: path.dirname(dir) });
    return;
  }
  console.error('No zip tool found (tried zip, python3, 7z).');
  process.exit(1);
}

function metaJson({ targetAbi }) {
  // Property names are the server's [JsonPropertyName] values
  // (MediaBrowser.Common.Plugins.PluginManifest); camelCase.
  return JSON.stringify(
    {
      category: 'General',
      changelog: 'Initial release.',
      description: DESCRIPTION,
      guid: PLUGIN_GUID,
      name: NAME,
      overview: OVERVIEW,
      owner: 'loguefx',
      targetAbi,
      timestamp: new Date().toISOString(),
      version: PLUGIN_VERSION,
      status: 0, // Active
      autoUpdate: false,
      imagePath: null,
      assemblies: [DLL_NAME],
    },
    null,
    2
  ) + '\n';
}

function main() {
  const outRoot = path.join(REPO, 'dist', 'plugins');
  fs.mkdirSync(outRoot, { recursive: true });

  for (const { tfm, line, targetAbi } of TARGETS) {
    console.log(`\n=== ${line} (${tfm}) ===`);

    console.log('[build] dotnet build -c Release -f ' + tfm);
    run(dotnet, ['build', PLUGIN_DIR, '-c', 'Release', '-f', tfm, '-v', 'q', '--nologo']);

    const srcDll = path.join(PLUGIN_DIR, 'bin', 'Release', tfm, DLL_NAME);
    if (!fs.existsSync(srcDll)) {
      console.error(`Missing built dll: ${srcDll}`);
      process.exit(1);
    }

    // Stage: dist/plugins-build/<line>/MediaDownloader/{dll,meta.json}
    const staged = path.join(REPO, 'dist', 'plugins-build', line, FOLDER);
    fs.rmSync(path.join(REPO, 'dist', 'plugins-build', line), { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });
    fs.copyFileSync(srcDll, path.join(staged, DLL_NAME));
    fs.writeFileSync(path.join(staged, 'meta.json'), metaJson({ targetAbi }));

    const outZip = path.join(outRoot, `MediaDownloader.${line}.zip`);
    fs.rmSync(outZip, { force: true });
    makeZip(staged, outZip);
    console.log(`[ok] ${path.relative(REPO, outZip)}`);
  }

  console.log('\nAll plugin zips built.');
  console.log('Install: extract the matching zip into the Jellyfin server plugins/');
  console.log('directory so the MediaDownloader/ folder sits next to the other plugin');
  console.log('folders, then restart the server. Match the line to your server:');
  console.log('  10.10 -> MediaDownloader.10.10.zip   10.11 -> MediaDownloader.10.11.zip');
  console.log('  12    -> MediaDownloader.12.zip');
}

main();
