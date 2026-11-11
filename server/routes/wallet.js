const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { getConn } = require('../utils/db');
const { successResponse } = require('../utils/response');
const { WalletSubscriptionService } = require('../services/walletSubscription.service');
const { requireMotherCompany, MOTHER_COMPANY_PERMISSIONS: P } = require('../middleware/motherCompany');
const { snakeToCamel } = require('../utils/caseConverter');

const router = express.Router();
router.use(authMiddleware);
const service = () => new WalletSubscriptionService(getConn());

const platformGuard = (permission) => (req,res,next) => {
  try {
    const caller=service().caller(req.user.userId);
    if (caller.role === 'platform') return requireMotherCompany(permission)(req,res,next);
    return next();
  } catch (e) { next(e); }
};
router.get('/', platformGuard(P.WALLETS_VIEW), (req,res,next) => {
  try { res.json(successResponse(service().listWallets(req.user.userId))); } catch (e) { next(e); }
});
router.get('/subscription', (req,res,next) => {
  try { res.json(successResponse(service().ownSubscription(req.user.userId))); } catch (e) { next(e); }
});
router.get('/subscription/plans', (req,res,next) => {
  try { res.json(successResponse({ plans: service().ownPlans(req.user.userId) })); } catch (e) { next(e); }
});
router.post('/subscription/plans', platformGuard(P.SUBSCRIPTIONS_MANAGE), (req,res,next) => {
  try {
    const body = snakeToCamel(req.body || {});
    res.status(201).json(successResponse(service().createPlan(req.user.userId, body)));
  } catch (e) { next(e); }
});
router.post('/subscription/pending', (req,res,next) => {
  try {
    const body = snakeToCamel(req.body || {});
    res.status(201).json(successResponse(service().createOwnPendingSubscription(req.user.userId, body.planId)));
  } catch (e) { next(e); }
});
router.post('/subscription/pending/:companyId', platformGuard(P.SUBSCRIPTIONS_MANAGE), (req,res,next) => {
  try {
    const body = snakeToCamel(req.body || {});
    res.status(201).json(successResponse(service().assignSubscription(req.user.userId, req.params.companyId, body)));
  } catch (e) { next(e); }
});
router.get('/:companyId', platformGuard(P.WALLETS_VIEW), (req,res,next) => {
  try { res.json(successResponse(service().walletDetails(req.user.userId,req.params.companyId))); } catch (e) { next(e); }
});
router.post('/credit', platformGuard(P.WALLETS_CREDIT), (req,res,next) => {
  try {
    const body=snakeToCamel(req.body);
    const result=service().credit(req.user.userId,body.companyId,body.amount,req.get('Idempotency-Key'),body.description);
    res.status(201).json(successResponse(result));
  } catch (e) { next(e); }
});
router.post('/subscription/pay', (req,res,next) => {
  try { res.json(successResponse(service().payOwnSubscription(req.user.userId))); } catch (e) { next(e); }
});

module.exports = router;
