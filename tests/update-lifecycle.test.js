/**
 * PHASE C — update lifecycle tests.
 *
 * Covers the 14 behaviours §18 of the Phase C brief asks for, to the extent each
 * is observable without a real signed update server. The honest constraint is
 * recorded rather than papered over: `autoUpdater` itself is only reachable in a
 * packaged build, so these tests drive the state machine, the policy flags and
 * the IPC surface directly, and assert the main-process source for the parts that
 * only run in a packaged app.
 *
 * Nothing here touches the production database — every case that needs one uses
 * an isolated temp path via BLACKSTACK_USER_DATA_DIR.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Vite tries to resolve a bare 'node:sqlite' import through its browser-ish
// resolver and fails; loading it through createRequire matches how the rest of
// this suite (and the app itself) reach node:sqlite.
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');

/**
 * Source with comments stripped.
 *
 * Several Phase C comments deliberately mention the OLD buggy behaviour
 * ("autoInstallOnAppQuit = true installed a pending update..."). Asserting
 * against raw source would then match the explanation instead of the code.
 */
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Point userData at a scratch dir before the modules under test capture it. */
let TMP;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-c-update-'));
  process.env.BLACKSTACK_USER_DATA_DIR = TMP;
  resetModules();
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.BLACKSTACK_USER_DATA_DIR;
});

/**
 * Fresh load of the state module.
 *
 * `vi.resetModules()` clears Vitest's ESM registry but NOT the CommonJS
 * require.cache, and updateState.js is CJS that captures `paths` at module
 * scope. Without evicting the cache entry, a test would keep reading the
 * previous test's temp directory and every assertion about persisted state
 * would silently pass or fail against the wrong file.
 */
function loadState() {
  const resolved = require.resolve('../server/services/updateState.js');
  delete require.cache[resolved];
  delete require.cache[require.resolve('../server/config/userDataPath.js')];
  return require(resolved);
}

function resetModules() {
  vi.resetModules();
  for (const k of Object.keys(require.cache)) {
    if (/updateState|userDataPath/.test(k)) delete require.cache[k];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1 — Update Available: detection produces AVAILABLE with versions
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 1 — Update Available', () => {
  it('IDLE → CHECKING → AVAILABLE carries both versions', () => {
    const U = loadState();
    expect(U.readState().status).toBe('IDLE');

    expect(U.setState('CHECKING', { currentVersion: '1.0.0' }).status).toBe('CHECKING');

    const available = U.setState('AVAILABLE', {
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      percent: null, transferred: null, total: null, bytesPerSecond: null,
    });
    expect(available.status).toBe('AVAILABLE');
    expect(available.currentVersion).toBe('1.0.0');
    expect(available.targetVersion).toBe('2.0.0');
    // An available-but-not-downloaded update must not claim progress.
    expect(available.percent).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2 — Update Now: AVAILABLE → DOWNLOADING (user-initiated, not automatic)
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 2 — Update Now starts the download', () => {
  it('the download only begins on an explicit user action', () => {
    const main = code('electron/main.js');
    // autoDownload must be OFF: detection alone must not start a download.
    expect(main).toMatch(/autoUpdater\.autoDownload\s*=\s*false/);
    // ...and the only way to start one is the guarded handler.
    expect(main).toMatch(/app:startDownload[\s\S]{0,2500}downloadUpdate\(\)/);
  });

  it('AVAILABLE → DOWNLOADING is a legal transition', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    const dl = U.setState('DOWNLOADING', { percent: 0 });
    expect(dl.status).toBe('DOWNLOADING');
    expect(U.TRANSITIONS.AVAILABLE).toContain('DOWNLOADING');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3 — Progress: real values survive to the persisted state
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 3 — Real progress is preserved', () => {
  it('carries percent, transferred, total and bytesPerSecond together', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    U.setState('DOWNLOADING', { percent: 0 });

    const progressed = U.setState('DOWNLOADING', {
      percent: 72.4,
      transferred: 75_497_472,      // 72 MiB
      total: 104_857_600,           // 100 MiB
      bytesPerSecond: 3_145_728,
    });

    expect(progressed.percent).toBeCloseTo(72.4);
    expect(progressed.transferred).toBe(75_497_472);
    expect(progressed.total).toBe(104_857_600);
    expect(progressed.bytesPerSecond).toBe(3_145_728);
    // Round-tripped through disk, so the renderer gets what the updater sent.
    expect(loadState().readState().transferred).toBe(75_497_472);
  });

  it('never invents a byte count the updater did not provide', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    U.setState('DOWNLOADING', { percent: 40 });
    const s = U.readState();
    expect(s.percent).toBe(40);
    expect(s.transferred).toBeNull();
    expect(s.total).toBeNull();
    expect(s.bytesPerSecond).toBeNull();
  });

  it('forwards the raw updater fields over IPC', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    for (const field of ['percent', 'transferred', 'total', 'bytesPerSecond']) {
      expect(main).toMatch(new RegExp(`${field}:\\s*p && typeof p\\.${field} === 'number' \\? p\\.${field} : null`));
    }
  });

  it('contains no synthetic progress timer', () => {
      const main = code('electron/main.js');
      const ui = code('public/js/pages/settings.js');
      // A fabricated progress bar needs a timer that advances percent on its own.
      // Every setInterval/setTimeout body is extracted separately and checked, because
      // main.js legitimately contains a periodic update CHECK — that timer must not
      // be confused with a progress timer, and the check must not stop at the first
      // timer in the file.
      // Two earlier attempts were wrong in opposite ways: `[^)]*` stopped at the `)`
      // inside Math.min(...) and missed a real fake timer, while an unbounded match ran
      // past the legitimate check timer and flagged a false positive.
      const timers = (src) => [
        ...src.matchAll(/set(?:Interval|Timeout)\s*\(([\s\S]{0,400}?)\)\s*;/g),
      ].map((m) => m[1]);

      for (const [name, src] of [['main.js', main], ['settings.js', ui]]) {
        for (const body of timers(src)) {
          expect(body, `${name} has a timer that writes progress: ${body.trim()}`)
            .not.toMatch(/\bpercent\b\s*(=|\+\+)/);
        }
      }

      // Belt and braces: percent must only ever come from the updater payload.
      for (const src of [main, ui]) {
        for (const line of src.split('\n')) {
          if (!/percent\s*=[^=]/.test(line)) continue;
          // Allowed: reading a reported value, or a local/render variable.
          if (/\bp\.percent\b|\bs\.percent\b|\bstate\.percent\b|\bpercent\s*=\s*\d+\s*;?\s*$|const percent|let percent/.test(line)) continue;
          expect(line, `percent assigned from a non-updater source: ${line.trim()}`).toMatch(
            /p\.percent|s\.percent|state\.percent|percent\s*=\s*\d+\s*;?\s*$/,
          );
        }
      }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 4 — Minimize: a pure renderer concern, download keeps running
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 4 — Minimize does not stop the download', () => {
  it('is implemented entirely in the renderer', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    // The minimize handler touches no IPC channel at all.
    expect(ui).toMatch(/minimize-update[\s\S]{0,120}setMinimized\(true\)/);
    // Nothing in main.js pauses, cancels or stops the updater.
    expect(main).not.toMatch(/cancelDownload|stopUpdate|pauseUpdate/);
  });

  it('exposes a way back to the progress UI', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
    expect(ui).toMatch(/id="show-update"/);
    expect(ui).toMatch(/Update downloading in the background/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 5 — App stays usable while downloading (no lockout, no restart)
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 5 — BlackStack stays usable during a download', () => {
  it('never quits or restarts the app while downloading', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const ui = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
    // quitAndInstall must be reachable ONLY from the explicit install handler.
    const quitCalls = main.match(/quitAndInstall\(/g) || [];
    expect(quitCalls).toHaveLength(1);
    const handler = main.slice(main.indexOf("ipcMain.handle('app:installUpdate'"));
    expect(handler).toContain('quitAndInstall(');
    expect(handler.slice(0, handler.indexOf('quitAndInstall('))).not.toMatch(/app\.quit\(/);
  });

  it('the download runs in the main process, not the renderer', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    // Fire-and-forget inside the IPC handler = renderer is never blocked on it.
    expect(main).toMatch(/au\.downloadUpdate\(\)\.catch/);
    expect(main).not.toMatch(/await au\.downloadUpdate/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 6 — Update Ready
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 6 — Download completes to READY', () => {
  it('DOWNLOADING → VERIFYING → READY reaches a pending update', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    U.setState('DOWNLOADING', { percent: 99 });
    expect(U.setState('VERIFYING').status).toBe('VERIFYING');
    const ready = U.setState('READY', { percent: 100, targetVersion: '2.0.0' });
    expect(ready.status).toBe('READY');
    expect(U.hasPendingUpdate()).toBe(true);
  });

  it('update-downloaded maps to READY and records the version', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    expect(main).toMatch(/autoUpdater\.on\('update-downloaded'[\s\S]{0,700}emit\('READY'/);
    expect(main).toMatch(/__pendingUpdateVersion\s*=\s*info\.version/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 7 — No automatic restart
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 7 — The app never restarts on its own', () => {
  it('nothing in the updater path calls quit or quitAndInstall', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const setup = main.slice(main.indexOf('function setupAutoUpdate'), main.indexOf("ipcMain.handle('app:getInfo'"));
    expect(setup).not.toMatch(/quitAndInstall|app\.quit\(/);
  });

  it('reaching READY does not trigger an install', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    U.setState('DOWNLOADING', { percent: 100 });
    const ready = U.setState('READY', { percent: 100, targetVersion: '2.0.0' });
    // READY is a resting state, not an action.
    expect(ready.status).toBe('READY');
    expect(U.hasPendingUpdate()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 8 — Later: app keeps running
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 8 — Later keeps BlackStack running', () => {
  it('READY → POSTPONED stays a pending, installable update', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    U.setState('DOWNLOADING', { percent: 100 });
    U.setState('READY', { percent: 100, targetVersion: '2.0.0' });

    const postponed = U.setState('POSTPONED', { postponed: true }, { force: true });
    expect(postponed.status).toBe('POSTPONED');
    expect(postponed.postponed).toBe(true);
    // Still downloadable/known — "Later" must not throw the update away.
    expect(U.hasPendingUpdate()).toBe(true);
    // And Restart & Update is still permitted from POSTPONED.
    expect(U.TRANSITIONS.POSTPONED).toContain('INSTALLING');
  });

  it('the Later handler never installs or quits', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:postponeUpdate'"));
    const body = h.slice(0, h.indexOf('return { ok: true, status:'));
    expect(body).not.toMatch(/quitAndInstall|app\.quit|installUpdate/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 9 — Later + close/reopen: no silent install, state recoverable
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 9 — Later survives close/reopen without installing', () => {
  it('autoInstallOnAppQuit is disabled', () => {
    const main = code('electron/main.js');
    expect(main).toMatch(/autoUpdater\.autoInstallOnAppQuit\s*=\s*false/);
    // and it is explicitly false, never merely absent
    expect(main).not.toMatch(/autoInstallOnAppQuit\s*=\s*true/);
  });

  it('pending state is recoverable by a fresh module load (new process)', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    U.setState('DOWNLOADING', { percent: 100 });
    U.setState('READY', { percent: 100, targetVersion: '2.0.0' });
    U.setState('POSTPONED', { postponed: true }, { force: true });

    // Simulate relaunch: clear the require cache so the module re-reads disk,
    // exactly as it would on next start.
    resetModules();
    const fresh = loadState();

    expect(fresh.readState().status).toBe('POSTPONED');
    expect(fresh.hasPendingUpdate()).toBe(true);
    expect(fresh.readState().targetVersion).toBe('2.0.0');
  });

  it('the state file lives outside the business database', () => {
    const U = loadState();
    const f = U.stateFile();
    expect(f.endsWith('update-state.json')).toBe(true);
    expect(f).not.toMatch(/blackstack-crm\.db/);
    expect(f.startsWith(TMP)).toBe(true);   // inside userData, not the repo
  });

  it('main.js restores a pending update on launch instead of re-downloading', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    expect(main).toMatch(/U\.hasPendingUpdate\(\)/);
    expect(main).toMatch(/alreadyDownloaded:\s*true/);
  });

  it('does not re-download an update that is already present', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:startDownload'"));
    const guard = h.slice(0, h.indexOf('au.downloadUpdate()'));
    expect(guard).toMatch(/STATES\.READY[\s\S]*STATES\.POSTPONED/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 9b — a re-check must not undo a pending update
//
// Found in Phase D (real packaged run): the background check 15s after launch
// re-fired 'update-available' and overwrote POSTPONED back to AVAILABLE. Since
// app:installUpdate accepts only READY or POSTPONED, "Restart & Update" then
// refused permanently for an update the user had already downloaded — a
// dead end with no user-visible explanation.
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 9b — re-detection preserves a pending update', () => {
  it('update-available skips the emit when the update is already pending', () => {
    const main = code('electron/main.js');
    const h = main.slice(main.indexOf("autoUpdater.on('update-available'"),
      main.indexOf("autoUpdater.on('update-not-available'"));
    expect(h).toMatch(/STATES\.READY/);
    expect(h).toMatch(/STATES\.POSTPONED/);
    // The guard must run BEFORE the AVAILABLE emit, or it protects nothing.
    expect(h.indexOf('stillPending')).toBeLessThan(h.indexOf("emit('AVAILABLE'"));
    expect(h).toMatch(/return;/);
  });

  it('the guard only protects the SAME version it already downloaded', () => {
    const main = code('electron/main.js');
    const h = main.slice(main.indexOf("autoUpdater.on('update-available'"),
      main.indexOf("autoUpdater.on('update-not-available'"));
    // A genuinely newer version must still be announced.
    expect(h).toMatch(/cur\.targetVersion === info\.version/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 10 — Restart & Update: the only install path
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 10 — Restart & Update is the only install trigger', () => {
  it('installUpdate runs the schema gate and a verified backup first', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:installUpdate'"));
    const body = h.slice(0, h.indexOf('quitAndInstall('));
    // Order matters: compatibility, then verified backup, then install.
    const quit = h.indexOf('quitAndInstall(');
    expect(body.indexOf('checkSchemaCompatibility')).toBeGreaterThan(-1);
    expect(body.indexOf('checkSchemaCompatibility')).toBeLessThan(body.indexOf('createBackup'));
    expect(body.indexOf('verifyBackup')).toBeGreaterThan(-1);
    expect(body.indexOf('verifyBackup')).toBeLessThan(quit);
    expect(body).toMatch(/if \(!check\.valid\)/);
  });

  it('refuses to install an update that is not downloaded', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:installUpdate'"));
    expect(h).toMatch(/st\.status !== U\.STATES\.READY && st\.status !== U\.STATES\.POSTPONED/);
    // The refusal returns before quitAndInstall is ever reached.
    const refusal = h.indexOf('st.status !== U.STATES.READY');
    const quit = h.indexOf('quitAndInstall(');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(quit);
  });

  it('the renderer exposes Restart & Update on the ready screen', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
    expect(ui).toMatch(/Restart &amp; Update/);
    expect(ui).toMatch(/installUpdate\(\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 11 — Data preservation across the update path
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 11 — Business data survives the update path', () => {
  it('backups are verified before any install', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:installUpdate'"));
    expect(h).toMatch(/createBackup\(\{ label: 'pre-update' \}\)/);
    expect(h).toMatch(/verifyBackup\(meta\.file\)/);
  });

  it('an incompatible schema blocks the update and touches nothing', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:installUpdate'"));
    const block = h.slice(h.indexOf("compat.result === 'INCOMPATIBLE'"), h.indexOf('// 2. Verified backup'));
    expect(block).toMatch(/return \{ ok: false, blocked: true/);
    // ...and no install call appears before that block.
    expect(h.indexOf('blocked: true')).toBeLessThan(h.indexOf('quitAndInstall('));
  });

  it('representative CRM/accounting/inventory/billing rows survive a backup+restore', () => {
    // Isolated DB: never the production file.
    const dbPath = path.join(TMP, 'preservation.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, balance REAL);
      CREATE TABLE journal_entries (id INTEGER PRIMARY KEY, memo TEXT, amount REAL);
      CREATE TABLE stock_items (id INTEGER PRIMARY KEY, name TEXT, qty REAL);
      CREATE TABLE invoices (id INTEGER PRIMARY KEY, contact_id INTEGER, total REAL);
    `);
    const seed = [
      ['contacts', 1, ['Asha Rao', 'asha@example.com']],
      ['accounts', 1, ['Sales Account', 1500.75]],
      ['journal_entries', 1, ['Opening balance', 1500.75]],
      ['stock_items', 1, ['Widget A', 42.5]],
      ['invoices', 1, [1, 1500.75]],
    ];
    for (const [t, id, vals] of seed) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).slice(1);
      db.prepare(`INSERT INTO ${t} (id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`)
        .run(id, ...vals);
    }

    // Copy = the backup step; reopen the copy = "after migration".
    const backupPath = path.join(TMP, 'pre-update.db');
    fs.copyFileSync(dbPath, backupPath);
    db.close();

    const restored = new DatabaseSync(backupPath, { readOnly: true });
    expect(restored.prepare('SELECT name,email FROM contacts').get()).toEqual({ name: 'Asha Rao', email: 'asha@example.com' });
    expect(restored.prepare('SELECT balance FROM accounts').get().balance).toBeCloseTo(1500.75);
    expect(restored.prepare('SELECT amount FROM journal_entries').get().amount).toBeCloseTo(1500.75);
    expect(restored.prepare('SELECT qty FROM stock_items').get().qty).toBeCloseTo(42.5);
    // Relationship intact: the invoice still points at a real contact.
    const inv = restored.prepare('SELECT contact_id, total FROM invoices').get();
    expect(inv.contact_id).toBe(1);
    expect(restored.prepare('SELECT COUNT(*) c FROM contacts WHERE id = ?').get(inv.contact_id).c).toBe(1);
    restored.close();
  });

  it('update state never writes into the business database', () => {
    const U = loadState();
    U.setState('READY', { targetVersion: '2.0.0' });
    const entries = fs.readdirSync(TMP, { recursive: true });
    expect(entries.filter((e) => String(e).endsWith('.db'))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 12 — Migration / install failure safety
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 12 — Failure paths protect data', () => {
  it('an unverifiable backup blocks the install', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:installUpdate'"));
    const check = h.indexOf('if (!check.valid)');
    const quit = h.indexOf('quitAndInstall(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(quit);
    expect(h.slice(check, quit)).toMatch(/update blocked|not been changed/i);
  });

  it('a failed download goes to ERROR, never to READY', () => {
    const U = loadState();
    U.setState('CHECKING', { currentVersion: '1.0.0' });
    U.setState('AVAILABLE', { currentVersion: '1.0.0', targetVersion: '2.0.0' });
    U.setState('DOWNLOADING', { percent: 30 });
    const err = U.setState('ERROR', { error: 'network reset' }, { force: true });
    expect(err.status).toBe('ERROR');
    // An interrupted download must not be treated as ready.
    expect(U.hasPendingUpdate()).toBe(false);
    expect(U.TRANSITIONS.ERROR).toContain('DOWNLOADING'); // retry possible
  });

  it('the download failure path keeps the app usable', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("ipcMain.handle('app:startDownload'"));
    const catchBlock = h.slice(h.indexOf('au.downloadUpdate().catch'));
    expect(catchBlock).toMatch(/setState\('ERROR'/);
    // No quit, no app-level shutdown on a download failure.
    expect(catchBlock.slice(0, 500)).not.toMatch(/quitAndInstall|app\.quit\(/);
  });

  it('RECOVERY_REQUIRED is a real state reachable from INSTALLING', () => {
    const U = loadState();
    expect(U.STATES.RECOVERY_REQUIRED).toBe('RECOVERY_REQUIRED');
    expect(U.TRANSITIONS.INSTALLING).toContain('RECOVERY_REQUIRED');
  });

  it('an illegal transition is refused rather than applied', () => {
    const U = loadState();
    U.setState('CHECKING');
    // CHECKING cannot jump straight to READY.
    expect(U.setState('READY').status).toBe('CHECKING');
  });

  it('a corrupt state file degrades to IDLE instead of crashing', () => {
    const U = loadState();
    fs.writeFileSync(U.stateFile(), '{ this is not json');
    expect(U.readState().status).toBe('IDLE');
    expect(U.hasPendingUpdate()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 13 — Single instance / port safety
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 13 — Restart safety', () => {
  it('single-instance lock is still requested', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    expect(main).toMatch(/requestSingleInstanceLock\(\)/);
    expect(main).toMatch(/second-instance/);
  });

  it('a second instance focuses the window instead of starting a server', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const h = main.slice(main.indexOf("'second-instance'"));
    const body = h.slice(0, h.indexOf('})'));
    expect(body).not.toMatch(/createServer|listen\(|app\.whenReady\(\)\.then/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Test 14 — Security is not weakened', () => {
  it('context isolation and node integration settings are unchanged', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
  });

  it('every new renderer entry point is a narrow IPC invoke', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
    const exposed = preload.slice(preload.indexOf('exposeInMainWorld'));
    for (const fn of ['getUpdateState', 'startDownload', 'postponeUpdate', 'installUpdate']) {
      expect(exposed).toMatch(new RegExp(`${fn}:\\s*\\(\\)\\s*=>\\s*ipcRenderer\\.invoke\\('app:${fn.replace('getUpdateState','getUpdateState')}'`));
    }
    // No node primitives leak into the renderer bridge.
    expect(exposed).not.toMatch(/require\(|\.exec\(|child_process/);
  });

  it('the data-safety API auth hardening from Phase B still holds', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'server/routes/dataSafety.js'), 'utf8');
    expect(routes).toMatch(/requirePermission\('settings\.manage'\)/);
    const ui = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
    expect(ui).not.toMatch(/fetch\('\/api\/datasafety/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// State machine completeness — §1
// ═══════════════════════════════════════════════════════════════════════
// PHASE D — staged-installer rehydration
//
// electron-updater records a downloaded installer only in memory
// (downloadedUpdateHelper.file) and never restores it from its on-disk pending/
// folder. After any restart, installerPath is null and install() fails with
// "No update filepath provided" even though the verified installer is on disk.
// main.js bridges that gap; these tests pin the security-relevant behaviour of
// that bridge, which is what makes "Restart & Update" work after "Later".
// ═══════════════════════════════════════════════════════════════════════
describe('Phase D — staged installer rehydration', () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'main.js'),
    'utf8',
  );
  const fnStart = mainSrc.indexOf('function rehydrateStagedInstaller()');
  const fnSrc = mainSrc.slice(fnStart, mainSrc.indexOf('\nfunction ', fnStart + 10));

  it('rehydrateStagedInstaller exists and is called on the pending-update path', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(mainSrc).toMatch(/rehydrateStagedInstaller\(\)/);
  });

  it('is invoked when a pending update is restored, so it runs after restart', () => {
    const block = mainSrc.slice(mainSrc.indexOf('if (U.hasPendingUpdate())'));
    expect(block.slice(0, 2500)).toMatch(/rehydrateStagedInstaller\(\)/);
  });

  it('verifies SHA-512 BEFORE installing the staged helper', () => {
    const hashAt = fnSrc.indexOf("createHash('sha512')");
    const rejectAt = fnSrc.indexOf('staged-installer-rejected');
    const assignAt = fnSrc.indexOf('autoUpdater.downloadedUpdateHelper =');
    expect(hashAt).toBeGreaterThan(-1);
    expect(rejectAt).toBeGreaterThan(hashAt);   // rejection decided after hashing
    expect(assignAt).toBeGreaterThan(rejectAt); // helper only replaced once trusted
  });

  it('refuses a staged installer whose digest does not match', () => {
    expect(fnSrc).toMatch(/if \(info\.sha512 && digest !== info\.sha512\)/);
    expect(fnSrc).toMatch(/FAILED sha512 verification/);
    // The rejection path must return before touching the updater.
    const rejectBlock = fnSrc.slice(
      fnSrc.indexOf('if (info.sha512 && digest !== info.sha512)'),
      fnSrc.indexOf('if (info.sha512 && digest !== info.sha512)') + 400,
    );
    expect(rejectBlock).toMatch(/return;/);
  });

  it('does not overwrite a live helper from the current session', () => {
    expect(fnSrc).toMatch(/downloadedUpdateHelper && autoUpdater\.downloadedUpdateHelper\.file/);
    expect(fnSrc).toMatch(/This session already downloaded the update/);
  });

  it('reads update-info.json from electron-updater own pending folder', () => {
    expect(fnSrc).toMatch(/path\.join\(cacheDir, 'pending'\)/);
    expect(fnSrc).toMatch(/update-info\.json/);
    // Never invent a private staging location; use the updater own resolution.
    expect(fnSrc).toMatch(/autoUpdater\.app\.baseCachePath/);
  });

  it('honours updaterCacheDirName, not just app.name', () => {
    // Regression: electron-builder writes updaterCacheDirName into app-update.yml
    // (here "blackstack-crm-v2-updater"), so resolving with app.name alone gave
    // "...\\blackstack-crm-v2\\pending" while the real folder was
    // "...\\blackstack-crm-v2-updater\\pending". Rehydration then found nothing and
    // install failed with "No update filepath provided".
    expect(fnSrc).toMatch(/updaterCacheDirName/);
    expect(fnSrc).toMatch(/dirName \|\| autoUpdater\.app\.name/);
    expect(mainSrc).toMatch(/function yamlUpdaterCacheDirName\(/);
  });

  it('parses updaterCacheDirName from the real packaged app-update.yml', () => {
    const ymlPath = path.join(__dirname, '..', 'dist-phase-d', 'v1', 'win-unpacked', 'resources', 'app-update.yml');
    if (!fs.existsSync(ymlPath)) {
      // Package not built in this environment; the source-level assertions above
      // still hold, but do not pretend the parse was exercised.
      return;
    }
    const yml = fs.readFileSync(ymlPath, 'utf8');
    const m = /^[ \t]*updaterCacheDirName[ \t]*:[ \t]*['"]?([^'"\r\n#]+)['"]?[ \t]*$/m.exec(yml);
    expect(m).not.toBeNull();
    expect(m[1].trim()).toBe('blackstack-crm-v2-updater');
  });

  it('supplies the three fields BaseUpdater.install() reads', () => {
    // installerPath getter -> .file; doInstall -> .packageFile; isAdminRightsRequired
    expect(fnSrc).toMatch(/get file\(\)/);
    expect(fnSrc).toMatch(/get packageFile\(\)/);
    expect(fnSrc).toMatch(/isAdminRightsRequired/);
  });

  it('still refuses to install from a state that is not READY/POSTPONED', () => {
    const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('app:installUpdate'"));
    expect(handler).toMatch(/st\.status !== U\.STATES\.READY && st\.status !== U\.STATES\.POSTPONED/);
  });

  it('keeps autoInstallOnAppQuit false, so Later never silently installs', () => {
    expect(mainSrc).toMatch(/autoUpdater\.autoInstallOnAppQuit = false/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('State machine integrity', () => {
  it('every state has at least one defined transition', () => {
    const U = loadState();
    for (const s of Object.values(U.STATES)) {
      if (s === 'UPDATED') continue; // terminal-success; app is restarting
      expect(Array.isArray(U.TRANSITIONS[s]), `no transitions defined for ${s}`).toBe(true);
    }
  });

  it('every target state actually exists', () => {
    const U = loadState();
    const valid = new Set(Object.values(U.STATES));
    for (const [from, targets] of Object.entries(U.TRANSITIONS)) {
      for (const t of targets) {
        expect(valid.has(t), `${from} -> ${t} targets a state that does not exist`).toBe(true);
      }
    }
  });

  it('exposes no state the updater cannot actually reach', () => {
    const U = loadState();
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    // Every state the UI renders is emitted by real main-process code.
    for (const emitted of ['CHECKING', 'AVAILABLE', 'DOWNLOADING', 'READY', 'POSTPONED', 'INSTALLING', 'ERROR', 'OFFLINE', 'UP_TO_DATE']) {
      expect(main).toMatch(new RegExp(`emit\\('${emitted}'|'${emitted}',`));
    }
  });

  it('the renderer handles every state the machine can reach', () => {
    const U = loadState();
    const ui = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
    const rendered = [...ui.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]);
    for (const s of ['CHECKING', 'AVAILABLE', 'DOWNLOADING', 'READY', 'POSTPONED', 'INSTALLING', 'OFFLINE', 'ERROR']) {
      expect(rendered, `renderer has no case for ${s}`).toContain(s);
    }
  });
});
