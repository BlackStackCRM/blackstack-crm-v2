#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;
const tag = `v${version}`;
const dist = path.join(root, pkg.build?.directories?.output || 'dist');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
  return options.capture ? result.stdout : '';
}

function cleanPreviousArtifacts() {
  fs.mkdirSync(dist, { recursive: true });
  for (const name of fs.readdirSync(dist)) {
    const fullPath = path.join(dist, name);
    if (!fs.statSync(fullPath).isFile()) continue;
    if (name === 'stable.yml' || name === 'latest.yml' || /\.exe(?:\.blockmap)?$/i.test(name)) {
      fs.rmSync(fullPath);
      console.log(`[release] Removed stale dist artifact: ${name}`);
    }
  }
}

function buildLocally(npmCli) {
  const hasSigningCredentials = Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
  if (hasSigningCredentials) {
    // Keep the production signing gate, but explicitly prevent electron-builder
    // from publishing. Artifact upload happens only after manifest validation.
    run(process.execPath, [path.join(root, 'scripts', 'require-signing.js')]);
    run(process.execPath, [
      npmCli, 'exec', '--', 'electron-builder', '--win', 'nsis', '--publish', 'never',
      '-c.win.forceCodeSigning=true',
    ]);
  } else {
    console.warn('[release] CSC_LINK / CSC_KEY_PASSWORD not set; building an UNSIGNED test installer.');
    run(process.execPath, [
      npmCli, 'exec', '--', 'electron-builder', '--win', 'nsis', '--publish', 'never',
      '-c.win.forceCodeSigning=false',
    ]);
  }
}

function parseScalar(yaml, key) {
  const line = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(yaml);
  if (!line) return null;
  return line[1].replace(/^['"]|['"]$/g, '').trim() || null;
}

function resolveManifestAndInstaller() {
  const stableYml = path.join(dist, 'stable.yml');
  const latestYml = path.join(dist, 'latest.yml');
  if (!fs.existsSync(stableYml) && fs.existsSync(latestYml)) {
    fs.copyFileSync(latestYml, stableYml);
    console.warn('[release] Builder emitted latest.yml; copied the fresh manifest to stable.yml.');
  }
  if (!fs.existsSync(stableYml) || fs.statSync(stableYml).size === 0) {
    throw new Error('Build did not produce a non-empty stable.yml (or latest.yml fallback).');
  }

  const yaml = fs.readFileSync(stableYml, 'utf8');
  const manifestPath = parseScalar(yaml, 'path');
  const urlMatch = /^\s*-?\s*url:[ \\t]*['"]?([^'"\r\n]+)['"]?[ \\t]*$/m.exec(yaml);
  const expectedName = path.basename(manifestPath || (urlMatch && urlMatch[1]) || '');
  if (!expectedName || expectedName === '.' || expectedName === '..') {
    throw new Error('stable.yml does not specify a usable installer path/url.');
  }
  if (urlMatch && path.basename(urlMatch[1]) !== expectedName) {
    throw new Error(`Manifest path (${expectedName}) and files URL (${urlMatch[1]}) disagree.`);
  }

  const installerPath = path.join(dist, expectedName);
  if (!fs.existsSync(installerPath)) {
    const candidates = fs.readdirSync(dist)
      .filter(name => /\.exe$/i.test(name) && !/uninstaller/i.test(name) && name.includes(version))
      .map(name => path.join(dist, name));
    if (candidates.length !== 1) {
      throw new Error(`Expected one fresh ${version} installer to rename to ${expectedName}; found ${candidates.length}.`);
    }
    fs.renameSync(candidates[0], installerPath);
    console.log(`[release] Renamed ${path.basename(candidates[0])} -> ${expectedName}`);
  }

  const blockmapPath = `${installerPath}.blockmap`;
  if (!fs.existsSync(blockmapPath)) {
    const blockmaps = fs.readdirSync(dist)
      .filter(name => /\.exe\.blockmap$/i.test(name) && name.includes(version))
      .map(name => path.join(dist, name));
    if (blockmaps.length !== 1) {
      throw new Error(`Expected one fresh ${version} installer blockmap; found ${blockmaps.length}.`);
    }
    fs.renameSync(blockmaps[0], blockmapPath);
    console.log(`[release] Renamed ${path.basename(blockmaps[0])} -> ${path.basename(blockmapPath)}`);
  }

  const expectedSha512 = parseScalar(yaml, 'sha512');
  const actualSha512 = crypto.createHash('sha512').update(fs.readFileSync(installerPath)).digest('base64');
  if (!expectedSha512 || actualSha512 !== expectedSha512) {
    throw new Error('stable.yml SHA-512 does not match the freshly built installer; nothing was uploaded.');
  }
  const expectedSize = Number(parseScalar(yaml, 'size'));
  if (Number.isFinite(expectedSize) && expectedSize > 0 && fs.statSync(installerPath).size !== expectedSize) {
    throw new Error('stable.yml size does not match the freshly built installer; nothing was uploaded.');
  }

  return { stableYml, installerPath, blockmapPath, expectedName };
}

function ensureReleaseExists() {
  const viewed = spawnSync('gh', ['release', 'view', tag, '--json', 'tagName,assets'], {
    cwd: root, encoding: 'utf8', shell: false,
  });
  if (!viewed.error && viewed.status === 0) {
    const release = JSON.parse(viewed.stdout);
    console.log(`[release] Found GitHub release ${tag} with ${(release.assets || []).length} existing asset(s).`);
    return;
  }

  // A tag can exist without a GitHub Release. Create an empty release first;
  // --verify-tag prevents gh from silently creating a release from another ref.
  console.log(`[release] No GitHub Release exists for ${tag}; creating it from the pushed tag.`);
  run('gh', [
    'release', 'create', tag, '--verify-tag',
    '--title', `BlackStack CRM ${version}`,
    '--notes', `BlackStack CRM ${version} Windows release.`,
  ]);
}

function uploadAndVerify(assets) {
  ensureReleaseExists();
  run('gh', [
    'release', 'upload', tag,
    assets.installerPath,
    assets.blockmapPath,
    assets.stableYml,
    '--clobber',
  ]);

  const release = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'assets'], { capture: true }));
  const uploaded = new Set((release.assets || []).map(asset => asset.name));
  for (const name of [assets.expectedName, `${assets.expectedName}.blockmap`, 'stable.yml']) {
    if (!uploaded.has(name)) throw new Error(`GitHub release ${tag} is missing uploaded asset ${name}.`);
  }
  console.log(`[release] Verified ${assets.expectedName}, ${assets.expectedName}.blockmap, and stable.yml on ${tag}.`);
}

function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this script through npm: npm run electron:release:win:fix');
  cleanPreviousArtifacts();
  buildLocally(npmCli);
  const assets = resolveManifestAndInstaller();
  uploadAndVerify(assets);
  console.log(`[release] ${tag} is ready for updater clients.`);
}

try {
  main();
} catch (error) {
  console.error(`[release] Failed: ${error.message}`);
  process.exit(1);
}
