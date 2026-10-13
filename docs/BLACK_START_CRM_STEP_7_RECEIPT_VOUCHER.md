# Step 7: Receipt Voucher / Money Received Transaction

## Overview

Step 7 implements the **Receipt Voucher** — the business transaction interface for recording money received by the company. It builds directly on the Step 6 Journal Entry engine, reusing the same `vouchers` table, `journal_entries` table, `journal_entry_lines` table, `accounting_audit` trail, RBAC permissions, and Financial Year validation.

## Architecture

```
Receipt Voucher (business interface)
        ↓
_step 7 Controller: createDraft, validate, post, cancel, reverse, delete
        ↓
_step 6 Journal Entry Engine (source of truth)
        ↓
journal_entries + journal_entry_lines
        ↓
Ledger → Trial Balance → P&L / Balance Sheet
        ↓
accounting_audit (audit trail)
```

## What Was Reused (Zero Duplication)

- **Journal Entry Engine** (`journal-entry.repository.js`): `createWithValidation()` — the same method used by Steps 1–6
- **Vouchers Table**: Extended with `receipt_mode` and `journal_entry_id` columns (new migration `032_receipt_voucher.sql`)
- **Journal Entry Lines**: Same `journal_entry_lines` table
- **Audit Trail**: Same `accounting_audit` table via the existing `logAudit()` helper
- **Financial Year Validation**: Same `financial_years` table with `is_locked`, `start_date`, `end_date`
- **Ledger Account Validation**: Same `getAccountDetails()` from `OpeningBalanceRepository`
- **RBAC**: Reuses `accounting.create`, `accounting.post`, `accounting.cancel` permissions
- **Document Numbering**: Reuses `getNextVoucherNumber()` with `RECEIPT` → `RC-YYYY-NNNNN` format
- **Company Isolation**: Reuses `assertTenantRefs()` and `_company()` scoping

## What Was Added

### Database Changes

**Migration `032_receipt_voucher.sql`** + bootstrap in `migrate.js`:
- `vouchers.receipt_mode` — `TEXT CHECK` for `CASH, BANK, UPI, CHEQUE, CARD, OTHER`
- `vouchers.journal_entry_id` — `TEXT REFERENCES journal_entries(id)` for voucher→JE linking
- `idx_vouchers_receipt_type` — index for receipt filtering by type and status
- Programmatic column addition in `migrate.js` for SQLite idempotency (SQLite doesn't support `ALTER TABLE ADD COLUMN IF NOT EXISTS`)

### Repository (`voucher.repository.js`)

New methods:
- **`createReceipt(data, lines)`** — Creates a receipt voucher in DRAFT status with `voucher_type = 'RECEIPT'`, stores `receipt_mode`, `contact_id`, `financial_year_id`, `total_amount`
- **`postReceipt(voucherId, companyId, userId, journalEntry)`** — Atomically links the generated JE to the voucher, sets status to `POSTED`, populates `posted_by`/`posted_at`
- **`getWithJournalEntry(id, companyId)`** — Retrieves a voucher with its associated journal entry
- Fixed `reverse()` to include `receipt_mode` and `journal_entry_id` columns

### Controller (`accounting.controller.js`)

New methods:
- **`_getNextReceiptNumber(companyId)`** — Generates `RC-YYYY-NNNNN` via existing numbering
- **`_validateReceipt(companyId, data, lines)`** — Comprehensive validation:
  - Receipt mode must be valid
  - Receipt date must belong to an active, unlocked Financial Year
  - Receiving ledger must exist, be active, allow direct posting, be DEBIT-nature (Cash/Bank/Asset)
  - Source ledger must exist, be active, allow direct posting, be CREDIT-nature (Revenue/Liability/Equity)
  - Amount must be > 0
  - Contact (party) must belong to the same company
- **`_buildReceiptLines(receivingLedgerId, sourceLedgerId, amount, narration, referenceNumber)`** — Builds the double-entry lines: Debit receiving, Credit source
- **`getReceipt(req, res)`** — `GET /api/accounting/receipts/:id` — Detail view with JE reference
- **`listReceipts(req, res)`** — `GET /api/accounting/receipts` — List with filters (status, date, party, query)
- **`createReceiptDraft(req, res)`** — `POST /api/accounting/receipts/draft` — Creates draft without JE
- **`validateReceipt(req, res)`** — `POST /api/accounting/receipts/validate` — Read-only validation with accounting preview
- **`postReceipt(req, res)`** — `POST /api/accounting/receipts` — Full atomic posting:
  1. Validates all inputs
  2. Generates voucher number
  3. Creates voucher record (DRAFT)
  4. Creates journal entry via Step 6 `createWithValidation()`
  5. Links JE to voucher and transitions to POSTED
  6. Records audit trail
- **`cancelReceipt(req, res)`** — `POST /api/accounting/receipts/:id/cancel` — Cancels posted receipt and linked JE
- **`reverseReceipt(req, res)`** — `POST /api/accounting/receipts/:id/reverse` — Creates reversal voucher
- **`deleteReceipt(req, res)`** — `DELETE /api/accounting/receipts/:id` — Only drafts can be deleted

### Routes (`routes/accounting.js`)

| Method | Path | Permission | Action |
|--------|------|-----------|--------|
| GET | `/api/accounting/receipts` | accounting.view | List receipts |
| GET | `/api/accounting/receipts/:id` | accounting.view | Get receipt detail |
| POST | `/api/accounting/receipts/draft` | accounting.create | Create draft receipt |
| POST | `/api/accounting/receipts/validate` | accounting.create | Validate receipt |
| POST | `/api/accounting/receipts` | accounting.post | Post receipt (creates JE) |
| POST | `/api/accounting/receipts/:id/cancel` | accounting.cancel | Cancel receipt |
| POST | `/api/accounting/receipts/:id/reverse` | accounting.cancel | Reverse receipt |
| DELETE | `/api/accounting/receipts/:id` | accounting.cancel | Delete draft receipt |

## Accounting Pattern

Every Receipt Voucher generates a double-entry Journal Entry through the Step 6 engine:

```text
Dr Receiving Ledger (Cash/Bank/Asset — DEBIT nature)
   Cr Source Ledger (Revenue/Liability/Equity — CREDIT nature)

Total Debit = Total Credit
```

Examples:
- **Customer Payment**: Dr Bank → Cr Accounts Receivable
- **Cash Sale**: Dr Cash → Cr Sales Revenue
- **Interest Income**: Dr Bank → Cr Interest Income
- **Capital Introduced**: Dr Bank → Cr Capital
- **Loan Received**: Dr Bank → Cr Loan Liability

## Test Results

```
── 40. Step 7: Receipt Voucher / Money Received ──
  ✅ Create Cash Receipt (post directly)
  ✅ Receipt generates a balanced Journal Entry
  ✅ Receipt JE has debit on receiving ledger, credit on source
  ✅ Ledger reflects receipt (receiving account debited)
  ✅ Trial Balance reflects receipt
  ✅ Receipt Detail view shows JE reference
  ✅ Receipt List shows posted receipts
  ✅ Validate Receipt (real-time accounting preview)
  ✅ Create Receipt as Draft
  ✅ Delete Draft Receipt
  ✅ Cannot delete Posted Receipt
  ✅ Cannot edit Posted Receipt (update)
  ✅ Cancel a Posted Receipt
  ✅ Cannot cancel already-cancelled Receipt
  ✅ Reverse a Posted Receipt
  ✅ Bank Receipt (post directly)
  ✅ Capital Receipt (balance sheet impact)
  ✅ Interest Income Receipt (P&L impact)
  ✅ Receipt audit trail exists
  ✅ Reject zero amount receipt
  ✅ Reject negative amount receipt
  ✅ Reject missing receiving account
  ✅ Reject missing source account
  ✅ Reject Group account as receiving ledger
  ✅ Reject inactive account in receipt
  ✅ Reject nature conflict (Debit-nature account as source/Credit)
  ✅ Reject invalid receipt_mode
  ✅ Reject transaction date outside Financial Year
  ✅ P&L reflects revenue receipts

Results: 195 passed, 0 failed
```

## Future Extensibility

The Receipt Voucher establishes a reusable pattern for all future transaction modules (Payment Voucher, Contra, Sales Invoice, Purchase Invoice, Credit Note, Debit Note) — each will follow the same: **Business Transaction → Validation → Journal Entry Engine → JE Lines → Ledger → Reports** pattern.
