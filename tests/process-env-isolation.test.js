/**
 * Guard: no test may replace `process.env` wholesale.
 *
 * Assigning a plain object to `process.env` is a genuine hazard on Windows, not
 * a style preference. Node's real `process.env` is a case-insensitive proxy over
 * the OS environment. Once replaced with an ordinary object:
 *
 *   - every differently-cased lookup silently returns undefined for the rest of
 *     the worker — `PATH` vs `Path`, `TEMP` vs `Temp`, `APPDATA`;
 *   - a suite that later restores its own teardown cannot repair it, because the
 *     damage is to process.env's identity, not its contents.
 *
 * Demonstrated directly before this guard existed:
 *
 *   process.env.PathLikeProbe = 'x';
 *   process.env.PATHLIKEPROBE        // 'x'      (native, case-insensitive)
 *   process.env = { ...process.env };
 *   process.env.PathLikeProbe2 = 'y';
 *   process.env.PATHLIKEPROBE2       // undefined (plain object)
 *
 * Two suites did exactly this (`phase2-data-hardening`, `phase3-update-enterprise`)
 * and each was also clobbering variables it never touched. The correct pattern is
 * to snapshot only the keys a suite writes and restore those:
 *
 *   const previous = process.env.DB_PATH;
 *   ...
 *   if (previous === undefined) delete process.env.DB_PATH;
 *   else process.env.DB_PATH = previous;
 *
 * This test enforces the rule so the pattern cannot be reintroduced.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['tests', 'scripts'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts']);

/** Matches `process.env = ...` but NOT `process.env.FOO = ...`. */
const WHOLESALE_ASSIGN = /process\.env\s*=(?!=)/;

/**
 * Strip comments and string literals so a documented "don't do this" example in
 * a comment (which these suites deliberately include to explain the rule) is not
 * reported as a violation.
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && src.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_EXT.has(path.extname(entry.name))) yield full;
  }
}

describe('test-infrastructure hygiene: process.env must not be replaced wholesale', () => {
  const violations = [];

  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const raw = fs.readFileSync(file, 'utf8');
      const code = stripCommentsAndStrings(raw);
      code.split('\n').forEach((line, idx) => {
        if (WHOLESALE_ASSIGN.test(line)) {
          violations.push({
            file: path.relative(ROOT, file),
            line: idx + 1,
            text: raw.split('\n')[idx].trim().slice(0, 120),
          });
        }
      });
    }
  }

  it('finds no wholesale process.env assignment', () => {
    expect(
      violations,
      `process.env must not be assigned a plain object.\n`
      + 'On Windows that destroys its case-insensitive proxy, breaking PATH/TEMP/APPDATA\n'
      + 'lookups for every later test in the worker. Snapshot and restore only the keys\n'
      + 'the suite writes.\n'
      + violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n'),
    ).toEqual([]);
  });

  it('scanned a non-trivial number of files (the scan itself works)', () => {
    // Guards against the scanner silently matching nothing because of a bad
    // path, which would make the test above vacuous.
    let count = 0;
    for (const dir of SCAN_DIRS) {
      const abs = path.join(ROOT, dir);
      if (fs.existsSync(abs)) count += [...walk(abs)].length;
    }
    expect(count).toBeGreaterThan(10);
  });

  it('detects the pattern when it is present (self-check)', () => {
    // Proves the regex is capable of catching a real violation, so a future
    // refactor of the matcher cannot make this guard silently inert.
    const bad = 'process.env = { ...process.env };';
    expect(WHOLESALE_ASSIGN.test(bad)).toBe(true);
    // And does NOT flag the sanctioned per-key form.
    expect(WHOLESALE_ASSIGN.test('process.env.DB_PATH = prev;')).toBe(false);
    expect(WHOLESALE_ASSIGN.test('delete process.env.DB_PATH;')).toBe(false);
  });
});