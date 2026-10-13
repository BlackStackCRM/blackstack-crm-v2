# PHASE 3A — CLEANUP EVIDENCE ARCHIVE AND PRE-CLEANUP SNAPSHOT

**Date:** 2026-10-09  
**Status:** EVIDENCE ARCHIVED — NO DELETION PERFORMED — AWAITING SEPARATE AUTHORIZATION (A and B)

Full machine-readable evidence: `docs/audits/phase-3a-cleanup-evidence-2026-10-09.json`  
Human-readable evidence: `docs/audits/phase-3a-cleanup-evidence-2026-10-09.md`  
Regenerated read-only by: `scripts/phase-3a-archive-cleanup-evidence.js`

---

## 1. PRE-CLEANUP SNAPSHOT

- Content fingerprint: `82a156bc94a40a1aa2a283e12cf544ab`
- `integrity_check` : **ok**
- `foreign_key_check` : **0 violations**

| Table | Rows |
|---|---|
| `audit_logs` | 431 |
| `role_permissions` | 165 |
| `permissions` | 126 |
| `journal_entry_lines` | 112 |
| `schema_migrations` | 70 |
| `specification_attributes` | 45 |
| `journal_entries` | 31 |
| `vouchers` | 25 |
| `accounts` | 24 |
| `account_groups` | 22 |
| `select_options` | 18 |
| `tax_components` | 12 |
| `tax_types` | 12 |
| `tax_masters` | 11 |
| `tax_account_mappings` | 8 |
| `adjustment_reasons` | 7 |
| `locations` | 7 |
| `specification_templates` | 7 |
| `stock_adjustment_reasons` | 7 |
| `number_sequences` | 6 |
| `godowns` | 5 |
| `legacy_tables` | 5 |
| `products` | 5 |
| `stock_groups` | 5 |
| `stock_items` | 5 |
| `currencies` | 4 |
| `pipeline_stages` | 4 |
| `roles` | 3 |
| `stock_categories` | 3 |
| `accounting_audit` | 2 |
| `brands` | 2 |
| `financial_years` | 2 |
| `inventory_voucher_headers` | 2 |
| `inventory_voucher_lines` | 2 |
| `item_serials` | 2 |
| `models` | 2 |
| `stock_balances` | 2 |
| `stock_ledger` | 2 |
| `system_metadata` | 2 |
| `units_of_measure` | 2 |
| `audit_fix_log` | 1 |
| `batches` | 1 |
| `bill_items` | 1 |
| `bills` | 1 |
| `colours` | 1 |
| `companies` | 1 |
| `company_tax_configs` | 1 |
| `contacts` | 1 |
| `inventory_items` | 1 |
| `organizations` | 1 |
| `receivables` | 1 |
| `sizes` | 1 |
| `styles` | 1 |
| `user_roles` | 1 |
| `users` | 1 |

## 2. BACKUP RESTORE VERIFICATION (performed, not assumed)

Each backup was **copied to a scratch path and opened there** — the actual restore
operation — then integrity-, FK- and writability-checked. A backup that only opens
in place is not proven restorable.

| Backup | Path | Integrity | FK | Writable | journal_entries | bills |
|---|---|---|---|---|---|---|
| Pre-leak | `%LOCALAPPDATA%\Temp\bs-backup-20261009-205746` | ok | 0 | yes | 31 | 0 |
| Current | `%LOCALAPPDATA%\Temp\bs-backup2-20261009-214827` | ok | 0 | yes | 31 | 1 |

Both are self-contained single files (2 953 216 bytes) and need no `-wal` sidecar.
The **pre-leak** backup is the one that would remove the leaked bill; the **current**
backup is the most recent state. Either is available for restore.

## 3. TARGET A — SIX JOURNAL ENTRIES (authorization A)

| # | Entry | Entry ID | Date | Status | FY | Lines | Debit/Credit | Synthetic because |
|---|---|---|---|---|---|---|---|---|
| 1 | `JE-1791550881603` | `je_01M4GC1ZT2GKE78T9DFZPK08HY` | 2026-10-09 | POSTED | fy_2024 | 2 | 100 / 100 | description is literally "probe"; date outside FY |
| 2 | `JE-1791550881613` | `je_01M4GC1ZTDNBVD24857PENP19C` | 2026-10-09 | POSTED | fy_2024 | 2 | -50 / -50 | description is literally "probe"; 2 negative; date outside FY |
| 3 | `JE-1791550881618` | `je_01M4GC1ZTJNEAWT9K0J30D71K9` | 2026-10-09 | POSTED | fy_2024 | 0 | 0 / 0 | description is literally "probe"; ZERO lines; date outside FY |
| 4 | `JE-1791552166536` | `je_01M4GD96KYKMEMT04Y4SJCFFDA` | 2024-01-01 | POSTED | fy_2024 | 2 | 100 / 100 | description is literally "locked-year probe" |
| 5 | `JE-1791552166543` | `je_01M4GD96MFX1N2CYENWC2NKEMZ` | 2024-01-01 | DRAFT | fy_2024 | 2 | -500 / -500 | description is literally "draft probe"; 2 negative; DRAFT (not reversible) |
| 6 | `JE-1791552765854` | `je_01M4GDVFWXKHWGY5JCJV9VVS7E` | 2026-01-01 | POSTED | None | 2 | 5 / 5 | description is literally "guard-test" |

**Ten line IDs (delete these first — they CASCADE, but order is explicit for auditability):**

- `jl_01M4GC1ZT4YN2XKGYA12RWMN1J`
- `jl_01M4GC1ZT4YYBTGKX6PVSVE0E3`
- `jl_01M4GC1ZTDJCFN9N8P03KX4ZGJ`
- `jl_01M4GC1ZTDHW37ENAC000776WK`
- `jl_01M4GD96M9C95QKC5PECGF2TDV`
- `jl_01M4GD96MA9BX7HGKR9SHM2YRM`
- `jl_01M4GD96MGPMKBBQRJZJMTJ5GD`
- `jl_01M4GD96MGZ7AFEYH2FFRS88Z1`
- `jl_01M4GDVFWZSHY6YZZNGA984M15`
- `jl_01M4GDVFWZ5R93MNTRJ5E560B4`

Dependency sweep across every table: the only dependent rows are the
`journal_entry_lines` belonging to each entry. **No** `accounting_audit`,
**no** `audit_logs`, **no** `vouchers` row references any of the six.

Prepared statements, to run inside ONE transaction, validate before COMMIT:

```sql
BEGIN IMMEDIATE;
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GC1ZT4YN2XKGYA12RWMN1J';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GC1ZT4YYBTGKX6PVSVE0E3';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GC1ZTDJCFN9N8P03KX4ZGJ';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GC1ZTDHW37ENAC000776WK';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GD96M9C95QKC5PECGF2TDV';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GD96MA9BX7HGKR9SHM2YRM';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GD96MGPMKBBQRJZJMTJ5GD';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GD96MGZ7AFEYH2FFRS88Z1';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GDVFWZSHY6YZZNGA984M15';
DELETE FROM journal_entry_lines WHERE id = 'jl_01M4GDVFWZ5R93MNTRJ5E560B4';
DELETE FROM journal_entries    WHERE id = 'je_01M4GC1ZT2GKE78T9DFZPK08HY';
DELETE FROM journal_entries    WHERE id = 'je_01M4GC1ZTDNBVD24857PENP19C';
DELETE FROM journal_entries    WHERE id = 'je_01M4GC1ZTJNEAWT9K0J30D71K9';
DELETE FROM journal_entries    WHERE id = 'je_01M4GD96KYKMEMT04Y4SJCFFDA';
DELETE FROM journal_entries    WHERE id = 'je_01M4GD96MFX1N2CYENWC2NKEMZ';
DELETE FROM journal_entries    WHERE id = 'je_01M4GDVFWXKHWGY5JCJV9VVS7E';
-- validate, then COMMIT
```

## 4. TARGET B — LEAKED BILL (authorization B)

`bill_01M4GPPH2HW3B3H56AFSR01FT5` — **BILL-2026-00001**, status `PENDING_APPROVAL`, 2000 INR

Synthetic because:

- status is `PENDING_APPROVAL` — never approved, never posted
- `approved_by` and `posted_by` are NULL
- `journal_entry_id` is NULL — **no accounting ledger entry exists**
- `reference_number`, `notes`, `terms` all empty
- no voucher or inventory-voucher linkage
- it is the ONLY bill in production
- created 2026-10-09 16:07:20 by `admin`, during the release-gate run

**All dependent record IDs (4):**

| Table | Row ID |
|---|---|
| `bill_items` | `bill_item_01M4GPPH2WNWSPB6VSVQ446SAN` |
| `receivables` | `rec_01M4GPPH2WMY2J0PWASYQFNSE6` |
| `accounting_audit` | `aud_01M4GPPH2YTF0W98V0RPGFG9H2` (CREATE) |
| `accounting_audit` | `aud_01M4GPPH3GJJESHBQQGQ4MJZ9` (SUBMIT) |

Full row payloads — including the complete `new_values_json` — are preserved in the
JSON archive. Prepared statements:

```sql
BEGIN IMMEDIATE;
DELETE FROM bill_items       WHERE bill_id    = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
DELETE FROM receivables      WHERE bill_id    = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
DELETE FROM accounting_audit WHERE entity_id  = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
DELETE FROM bills            WHERE id         = 'bill_01M4GPPH2HW3B3H56AFSR01FT5';
-- validate, then COMMIT
```

## 5. EXPLICITLY PRESERVED (must not change)

- `audit_logs` — all 431 rows kept (audit history is not deletable data)
- `number_sequences` `CUSTOMER_BILL.next_seq` stays **2** — NOT reset, so `BILL-2026-00001` can never be reused
- `financial_years.is_locked` stays **1 / 1** (per owner decision)
- `system_metadata` untouched
- All 25 genuine journal entries, 25 vouchers, 2 stock_ledger rows

## 6. POST-CLEANUP VALIDATION (dry-run results already confirmed)

On a throwaway copy the full sequence produced:

| | journal_entries | journal_lines | trial net | ABS debits | bills | accounting_audit |
|---|---|---|---|---|---|---|
| before | 31 | 112 | 0 | 8855 | 1 | 2 |
| after target A | 25 | 102 | 0 | 8100 | 1 | 2 |
| after target B | 25 | 102 | 0 | 8100 | 0 | 0 |

- `integrity_check` **ok**, `foreign_key_check` **0 violations**
- 25 genuine entries survive; date range 2026-10-01 .. 2026-10-05
- trial balance: debits 8100 = credits 8100, **balanced**
- `financial_years` locks 1 / 1 unchanged

## 7. NOT DONE

- **No deletion performed.** Neither A nor B is authorized.
- **Full 16-gate suite not run** — deliberately withheld until cleanup completes,
  so gate 9 is evaluated once against a corrected database.
- Phase 3 is **not** complete.
