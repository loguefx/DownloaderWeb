#!/usr/bin/env node
'use strict';
/**
 * Publish a new plugin version to the Jellyfin plugin repository.
 *
 * 1. Builds the three line zips (10.10 / 10.11 / 12), versioned <abi>.<build>.
 * 2. Uploads them as assets of the GitHub release `v<build>`.
 * 3. (Re)generates plugin-repo/manifest.json — the file the Jellyfin server
 *    fetches as a custom plugin repository — merging in the new versions and
 *    keeping older ones (so clients can still update from any previous one).
 * 4. Commits + pushes the manifest, and prints the repository URL to add in
 *    the Jellyfin dashboard (Plugins -> Add repository).
 *
 * Usage:  npm run publish:plugin -- 2            (build number 2)
 *         BUILD=2 CHANGELOG="fix X" npm run publish:plugin
 *
 * Auth: GITHUB_TOKEN env var, or the token in ~/.git-credentials
 * (https://x-access-token:<token>@github.com).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildZips, NAME, OVERVIEW, DESCRIPTION, OWNER, CATEGORY, PLUGIN_GUID } =
  require('./build-plugin-zips.js');

const REPO = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'plugin-repo', 'manifest.json');
const GITHUB_REPO = 'loguefx/DownloaderWeb';
const GITHUB_BRANCH = 'jellyfin';
const CRED_FILE = path.join(os.homedir(), '.git-credentials');

function fail(msg) {
  console.error('\n[publish] ' + msg);
  process.exit(1);
}

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (fs.existsSync(CRED_FILE)) {
    const m = fs.readFileSync(CRED_FILE, 'utf8').match(/https:\/\/x-access-token:([^@]+)@github\.com/);
    if (m) return m[1];
  }
  fail('No GitHub token found. Set GITHUB_TOKEN or add it to ~/.git-credentials.');
}

async function gh(apiPath, { method = 'GET', body, ok404 = false } = {}) {
  const token = getToken();
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 404 && ok404) return null;
  if (!res.ok) fail(`GitHub API ${method} ${apiPath} -> ${res.status}: ${text.slice(0, 300)}`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* empty body */ }
  return json;
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function uploadAsset(releaseId, file, name) {
  const token = getToken();
  const res = spawnSync('curl', [
    '-s', '-f', '-X', 'POST',
    '-H', `authorization: Bearer ${token}`,
    '-H', 'accept: application/vnd.github+json',
    '-H', 'content-type: application/octet-stream',
    '--upload-file', file,
    `https://api.github.com/repos/${GITHUB_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
  ], { encoding: 'utf8' });
  if (res.status !== 0) fail(`asset upload failed: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  return JSON.parse(res.stdout);
}

function releaseTag(build) {
  return `v${build}`;
}

/** Write plugin-repo/manifest.json, merging in the new versions. */
function writeManifest(built, changelog, tag) {
  let manifest = [];
  if (fs.existsSync(MANIFEST_PATH)) {
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
    catch { manifest = []; }
  }

  let plugin = manifest.find(p => p.guid === PLUGIN_GUID);
  if (!plugin) {
    plugin = {
      guid: PLUGIN_GUID,
      name: NAME,
      description: DESCRIPTION,
      overview: OVERVIEW,
      owner: OWNER,
      category: CATEGORY,
      versions: [],
    };
    manifest.push(plugin);
  }

  for (const { version, targetAbi, zip, assetUrl } of built) {
    const name = path.basename(zip);
    const entry = {
      version,
      changelog: changelog || `Version ${version}`,
      targetAbi,
      // Prefer the exact URL the GitHub API returned; fall back to the
      // canonical release-download shape.
      sourceUrl: assetUrl || `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${name}`,
      checksum: md5(zip),
      timestamp: new Date().toISOString(),
    };
    plugin.versions = plugin.versions.filter(v => v.version !== version);
    plugin.versions.push(entry);
  }

  // Highest version first (the catalog expects ordered lists).
  plugin.versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  manifest.sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 4) + '\n');
  console.log(`[manifest] wrote ${path.relative(REPO, MANIFEST_PATH)} (${plugin.versions.length} version(s))`);
}

function gitPush(message) {
  const cred = fs.existsSync(CRED_FILE) ? ['-c', `credential.helper=store --file ${CRED_FILE}`] : [];
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
    if (r.status !== 0) fail(`git ${args.join(' ')} -> ${(r.stderr || r.stdout).slice(0, 400)}`);
    return r;
  };
  run(['add', 'plugin-repo/manifest.json']);
  run(['commit', '-m', message]);
  run([...cred, 'push', 'origin', GITHUB_BRANCH]);
  console.log('[git] pushed manifest');
}

async function main() {
  const build = process.argv[2] || process.env.BUILD || '1';
  const changelog = process.env.CHANGELOG || '';
  const tag = releaseTag(build);

  // 1. Build the three line zips.
  const built = buildZips({ build });

  // 2. GitHub release v<build> with the three zips as assets.
  console.log(`\n[release] ${tag}`);
  const existing = await gh(`/releases/tags/${tag}`, { ok404: true });
  let release;
  if (existing && existing.id) {
    release = existing;
    console.log(`[release] exists (id ${release.id}); adding assets`);
  } else {
    release = await gh('/releases', {
      method: 'POST',
      body: {
        tag_name: tag,
        name: `Media Downloader plugin — build ${build}`,
        draft: false,
        prerelease: false,
        target_commitish: GITHUB_BRANCH,
      },
    });
    console.log(`[release] created (id ${release.id})`);
  }

  for (const item of built) {
    const name = `MediaDownloader.${item.version}.zip`;
    const uploaded = uploadAsset(release.id, item.zip, name);
    item.assetUrl = uploaded.browser_download_url;
    console.log(`[release] uploaded ${name} -> ${uploaded.browser_download_url}`);
  }

  // 3. Manifest (points at the release asset URLs) + commit + push.
  writeManifest(built, changelog, tag);
  gitPush(`plugin repo: release build ${build} (10.10/10.11/12)`);

  const repoUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/plugin-repo/manifest.json`;
  console.log('\nDone. Add this as a plugin repository in Jellyfin:');
  console.log('  Dashboard -> Plugins -> Add repository (third-party)');
  console.log(`  ${repoUrl}`);
}

main().catch(e => fail(e.message));
