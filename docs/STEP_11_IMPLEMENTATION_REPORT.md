# Step 11 Implementation Report: Credit Notes, Debit Notes & Reversals

## Executive Summary

Step 11 has been fully implemented and verified with **61/61 tests passing**. The implementation adds complete accounting-grade Credit Note, Debit Note, Sales Return, and Posted Bill Reversal workflows to Black Stack CRM V2, integrating natively with the existing accounting architecture.

## What Was Implemented

### 1. Database Migrations
- **`061_step11_credit_debit_note.sql`**: Adds `idempotency_key` column (for deduplication) and `overpayment_amount` column (tracks actual bill reduction vs CN total for correct cancel restoration) to the `vouchers` table, plus supporting indexes and a unique constraint.
- **`062_step11_permissions.sql`**: Adds 4 new permissions (`view_credit_note`, `cancel_credit_note`, `view_debit_note`, `cancel_debit_note`) and assigns them to the admin role.

### 2. Service Layer (`customer-bill.service.js`)

**`createCreditNote(data, userId)`** — Full credit note workflow:
- Supports **Full**, **Partial**, and **Line-level** credit notes (via `items` array or flat `amount`)
- 8 supported reasons: Sales Return, Overbilling, Pricing Correction, Discount Adjustment, Tax Correction, Cancellation, Customer Compensation, Other
- **Tax-preserving scaling**: Derives tax breakdown from the original bill's tax result, scales proportionally to the credit note's taxable amount
- **Idempotency key** deduplication (Prevents duplicate CN creation)
- **Bill balance + receivable updates** (direct `balance = balance - reduction` updates, capped to prevent negative outstanding)
- **Balanced JE**: Dr Sales Returns + Dr Output Tax, Cr Receivable
- Stores `overpayment_amount` = actual reduction for correct cancel restoration
- **Phase 7 handling**: If bill is already paid, excess credit note amount is tracked as overpayment (not negative receivable)

**`createDebitNote(data, userId)`** — Complete debit note workflow:
- Supports flat amount + optional link to original bill
- **Tax calculation** via existing TaxService
- **Bill-linked**: When linked to a bill, increases the bill's outstanding balance and receivable
- **Balanced JE**: Dr Receivable, Cr Other Charges/Expense + Cr Output Tax

**`getCreditNote(id, companyId)`** — Retrieves full credit note detail with line items, JE lines, tax details, and original bill info.

**`getDebitNote(id, companyId)`** — Retrieves full debit note detail with JE lines and tax details.

**`cancelCreditNote(id, companyId, userId, reason)`** — Cancels a posted credit note:
- Reverses the original JE via existing `journalRepo.reverse()` architecture
- Restores bill balance using stored `overpayment_amount` (the actual reduction amount)
- Restores receivable outstanding
- Rejects already-cancelled CNs

**`cancelDebitNote(id, companyId, userId, reason)`** — Cancels a posted debit note:
- Reverses the JE via existing reversal architecture
- Restores bill balance (subtracts dnTotal)
- Restores receivable outstanding

**`listCreditNotes` / `listDebitNotes`** — Paginated listing with filters (contact_id, bill_id, date range, status).

### 3. Controller Layer (`customer-bill.controller.js`)
- 4 controller methods: `getCreditNote`, `cancelCreditNote`, `getDebitNote`, `cancelDebitNote`
- Proper error handling via Express error middleware

### 4. Routes (`customer-bills.js`)
- `POST /credit-notes` — Create credit note
- `GET /credit-notes` — List credit notes
- `GET /credit-notes/:id` — Get credit note detail
- `POST /credit-notes/:id/cancel` — Cancel credit note
- `POST /debit-notes` — Create debit note
- `GET /debit-notes` — List debit notes
- `GET /debit-notes/:id` — Get debit note detail
- `POST /debit-notes/:id/cancel` — Cancel debit note
- All routes use proper permission middleware

### 5. Tests (`customer-bills.vitest.test.js`)
**37 new tests** covering:
- Full/Partial/Line-level credit notes
- Tax calculation and preservation
- Unpaid/partially-paid/fully-paid invoice scenarios
- Idempotency key deduplication
- Over-credit rejection
- JE balancing for credit notes and debit notes
- Debit note with and without linked bills
- Credit note and debit note detail retrieval
- Cancellation with JE reversal and bill balance restoration
- Re-cancellation rejection
- Validation: wrong contact, cancelled bill, company isolation
- Accounting reconciliation: invoice + CN (net zero), invoice + DN (receivable increases), invoice + payment + CN, invoice + payment + DN
- Customer statement includes CN and DN entries
- All JEs are balanced (Dr = Cr)

## Key Design Decisions

1. **`amount` is taxable (base), not grand total** — Consistent with existing code patterns. Grand total = taxable + tax.

2. **`overpayment_amount` column** stores the actual bill reduction (which may be less than `cnTotal` when the bill was already paid). This is critical for correct cancel restoration.

3. **Direct balance updates** instead of `_updateBillPayment` — Credit notes don't go through `bill_allocations` (which tracks payments only), avoiding reconciliation conflicts.

4. **Tax scaling** — Credit note tax breakdown is derived proportionally from the original bill's tax result, ensuring consistency with the original invoice's tax rates.

5. **JE reversal via existing architecture** — Cancel operations use `journalRepo.reverse()` to create a balancing reversal entry, not a destructive delete.

## Files Modified

| File | Status |
|------|--------|
| `server/database/migrations/061_step11_credit_debit_note.sql` | New |
| `server/database/migrations/062_step11_permissions.sql` | New |
| `server/services/customer-bill.service.js` | Modified (8 new methods) |
| `server/controllers/customer-bill.controller.js` | Modified (4 new methods) |
| `server/routes/customer-bills.js` | Modified (8 new routes) |
| `tests/customer-bills.vitest.test.js` | Modified (37 new tests) |

## Test Results

```
Test Files  1 passed (1)
     Tests  61 passed (61)
```

All pre-existing tests continue to pass, confirming no regressions were introduced.
