-- Migration 068: Fix tax input group type and mark equity accounts as system
-- Input tax accounts (acc_input_*) have type=ASSET (recoverable) but were placed
-- under ag_tax_input which had type=EXPENSE. Correct the group type to ASSET.
UPDATE account_groups SET type = 'ASSET', debit_credit_nature = 'DEBIT'
  WHERE id = 'ag_tax_input';

-- Mark Retained Earnings and Share Capital as system accounts (protected)
UPDATE accounts SET is_system = 1
  WHERE id IN ('acc_retained', 'acc_capital');

-- Ensure tax input accounts are correctly typed as ASSET under the now-ASSET group
-- (no change needed to the accounts themselves — they already have type='ASSET')
