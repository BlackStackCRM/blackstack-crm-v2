#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const tag = `v${version}`;
const stableYml = path.join(root, 'dist', 'stable.yml');
const latestYml = path.join(root, 'dist', 'latest.yml');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this script through npm: npm run electron:release:win:fix');

  const hasSigningCredentials = Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
  if (hasSigningCredentials) {
    // Use the strict production path when both signing credentials are present.
    run(process.execPath, [npmCli, 'run', 'electron:release:win']);
  } else {
    // Explicitly authorized unsigned release fallback for environments without
    // a configured certificate. Pass argv directly so PowerShell cannot parse
    // the electron-builder config flag as a path or expression.
    console.warn('[release] CSC_LINK / CSC_KEY_PASSWORD not set; building an UNSIGNED release as requested.');
    run(process.execPath, [
      npmCli, 'exec', '--', 'electron-builder', '--win', 'nsis', '--publish', 'always',
      '-c.win.forceCodeSigning=false',
    ]);
  }

  // electron-builder normally writes stable.yml because the publish channel is
  // stable. If it emitted its default latest.yml instead, the metadata contents
  // are equivalent for this channel; create the expected updater filename.
  if (!fs.existsSync(stableYml) && fs.existsSync(latestYml)) {
    fs.copyFileSync(latestYml, stableYml);
    console.warn('[release] stable.yml was absent; copied latest.yml to stable.yml for the configured stable channel.');
  }
  if (!fs.existsSync(stableYml) || fs.statSync(stableYml).size === 0) {
    throw new Error(`Expected a non-empty update manifest at ${path.relative(root, stableYml)}; release upload aborted.`);
  }

  console.log(`[release] Ensuring ${path.relative(root, stableYml)} is attached to ${tag}...`);
  run('gh', ['release', 'upload', tag, stableYml, '--clobber']);
  console.log(`[release] ${tag} now has the stable update manifest.`);
}

try {
  main();
} catch (error) {
  console.error(`[release] Failed: ${error.message}`);
  process.exit(1);
}
