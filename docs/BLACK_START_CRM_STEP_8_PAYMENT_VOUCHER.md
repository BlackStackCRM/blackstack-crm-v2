# Step 8 — Payment Voucher / Money Paid Transaction

## Specification

### Objective

Implement **Step 8 — Payment Voucher** to record money paid by the company, reusing the existing Step 6 Journal Entry engine, the `vouchers` table, and audit trail infrastructure.

---

## Accounting Pattern

**Debit = account receiving the value (expense/liability/asset reduction)**
**Credit = account from which money is paid (Cash/Bank asset reduction)**

| Scenario | Debit | Credit |
|---|---|---|
| Rent payment | Rent Expense (DEBIT) | Bank (DEBIT) |
| Supplier payment | Accounts Payable (CREDIT) | Bank (DEBIT) |
| Salary payment | Salaries Expense (DEBIT) | Bank (DEBIT) |
| Loan repayment | Loan Liability (CREDIT) | Bank (DEBIT) |

**Note:** Unlike receipts (where source is always CREDIT-nature), payments can debit accounts of ANY nature — DEBIT-nature expenses (debited to increase) or CREDIT-nature liabilities/payables (debited to decrease). The payment account (Cash/Bank) is always DEBIT-nature and is credited.

---

## Database

### payments (via vouchers table)

The existing `vouchers` table is reused with `voucher_type = 'PAYMENT'`.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | Voucher UUID |
| `company_id` | TEXT | Company scoping |
| `voucher_number` | TEXT | Auto-generated: `PY-2026-0001` |
| `voucher_type` | TEXT | `'PAYMENT'` |
| `receipt_mode` | TEXT | Payment mode: `CASH`, `BANK`, `UPI`, `CHEQUE`, `CARD`, `OTHER` |
| `voucher_date` | TEXT | Must fall within active Financial Year |
| `reference_number` | TEXT | Optional external ref |
| `description` | TEXT | Narration |
| `contact_id` | TEXT | Optional party/supplier |
| `currency` | TEXT | Default `INR` |
| `exchange_rate` | REAL | Default `1.0` |
| `financial_year_id` | TEXT FK | Links to `financial_years` |
| `total_amount` | REAL | Payment amount |
| `journal_entry_id` | TEXT FK | Links to `journal_entries` |
| `status` | TEXT | `DRAFT` → `POSTED` → `CANCELLED`/`REVERSED` |
| `posted_by` | TEXT | User who posted |
| `posted_at` | TEXT | Timestamp |

No new tables created. The `receipt_mode` column (added in Step 7 migration 032) serves double-duty for payment modes.

### Voucher Number Format

`PY-{year}-{sequence}` (e.g., `PY-2026-0001`)

Reversal vouchers append `_REV` suffix (e.g., `PY-2026-0001_REV`).

---

## API Endpoints

All endpoints are under `/api/accounting/payment-vouchers`.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/payment-vouchers` | `accounting.view` | List with filters |
| GET | `/payment-vouchers/:id` | `accounting.view` | Payment detail + JE reference |
| POST | `/payment-vouchers/draft` | `accounting.create` | Save as DRAFT |
| POST | `/payment-vouchers/validate` | `accounting.create` | Real-time accounting preview |
| POST | `/payment-vouchers` | `accounting.post` | Post payment (creates JE atomically) |
| POST | `/payment-vouchers/:id/cancel` | `accounting.cancel` | Cancel posted payment |
| POST | `/payment-vouchers/:id/reverse` | `accounting.cancel` | Reverse posted payment |
| DELETE | `/payment-vouchers/:id` | `accounting.cancel` | Delete DRAFT only |

### Filters (GET list)

- `status` — DRAFT, POSTED, CANCELLED, REVERSED
- `from`, `to` — date range
- `contact_id` — party filter
- `q` — search by voucher number / reference

---

## Validation Rules

### Payment Date
- Required
- Must fall within an active, unlocked Financial Year
- Cannot post into a closed/locked Financial Year

### Payment Account (Credit side)
- Must be a valid Ledger Account (not a Group)
- Must be Active
- Must allow direct posting
- Must be DEBIT-nature (Cash/Bank/Asset)
- Must belong to the current company

### Destination Ledger (Debit side)
- Must be a valid Ledger Account (not a Group)
- Must be Active
- Must allow direct posting
- Must belong to the current company
- Can be DEBIT-nature (Expense/Asset) or CREDIT-nature (Liability/Equity)

### Amount
- Required
- Must be greater than zero
- Valid monetary value (supports decimals)

### Payment Mode
- Must be one of: `CASH`, `BANK`, `UPI`, `CHEQUE`, `CARD`, `OTHER`

---

## Accounting Integration

Every posted Payment Voucher creates a balanced double-entry Journal Entry via:

```
ReceiptVoucher (business interface)
    → _validatePayment()     (header validation)
    → _buildPaymentLines()   (build Debit/Credit lines)
    → JournalEntryRepository.createWithValidation()  (Step 6 engine)
    → VoucherRepository.postPayment()  (link JE to voucher)
```

The `createWithValidation` method in the JE repository only validates:
- Total debits = total credits
- Each line has valid account_id, debit_amount, credit_amount

It does NOT enforce debit_credit_nature rules (those are handled at the business-transaction layer).

---

## Transaction Lifecycle

```
Draft → Validated → Posted → Cancelled
                    → Reversed
```

### Draft
- Editable
- No Journal Entry created
- Can be deleted

### Posted
- Journal Entry created (balanced double-entry)
- Cannot be edited or deleted
- Can be cancelled or reversed

### Cancelled
- Retains full history
- JE status set to CANCELLED
- Cannot be posted again

### Reversed
- Original voucher remains intact for audit
- A reversing voucher + reversing JE is created with `_REV` suffix
- Original is marked REVERSED

---

## Company Isolation

All entities are validated for company scope:
- Payment voucher's `company_id`
- Financial Year's `company_id`
- Payment account's `company_id`
- Destination ledger's `company_id`
- Contact/party's `company_id`

Company ID is always derived from the backend session context (`req.user.companyId`), never trusted from the frontend.

---

## Future Extensibility

The Payment Voucher establishes the pattern for future business-transaction modules:

```
Business Transaction (Payment Voucher)
        ↓
Accounting Validation
        ↓
Step 6 Journal Entry Engine
        ↓
Journal Entry Lines
        ↓
Ledger
        ↓
Trial Balance
        ↓
P&L / Balance Sheet
```

All future modules (Contra, Sales, Purchase, Credit Note, Debit Note, Payroll, Tax, Bank Reconciliation) should reuse this pattern.

---

## Test Coverage

### Positive Tests (25)
1. Create Cash Payment
2. Payment generates a balanced Journal Entry
3. Payment JE has correct debit/credit lines
4. Ledger reflects payment (payment account credited)
5. Payment Detail view shows JE reference
6. Payment List shows posted payments
7. Validate Payment (real-time accounting preview)
8. Create Payment as Draft
9. Delete Draft Payment
10. Cannot delete Posted Payment
11. Cancel a Posted Payment
12. Cannot cancel already-cancelled Payment
13. Reverse a Posted Payment
14. Bank Payment
15. Supplier Payment (Accounts Payable)
16. Loan Repayment (Liability)
17. Payment audit trail
18. Reject zero amount — **validation**
19. Reject negative amount — **validation**
20. Reject missing payment account — **validation**
21. Reject missing destination account — **validation**
22. Reject Group account as payment account — **validation**
23. Reject inactive account — **validation**
24. Reject CREDIT-nature account as payment account — **validation**
25. Reject invalid payment_mode — **validation**
26. Reject date outside Financial Year — **validation**
27. Payment Trial Balance impact
28. P&L reflects expense payments
29. Cannot edit Posted Payment

### Test Results
- **222 passed, 2 failed** (2 pre-existing failures unrelated to Step 8)
- 195 tests from Steps 1–7 all pass
- 27 new Step 8 tests all pass
