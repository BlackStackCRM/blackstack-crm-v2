/**
 * Counts production references to legacy/retired tables using the SAME detection
 * rules as tests/architecture-retired-tables.test.js, so the numbers in the
 * status report cannot drift from what CI actually enforces.
 *
 *   node scripts/legacy-table-refcount.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'backups', 'docs', 'tests', 'playwright-tests',
  'test-results', 'test-results-regression', 'test-results-e2e', 'coverage',
  'dist', 'build', '.cache', 'tmp', 'temp', 'data', 'user-data',
]);
const EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.html', '.sql']);
const DIRS = ['server', 'public', 'launcher', 'electron'];

const TABLES = [
  'inv_locations',
  'inventory_movements',
  'batch_wise_stock',
  'uoms',
  'stock_adjustment_reasons',
  'inventory_items_v2',
  '_payments_backup',
  'invoices',
  'adjustment_reasons',
  'locations',
  'stock_ledger',
];

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDED_DIRS.has(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile() && EXT.has(path.extname(e.name))) {
      acc.push(full);
    }
  }
  return acc;
}

const files = DIRS.map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d));

const counts = Object.fromEntries(TABLES.map((t) => [t, 0]));
const where = Object.fromEntries(TABLES.map((t) => [t, []]));

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // Migration history is exempt: it is the permanent record of what was applied.
  if (/server\/database\/migrations\//.test(rel) || /server\/database\/migrate\.js$/.test(rel)) continue;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return;
    for (const table of TABLES) {
      const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        '\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(?:IF\\s+EXISTS\\s+)?' + esc + '\\b',
        'i',
      );
      if (re.test(line)) {
        counts[table]++;
        where[table].push(`${rel}:${i + 1}`);
      }
    }
  });
}

console.log(`production files scanned: ${files.length}\n`);
const pad = Math.max(...TABLES.map((t) => t.length));
for (const table of TABLES) {
  const n = counts[table];
  const shown = where[table].slice(0, 3).join('  ');
  console.log(`${table.padEnd(pad)}  ${String(n).padStart(3)}  ${shown}`);
}
