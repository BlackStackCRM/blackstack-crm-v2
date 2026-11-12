'use strict';

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { resolveCaller } = require('../services/rbac.service');
const { getConn } = require('../utils/db');
const { AuthorizationError } = require('../utils/errors');
const { successResponse } = require('../utils/response');
const { snakeToCamel } = require('../utils/caseConverter');
const { StorageService } = require('../services/storage.service');

const router=express.Router();
router.use(authMiddleware);
router.use((req,res,next)=>{
  try {
    const caller=resolveCaller(getConn(),{userId:req.user.userId});
    if(!caller||caller.role!=='platform')throw new AuthorizationError('Platform administrator access required.');
    req.platformCaller=caller;
    next();
  } catch(err) { next(err); }
});
const service=()=>new StorageService(getConn());

router.get('/sqlite',(req,res,next)=>{
  try{res.json(successResponse(service().sqliteMetrics()));}catch(err){next(err);}
});
router.get('/supabase',(req,res,next)=>{
  try{res.json(successResponse(service().supabaseMetrics()));}catch(err){next(err);}
});
router.get('/supabase/verify',async(req,res,next)=>{
  try{res.json(successResponse(await service().verifySupabase()));}catch(err){next(err);}
});
router.get('/orphans',(req,res,next)=>{
  try{res.json(successResponse(service().orphanRecords()));}catch(err){next(err);}
});
router.get('/search',async(req,res,next)=>{
  try{res.json(successResponse(await service().searchRecords(req.query.q)));}catch(err){next(err);}
});
router.post('/search/remove',async(req,res,next)=>{
  try{res.json(successResponse(await service().deleteSearchRecords(req.user.userId,snakeToCamel(req.body||{}))));}catch(err){next(err);}
});
router.post('/orphans/purge',(req,res,next)=>{
  try{res.json(successResponse(service().purgeOrphans(req.user.userId,snakeToCamel(req.body||{}))));}catch(err){next(err);}
});
router.post('/orphans/deactivate',(req,res,next)=>{
  try{res.json(successResponse(service().deactivateOrphanUsers(req.user.userId,snakeToCamel(req.body||{}))));}catch(err){next(err);}
});
router.post('/orphans/suspend',(req,res,next)=>{
  try{res.json(successResponse(service().suspendReviewUsers(req.user.userId,snakeToCamel(req.body||{}))));}catch(err){next(err);}
});
router.post('/orphans/hard-delete',(req,res,next)=>{
  try{res.json(successResponse(service().hardDeleteSuspendedUsers(req.user.userId,snakeToCamel(req.body||{}))));}catch(err){next(err);}
});
router.post('/users/hard-delete',(req,res,next)=>{
  try{res.json(successResponse(service().hardDeleteSelectedNonAdminUsers(req.user.userId,snakeToCamel(req.body||{}))));}catch(err){next(err);}
});
router.post('/purge-all-data',async(req,res,next)=>{
  try{
    if(!req.platformCaller||req.platformCaller.role!=='platform')throw new AuthorizationError('Platform administrator access required.');
    res.json(successResponse(await service().purgeAllTenantData(req.user.userId,snakeToCamel(req.body||{}))));
  }catch(err){next(err);}
});
router.post('/sqlite/optimize',(req,res,next)=>{
  try{res.json(successResponse(service().optimize(req.user.userId,snakeToCamel(req.body||{}).confirm)));}catch(err){next(err);}
});
router.post('/supabase/retry',async(req,res,next)=>{
  try{res.json(successResponse(await service().retryCloudSync(req.user.userId,snakeToCamel(req.body||{}))));}catch(err){next(err);}
});
router.post('/sessions/clear',(req,res,next)=>{
  try{res.json(successResponse(service().clearStaleSessions(req.user.userId,snakeToCamel(req.body||{}).confirm)));}catch(err){next(err);}
});

module.exports=router;
