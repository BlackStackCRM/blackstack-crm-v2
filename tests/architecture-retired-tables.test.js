/**
 * Architecture guard: production code must not reference RETIRED tables.
 *
 * WHY THIS EXISTS
 *   A previous consolidation retired several tables but left code pointing at
 *   them. `GET /api/inventory/hierarchy` silently returned ZERO locations because
 *   it still queried the emptied `inv_locations`; two accounting endpoints
 *   returned HTTP 500 because they still selected the removed
 *   `inventory_items.product_id`. Both shipped undetected because nothing checked.
 *
 *   This test is the mechanical detector for that entire bug class.
 *
 * WHAT COUNTS AS A VIOLATION
 *   A reference to a retired table that is *executed*: SQL against the table, or
 *   a string literal naming it in a position that reaches the database.
 *
 * WHAT DOES NOT COUNT
 *   * Comments and JSDoc — they explain WHY a table is gone and must survive.
 *   * Migration history (`server/database/migrations/**`, `server/database/migrate.js`)
 *     — that is the permanent record of what was applied.
 *   * Audit/test tooling under `scripts/` — its whole purpose is inspecting
 *     retired tables to prove they are retired.
 *   * The test fixtures under `tests/` and `playwright-tests/`.
 *   * Docs and reports under `docs/`.
 *
 *   Note on UI identifiers: `batch_wise_stock` is also a dashboard *card key* and
 *   a URL segment (`#/inventory/batch_wise_stock`). Those are not table
 *   references, so the detector requires SQL context rather than a bare match.
 *   `uoms` is likewise a local JS variable name in `public/js/pages/products.js`.
 *   Detecting those as violations would be a false positive that trains people to
 *   ignore the guard.
 *
 * EXIT STATUS
 *   Non-zero when any violation is found, with a full report printed.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that contain production runtime code. */
const PRODUCTION_DIRS = ['server', 'public', 'launcher', 'electron', 'renderer', 'src'];

/** Never scanned: dependencies, VCS, fixtures, artifacts, documentation. */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'backups', 'docs', 'tests', 'playwright-tests',
  'test-results', 'test-results-new', 'test-results-regression', 'test-results-e2e',
  'coverage', 'dist', 'build', '.cache', 'tmp', 'temp', 'data', 'user-data',
]);

const SCANNED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.html', '.sql']);

/**
 * Tables retired from the canonical architecture. Production code must not
 * introduce new references to any of these.
 *
 * `invoices` is deliberately ABSENT: it is still an active, if legacy, document
 * table with live route and UI references. It is audited separately in
 * docs/audits/invoices-legacy-path-audit-*.md and is not a guard violation.
 */
const RETIRED_TABLES = {
  inv_locations: 'Superseded by `locations` (consolidated in migration 081).',
  inventory_movements: 'Superseded by `stock_ledger` + `valuation_movements`.',
  batch_wise_stock: 'Superseded by `stock_balances` (dimensional) + `batches`.',
  uoms: 'Superseded by `units_of_measure`.',
  stock_adjustment_reasons: 'Superseded by `adjustment_reasons` (the FK target).',
};

/** Files under these paths are permitted to mention retired tables. */
const ALLOWED_FILE_PATTERNS = [
  /server[\\/]database[\\/]migrations[\\/]/,   // applied migration history
  /server[\\/]database[\\/]migrate\.js$/,     // programmatic migration steps
];

// ── file discovery ────────────────────────────────────────────────────────
function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

/**
 * True when the line references the table in a way that reaches the database.
 *
 * Requires SQL keyword context, or the table appearing inside a string that is
 * part of a SQL statement. This keeps UI card keys, URL segments and local
 * variable names out of the results.
 */
function looksLikeTableReference(line, table) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Direct SQL statement forms.
  const sqlForms = [
    new RegExp(`\\bFROM\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bJOIN\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bUPDATE\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bINSERT\\s+INTO\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bDELETE\\s+FROM\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bREPLACE\\s+INTO\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?${escaped}\\b`, 'i'),
    new RegExp(`\\bALTER\\s+TABLE\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${escaped}\\b`, 'i'),
  ];
  if (sqlForms.some((re) => re.test(line))) return true;

  // Executed allow-list membership. A bare quoted name is NOT enough:
  // `batch_wise_stock` is also a dashboard card key and a URL segment
  // (`#/inventory/batch_wise_stock`), and `uoms` is a local JS variable in
  // products.js. Flagging those trains people to ignore the guard.
  //
  // What IS a real reference is a name inside a table allow-list that the
  // generic master CRUD actually consults, because that list decides which
  // tables `/api/inventory/masters/:table` will query.
  const ALLOW_LIST_DECL = /(MASTER_TABLES|masterTables|ALLOWED_TABLES|allowedTables|ALLOW_LIST|allowList|softMasters|masterList)\s*=\s*\[/;
  const ALLOW_LIST_USE = /\.(includes|has)\s*\(/;
  const isQuoted = new RegExp(`['"\`]${escaped}['"\`]`, 'i').test(line);
  if (isQuoted && (ALLOW_LIST_DECL.test(line) || ALLOW_LIST_USE.test(line))) return true;

  return false;
}

function scan() {
  const violations = [];
  const files = PRODUCTION_DIRS
    .map((d) => path.join(ROOT, d))
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => walk(d));

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWED_FILE_PATTERNS.some((re) => re.test(rel))) continue;

    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const [table, note] of Object.entries(RETIRED_TABLES)) {
        if (looksLikeTableReference(line, table)) {
          violations.push({ table, file: rel, line: i + 1, text: line.trim(), note });
        }
      }
    });
  }
  return { violations, filesScanned: files.length };
}

describe('Architecture guard — retired tables must not be referenced by production code', () => {
  const { violations, filesScanned } = scan();

  it('scans the real production source tree', () => {
    // Guard against the scan silently covering nothing.
    expect(filesScanned).toBeGreaterThan(50);
  });

  it('reports no retired-table references in production code', () => {
    if (violations.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `\n  Architecture guard OK — ${filesScanned} production file(s) scanned, `
        + `0 references to ${Object.keys(RETIRED_TABLES).length} retired table(s).\n`
      );
      return;
    }

    const report = violations.map((v) => [
      '',
      '======================================================================',
      'RETIRED TABLE REFERENCE DETECTED',
      `Table:         ${v.table}`,
      `File:          ${v.file}`,
      `Line:          ${v.line}`,
      `Matched text:  ${v.text}`,
      `Why retired:   ${v.note}`,
      '======================================================================',
      '',
    ].join('\n')).join('\n');

    throw new Error(
      `\n\n${violations.length} RETIRED TABLE REFERENCE(S) DETECTED IN PRODUCTION CODE\n`
      + `${report}\n`
      + 'Production runtime code must not reintroduce a retired table. Point the\n'
      + 'reference at the canonical replacement instead, or record a justified\n'
      + 'exception in ALLOWED_FILE_PATTERNS with a comment explaining why.\n'
    );
  });

  it('keeps the retired list and the canonical replacements in agreement', async () => {
    // If a table is retired, its canonical replacement must actually exist as a
    // table — otherwise the guard would be enforcing a migration that never landed.
    const dbPath = path.join(ROOT, 'data', 'blackstack-crm.db');
    if (!fs.existsSync(dbPath)) return;   // nothing to verify in this environment
    // node:sqlite cannot go through vitest's bundler (it tries to resolve a bare
    // 'sqlite' package), and a dynamic import is intercepted too. createRequire
    // bypasses the transform entirely.
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const expected = {
        inv_locations: 'locations',
        inventory_movements: 'stock_ledger',
        batch_wise_stock: 'stock_balances',
        uoms: 'units_of_measure',
        stock_adjustment_reasons: 'adjustment_reasons',
      };
      for (const [retired, canonical] of Object.entries(expected)) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        ).get(canonical);
        expect(row, `canonical replacement '${canonical}' for '${retired}' must exist`).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });
});