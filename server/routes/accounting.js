const express = require('express');
const { body, validationResult } = require('express-validator');
const { AccountingController } = require('../controllers/accounting.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new AccountingController();

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

const authView = [authMiddleware, requirePermission('accounting.view')];
const authCreate = [authMiddleware, requirePermission('accounting.create')];
const authManage = [authMiddleware, requirePermission('accounting.manage')];
const authPost = [authMiddleware, requirePermission('accounting.post')];
const authCancel = [authMiddleware, requirePermission('accounting.cancel')];
const authReports = [authMiddleware, requirePermission('reports.view')];

// ===== Chart of Accounts =====
router.get('/accounts/tree', authView, controller.getAccountTree.bind(controller));
router.get('/accounts/summary', authView, controller.getAccountSummary.bind(controller));
router.get('/accounts/export', authView, controller.exportAccounts.bind(controller));
router.post('/accounts/import', authManage, controller.importAccounts.bind(controller));
router.post('/accounts/default', authManage, controller.createDefaultCOA.bind(controller));
router.get('/accounts', authView, controller.listAccounts.bind(controller));
router.get('/accounts/gl', authView, controller.listGLAccounts.bind(controller));
router.get('/accounts/groups', authView, controller.listAccountGroups.bind(controller));
router.get('/accounts/groups/tree', authView, controller.listAccountGroups.bind(controller));
router.get('/accounts/groups/suggest/:parentId', authView, controller.suggestGroupType.bind(controller));
router.get('/accounts/groups/:id', authView, controller.getAccountGroup.bind(controller));
router.put('/accounts/groups/:id', authManage, controller.updateAccountGroup.bind(controller));
router.delete('/accounts/groups/:id', authManage, controller.deleteAccountGroup.bind(controller));

// ===== Account Types (must come before /accounts/:id) =====
router.get('/account-types', authView, controller.listAccountTypes.bind(controller));
router.post('/account-types', authManage, controller.createAccountType.bind(controller));

// ===== Account Groups (create must come before :id) =====
router.post('/accounts/groups', authManage, controller.createAccountGroup.bind(controller));

// ===== Automatic code generation preview (CRM-wide centralized numbering) =====
router.get('/codes/preview', authView, controller.getNextCode.bind(controller));

// ===== Ledger Accounts =====
router.get('/accounts/:id', authView, controller.getAccount.bind(controller));
router.post('/accounts', authManage, controller.createAccount.bind(controller));
router.put('/accounts/:id', authManage, controller.updateAccount.bind(controller));
router.delete('/accounts/:id', authManage, controller.deleteAccount.bind(controller));

// ===== Journal Entries =====
router.get('/journal', authView, controller.listJournalEntries.bind(controller));
router.get('/journal/:id', authView, controller.getJournalEntry.bind(controller));
router.post('/journal', authCreate, controller.createJournalEntry.bind(controller));
router.put('/journal/:id', authManage, controller.updateJournalEntry.bind(controller));
router.delete('/journal/:id', authManage, controller.deleteJournalEntry.bind(controller));
router.post('/journal/:id/validate', authCreate, controller.validateJournalEntry.bind(controller));
router.post('/journal/:id/post', authManage, controller.postJournalEntry.bind(controller));
router.post('/journal/:id/cancel', authCancel, controller.cancelJournalEntry.bind(controller));
router.post('/journal/:id/reverse', authCancel, controller.reverseJournalEntry.bind(controller));

// ===== Journal Entry Drafts =====
router.post('/journal/draft', authCreate, controller.createJournalEntryDraft.bind(controller));

// ===== Vouchers =====
router.get('/vouchers', authView, controller.listVouchers.bind(controller));
router.post('/vouchers', authCreate, controller.createVoucher.bind(controller));
router.get('/vouchers/:id', authView, controller.getVoucher.bind(controller));
router.post('/vouchers/:id/cancel', authCancel, controller.cancelVoucher.bind(controller));
router.post('/vouchers/:id/reverse', authCancel, controller.reverseVoucher.bind(controller));

// ===== Receipt Vouchers (Step 7) =====
router.get('/receipts', authView, controller.listReceipts.bind(controller));
router.get('/receipts/:id', authView, controller.getReceipt.bind(controller));
router.post('/receipts/draft', authCreate, controller.createReceiptDraft.bind(controller));
router.post('/receipts/validate', authCreate, controller.validateReceipt.bind(controller));
router.post('/receipts', authPost, controller.postReceipt.bind(controller));
router.post('/receipts/:id/cancel', authCancel, controller.cancelReceipt.bind(controller));
router.post('/receipts/:id/reverse', authCancel, controller.reverseReceipt.bind(controller));
router.delete('/receipts/:id', authCancel, controller.deleteReceipt.bind(controller));

// ===== Payment Vouchers (Step 8) =====
router.get('/payment-vouchers', authView, controller.listPayments.bind(controller));
router.get('/payment-vouchers/:id', authView, controller.getPayment.bind(controller));
router.post('/payment-vouchers/draft', authCreate, controller.createPaymentDraft.bind(controller));
router.post('/payment-vouchers/validate', authCreate, controller.validatePayment.bind(controller));
router.post('/payment-vouchers', authPost, controller.postPayment.bind(controller));
router.post('/payment-vouchers/:id/cancel', authCancel, controller.cancelPayment.bind(controller));
router.post('/payment-vouchers/:id/reverse', authCancel, controller.reversePayment.bind(controller));
router.delete('/payment-vouchers/:id', authCancel, controller.deletePayment.bind(controller));

// ===== Contra Vouchers (Step 9) =====
router.get('/contra', authView, controller.listContras.bind(controller));
router.get('/contra/:id', authView, controller.getContra.bind(controller));
router.post('/contra/draft', authCreate, controller.createContraDraft.bind(controller));
router.post('/contra/validate', authCreate, controller.validateContra.bind(controller));
router.post('/contra', authPost, controller.postContra.bind(controller));
router.post('/contra/:id/cancel', authCancel, controller.cancelContra.bind(controller));
router.post('/contra/:id/reverse', authCancel, controller.reverseContra.bind(controller));
router.delete('/contra/:id', authCancel, controller.deleteContra.bind(controller));

// ===== Sales Vouchers (Step 10) =====
router.get('/sales', authView, controller.listSales.bind(controller));
router.get('/sales/:id', authView, controller.getSales.bind(controller));
router.post('/sales/draft', authCreate, controller.createSalesDraft.bind(controller));
router.post('/sales/validate', authCreate, controller.validateSales.bind(controller));
router.post('/sales', authPost, controller.postSales.bind(controller));
router.post('/sales/:id/cancel', authCancel, controller.cancelSales.bind(controller));
router.post('/sales/:id/reverse', authCancel, controller.reverseSales.bind(controller));
router.delete('/sales/:id', authCancel, controller.deleteSales.bind(controller));

// ===== Purchase Vouchers (Step 11) =====
router.get('/purchases', authView, controller.listPurchases.bind(controller));
router.get('/purchases/:id', authView, controller.getPurchase.bind(controller));
router.post('/purchases/draft', authCreate, controller.createPurchaseDraft.bind(controller));
router.post('/purchases/validate', authCreate, controller.validatePurchase.bind(controller));
router.post('/purchases', authPost, controller.postPurchase.bind(controller));
router.post('/purchases/:id/cancel', authCancel, controller.cancelPurchase.bind(controller));
router.post('/purchases/:id/reverse', authCancel, controller.reversePurchase.bind(controller));
router.delete('/purchases/:id', authCancel, controller.deletePurchase.bind(controller));

// ===== Expense Vouchers (Step 12) =====
router.get('/expenses', authView, controller.listExpenses.bind(controller));
router.get('/expenses/:id', authView, controller.getExpense.bind(controller));
router.post('/expenses/draft', authCreate, controller.createExpenseDraft.bind(controller));
router.post('/expenses/validate', authCreate, controller.validateExpense.bind(controller));
router.post('/expenses', authPost, controller.postExpense.bind(controller));
router.post('/expenses/:id/cancel', authCancel, controller.cancelExpense.bind(controller));
router.post('/expenses/:id/reverse', authCancel, controller.reverseExpense.bind(controller));
router.delete('/expenses/:id', authCancel, controller.deleteExpense.bind(controller));

// ===== Credit Notes / Sales Return (Step 13) =====
router.get('/credit-notes', authView, controller.listCreditNotes.bind(controller));
router.get('/credit-notes/:id', authView, controller.getCreditNote.bind(controller));
router.post('/credit-notes/draft', authCreate, controller.createCreditNoteDraft.bind(controller));
router.post('/credit-notes/validate', authCreate, controller.validateCreditNote.bind(controller));
router.post('/credit-notes', authPost, controller.postCreditNote.bind(controller));
router.post('/credit-notes/:id/cancel', authCancel, controller.cancelCreditNote.bind(controller));
router.post('/credit-notes/:id/reverse', authCancel, controller.reverseCreditNote.bind(controller));
router.delete('/credit-notes/:id', authCancel, controller.deleteCreditNote.bind(controller));

// ===== Debit Notes / Purchase Return (Step 14) =====
router.get('/debit-notes', authView, controller.listDebitNotes.bind(controller));
router.get('/debit-notes/:id', authView, controller.getDebitNote.bind(controller));
router.post('/debit-notes/draft', authCreate, controller.createDebitNoteDraft.bind(controller));
router.post('/debit-notes/validate', authCreate, controller.validateDebitNote.bind(controller));
router.post('/debit-notes', authPost, controller.postDebitNote.bind(controller));
router.post('/debit-notes/:id/cancel', authCancel, controller.cancelDebitNote.bind(controller));
router.post('/debit-notes/:id/reverse', authCancel, controller.reverseDebitNote.bind(controller));
router.delete('/debit-notes/:id', authCancel, controller.deleteDebitNote.bind(controller));

// ===== Step 17: Tax / GST Master & Accounting Integration =====
router.get('/taxes', authView, controller.listTaxes.bind(controller));
router.post('/taxes', authManage, controller.createTax.bind(controller));
router.get('/taxes/reports/summary', authReports, controller.taxSummaryReport.bind(controller));
router.get('/taxes/reports/sales-tax-summary', authReports, controller.salesTaxSummary.bind(controller));
router.get('/taxes/reports/purchase-tax-summary', authReports, controller.purchaseTaxSummary.bind(controller));
router.get('/taxes/reports/output-input-reconciliation', authReports, controller.outputInputGSTReconciliation.bind(controller));
router.get('/taxes/reconciliation', authReports, controller.getTaxReconciliation.bind(controller));
router.get('/taxes/reconciliation/:taxId', authReports, controller.getTaxReconciliation.bind(controller));
router.get('/taxes/company-config', authView, controller.getCompanyTaxConfig.bind(controller));
router.put('/taxes/company-config', authManage, controller.setCompanyTaxConfig.bind(controller));
router.get('/taxes/account-mappings', authView, controller.listTaxAccountMappings.bind(controller));
router.post('/taxes/account-mappings', authManage, controller.upsertTaxAccountMapping.bind(controller));
router.delete('/taxes/account-mappings/:id', authManage, controller.deleteTaxAccountMapping.bind(controller));
router.get('/taxes/:id', authView, controller.getTax.bind(controller));
router.put('/taxes/:id', authManage, controller.updateTax.bind(controller));
router.patch('/taxes/:id/status', authManage, controller.toggleTaxStatus.bind(controller));
router.post('/taxes/calculate', authView, controller.calculateTaxPreview.bind(controller));

// ===== Step 18: Tax Reports & Reconciliation =====

// ===== Accounts Receivable (Step 15) =====
router.get('/accounts-receivable/customers', authView, controller.getCustomerOutstanding.bind(controller));
router.get('/accounts-receivable/aging', authView, controller.getArAging.bind(controller));
router.get('/accounts-receivable/reconciliation', authView, controller.getArReconciliation.bind(controller));
router.get('/accounts-receivable/customers/:id', authView, controller.getCustomerStatement.bind(controller));
router.get('/accounts-receivable/customers/:id/invoices', authView, controller.getCustomerInvoices.bind(controller));
router.post('/accounts-receivable/allocations', authCreate, controller.createAllocation.bind(controller));

// ===== Step 16: Accounts Payable / Supplier Outstanding =====
router.get('/accounts-payable/suppliers', authView, controller.getSupplierOutstanding.bind(controller));
router.get('/accounts-payable/suppliers/:id', authView, controller.getSupplierStatement.bind(controller));
router.get('/accounts-payable/suppliers/:id/invoices', authView, controller.getSupplierInvoices.bind(controller));
router.get('/accounts-payable/aging', authView, controller.getApAging.bind(controller));
router.get('/accounts-payable/reconciliation', authView, controller.getApReconciliation.bind(controller));
router.post('/accounts-payable/allocations', authCreate, controller.createPayableAllocation.bind(controller));

// ===== Bills (Customer + Supplier) =====
router.get('/bills', authView, controller.listBills.bind(controller));
router.get('/bills/:id', authView, controller.getBill.bind(controller));
router.post('/bills', authCreate, controller.createBill.bind(controller));
router.put('/bills/:id', authManage, controller.updateBill.bind(controller));

// ===== Payments =====
router.post('/payments', authCreate, controller.recordPayment.bind(controller));

// ===== Receivables =====
router.get('/receivables', authView, controller.listReceivables.bind(controller));
router.get('/receivables/summary', authView, controller.getReceivablesSummary.bind(controller));
router.get('/receivables/:id', authView, controller.getReceivable.bind(controller));

// ===== Payables =====
router.get('/payables', authView, controller.listPayables.bind(controller));
router.get('/payables/summary', authView, controller.getPayablesSummary.bind(controller));

// ===== Outstanding / Aging =====
router.get('/outstanding', authView, controller.getAging.bind(controller));
router.get('/aging', authView, controller.getAging.bind(controller));

// ===== Ledger =====
router.get('/ledger/:accountId', authView, controller.getLedger.bind(controller));

// ===== Financial Years =====
router.get('/financial-years', authView, controller.listFinancialYears.bind(controller));
router.post('/financial-years', authManage, controller.createFinancialYear.bind(controller));
router.post('/financial-years/:id/activate', authManage, controller.setActiveFinancialYear.bind(controller));
router.post('/financial-years/:id/lock', authManage, controller.lockFinancialYear.bind(controller));

// ===== Cost Centres =====
router.get('/cost-centres', authView, controller.listCostCentres.bind(controller));
router.post('/cost-centres', authManage, controller.createCostCentre.bind(controller));
router.put('/cost-centres/:id', authManage, controller.updateCostCentre.bind(controller));
router.delete('/cost-centres/:id', authManage, controller.deleteCostCentre.bind(controller));

// ===== Cost Categories =====
router.get('/cost-categories', authView, controller.listCostCategories.bind(controller));
router.post('/cost-categories', authManage, controller.createCostCategory.bind(controller));
router.put('/cost-categories/:id', authManage, controller.updateCostCategory.bind(controller));
router.delete('/cost-categories/:id', authManage, controller.deleteCostCategory.bind(controller));

// ===== Bank Accounts =====
router.get('/bank-accounts', authView, controller.listBankAccounts.bind(controller));
router.post('/bank-accounts', authManage, controller.createBankAccount.bind(controller));
router.put('/bank-accounts/:id', authManage, controller.updateBankAccount.bind(controller));
router.get('/bank-accounts/:id/transactions', authView, controller.getBankTransactions.bind(controller));

// ===== Budgets =====
router.get('/budgets', authView, controller.listBudgets.bind(controller));
router.get('/budgets/:id', authView, controller.getBudget.bind(controller));
router.post('/budgets', authManage, controller.createBudget.bind(controller));
router.post('/budgets/:id/update-actuals', authView, controller.updateBudgetActuals.bind(controller));

// ===== Credit Rules =====
router.get('/credit-rules/:contactId', authView, controller.getCreditRule.bind(controller));
router.post('/credit-rules', authManage, controller.setCreditRule.bind(controller));

// ===== Interest =====
router.post('/receivables/:id/interest/calculate', authView, controller.calculateInterest.bind(controller));
router.post('/receivables/:id/interest/post', authCreate, controller.postInterest.bind(controller));

// ===== Dashboard =====
router.get('/dashboard', authView, controller.dashboard.bind(controller));

// ===== Reports =====
router.get('/reports/cash-book', authReports, controller.cashBook.bind(controller));
router.get('/reports/bank-book/:bankAccountId', authReports, controller.bankBook.bind(controller));
router.get('/reports/trial-balance', authReports, controller.trialBalance.bind(controller));
router.get('/reports/profit-loss', authReports, controller.profitLoss.bind(controller));
router.get('/reports/balance-sheet', authReports, controller.balanceSheet.bind(controller));
router.get('/reports/cash-flow', authReports, controller.cashFlow.bind(controller));
router.get('/reports/fund-flow', authReports, controller.fundFlow.bind(controller));
router.get('/reports/ratios', authReports, controller.ratios.bind(controller));
router.get('/reports/day-book', authReports, controller.dayBook.bind(controller));
router.get('/reports/ledger', authReports, controller.ledgerReport.bind(controller));

// ===== Opening Balances (Step 5) =====
router.get('/opening-balances', authView, controller.listOpeningBalances.bind(controller));
router.post('/opening-balances', authManage, controller.createOpeningBalance.bind(controller));
router.get('/opening-balances/:id', authView, controller.getOpeningBalance.bind(controller));
router.delete('/opening-balances/:id', authManage, controller.deleteOpeningBalance.bind(controller));
router.post('/opening-balances/:id/lines', authManage, controller.addOpeningBalanceLine.bind(controller));
router.put('/opening-balances/:obId/lines/:lineId', authManage, controller.updateOpeningBalanceLine.bind(controller));
router.delete('/opening-balances/:obId/lines/:lineId', authManage, controller.deleteOpeningBalanceLine.bind(controller));
router.post('/opening-balances/:id/validate', authManage, controller.validateOpeningBalance.bind(controller));
router.post('/opening-balances/:id/finalize', authManage, controller.finalizeOpeningBalance.bind(controller));
router.post('/opening-balances/:id/post', authManage, controller.postOpeningBalance.bind(controller));

// ===== Step 19: Inventory Accounting & Stock Valuation =====
router.get('/inventory/items', authView, controller.listInventoryItems.bind(controller));
router.get('/inventory/items/:productId', authView, controller.getInventoryItem.bind(controller));
router.get('/inventory/movements', authView, controller.listInventoryMovements.bind(controller));
router.get('/inventory/valuation', authReports, controller.inventoryValuation.bind(controller));

// ===== Step 25: Bank Reconciliation =====
router.get('/bank-reconciliations', authView, controller.listBankReconciliations.bind(controller));
router.post('/bank-reconciliations', authPost, controller.createBankReconciliation.bind(controller));
router.get('/bank-reconciliations/:id/items', authView, controller.listBankReconItems.bind(controller));
router.post('/bank-reconciliations/:id/items', authManage, controller.createBankReconItem.bind(controller));
router.delete('/bank-reconciliations/:reconId/items/:itemId', authCancel, controller.deleteBankReconItem.bind(controller));
router.get('/bank-reconciliations/:id', authView, controller.getBankReconciliation.bind(controller));
router.delete('/bank-reconciliations/:id', authCancel, controller.deleteBankReconciliation.bind(controller));

// ===== Step 19: Year-End Closing =====
router.get('/year-end/status', authView, controller.getYearEndStatus.bind(controller));
router.post('/year-end/close', authManage, controller.closeFinancialYear.bind(controller));
router.get('/year-end', authView, controller.listYearEndClosings.bind(controller));
router.get('/year-end/:id', authView, controller.getYearEndClosing.bind(controller));

// ===== Step 20: Audit Trail & System Integrity =====
router.get('/audit-trail', authReports, controller.auditTrail.bind(controller));
router.get('/reports/system-integrity', authReports, controller.systemIntegrity.bind(controller));

// ===== Financial Years =====
router.get('/financial-years', authView, controller.listFinancialYears.bind(controller));
router.post('/financial-years', authManage, controller.createFinancialYear.bind(controller));
router.post('/financial-years/:id/activate', authManage, controller.setActiveFinancialYear.bind(controller));
router.post('/financial-years/:id/lock', authManage, controller.lockFinancialYear.bind(controller));

module.exports = router;
