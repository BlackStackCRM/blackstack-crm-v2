const express = require('express');
const { body, validationResult } = require('express-validator');
const { CustomerBillController } = require('../controllers/customer-bill.controller');
const { authMiddleware } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { errorResponse } = require('../utils/response');

const router = express.Router();
const controller = new CustomerBillController();

const cbView = [authMiddleware, requirePermission('customer_bills.view')];
const cbCreate = [authMiddleware, requirePermission('customer_bills.create')];
const cbEdit = [authMiddleware, requirePermission('customer_bills.edit')];
const cbApprove = [authMiddleware, requirePermission('customer_bills.approve')];
const cbPost = [authMiddleware, requirePermission('customer_bills.post')];
const cbCancel = [authMiddleware, requirePermission('customer_bills.cancel')];
const cbDelete = [authMiddleware, requirePermission('customer_bills.delete_draft')];
const cbPay = [authMiddleware, requirePermission('customer_bills.record_payment')];
const cbCN = [authMiddleware, requirePermission('customer_bills.create_credit_note')];
const cbCNView = [authMiddleware, requirePermission('customer_bills.view_credit_note')];
const cbCNCancel = [authMiddleware, requirePermission('customer_bills.cancel_credit_note')];
const cbDN = [authMiddleware, requirePermission('customer_bills.create_debit_note')];
const cbDNView = [authMiddleware, requirePermission('customer_bills.view_debit_note')];
const cbDNCancel = [authMiddleware, requirePermission('customer_bills.cancel_debit_note')];
const cbReports = [authMiddleware, requirePermission('customer_bills.view_reports')];
const cbWriteOff = [authMiddleware, requirePermission('customer_bills.write_off')];
const cbAllocate = [authMiddleware, requirePermission('customer_bills.allocate')];
const cbReconcile = [authMiddleware, requirePermission('customer_bills.reconcile')];
const cbDispute = [authMiddleware, requirePermission('customer_bills.dispute')];

const handle = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json(errorResponse('VALIDATION_ERROR', errors.array().map(e => e.msg).join('; ')));
  next();
};

// ─── Specific routes (must come BEFORE /:id to avoid param capture) ───
// Number & Tax Preview
router.get('/number/preview', cbView, controller.previewNumber.bind(controller));
router.post('/tax/calculate', cbView, controller.calculateTax.bind(controller));

// KPI Dashboard
router.get('/kpi', cbView, controller.getKpiSummary.bind(controller));
router.get('/status-counts', cbView, controller.getStatusCounts.bind(controller));

// Payments, Allocation & Reconciliation
router.post('/payments', cbPay, controller.recordPayment.bind(controller));
router.post('/payments/allocate', cbAllocate, controller.allocatePayment.bind(controller));
router.post('/payments/reconcile', cbReconcile, controller.reconcile.bind(controller));

// Credit / Debit Notes
router.post('/credit-notes', cbCN, controller.createCreditNote.bind(controller));
router.get('/credit-notes', cbView, controller.listCreditNotes.bind(controller));
router.get('/credit-notes/:id', cbCNView, controller.getCreditNote.bind(controller));
router.post('/credit-notes/:id/cancel', cbCNCancel, controller.cancelCreditNote.bind(controller));
router.post('/debit-notes', cbDN, controller.createDebitNote.bind(controller));
router.get('/debit-notes', cbView, controller.listDebitNotes.bind(controller));
router.get('/debit-notes/:id', cbDNView, controller.getDebitNote.bind(controller));
router.post('/debit-notes/:id/cancel', cbDNCancel, controller.cancelDebitNote.bind(controller));

// Customer Financial Data
router.get('/customers/:contactId/summary', cbView, controller.getCustomerSummary.bind(controller));
router.get('/customers/:id/statement', cbView, controller.getCustomerStatement.bind(controller));

// Aging & Receivables
router.get('/aging', cbReports, controller.getAging.bind(controller));
router.get('/receivables/summary', cbView, controller.getReceivablesSummary.bind(controller));

// Reports: Sales Register & Tax Summary
router.get('/sales-register', cbReports, controller.getSalesRegister.bind(controller));
router.get('/tax-summary', cbReports, controller.getTaxSummary.bind(controller));

// ─── CRUD (collection-level) ───
router.get('/', cbView, controller.listBills.bind(controller));
router.post('/', cbCreate, controller.createBill.bind(controller));

// ─── Lifecycle (collection-level actions first, then /:id routes) ───
// (all lifecycle routes use /:id below)

// ─── Detail routes (/:id) ───
// NOTE: These must come AFTER all specific collection routes above
router.get('/:id', cbView, controller.getBill.bind(controller));
router.put('/:id', cbEdit, controller.updateBill.bind(controller));
router.delete('/:id', cbDelete, controller.deleteDraft.bind(controller));

// Lifecycle
router.post('/:id/submit', cbApprove, controller.submitForApproval.bind(controller));
router.post('/:id/approve', cbApprove, controller.approveBill.bind(controller));
router.post('/:id/post', cbPost, controller.postBill.bind(controller));
router.post('/:id/cancel', cbCancel, controller.cancelBill.bind(controller));

// Credit Control
router.post('/:id/writeoff', cbWriteOff, controller.writeoff.bind(controller));
router.post('/:id/dispute', cbDispute, controller.dispute.bind(controller));

// Dispute resolution
router.post('/disputes/:disputeId/resolve', cbDispute, controller.resolveDispute.bind(controller));

// ═══ Step 12: Customer Outstanding & AR Aging ════════════════════════════════
router.get('/outstanding', cbReports, controller.getCustomerOutstanding.bind(controller));
router.get('/customers/:contactId/aging', cbView, controller.getCustomerAging.bind(controller));
router.get('/bills/:billId/invoice-aging', cbView, controller.getInvoiceAging.bind(controller));

// ═══ Step 12: Collection Management ════════════════════════════════════════════
router.post('/customers/:contactId/collection-owner', requirePermission('customer_bills.assign_collection_owner'), controller.assignCollectionOwner.bind(controller));
router.get('/customers/:contactId/activities', requirePermission('customer_bills.manage_collections'), controller.getCollectionActivities.bind(controller));
router.post('/customers/:contactId/activities', requirePermission('customer_bills.manage_collections'), controller.addCollectionActivity.bind(controller));
router.post('/customers/:contactId/promises', requirePermission('customer_bills.manage_promises'), controller.createPromiseToPay.bind(controller));
router.post('/promises/:promiseId/payment', requirePermission('customer_bills.manage_promises'), controller.recordPromisePayment.bind(controller));
router.get('/promises/:contactId', requirePermission('customer_bills.manage_collections'), controller.getPromisesToPay.bind(controller));
router.post('/disputes', requirePermission('customer_bills.manage_disputes'), controller.createDispute.bind(controller));
router.get('/disputes', requirePermission('customer_bills.manage_disputes'), controller.getDisputes.bind(controller));
router.post('/disputes/:disputeId/resolve', requirePermission('customer_bills.manage_disputes'), controller.resolveCollectionDispute.bind(controller));

// Collection dashboard
router.get('/collection-dashboard', requirePermission('customer_bills.view_reports'), controller.getCollectionDashboard.bind(controller));

// ═══ Step 13: Reports & Analytics ══════════════════════════════════════════════
const cbExport = [authMiddleware, requirePermission('customer_bills.export_reports')];

// Billing Dashboard
router.get('/reports/dashboard', cbReports, controller.getBillingDashboard.bind(controller));

// Billing Trend
router.get('/reports/billing-trend', cbReports, controller.getBillingTrend.bind(controller));

// Sales Register
router.get('/reports/sales-register', cbReports, controller.getSalesRegister.bind(controller));
router.get('/reports/sales-register/export', cbExport, controller.getSalesRegister.bind(controller));

// Invoice Register
router.get('/reports/invoice-register', cbReports, controller.getInvoiceRegister.bind(controller));
router.get('/reports/invoice-register/export', cbExport, controller.getInvoiceRegister.bind(controller));

// Customer Outstanding Report
router.get('/reports/customer-outstanding', cbReports, controller.getCustomerOutstandingReport.bind(controller));

// AR Aging Report
router.get('/reports/ar-aging', cbReports, controller.getCustomerAging.bind(controller));

// Customer Statement Report
router.get('/reports/customer-statement/:contactId', cbReports, controller.getCustomerStatement.bind(controller));

// Payment Register
router.get('/reports/payment-register', cbReports, controller.getPaymentRegister.bind(controller));
router.get('/reports/payment-register/export', cbExport, controller.getPaymentRegister.bind(controller));

// Collection Report
router.get('/reports/collection', cbReports, controller.getCollectionReport.bind(controller));

// Collection Performance
router.get('/reports/collection-performance', cbReports, controller.getCollectionPerformance.bind(controller));

// Overdue Analytics
router.get('/reports/overdue-analytics', cbReports, controller.getOverdueAnalytics.bind(controller));

// Top Customers
router.get('/reports/top-customers', cbReports, controller.getTopCustomers.bind(controller));

// Credit Note Register
router.get('/reports/credit-notes', cbReports, controller.getCreditNoteRegister.bind(controller));

// Debit Note Register
router.get('/reports/debit-notes', cbReports, controller.getDebitNoteRegister.bind(controller));

// Tax / GST Report
router.get('/reports/tax', cbReports, controller.getTaxReport.bind(controller));

// Salesperson Report
router.get('/reports/salesperson', cbReports, controller.getSalespersonReport.bind(controller));

// Product / Service Sales
router.get('/reports/product-sales', cbReports, controller.getProductSalesReport.bind(controller));

// Branch / Warehouse
router.get('/reports/branch-warehouse', cbReports, controller.getBranchWarehouseReport.bind(controller));

// Collection Trend
router.get('/reports/collection-trend', cbReports, controller.getCollectionTrend.bind(controller));

// Payment Method Distribution
router.get('/reports/payment-methods', cbReports, controller.getPaymentMethodDistribution.bind(controller));

// Aging Distribution (for charts)
router.get('/reports/aging-distribution', cbReports, controller.getAgingDistribution.bind(controller));

// ═══ Step 14: Receivables Follow-up & Collections Automation ════════════════

// Permission middleware aliases
const cbCollections = [authMiddleware, requirePermission('customer_bills.view_collections')];
const cbManageRules = [authMiddleware, requirePermission('customer_bills.manage_collection_rules')];
const cbExecute = [authMiddleware, requirePermission('customer_bills.execute_collection_actions')];
const cbPlans = [authMiddleware, requirePermission('customer_bills.manage_payment_plans')];
const cbInterest = [authMiddleware, requirePermission('customer_bills.calculate_interest')];
const cbApproveInterest = [authMiddleware, requirePermission('customer_bills.approve_interest')];
const cbBadDebt = [authMiddleware, requirePermission('customer_bills.manage_bad_debt')];
const cbApproveBadDebt = [authMiddleware, requirePermission('customer_bills.approve_bad_debt')];
const cbRisk = [authMiddleware, requirePermission('customer_bills.view_collection_risk')];
const cbEscalate = [authMiddleware, requirePermission('customer_bills.manage_escalations')];
const cbExportColl = [authMiddleware, requirePermission('customer_bills.export_collections')];

// Collections Dashboard
router.get('/collections/dashboard', cbCollections, controller.getCollectionsDashboard.bind(controller));

// Collection Rules
router.get('/collection-rules', cbManageRules, controller.listCollectionRules.bind(controller));
router.get('/collection-rules/:id', cbManageRules, controller.getCollectionRule.bind(controller));
router.post('/collection-rules', cbManageRules, controller.createCollectionRule.bind(controller));
router.put('/collection-rules/:id', cbManageRules, controller.updateCollectionRule.bind(controller));
router.delete('/collection-rules/:id', cbManageRules, controller.deleteCollectionRule.bind(controller));

// Dunning
router.post('/dunning/run', cbExecute, controller.runDunning.bind(controller));
router.get('/dunning/actions', cbExecute, controller.getDunningActions.bind(controller));

// Collection Actions
router.get('/collection-actions', cbExecute, controller.listCollectionActions.bind(controller));
router.get('/collection-actions/:id', cbExecute, controller.getCollectionAction.bind(controller));
router.post('/collection-actions', cbExecute, controller.createCollectionAction.bind(controller));
router.post('/collection-actions/:id/execute', cbExecute, controller.executeCollectionAction.bind(controller));

// Communication Templates
router.get('/templates', cbManageRules, controller.listTemplates.bind(controller));
router.get('/templates/:id', cbManageRules, controller.getTemplate.bind(controller));
router.post('/templates', cbManageRules, controller.createTemplate.bind(controller));

// Interest Calculation
router.get('/interest-rules', cbInterest, controller.listInterestRules.bind(controller));
router.get('/interest-rules/:id', cbInterest, controller.getInterestRule.bind(controller));
router.post('/interest-rules', cbInterest, controller.createInterestRule.bind(controller));
router.get('/bills/:billId/interest/calculate', cbInterest, controller.calculateInterest.bind(controller));
router.post('/bills/:billId/interest/charges', cbInterest, controller.createInterestCharge.bind(controller));
router.post('/interest-charges/:id/approve', cbApproveInterest, controller.approveInterestCharge.bind(controller));
router.post('/interest-charges/:id/post', cbApproveInterest, controller.postInterestCharge.bind(controller));

// Bad Debt
router.get('/bad-debt', cbBadDebt, controller.listBadDebtCases.bind(controller));
router.get('/bad-debt/:id', cbBadDebt, controller.getBadDebtCase.bind(controller));
router.post('/bad-debt', cbBadDebt, controller.createBadDebtCase.bind(controller));
router.post('/bad-debt/:id/approve', cbApproveBadDebt, controller.approveBadDebtCase.bind(controller));
router.post('/bad-debt/:id/write-off', cbApproveBadDebt, controller.writeOffBadDebt.bind(controller));
router.post('/bad-debt/:id/reverse', cbApproveBadDebt, controller.reverseBadDebtCase.bind(controller));

// Payment Plans
router.get('/payment-plans', cbPlans, controller.listPaymentPlans.bind(controller));
router.get('/payment-plans/:id', cbPlans, controller.getPaymentPlan.bind(controller));
router.post('/payment-plans', cbPlans, controller.createPaymentPlan.bind(controller));
router.post('/payment-plans/:id/approve', cbPlans, controller.approvePaymentPlan.bind(controller));
router.post('/payment-plans/:id/cancel', cbPlans, controller.cancelPaymentPlan.bind(controller));
router.post('/payment-plans/:id/apply-payment', cbPlans, controller.applyPaymentToPlan.bind(controller));

// Risk Scoring
router.get('/customers/:contactId/risk', cbRisk, controller.calculateRiskScore.bind(controller));

// Forecast
router.get('/collection-forecast', cbCollections, controller.getCollectionForecast.bind(controller));

// Escalations
router.get('/escalations', cbEscalate, controller.listEscalations.bind(controller));
router.post('/escalations', cbEscalate, controller.createEscalation.bind(controller));
router.post('/escalations/:id/approve', cbEscalate, controller.approveEscalation.bind(controller));

module.exports = router;
