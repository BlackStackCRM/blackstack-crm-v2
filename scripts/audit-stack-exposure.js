/**
 * Is the stack-trace gate actually a production risk?
 *
 * server/app.js exposes `err.stack` when `NODE_ENV === 'development'`. The
 * open question is whether a SHIPPED build can reach that state.
 *
 * server/app.js line 1 is `require('dotenv').config()`, which loads a `.env`
 * from the process working directory. The repository root `.env` contains
 * `NODE_ENV=development` and is gitignored — but gitignoring only affects VCS; it
 * does not stop electron-builder from copying a file present in the project tree
 * into the asar, unless `files` explicitly excludes it.
 *
 * So this script answers three separate questions rather than assuming:
 *   1. What NODE_ENV does the server see when the root .env is present?
 *   2. Does electron-builder's `files` allowlist include .env?
 *   3. Does a packaged layout start the server from the app directory (where a
 *      bundled .env would be found by dotenv)?
 *
 * Read-only inspection; no build is performed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

// 1. dotenv behaviour in this repo
const envPath = path.join(ROOT, '.env');
console.log('root .env present      :', fs.existsSync(envPath));
if (fs.existsSync(envPath)) {
  const devLine = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('NODE_ENV='));
  console.log('root .env NODE_ENV     :', devLine ? devLine.split('=')[1] : '(absent)');
}
const appSrc = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
console.log('app.js loads dotenv    :', /require\(['"]dotenv['"]\)\.config\(\)/.test(appSrc));

// 2. electron-builder packaging rules
console.log('\n--- build config candidates ---');
for (const rel of ['package.json', 'electron/package.json', 'electron-builder.yml', 'electron-builder.yaml']) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  const hasFiles = /"files"\s*:/.test(src) || /^files:/m.test(src);
  console.log(`${rel}: ${hasFiles ? 'HAS files allowlist' : 'no files allowlist'}`);
  if (hasFiles) {
    const m = src.match(/"files"\s*:\s*\[([\s\S]*?)\]/);
    if (m) {
      const entries = m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
      console.log('   entries:', entries.join(', '));
      console.log('   .env excluded explicitly:', entries.some((e) => e.includes('!.env') || e.includes('.env')));
    }
  }
}

// 3. Where does the packaged app start the server from?
console.log('\n--- electron server startup ---');
const mainJs = path.join(ROOT, 'electron', 'main.js');
if (fs.existsSync(mainJs)) {
  const src = fs.readFileSync(mainJs, 'utf8');
  const cwdSet = src.match(/cwd\s*:\s*([^,\n}]+)/g) || [];
  console.log('cwd assignments in electron/main.js:', cwdSet.length ? cwdSet.join(' | ') : '(none)');
  const spawnLine = src.match(/spawn\([^)]*\)|fork\([^)]*\)/g) || [];
  for (const s of spawnLine.slice(0, 3)) console.log('   ', s.replace(/\s+/g, ' ').slice(0, 110));
  console.log('electron sets NODE_ENV:', /NODE_ENV\s*=/.test(src));
}

// 4. Does the launcher force development?
const launcherEnv = path.join(ROOT, 'launcher', '.env');
if (fs.existsSync(launcherEnv)) {
  const l = fs.readFileSync(launcherEnv, 'utf8').split('\n').find((x) => x.startsWith('NODE_ENV='));
  console.log('\nlauncher/.env NODE_ENV :', l ? l.split('=')[1] : '(absent)');
}

console.log('\nConclusion: see audit report — a .env beside the server sets NODE_ENV=development,');
console.log('so stack traces are exposed whenever that file ships or is present at runtime.');