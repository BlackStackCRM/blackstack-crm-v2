const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { requireMotherCompany, MOTHER_COMPANY_PERMISSIONS: P } = require('../middleware/motherCompany');
const { getConn } = require('../utils/db');
const { successResponse } = require('../utils/response');
const { WalletSubscriptionService } = require('../services/walletSubscription.service');
const { snakeToCamel } = require('../utils/caseConverter');

const router = express.Router();
router.use(authMiddleware);
router.use(requireMotherCompany(P.SUBSCRIPTIONS_MANAGE));
const service = () => new WalletSubscriptionService(getConn());

router.get('/', (req,res,next) => {
  try { res.json(successResponse({ subscriptions:service().subscriptions(), plans:service().plans(), renewals:getConn().all('SELECT r.*,c.name AS account_name FROM subscription_renewal_attempts r JOIN companies c ON c.id=r.company_id ORDER BY attempted_at DESC LIMIT 500') })); } catch(e) { next(e); }
});
router.post('/plans', (req,res,next) => {
  try { res.status(201).json(successResponse(service().createPlan(req.user.userId,snakeToCamel(req.body)))); } catch(e) { next(e); }
});
router.patch('/plans/:id', (req,res,next) => {
  try { res.json(successResponse(service().updatePlan(req.user.userId,req.params.id,snakeToCamel(req.body)))); } catch(e) { next(e); }
});
router.post('/:companyId/assign', (req,res,next) => {
  try { res.status(201).json(successResponse(service().assignSubscription(req.user.userId,req.params.companyId,snakeToCamel(req.body)))); } catch(e) { next(e); }
});
router.patch('/:id', (req,res,next) => {
  try { res.json(successResponse(service().updateSubscription(req.user.userId,req.params.id,snakeToCamel(req.body)))); } catch(e) { next(e); }
});

module.exports = router;
