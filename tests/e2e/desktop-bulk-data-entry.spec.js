/**
 * BlackStack CRM — Electron Desktop bulk dummy-data entry (QA automation).
 *
 * Launches the PACKAGED Electron app via _electron.launch(), logs in as admin,
 * and enters 10 dummy records into every requested module THROUGH THE UI,
 * at human speed (slowMo + typed keystrokes + fixed waits), taking a list-view
 * screenshot after each module completes.
 *
 * Run:
 *   npx playwright test tests/e2e/desktop-bulk-data-entry.spec.js --headed --workers=1
 * Dev-mode (launch electron from source instead of the built exe):
 *   set E2E_ELECTRON_DEV=1 && npx playwright test tests/e2e/desktop-bulk-data-entry.spec.js --headed --workers=1
 */

const { test, _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXE_PATH = path.resolve(__dirname, '../../dist/win-unpacked/BlackStack CRM.exe');
// Fresh/temporary Electron userData so a remembered session can't bypass the
// login screen (Task 1). Wiped before every launch.
const USER_DATA_DIR = path.join(os.tmpdir(), 'blackstack-crm-qa-userdata');
const ADMIN_EMAIL = process.env.E2E_EMAIL || 'admin@blackstack.local';
const ADMIN_PASSWORD = process.env.E2E_PASSWORD || 'admin123';
const RECORDS = 10;
const SHOT_DIR = path.resolve(__dirname, '../screenshots');
const HUMAN = 1500; // fixed pause after clicks/saves — the user wants to watch

test.setTimeout(90 * 60 * 1000); // 90 min — 13 modules × 10 records at human speed

/* ─────────────────────────── data generators ─────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const firstName = (i) => `TestFirst${i}`;
const lastName = (i) => `TestLast${i}`;
const contactName = (i) => `${firstName(i)} ${lastName(i)}`;
const contactEmail = (i) => `testcontact${i}@example.com`;
const orgName = (i) => `Test Org ${i}`;
const orgEmail = (i) => `testorg${i}@example.com`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Random date within the CURRENT month, but always ON or AFTER today —
 * bill validation rejects "Due date cannot be before invoice date", and the
 * invoice date defaults to today, so a due date earlier in the month fails.
 * If the month is nearly over, clamp to today.
 */
function randomDueDateFromToday() {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = lastDay - now.getDate();
  // Between today and end-of-month (inclusive). Falls back to today when the
  // month has only one day left.
  const offset = daysLeft > 0 ? Math.floor(Math.random() * (daysLeft + 1)) : 0;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Alias kept for existing call sites (deals/tasks accept any month date). */
const randomDateThisMonth = randomDueDateFromToday;

/* ─────────────────────────── UI helper functions ─────────────────────── */

/** Open the SPA hash route and wait until the page has actually rendered. */
async function gotoRoute(page, route) {
  await page.evaluate((r) => { window.location.hash = r; }, route);
  await page.waitForTimeout(800); // SPA route swap + fetches
  await page.waitForFunction(
    () => {
      const el = document.getElementById('page-container');
      return el && !el.textContent.includes('Loading...');
    },
    undefined,
    { timeout: 20000 },
  ).catch(() => { });
  await page.waitForTimeout(HUMAN);
}

/** Wait for any toast, then report the text of the LAST one shown. */
async function lastToast(page) {
  await page.waitForTimeout(400);
  return page.locator('#toast-container [role="alert"]').last().innerText().catch(() => '');
}

/** True if the last toast is an ERROR toast (red styling). */
async function lastToastIsError(page) {
  const toast = page.locator('#toast-container [role="alert"]').last();
  if (!(await toast.count())) return false;
  const cls = (await toast.getAttribute('class')) || '';
  return cls.includes('bg-red-50') || cls.includes('text-red-800');
}

/** Close any open modal so the next record starts clean. */
async function closeAnyModal(page) {
  for (let i = 0; i < 3; i++) {
    const btn = page.locator('[data-modal-close]:visible').first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(600); }
    else break;
  }
}

/**
 * Guardrail: pick the first selectable (non-empty) option in a <select>.
 * Returns '' when there is nothing to pick.
 */
async function pickFirstOption(selectLocator) {
  const value = await selectLocator.evaluate((sel) => {
    const opt = Array.from(sel.options).find((o) => o.value && !o.disabled);
    return opt ? opt.value : '';
  });
  if (value) await selectLocator.selectOption(value);
  return value;
}

/**
 * EntitySelector (custom autocomplete widget): type a term, WAIT for the async
 * search (250 ms debounce + network round-trip) to actually populate the
 * dropdown, then click the first dropdown list item (not the input).
 *
 * Polls for up to `timeoutMs` for .es-option rows to appear; falls back to a
 * broader term ('Test') once if the specific term matches nothing.
 */
async function fillEntitySelector(page, containerSel, term = 'Test') {
  const container = page.locator(containerSel).first();
  const input = container.locator('.es-input').first();

  const tryTerm = async (t, timeoutMs) => {
    await input.click();
    await input.fill('');
    await input.pressSequentially(t, { delay: 100 });
    // Poll instead of a fixed sleep: resolves as soon as options render.
    try {
      await container.locator('.es-option').first()
        .waitFor({ state: 'visible', timeout: timeoutMs });
      await page.waitForTimeout(300); // let remaining rows render
      return true;
    } catch {
      return false;
    }
  };

  // Attempt 1: specific term (250ms debounce + search ≈ up to 5s of polling)
  if (await tryTerm(term, 5000)) {
    await container.locator('.es-option').first().click();
    await page.waitForTimeout(500);
    return true;
  }
  // Attempt 2 (guardrail): broaden to 'Test' so anything just created matches
  if (term !== 'Test' && (await tryTerm('Test', 5000))) {
    await container.locator('.es-option').first().click();
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

/** Fill a form input by name with human typing speed. */
async function typeField(page, sel, value) {
  const field = page.locator(sel).first();
  await field.click();
  await field.fill('');
  await field.pressSequentially(String(value), { delay: 100 });
}

/**
 * Set a DATE input correctly.
 *
 * Chrome renders <input type="date"> as three segmented spinners (MM / DD / YYYY
 * in en-US locale). pressSequentially('2026-11-14') types those literal
 * characters into whatever segment has focus — the "11" lands in the Month
 * spinner, "26" spills into the Year spinner, and the day digits get dropped
 * or wrapped — producing garbage like year=2026→"12/26/2022".
 *
 * fill() is locale-independent: it takes the ISO value directly and Chrome
 * maps it to the correct segments. Use fill() (no typing) for every date.
 */
async function setDateField(page, sel, isoDate) {
  await page.locator(sel).first().fill(String(isoDate));
  await page.waitForTimeout(200);
}

/**
 * Wait until every modal overlay is gone. Modal.js elements are
 * [role="dialog"] inside #modal-root, and close() REMOVE()s the element
 * (plus adds .hidden to #modal-root when empty). Both signals are checked.
 */
async function waitModalsGone(page, timeout = 8000) {
  await page.locator('#modal-root [role="dialog"]').last()
    .waitFor({ state: 'detached', timeout }).catch(() => {});
  await page.evaluate(() => {
    const root = document.getElementById('modal-root');
    return !root || root.classList.contains('hidden') || root.querySelectorAll('[role="dialog"]').length === 0;
  }).catch(() => true);
  await page.waitForTimeout(300);
}

/**
 * Click an "open form" button that can be covered by a lingering modal.
 * Journal's form modal stays OPEN on a failed save (Toast.error but no
 * modal.close()), so before clicking we force-close any survivor.
 */
async function clickNewButton(page, sel) {
  // Close any lingering dialog first (e.g. a form left open by a failed save).
  const leftover = page.locator('#modal-root [role="dialog"] [data-modal-close]');
  while (await leftover.count()) {
    await leftover.first().click().catch(() => {});
    await waitModalsGone(page, 4000);
  }
  // Now the button is unobstructed — wait until visible then click.
  await page.locator(sel).first().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator(sel).first().click();
}

/** Screenshot the current (list) view. */
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });
  console.log(`    📸 screenshot saved: ${name}`);
}

/**
 * Standard record loop wrapper: opens the form, fills, saves, verifies via
 * toast, recovers on validation error (guardrail), retries once with a
 * slightly different value, then continues.
 */
async function enterRecord(page, name, openAndFill) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await openAndFill(attempt);
      await page.waitForTimeout(HUMAN);
      if (await lastToastIsError(page)) {
        const msg = await lastToast(page);
        throw new Error(msg.replace(/\n/g, ' ').slice(0, 160));
      }
      await page.waitForTimeout(HUMAN);
      console.log(`    ✔ ${name}`);
      return true;
    } catch (err) {
      console.log(`    ✖ ${name} (attempt ${attempt}): ${String(err.message || err).slice(0, 180)}`);
      await closeAnyModal(page);
      await page.waitForTimeout(500);
    }
  }
  console.log(`    ⏭ skipped: ${name} (guardrail — script continues)`);
  return false;
}

/* ─────────────────────────── module implementations ──────────────────── */

async function moduleContacts(page) {
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Contact ${i}`, async (attempt) => {
      await page.locator('#contact-new').click();
      await page.waitForSelector('#contact-form', { timeout: 10000 });
      await typeField(page, '#contact-form input[name="firstName"]', attempt === 1 ? firstName(i) : `${firstName(i)}B`);
      await typeField(page, '#contact-form input[name="lastName"]', lastName(i));
      await typeField(page, '#contact-form input[name="email"]', attempt === 1 ? contactEmail(i) : `testcontact${i}b@example.com`);
      await typeField(page, '#contact-form input[name="phone"]', `98765432${pad(i)}`);
      await page.locator('#contact-form button[type="submit"]').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-contacts-10.png');
}

async function moduleOrganizations(page) {
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Organization ${i}`, async (attempt) => {
      await page.locator('#org-new').click();
      await page.waitForSelector('#org-form', { timeout: 10000 });
      await typeField(page, '#org-form input[name="name"]', attempt === 1 ? orgName(i) : `${orgName(i)} B`);
      await typeField(page, '#org-form input[name="industry"]', `Industry ${i}`);
      await typeField(page, '#org-form input[name="website"]', `https://testorg${i}.example.com`);
      await page.locator('#org-form button[type="submit"]').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-organizations-10.png');
}

async function moduleLeads(page) {
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Lead ${i}`, async () => {
      await page.locator('#lead-new').click();
      await page.waitForSelector('#lead-form', { timeout: 10000 });
      const ok = await fillEntitySelector(page, '#lead-contact-selector', firstName(i));
      if (!ok) throw new Error('no contact selectable in lead form');
      await page.locator('#lead-form select[name="source"]').selectOption('website');
      await page.locator('#lead-form select[name="leadStatus"]').selectOption('NEW');
      await typeField(page, '#lead-form input[name="leadScore"]', String(50 + i));
      await typeField(page, '#lead-form input[name="budget"]', String(1000 * i));
      await page.locator('#lead-form button[type="submit"]').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-leads-10.png');
}

async function moduleDeals(page) {
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Deal ${i}`, async () => {
      await page.locator('#deal-new').click();
      await page.waitForSelector('#deal-form', { timeout: 10000 });
      const ok = await fillEntitySelector(page, '#deal-contact-selector', firstName(i));
      if (!ok) throw new Error('no contact selectable in deal form');
      await typeField(page, '#deal-form input[name="title"]', `Test Deal ${i}`);
      await typeField(page, '#deal-form input[name="value"]', String(5000 * i));
      await typeField(page, '#deal-form input[name="probability"]', String(10 + i * 5));
      const stage = await pickFirstOption(page.locator('#deal-stage-select'));
      if (!stage) throw new Error('no deal stage available');
      await setDateField(page, '#deal-form input[name="expectedCloseDate"]', randomDateThisMonth());
      await page.locator('#deal-form button[type="submit"]').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-deals-10.png');
}

async function moduleTasks(page) {
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Task ${i}`, async () => {
      await page.locator('#task-new').click();
      await page.waitForSelector('#task-form', { timeout: 10000 });
      const ok = await fillEntitySelector(page, '#task-contact-selector', firstName(i));
      if (!ok) throw new Error('no contact selectable in task form');
      await typeField(page, '#task-form input[name="title"]', `Test Task ${i}`);
      await typeField(page, '#task-form textarea[name="description"]', `Automated dummy task number ${i}`);
      await page.locator('#task-form select[name="priority"]').selectOption(['low', 'medium', 'high'][i % 3]);
      await setDateField(page, '#task-form input[name="dueDate"]', randomDateThisMonth());
      await page.locator('#task-form button[type="submit"]').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-tasks-10.png');
}

async function moduleAppointments(page) {
  const now = new Date();
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Appointment ${i}`, async () => {
      await page.locator('#apt-new').click();
      await page.waitForSelector('#apt-form', { timeout: 10000 });
      const ok = await fillEntitySelector(page, '#apt-contact-selector', firstName(i));
      if (!ok) throw new Error('no contact selectable in appointment form');
      await typeField(page, '#apt-form input[name="title"]', `Test Appointment ${i}`);
      const day = randomDateThisMonth();
      await typeField(page, '#apt-form input[name="start_time"]', `${day}T${pad(9 + (i % 8))}:00`);
      await typeField(page, '#apt-form input[name="end_time"]', `${day}T${pad(10 + (i % 8))}:00`);
      await typeField(page, '#apt-form input[name="location"]', `Meeting Room ${i}`);
      await page.locator('#apt-form button[type="submit"]').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-appointments-10.png');
}

/** Action Center is a read-only AI page — no create form exists (guardrail). */
async function moduleActionCenter(page) {
  await gotoRoute(page, 'action-center');
  await page.waitForTimeout(HUMAN);
  console.log('    ℹ Action Center is read-only (no Add/Create button) — recording view only.');
  await screenshot(page, 'screenshot-action-center.png');
}

async function moduleCustomerBills(page) {
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Customer Bill ${i}`, async (attempt) => {
      await page.evaluate(() => { window.location.hash = '#customer-bills'; });
      await page.waitForTimeout(1200);
      await page.locator('#cb-new').click(); // → #customer-bills/new full-page workspace
      await page.waitForSelector('#cb-create-form', { timeout: 15000 });
      await page.waitForTimeout(1000);

      const ok = await fillEntitySelector(page, '#cb-customer-selector', firstName(i));
      if (!ok) throw new Error('no customer selectable');
      await page.waitForTimeout(500);

      await setDateField(page, '#cb-bill-date', today());
      await setDateField(page, '#cb-due-date', randomDueDateFromToday());
      await typeField(page, '#cb-reference-number', `QA-REF-${i}${attempt === 2 ? 'B' : ''}`);

      // Line item: description + qty + rate (validation needs qty > 0)
      await typeField(page, '#cb-items-body input[data-field="description"]', `Dummy bill line ${i}`);
      await typeField(page, '#cb-items-body input[data-field="quantity"]', String(1 + (i % 3)));
      await typeField(page, '#cb-items-body input[data-field="unit_price"]', String(100 * i));
      // Tax Master: pick the FIRST option the UI actually loaded instead of
      // trusting the hardcoded default ('tax_gst_5_intra' may be absent).
      const taxSel = page.locator('#cb-items-body select[data-field="tax_master_id"]').first();
      if (await taxSel.count()) {
        const tax = await taxSel.evaluate((sel) => {
          const opt = Array.from(sel.options).find((o) => o.value && !o.disabled);
          return opt ? opt.value : '';
        });
        if (tax) await taxSel.selectOption(tax);
        else throw new Error('no tax masters loaded (is migration 040 seeded?)');
      }
      await page.waitForTimeout(600);

      await page.locator('#cb-btn-save-draft').click();
      await page.waitForTimeout(HUMAN);
      // Successful save navigates back to #customer-bills; if we are still on
      // the create page an error toast will have appeared.
      const stillOnCreate = await page.locator('#cb-create-form').count();
      if (stillOnCreate && (await lastToastIsError(page))) {
        throw new Error((await lastToast(page)).replace(/\n/g, ' ').slice(0, 160));
      }
    });
  }
  await gotoRoute(page, 'customer-bills');
  await screenshot(page, 'screenshot-customer-bills-10.png');
}

async function moduleChartOfAccounts(page) {
  await gotoRoute(page, 'accounting/chart-of-accounts');
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Chart of Account ${i}`, async () => {
      await page.locator('#coa-add-btn').click();
      await page.waitForTimeout(800);
      await page.locator('[data-act="create-ledger"]').click(); // modal choice: ledger account
      await page.waitForSelector('#coa-form', { timeout: 10000 });
      await page.waitForTimeout(800); // code auto-gen + type list load

      await typeField(page, '#coa-form input[name="name"]', `Test Ledger Account ${i}`);

      // The Account Group dropdown is filtered BY the selected Account Type.
      // Cycle through types until one has groups (source DB may only seed
      // certain types); groups load asynchronously after the change event.
      const typeSelect = page.locator('#coa-type-select');
      const groupSelect = page.locator('#coa-group-select');
      const typeValues = await typeSelect.evaluate((sel) =>
        Array.from(sel.options).map((o) => o.value).filter((v) => v && v !== '__create_new__'));
      if (!typeValues.length) throw new Error('no account types in dropdown');

      let group = '';
      for (const tv of typeValues) {
        await typeSelect.selectOption(tv);
        // Wait for the async groups fetch triggered by the type change.
        try {
          await groupSelect.locator('option[value=""]:disabled, option[disabled]').first()
            .waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(800);
          group = await groupSelect.evaluate((sel) => {
            const opt = Array.from(sel.options).find((o) => o.value && !o.disabled);
            return opt ? opt.value : '';
          });
          if (group) { await groupSelect.selectOption(group); break; }
        } catch { /* try next type */ }
      }
      if (!group) throw new Error('no account group available for ANY type (is Chart of Accounts seeded?)');

      await page.locator('#coa-form button[type="submit"]').click();
    });
  }
  await screenshot(page, 'screenshot-chart-of-accounts-10.png');
}

async function moduleJournal(page) {
  await gotoRoute(page, 'accounting/journal');
  const todayStr = today(); // server rejects dates outside the selected FY,
  // so pin entry_date to today AND pick the FY that actually contains it.
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Journal Entry ${i}`, async (attempt) => {
      await clickNewButton(page, '#jnl-new');
      await page.waitForSelector('#jnl-form', { timeout: 10000 });
      await page.waitForTimeout(1000); // financial years + accounts load

      // Pick the FY that CONTAINS today (the first option may be an old FY,
      // which triggers "Transaction date must fall within the selected FY").
      const fySel = page.locator('#jnl-form select[name="financial_year_id"]');
      const fy = await fySel.evaluate((sel) => {
        const d = new Date().toISOString().split('T')[0];
        const opts = Array.from(sel.options).filter((o) => o.value);
        // data attributes aren't set; try text like "FY 2026" first, else any
        const byYear = opts.find((o) => o.textContent.includes(String(new Date().getFullYear())));
        return (byYear || opts[opts.length - 1] || {}).value || '';
      });
      if (!fy) throw new Error('no financial year available');
      await fySel.selectOption(fy);
      await setDateField(page, '#jnl-form input[name="entry_date"]', todayStr);
      await typeField(page, '#jnl-form input[name="description"]', `Test Journal Entry ${i}`);
      // entry_number has a UNIQUE(company_id, entry_number) constraint —
      // a static `QA-JNL-1` collides with rows from previous runs and with
      // this run's own retry (400 "UNIQUE constraint failed"). Timestamp-
      // scoped reference keeps every attempt unique.
      await typeField(page, '#jnl-form input[name="reference_number"]', `QA-JNL-${Date.now().toString(36)}-${i}${attempt === 2 ? 'b' : ''}`);

      // Two DISTINCT accounts — the server rejects duplicate account entries.
      // Also EXPLICITLY ZERO the opposite field on each line: a stale value in
      // the untouched debit/credit input would put BOTH amounts on one line,
      // which the server rejects ("Cannot have both Debit and Credit on the
      // same line").
      const line1Account = page.locator('#jnl-lines-body select[data-k="account_id"]').first();
      const acc1 = await pickFirstOption(line1Account);
      if (!acc1) throw new Error('no GL accounts available');
      // Line 1: Debit ONLY — clear the credit side first.
      await page.locator('#jnl-lines-body input[data-k="credit_amount"] >> nth=0').fill('');
      await typeField(page, '#jnl-lines-body input[data-k="debit_amount"] >> nth=0', '100');

      await page.locator('#jnl-add-line').click();
      await page.waitForTimeout(700);
      const accounts = page.locator('#jnl-lines-body select[data-k="account_id"]');
      // Explicitly pick a DIFFERENT account on line 2 — duplicate accounts are
      // rejected. CRITICAL: compute the target in the DOM, but apply it with
      // Playwright's selectOption, which fires the native `change` event the
      // form listens to (journal.js:466-470 updates journalLines[idx].account_id
      // ONLY from the change event — a bare sel.value assignment leaves the
      // app state thinking line 2 has no account → 400 "Line 2: Account is
      // required").
      const targetValue = await accounts.nth(1).evaluate((sel, first) => {
        const opts = Array.from(sel.options).filter((o) => o.value && o.value !== first);
        return opts.length ? opts[0].value : '';
      }, acc1);
      if (!targetValue) throw new Error('no second GL account available (need 2 distinct accounts)');
      await accounts.nth(1).selectOption(targetValue);
      const distinct = targetValue;
      // Line 2: Credit ONLY — clear the debit side first.
      await page.locator('#jnl-lines-body input[data-k="debit_amount"] >> nth=1').fill('');
      await typeField(page, '#jnl-lines-body input[data-k="credit_amount"] >> nth=1', '100');
      await page.waitForTimeout(600); // totals recalc → must show balanced

      // Verify the UI balance indicator before submitting.
      const dr = parseFloat(await page.locator('#jnl-total-dr').innerText().catch(() => '0').then(s => s.replace(/[^\d.]/g, ''))) || 0;
      const cr = parseFloat(await page.locator('#jnl-total-cr').innerText().catch(() => '0').then(s => s.replace(/[^\d.]/g, ''))) || 0;
      if (Math.abs(dr - cr) > 0.001) throw new Error(`unbalanced in UI: DR ${dr} != CR ${cr}`);

      await page.locator('#jnl-form button[type="submit"]').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-journal-10.png');
}

async function moduleAccountingBills(page) {
  await gotoRoute(page, 'accounting/bills');
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Accounting Bill ${i}`, async (attempt) => {
      await clickNewButton(page, '#bill-new');
      await page.waitForSelector('#bill-form', { timeout: 10000 });

      const ok = await fillEntitySelector(page, '#bill-contact-selector', firstName(i));
      if (!ok) throw new Error('no customer selectable');
      await page.waitForTimeout(400);

      await typeField(page, '#bill-form input[name="bill_number"]', `QA-BILL-${i}${attempt === 2 ? 'B' : ''}`);
      await setDateField(page, '#bill-form input[name="due_date"]', randomDateThisMonth());
      await typeField(page, '#bill-items input[data-k="description"]', `Dummy vendor bill line ${i}`);
      await typeField(page, '#bill-items input[data-k="unit_price"]', String(200 * i));
      await page.waitForTimeout(500);

      await page.locator('#bill-form button[type="submit"]').click();
      // TASK 3: the modal element is REMOVE()d on close — wait for the dialog
      // to detach AND #modal-root to empty before the next '#bill-new' click.
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-accounting-bills-10.png');
}

/**
 * TASK 2 SEED — the product hierarchy is Stock Group → Stock Category →
 * Brand → Model, and the Products form REQUIRES a Model with a complete
 * hierarchy. The live DB can be empty of models, so seed the whole chain
 * through the inventory masters UI first (one Brand, one Model per Brand).
 * Idempotent: reuses whatever already exists.
 */
async function seedProductHierarchy(page) {
  console.log('  [seed] Ensuring product hierarchy (Brand → Model) exists...');

  // 1. Brand (independent master) — create one if the Brand list is empty.
  await gotoRoute(page, 'inventory/brands');
  const hasBrand = await page.locator('#inv-master-new').count();
  if (!hasBrand) throw new Error('inventory/brands page did not render');
  const brandRows = await page.locator('#inv-master-table tbody tr, table tbody tr').count();
  if (brandRows === 0) {
    await enterRecord(page, '[seed] Brand', async () => {
      await page.locator('#inv-master-new').click();
      await page.waitForSelector('#inv-master-form', { timeout: 10000 });
      await typeField(page, '#inv-master-form input[name="name"]', 'QA Seed Brand');
      await page.locator('#inv-master-form button[type="submit"]').click();
    });
  }

  // 2. Model — needs brand_id; the Model page form has name + brand + category.
  await gotoRoute(page, 'inventory/models');
  const modelRows = await page.locator('#inv-master-table tbody tr, table tbody tr').count();
  if (modelRows === 0) {
    await enterRecord(page, '[seed] Model', async () => {
      await page.locator('#inv-master-new').click();
      await page.waitForSelector('#inv-master-form', { timeout: 10000 });
      await page.waitForTimeout(800); // brand dropdown loads async
      await typeField(page, '#inv-master-form input[name="name"]', 'QA Seed Model');
      // pick first brand + first stock category if the selects are present
      const brandSel = page.locator('#inv-master-form select[name="brand_id"]');
      if (await brandSel.count()) {
        const b = await pickFirstOption(brandSel);
        if (!b) throw new Error('seed: no brand selectable for model');
      }
      const catSel = page.locator('#inv-master-form select[name="stock_category_id"]');
      if (await catSel.count()) await pickFirstOption(catSel);
      await page.locator('#inv-master-form button[type="submit"]').click();
    });
  }
  console.log('  [seed] Product hierarchy seed done.');
}

async function moduleProducts(page) {
  await gotoRoute(page, 'products');
  // TASK 2: seed Brand → Model first, otherwise every product fails validation.
  await seedProductHierarchy(page);
  await gotoRoute(page, 'products');
  for (let i = 1; i <= RECORDS; i++) {
    await enterRecord(page, `Product ${i}`, async (attempt) => {
      await clickNewButton(page, '#prod-new');
      await page.waitForSelector('#prod-form', { timeout: 10000 });
      await page.waitForTimeout(1500); // brand/model dropdowns populate async

      await typeField(page, '#prod-form input[name="name"]', `Test Product ${i}`);
      await typeField(page, '#prod-form input[name="sku"]', `QA-SKU-${Date.now().toString(36)}-${i}${attempt === 2 ? 'b' : ''}`);
      const brand = await pickFirstOption(page.locator('#prod-form select[name="brand_id"]'));
      if (!brand) throw new Error('no brand available (hierarchy seed failed)');
      await page.waitForTimeout(600);
      const model = await pickFirstOption(page.locator('#prod-form select[name="model_id"]'));
      if (!model) throw new Error('no model available (hierarchy seed failed)');
      await page.waitForTimeout(900); // hierarchy resolution round-trip

      await typeField(page, '#prod-form input[name="cost"]', String(50 * i));
      await typeField(page, '#prod-form input[name="price"]', String(120 * i));

      await page.locator('#prod-submit').click();
      await waitModalsGone(page);
    });
  }
  await screenshot(page, 'screenshot-products-10.png');
}

/* ─────────────────────────────── the test ────────────────────────────── */

test('bulk dummy data entry across all modules in the Electron desktop app', async () => {
  // ── 1. Launch the Electron app (headed, slowMo, FRESH user data) ──
  const useDev = !!process.env.E2E_ELECTRON_DEV;
  // Wipe the temp profile so the app cannot restore a previous login session.
  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  const userDataArg = `--user-data-dir=${USER_DATA_DIR}`;
  console.log(`  Electron userData (fresh): ${USER_DATA_DIR}`);
  const electronApp = await _electron.launch({
    executablePath: useDev ? undefined : EXE_PATH,
    args: useDev ? ['.', userDataArg] : [userDataArg],
    slowMo: 1000,
    // Electron ignores the Chromium --user-data-dir switch for its userData
    // path (electron/main.js reads BLACKSTACK_USER_DATA_DIR instead) — pass
    // BOTH so a stale session/localStorage can never survive a run.
    env: { ...process.env, BLACKSTACK_USER_DATA_DIR: USER_DATA_DIR },
  });
  const page = await electronApp.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [app console.error] ${m.text().slice(0, 200)}`);
  });
  // Native confirm()/alert() dialogs (e.g. task bulk-delete) must be dismissed
  // automatically, otherwise one left open kills electronApp.close() with
  // "Protocol error (Page.handleJavaScriptDialog): No dialog is showing".
  page.on('dialog', (d) => d.accept().catch(() => {}));

  // TASK 2: capture the EXACT backend response for accounting POSTs — the UI
  // toast only says "Request failed"/"400", so this is the ground truth.
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/accounting/') || res.request().method() !== 'POST') return;
    if (res.status() < 400) return; // only failures
    let body = '';
    try { body = (await res.text()).slice(0, 400); } catch { body = '<unreadable>'; }
    console.log(`  🔴 ${res.request().method()} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    console.log(`     → HTTP ${res.status()} BODY: ${body}`);
  });

  // ── 2. Force a CLEAN login — never trust prior session state ──
  // (#page-container exists even on an UNauthenticated page, so its mere
  // visibility proves nothing. Instead: wipe stored credentials, navigate to
  // login.html explicitly, sign in, then wait for the shell to have CONTENT.)
  //
  // The app auto-checks its token on startup and 401-bounces to login.html —
  // that redirect DESTROYS the JS execution context mid-evaluate. Wait until
  // BOTH the load is complete AND a landing page (login OR app shell) is
  // actually rendered before touching localStorage; and wrap the clear in a
  // retry so a late redirect can't kill the run.
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('input[type="email"], input[name="email"], #page-container', { timeout: 60000 });
  await page.waitForTimeout(2000); // let the startup 401 redirect fully settle
  const origin = new URL(page.url()).origin; // http://127.0.0.1:<port>
  console.log(`  App server origin: ${origin}`);

  // Retry loop: if the context is destroyed mid-evaluate (late redirect),
  // wait for the new page to settle and try again.
  for (let i = 0; i < 3; i++) {
    try {
      await page.evaluate(() => {
        try {
          localStorage.removeItem('crm_token');
          localStorage.removeItem('crm_user');
          localStorage.removeItem('crm_profile');
          document.cookie = 'crm_token=; Path=/; Max-Age=0; SameSite=Lax';
        } catch (e) { /* storage may not be ready yet */ }
      });
      break; // success
    } catch (err) {
      if (i === 2) throw err;
      console.log(`  localStorage clear interrupted (attempt ${i + 1}): ${String(err.message || err).slice(0, 80)} — retrying`);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  await page.goto(`${origin}/login.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 90000 });
  await page.waitForTimeout(HUMAN);
  await typeField(page, 'input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await typeField(page, 'input[type="password"], input[name="password"]', ADMIN_PASSWORD);
  await page.locator('button[type="submit"], button:has-text("SIGN IN")').first().click();

  // Wait for the SPA shell AND real rendered content (guards against both an
  // empty container and a 401 bounce-back to login).
  await page.waitForFunction(
    () => {
      const el = document.getElementById('page-container');
      return el && el.textContent.trim().length > 0 && !el.textContent.includes('Loading...');
    },
    undefined,
    { timeout: 90000 },
  );
  if (page.url().includes('login.html')) {
    await page.screenshot({ path: path.join(SHOT_DIR, 'screenshot-login-bounce.png') });
    throw new Error('Login rejected — app bounced back to login.html (see screenshot-login-bounce.png). Check credentials.');
  }
  await page.waitForTimeout(HUMAN);
  console.log('✔ Logged in as admin');

  // ── 3. Populate modules ──
  // TASK 2 ordering: Contacts/Organizations FIRST (Leads/Deals/Tasks/Bills
  // reference them), Chart of Accounts BEFORE Journal (its GL-accounts
  // dropdown lists the ledger accounts the CoA step creates), and Products
  // seeds its own Brand → Model hierarchy inside moduleProducts.
  //
  // RUN ONLY FAILED MODULES: set E2E_MODULES="Customer Bills,Journal,..."
  // (comma-separated, name substrings, case-insensitive) to skip modules
  // that already passed — no need to re-run Contacts/Leads/etc. every time.
  const onlyFilter = (process.env.E2E_MODULES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const modules = [
    ['Contacts', () => gotoRoute(page, 'contacts'), moduleContacts],
    ['Organizations', () => gotoRoute(page, 'organizations'), moduleOrganizations],
    ['Leads', () => gotoRoute(page, 'leads'), moduleLeads],
    ['Deals', () => gotoRoute(page, 'deals'), moduleDeals],
    ['Tasks', () => gotoRoute(page, 'tasks'), moduleTasks],
    ['Appointments', () => gotoRoute(page, 'appointments'), moduleAppointments],
    ['Action Center', () => gotoRoute(page, 'action-center'), moduleActionCenter],
    ['Customer Bills', () => gotoRoute(page, 'customer-bills'), moduleCustomerBills],
    ['Chart of Accounts', () => { }, moduleChartOfAccounts],
    ['Journal (uses seeded GL accounts)', () => { }, moduleJournal],
    ['Accounting Bills', () => { }, moduleAccountingBills],
    ['Products', () => { }, moduleProducts],
  ].filter(([name]) =>
    !onlyFilter.length || onlyFilter.some(f => name.toLowerCase().includes(f)));

  // AUTO-SKIP: also skip modules whose data already exists in the DB from a
  // previous run, unless E2E_FORCE_ALL=1. Counts marker records created by
  // this suite so a re-run after a partial failure only exercises what failed.
  const skipAlreadyDone = process.env.E2E_FORCE_ALL !== '1';
  const existingCounts = await page.evaluate(async () => {
    const token = localStorage.getItem('crm_token');
    const get = async (url) => {
      try {
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) return -1;
        const j = await r.json();
        const d = j?.data ?? j;
        return d.total ?? d.items?.length ?? (Array.isArray(d) ? d.length : -1);
      } catch { return -1; }
    };
    return {
      contacts: await get('/api/contacts?limit=1'),
      organizations: await get('/api/organizations?limit=1'),
      leads: await get('/api/leads?limit=1'),
      deals: await get('/api/deals?limit=1'),
      tasks: await get('/api/tasks?limit=1'),
      appointments: await get('/api/appointments?limit=1'),
      'customer bills': await get('/api/customer-bills?limit=1'),
      'chart of accounts': await get('/api/accounting/accounts?limit=1'),
      journal: await get('/api/accounting/journal?limit=1'),
      'accounting bills': await get('/api/accounting/bills?limit=1'),
      products: await get('/api/products?limit=1'),
    };
  }).catch(() => ({}));
  if (skipAlreadyDone && Object.keys(existingCounts).length) {
    const before = modules.length;
    const kept = [];
    for (const m of modules) {
      const key = Object.keys(existingCounts).find(k => m[0].toLowerCase().includes(k));
      const n = key ? existingCounts[key] : -1;
      if (n > 0) console.log(`⏭ skip ${m[0]} — ${n} record(s) already exist (set E2E_FORCE_ALL=1 to re-enter)`);
      else kept.push(m);
    }
    modules.length = 0; modules.push(...kept);
    console.log(`  Module filter: ${before - modules.length} skipped, ${modules.length} to run`);
  }

  for (const [name, navigate, runner] of modules) {
    console.log(`--- Starting ${name} Entry ---`);
    try {
      await navigate();
      await runner(page);
    } catch (err) {
      console.log(`!!! Module ${name} aborted: ${String(err.message || err).slice(0, 200)}`);
      await closeAnyModal(page);
    }
    await page.waitForTimeout(HUMAN);
  }

  console.log('--- Bulk data entry complete — closing app ---');
  await waitModalsGone(page).catch(() => {});
  await page.screenshot({ path: path.join(SHOT_DIR, 'screenshot-final-dashboard.png') });
  await page.close().catch(() => {});
  await electronApp.close();
});
