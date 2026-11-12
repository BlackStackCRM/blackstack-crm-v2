'use strict';

const fs = require('fs');
const path = require('path');
const { _boundDbPath } = require('../database/connection');
const { retryPending } = require('./supabase.service');
const { supabaseCreateClient } = require('./supabase.client');
const { isConfigured: isSupabaseConfigured } = require('../config/supabase');
const { ValidationError } = require('../utils/errors');
const { generateId } = require('../utils/generateId');

const COUNT_TABLES = ['companies','users','agencies','customer_tenant_agencies','contacts','organizations','leads','deals','tasks','appointments','invoices','payments','audit_logs','cloud_sync_status','cloud_sync_log','auth_sessions'];
const TERMINAL_DEAL_STATUSES = ['CLOSED','CLOSED_WON','CLOSED_LOST','WON','LOST','ARCHIVED','DELETED'];
const SEARCH_SECRET_KEY = /password|token|secret|api.?key|private.?key|credential|authorization|hash|salt|cookie/i;
const SEARCH_PROTECTED_TABLES = new Set(['users','companies','agencies','roles','permissions','role_permissions','user_roles','system_metadata','schema_migrations','auth_sessions']);

function sanitizeSearchValue(value) {
  if(Array.isArray(value))return value.map(sanitizeSearchValue);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value).filter(([key])=>!SEARCH_SECRET_KEY.test(key)).map(([key,item])=>[key,sanitizeSearchValue(item)]));
  }
  if(typeof value==='string'){
    const trimmed=value.trim();
    if(trimmed.startsWith('{')||trimmed.startsWith('[')){
      try{return JSON.stringify(sanitizeSearchValue(JSON.parse(value)));}catch{}
    }
    return value.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED TOKEN]');
  }
  return value;
}

class StorageService {
  constructor(db) { this.db=db; }
  tableExists(name) { return !!this.db.get("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name=?", [name]); }
  async searchRecords(searchTerm) {
    const query=String(searchTerm||'').trim();
    if(query.length<2||query.length>200)throw new ValidationError('Search text must be between 2 and 200 characters.');
    const sensitive=SEARCH_SECRET_KEY;
    const escaped=query.replace(/[\\%_]/g,'\\$&');
    const pattern='%'+escaped+'%';
    const limit=300,records=[],seen=new Set();
    const tables=this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE").map(r=>String(r.name));
    const tableMeta=new Map();
    for(const table of tables){
      const quoted='"'+table.replace(/"/g,'""')+'"';
      const columns=this.db.all('PRAGMA table_info('+quoted+')')
        .filter(c=>!sensitive.test(String(c.name))&&String(c.type||'').toUpperCase()!=='BLOB');
      tableMeta.set(table,{quoted,columns});
    }
    const addRow=(table,row,matchedColumns,relation)=>{
      const key=String(row.id||'');
      const primary=tableMeta.get(table)?.columns.filter(column=>Number(column.pk)>0)||[];
      const hasSupportedKey=primary.length===1&&primary[0].name==='id';
      const dedupe=table+'\\u0000'+(key||JSON.stringify(row));
      if(seen.has(dedupe)||records.length>=limit)return false;
      seen.add(dedupe);
      records.push({table,recordId:key||null,data:row,matchedColumns,relation,removable:Boolean(key&&hasSupportedKey&&!SEARCH_PROTECTED_TABLES.has(table))});
      return true;
    };
    const tokens=new Set();
    const captureTokens=row=>{
      for(const [name,value] of Object.entries(row)){
        if(name==='id'||/_id$/i.test(name)){
          if(value!=null&&String(value).length>=3&&String(value).length<=200)tokens.add(String(value));
        }
      }
    };

    // First pass finds direct value matches. Search only non-secret, non-blob
    // columns; response rows use the same safe column allowlist.
    for(const table of tables){
      if(records.length>=limit)break;
      const meta=tableMeta.get(table),cols=meta.columns;
      if(!cols.length)continue;
      const searchable=cols.filter(c=>['TEXT','CHAR','VARCHAR','INTEGER','REAL','NUMERIC',''].some(t=>String(c.type||'').toUpperCase().includes(t)));
      if(!searchable.length)continue;
      const selected=cols.map(c=>'"'+String(c.name).replace(/"/g,'""')+'"').join(',');
      const predicate=searchable.map(c=>'LOWER(CAST("'+String(c.name).replace(/"/g,'""')+'" AS TEXT)) LIKE ? ESCAPE \'\\\'').join(' OR ');
      const rows=this.db.all('SELECT '+selected+' FROM '+meta.quoted+' WHERE ('+predicate+') LIMIT 20',searchable.map(()=>pattern.toLowerCase()));
      for(const row of rows){
        const safe=Object.fromEntries(cols.map(c=>[c.name,sanitizeSearchValue(row[c.name])]));
        const matches=searchable.filter(c=>String(safe[c.name]??'').toLowerCase().includes(query.toLowerCase())).map(c=>c.name);
        if(matches.length){addRow(table,safe,matches,'match');captureTokens(safe);}
        if(records.length>=limit)break;
      }
    }

    // Follow database id / foreign-key-shaped columns one hop so an email hit
    // also reveals records linked by user_id/company_id, without broad joins or
    // restoring cloud data into SQLite.
    if(tokens.size&&records.length<limit){
      const wanted=new Set(tokens);
      for(const table of tables){
        if(records.length>=limit)break;
        const meta=tableMeta.get(table),idColumns=meta.columns.filter(c=>c.name==='id'||/_id$/i.test(String(c.name)));
        if(!idColumns.length)continue;
        const selected=meta.columns.map(c=>'"'+String(c.name).replace(/"/g,'""')+'"').join(',');
        const conditions=[],params=[];
        for(const col of idColumns){
          const name='"'+String(col.name).replace(/"/g,'""')+'"';
          conditions.push(name+' IN ('+[...wanted].map(()=>'?').join(',')+')');
          params.push(...wanted);
        }
        if(!conditions.length)continue;
        const rows=this.db.all('SELECT '+selected+' FROM '+meta.quoted+' WHERE ('+conditions.join(' OR ')+') LIMIT 20',params);
        for(const row of rows){
          const safe=Object.fromEntries(meta.columns.map(c=>[c.name,sanitizeSearchValue(row[c.name])]));
          const matches=idColumns.filter(c=>wanted.has(String(row[c.name]))).map(c=>c.name);
          addRow(table,safe,matches,'linked');
          if(records.length>=limit)break;
        }
      }
    }

    let cloud={configured:isSupabaseConfigured(),searched:false,records:[],truncated:false,message:null};
    if(cloud.configured){
      try{
        const supabase=supabaseCreateClient();
        const {data,error}=await supabase.rpc('storage_search_data',{p_search_term:query,p_max_results:limit});
        if(error)throw error;
        const rows=Array.isArray(data)?data:[];
        cloud={configured:true,searched:true,records:rows.map(row=>({table:row.table_name,recordId:row.record_id||row.row_data?.id||null,data:row.row_data||{},matchedColumns:row.matched_columns||[],relation:row.relation_type||'match',removable:Boolean((row.record_id||row.row_data?.id)&&!SEARCH_PROTECTED_TABLES.has(row.table_name))})),truncated:rows.length>=limit,message:null};
      }catch{
        cloud={configured:true,searched:false,records:[],truncated:false,message:'Cloud search is not ready. Apply the storage search database migration and verify the Supabase connection.'};
      }
    }
    return {query,local:{searched:true,records,truncated:records.length>=limit},cloud};
  }
  deleteSearchRecords(userId,body={}) {
    if(body.confirm!=='DELETE SELECTED DATA')throw new ValidationError('Type DELETE SELECTED DATA to confirm bulk removal.');
    const source=String(body.source||'');
    const records=Array.isArray(body.records)?body.records:[];
    if(!['local','cloud'].includes(source))throw new ValidationError('Choose Local SQLite or Supabase Cloud as the data source.');
    if(!records.length||records.length>300)throw new ValidationError('Select between 1 and 300 search results to remove.');
    const normalized=[...new Map(records.map(item=>[String(item.table||'')+'\\u0000'+String(item.recordId||''),{table:String(item.table||''),recordId:String(item.recordId||'')}])).values()];
    if(normalized.length!==records.length||normalized.some(item=>!item.table||!item.recordId||item.recordId.length>200))throw new ValidationError('The selected search results contain an invalid or duplicate record.');
    if(normalized.some(item=>SEARCH_PROTECTED_TABLES.has(item.table)))throw new ValidationError('Core accounts, companies, agencies, and system tables cannot be removed from search. Use their dedicated Storage actions.');
    if(source==='cloud'){
      return this.deleteCloudSearchRecords(userId,normalized);
    }
    const tableNames=this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row=>String(row.name));
    const selected=new Map(normalized.map(item=>[item.table+'\\u0000'+item.recordId,item]));
    const run=this.db.transaction(()=>{
      const rows=new Map();
      for(const item of normalized){
        if(!tableNames.includes(item.table))throw new ValidationError('A selected local table no longer exists. Refresh search results.');
        const quoted='"'+item.table.replace(/"/g,'""')+'"';
        const columns=this.db.all('PRAGMA table_info('+quoted+')');
        const primary=columns.filter(column=>Number(column.pk)>0);
        if(primary.length!==1||primary[0].name!=='id')throw new ValidationError('Bulk removal supports records with a single id key.');
        const row=this.db.get('SELECT * FROM '+quoted+' WHERE "id"=?',[item.recordId]);
        if(!row)throw new ValidationError('A selected local record no longer exists. Refresh search results.');
        rows.set(item.table+'\\u0000'+item.recordId,row);
      }

      // Do not allow deleting a parent when any dependent row is omitted from
      // this selection. Included children are deleted first; the whole SQLite
      // transaction rolls back if the selected graph contains a cycle/constraint.
      const dependencies=new Map(normalized.map(item=>[item.table+'\\u0000'+item.recordId,new Set()]));
      for(const item of normalized){
        const parentKey=item.table+'\\u0000'+item.recordId,parentRow=rows.get(parentKey);
        for(const childTable of tableNames){
          const childQuoted='"'+childTable.replace(/"/g,'""')+'"';
          let foreignKeys=[];try{foreignKeys=this.db.all('PRAGMA foreign_key_list('+childQuoted+')');}catch{continue;}
          for(const fk of foreignKeys.filter(entry=>entry.table===item.table)){
            const parentColumn=fk.to||'id';
            if(parentRow[parentColumn]===undefined)continue;
            const childColumns=this.db.all('PRAGMA table_info('+childQuoted+')');
            const childPk=childColumns.find(column=>column.name==='id')?'id':'rowid';
            let dependents=[];
            try{dependents=this.db.all('SELECT "'+childPk+'" AS selected_id FROM '+childQuoted+' WHERE "'+String(fk.from).replace(/"/g,'""')+'"=?',[parentRow[parentColumn]]);}catch{throw new ValidationError('Could not verify dependent records; nothing was removed.');}
            for(const dependent of dependents){
              const dependentKey=childTable+'\\u0000'+String(dependent.selected_id);
              if(!selected.has(dependentKey))throw new ValidationError('Related records in "'+childTable+'" must also be selected before removing this record.');
              dependencies.get(parentKey).add(dependentKey);
            }
          }
        }
      }

      let remaining=new Set(selected.keys()),deleted=0;
      while(remaining.size){
        let progressed=false;
        for(const key of [...remaining]){
          const pendingChildren=[...dependencies.get(key)].some(childKey=>remaining.has(childKey));
          if(pendingChildren)continue;
          const item=selected.get(key),quoted='"'+item.table.replace(/"/g,'""')+'"';
          const result=this.db.run('DELETE FROM '+quoted+' WHERE "id"=?',[item.recordId]);
          if(!Number(result.changes||0))throw new ValidationError('A selected record changed before removal; the transaction was rolled back.');
          remaining.delete(key);deleted++;progressed=true;
        }
        if(!progressed)throw new ValidationError('The selected records contain a dependency cycle; nothing was removed.');
      }
      this.audit(userId,'STORAGE_SEARCH_RECORDS_REMOVED','storage','search-results',{source,removed:deleted});
      return deleted;
    });
    const removed=run();
    return {source,removed};
  }
  async deleteCloudSearchRecords(userId,records) {
    if(!isSupabaseConfigured())throw new ValidationError('Supabase is not configured; cloud records were not removed.');
    let data,error;
    try{({data,error}=await supabaseCreateClient().rpc('storage_delete_search_data',{p_items:records.map(item=>({table_name:item.table,record_id:item.recordId}))}));}
    catch{throw new ValidationError('Cloud bulk removal is unavailable. Apply the Storage search database migration first.');}
    if(error)throw new ValidationError('Cloud bulk removal failed safely. No selected cloud records were removed.');
    const removed=Number(data?.removed||0);
    this.audit(userId,'STORAGE_SEARCH_RECORDS_REMOVED','storage','search-results',{source:'cloud',removed});
    return {source:'cloud',removed};
  }
  count(table, where = '', params = []) {
    if (!COUNT_TABLES.includes(table) || !this.tableExists(table)) return 0;
    return Number(this.db.get('SELECT COUNT(*) AS count FROM "'+table+'" '+where,params)?.count||0);
  }
  databasePath() {
    return _boundDbPath() || path.resolve(process.env.DB_PATH || path.join(__dirname,'../../data/blackstack-crm.db'));
  }
  sqliteMetrics() {
    const dbPath=this.databasePath();
    let databaseSizeBytes=0,walSizeBytes=0;
    try{databaseSizeBytes=fs.statSync(dbPath).size;}catch{}
    try{walSizeBytes=fs.statSync(dbPath+'-wal').size;}catch{}
    const rowCounts={};for(const table of COUNT_TABLES)rowCounts[table]=this.count(table);
    const softDeleted={
      inactiveUsers:this.count('users',"WHERE upper(coalesce(status,'')) IN ('INACTIVE','SUSPENDED','DELETED')"),
      terminatedAgencies:this.count('agencies',"WHERE upper(coalesce(status,'')) IN ('TERMINATED','DELETED')"),
      inactiveCompanies:this.count('companies',"WHERE upper(coalesce(status,'')) IN ('INACTIVE','SUSPENDED','DELETED')")
    };
    const sessions=this.tableExists('auth_sessions')?{
      active:this.count('auth_sessions',"WHERE revoked_at IS NULL AND datetime(expires_at)>datetime('now')"),
      expired:this.count('auth_sessions',"WHERE datetime(expires_at)<=datetime('now')"),
      revoked:this.count('auth_sessions',"WHERE revoked_at IS NOT NULL")
    }:{active:0,expired:0,revoked:0};
    return {databasePath:path.basename(dbPath),databaseSizeBytes:databaseSizeBytes+walSizeBytes,walSizeBytes,rowCounts,softDeleted,sessions};
  }
  async verifySupabase(createClient=supabaseCreateClient) {
    const checkedAt=new Date().toISOString();
    try {
      const supabase=createClient();
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),5000);
      try {
        const {error}=await supabase.from('agencies').select('id').limit(1).abortSignal(controller.signal);
        if(error)return {connected:false,checkedAt,message:'Supabase verification failed.'};
        return {connected:true,checkedAt,message:'Connected'};
      } finally { clearTimeout(timeout); }
    } catch {
      return {connected:false,checkedAt,message:'Supabase is unavailable or not configured.'};
    }
  }
  supabaseMetrics() {
    if(!this.tableExists('cloud_sync_status'))return {configured:false,pending:0,failed:0,synced:0,queue:[],recentFailures:[]};
    const pending=Number(this.db.get("SELECT COUNT(*) AS count FROM cloud_sync_status WHERE status='PENDING'")?.count||0);
    const failed=Number(this.db.get("SELECT COUNT(*) AS count FROM cloud_sync_status WHERE status='FAILED'")?.count||0);
    const synced=Number(this.db.get("SELECT COUNT(*) AS count FROM cloud_sync_status WHERE status='SYNCED'")?.count||0);
    const queue=this.db.all("SELECT s.agency_id,a.name AS agency_name,s.status,s.attempts,s.error_message,s.updated_at FROM cloud_sync_status s LEFT JOIN agencies a ON a.id=s.agency_id WHERE s.status IN ('PENDING','FAILED') ORDER BY CASE s.status WHEN 'FAILED' THEN 0 ELSE 1 END,s.updated_at ASC");
    const recentFailures=this.tableExists('cloud_sync_log')?this.db.all("SELECT agency_id,event,status,attempts,error_message,created_at FROM cloud_sync_log WHERE status='FAILED' ORDER BY created_at DESC LIMIT 100"):[];
    return {configured:true,pending,failed,synced,queue,recentFailures};
  }
  async purgeAllTenantData(platformUserId,body={}) {
    if(body.confirm!=='DELETE ALL DATA')throw new ValidationError('Type DELETE ALL DATA to confirm the factory reset.');
    const purgeSupabase=body.alsoPurgeSupabase===true;
    const platformUser=this.db.get('SELECT id,company_id FROM users WHERE id=?',[platformUserId]);
    if(!platformUser)throw new ValidationError('The current platform account could not be verified in the local database.');
    const admin=this.db.get("SELECT id,company_id FROM users WHERE lower(email)='admin@blackstack.local' LIMIT 1")||this.db.get("SELECT id,company_id FROM users WHERE id='admin' LIMIT 1");
    const keepUserIds=[...new Set([platformUser.id,admin&&admin.id].filter(Boolean))];
    const defaultCompany=this.db.get("SELECT id FROM companies WHERE id='default'");
    if(!defaultCompany)throw new ValidationError('The required default company is missing; factory reset was not started.');
    if([platformUser,admin].filter(Boolean).some(user=>String(user.company_id)!=='default'))throw new ValidationError('The platform admin is not linked to the default company; factory reset was not started.');

    // Preflight Supabase configuration before opening the local transaction.
    // The RPC is a single PostgreSQL transaction; an RPC error rolls SQLite back.
    const supabase=purgeSupabase?supabaseCreateClient():null;
    const {pauseRetryWorker,resumeRetryWorker}=require('./retry-worker');
    await pauseRetryWorker();
    let localDeleted={},cloudSummary=null;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const allTables=this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(r=>String(r.name));
        const excluded=new Set(['companies','users','roles','permissions','role_permissions','user_roles','auth_sessions','schema_migrations','system_metadata']);
        const purgeTables=new Set(['audit_logs','cloud_sync_status','cloud_sync_log']);
        const columns=new Map();
        for(const table of allTables){
          const safe=table.replace(/"/g,'""');
          const names=this.db.all('PRAGMA table_info("'+safe+'")').map(c=>c.name);
          columns.set(table,names);
          if(!excluded.has(table)&&names.includes('company_id'))purgeTables.add(table);
        }
        // Include dependent non-company tables (for example invoice lines and
        // agency history) so restrictive FKs are cleared child-first.
        let changed=true;
        while(changed){
          changed=false;
          for(const table of allTables){
            if(excluded.has(table)||purgeTables.has(table))continue;
            const safe=table.replace(/"/g,'""');
            const refs=this.db.all('PRAGMA foreign_key_list("'+safe+'")');
            if(refs.some(ref=>purgeTables.has(String(ref.table))||String(ref.table)==='companies')){
              purgeTables.add(table);changed=true;
            }
          }
        }
        const children=new Map();
        for(const table of purgeTables)children.set(table,[]);
        for(const table of purgeTables){
          const safe=table.replace(/"/g,'""');
          for(const ref of this.db.all('PRAGMA foreign_key_list("'+safe+'")')){
            const parent=String(ref.table);
            const onDelete=String(ref.on_delete||'').toUpperCase();
            if(purgeTables.has(parent)&&parent!==table&&(onDelete==='NO ACTION'||onDelete==='RESTRICT'))children.get(parent).push(table);
          }
        }
        const visiting=new Set(),visited=new Set(),ordered=[];
        const visit=table=>{
          if(visited.has(table))return;
          if(visiting.has(table))throw new Error('A foreign-key cycle prevents a safe factory reset.');
          visiting.add(table);
          for(const child of children.get(table)||[])visit(child);
          visiting.delete(table);visited.add(table);ordered.push(table);
        };
        for(const table of purgeTables)visit(table);

        const countFor=(table,where='',params=[])=>this.tableExists(table)?Number(this.db.get('SELECT COUNT(*) AS count FROM "'+table+'" '+where,params)?.count||0):0;
        const purgeBefore=Object.fromEntries([...purgeTables].map(table=>[table,countFor(table)]));
        const before={users:countFor('users'),companies:countFor('companies'),agencies:countFor('agencies'),customerAssignments:countFor('customer_tenant_agencies'),wallets:countFor('wallets'),contacts:countFor('contacts'),organizations:countFor('organizations'),leads:countFor('leads'),deals:countFor('deals'),tasks:countFor('tasks'),appointments:countFor('appointments'),invoices:countFor('invoices'),payments:countFor('payments'),auditLogs:countFor('audit_logs'),cloudSyncLogs:countFor('cloud_sync_log')};
        const keepMarks=keepUserIds.map(()=>'?').join(',');
        const usersResult=this.db.run('DELETE FROM users WHERE id NOT IN ('+keepMarks+')',...keepUserIds);
        localDeleted.users=Number(usersResult.changes||0);

        if(this.tableExists('roles')&&columns.get('roles')?.includes('company_id')){
          const systemColumn=columns.get('roles').includes('is_system')?'COALESCE(is_system,0)=0':'1=1';
          const roleResult=this.db.run("DELETE FROM roles WHERE company_id<>'default' AND "+systemColumn+" AND id NOT IN (SELECT role_id FROM user_roles WHERE user_id IN ("+keepMarks+"))",...keepUserIds);
          localDeleted.tenantRoles=Number(roleResult.changes||0);
        }
        for(const table of ordered){
          if(!this.tableExists(table))continue;
          const safe=table.replace(/"/g,'""');
          this.db.run('DELETE FROM "'+safe+'"');
          localDeleted[table]=purgeBefore[table]||0;
        }
        const companyResult=this.db.run("DELETE FROM companies WHERE id<>'default'");
        localDeleted.companies=Number(companyResult.changes||0);
        for(const table of purgeTables){if(countFor(table)!==0)throw new Error('Factory reset did not clear '+table+'; the transaction was rolled back.');}

        if(purgeSupabase){
          const {data,error}=await supabase.rpc('purge_all_tenant_data');
          if(error)throw new Error('Supabase purge failed; local changes were rolled back. '+(error.message||'Cloud RPC returned an error.'));
          cloudSummary=data||{};
        }
        this.db.exec('COMMIT');
        localDeleted.before=before;
      } catch(err) {
        try{this.db.exec('ROLLBACK');}catch{}
        throw err;
      }
    } finally {
      resumeRetryWorker();
    }

    let vacuumed=false,vacuumError=null;
    try{this.db.exec('VACUUM');vacuumed=true;}catch(err){vacuumError=err.message||'VACUUM failed.';}
    try{this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}
    const summaryItems=[
      [localDeleted.users,'users'],[localDeleted.companies,'companies'],[localDeleted.agencies,'agencies'],[localDeleted.customer_tenant_agencies,'customer assignments'],[localDeleted.wallets,'wallets'],[localDeleted.contacts,'contacts'],[localDeleted.organizations,'organizations'],[localDeleted.leads,'leads'],[localDeleted.deals,'deals'],[localDeleted.tasks,'tasks'],[localDeleted.appointments,'appointments'],[localDeleted.invoices,'invoices'],[localDeleted.payments,'payments'],[localDeleted.audit_logs,'audit logs'],[localDeleted.cloud_sync_log,'cloud sync log entries']
    ].filter(([count])=>Number(count||0)>0).map(([count,label])=>Number(count)+' '+label);
    const summary='Deleted '+(summaryItems.length?summaryItems.join(', '):'no tenant records')+'.';
    return {summary,deleted:localDeleted,retained:{users:keepUserIds.length,companies:1},cloudPurged:purgeSupabase,cloud:cloudSummary,vacuumed,vacuumError};
  }
  orphanRecords() {
    const marks=TERMINAL_DEAL_STATUSES.map(()=>'?').join(',');
    const deals=this.tableExists('deals')&&this.tableExists('companies')
      ? this.db.all("SELECT d.id,d.title,d.company_id,d.status,d.created_at FROM deals d LEFT JOIN companies c ON c.id=d.company_id WHERE c.id IS NULL AND upper(coalesce(d.status,'')) IN ("+marks+") ORDER BY d.created_at DESC",TERMINAL_DEAL_STATUSES)
        .map(row=>({type:'deal',id:row.id,label:row.title||row.id,companyId:row.company_id,status:row.status,createdAt:row.created_at,actionable:true,reason:'Missing tenant company and terminal status'}))
      : [];
    let orphanUsers=[];
    if(this.tableExists('users')&&this.tableExists('agency_administrators')&&this.tableExists('agencies')){
      orphanUsers=this.db.all("SELECT u.id,u.full_name,u.hierarchy_role,u.status,u.company_id FROM users u WHERE u.hierarchy_role IN ('agency','sub_agency') AND NOT EXISTS(SELECT 1 FROM agency_administrators aa WHERE aa.user_id=u.id AND upper(aa.status)='ACTIVE') AND NOT EXISTS(SELECT 1 FROM agencies a WHERE a.company_id=u.company_id) ORDER BY u.created_at DESC")
        .map(row=>({type:'user',id:row.id,label:row.full_name||row.id,companyId:row.company_id,status:row.status,actionable:false,suspendable:['ACTIVE','INACTIVE'].includes(upperStatus(row.status)),hardDeletable:upperStatus(row.status)==='SUSPENDED',reason:'Hierarchy user has no agency record; identity retained for manual repair'}));
    }
    const softDeleted=[];
    const listedUserIds=new Set(orphanUsers.map(row=>String(row.id)));
    if(this.tableExists('users')){
      softDeleted.push(...this.db.all("SELECT id,full_name AS label,company_id,status FROM users WHERE upper(coalesce(status,'')) IN ('INACTIVE','SUSPENDED','DELETED') ORDER BY updated_at DESC LIMIT 200").filter(r=>!listedUserIds.has(String(r.id))).map(r=>({...r,type:'inactive_user',actionable:false,suspendable:upperStatus(r.status)==='INACTIVE',hardDeletable:upperStatus(r.status)==='SUSPENDED',reason:'Inactive identity retained; review only'})));
    }
    if(this.tableExists('agencies')){
      softDeleted.push(...this.db.all("SELECT id,name AS label,company_id,status FROM agencies WHERE upper(coalesce(status,'')) IN ('TERMINATED','DELETED') ORDER BY updated_at DESC LIMIT 200").map(r=>({...r,type:'terminated_agency',actionable:false,reason:'Terminated agency retained; review only'})));
    }
    return {records:[...deals,...orphanUsers,...softDeleted],actionableCount:deals.length,reviewOnlyCount:orphanUsers.length+softDeleted.length};
  }
  hasForeignKeyDependents(targetTable,rowId) {
    const tables=this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    for(const table of tables){
      const name=String(table.name).replace(/"/g,'""');
      for(const ref of this.db.all('PRAGMA foreign_key_list("'+name+'")')){
        if(String(ref.table).toLowerCase()!==targetTable.toLowerCase())continue;
        const column=String(ref.from).replace(/"/g,'""');
        if(this.db.get('SELECT 1 AS found FROM "'+name+'" WHERE "'+column+'"=? LIMIT 1',[rowId]))return true;
      }
    }
    return false;
  }
  revalidateOrphanDeal(id) {
    const marks=TERMINAL_DEAL_STATUSES.map(()=>'?').join(',');
    const row=this.db.get("SELECT d.id,d.company_id,d.status FROM deals d LEFT JOIN companies c ON c.id=d.company_id WHERE d.id=? AND c.id IS NULL AND upper(coalesce(d.status,'')) IN ("+marks+")",[id,...TERMINAL_DEAL_STATUSES]);
    if(!row)return {eligible:false,reason:'Record is no longer an eligible terminal orphan.'};
    if(this.hasForeignKeyDependents('deals',id))return {eligible:false,reason:'Record has dependent rows; deletion skipped to prevent cascade loss.'};
    return {eligible:true,row};
  }
  purgeOrphans(userId,body) {
    const ids=Array.isArray(body.ids)?[...new Set(body.ids.map(String))]:[];
    if(!ids.length||ids.length>500)throw new ValidationError('Select between 1 and 500 orphan record IDs.');
    if(ids.some(id=>id.length>200))throw new ValidationError('Invalid orphan record ID.');
    const checks=ids.map(id=>({id,type:'deal',...this.revalidateOrphanDeal(id)}));
    if(body.dryRun===true)return {dryRun:true,eligible:checks.filter(x=>x.eligible).length,skipped:checks.filter(x=>!x.eligible)};
    if(body.confirm!=='DELETE')throw new ValidationError('Type DELETE to confirm orphan cleanup.');
    let deleted=0;const skipped=[];
    const run=this.db.transaction(()=>{
      for(const id of ids){
        const check=this.revalidateOrphanDeal(id);
        if(!check.eligible){skipped.push({id,reason:check.reason});continue;}
        try{
          this.db.exec('SAVEPOINT storage_orphan_delete');
          const marks=TERMINAL_DEAL_STATUSES.map(()=>'?').join(',');
          this.db.run("DELETE FROM deals WHERE id=? AND company_id=? AND upper(coalesce(status,'')) IN ("+marks+")",id,check.row.company_id,...TERMINAL_DEAL_STATUSES);
          this.db.exec('RELEASE SAVEPOINT storage_orphan_delete');deleted++;
        }catch(err){
          try{this.db.exec('ROLLBACK TO SAVEPOINT storage_orphan_delete');this.db.exec('RELEASE SAVEPOINT storage_orphan_delete');}catch{}
          skipped.push({id,reason:/constraint|foreign key/i.test(err.message)?'Foreign-key protection skipped this record.':'Delete failed; record was skipped.'});
        }
      }
      this.audit(userId,'STORAGE_ORPHANS_PURGED','storage_cleanup','orphan-deals',{deleted,skipped:skipped.length});
    });
    run();return {deleted,skipped};
  }
  deactivateOrphanUsers(userId,body) {
    const ids=Array.isArray(body.ids)?[...new Set(body.ids.map(String))]:[];
    if(!ids.length||ids.length>500)throw new ValidationError('Select between 1 and 500 active hierarchy accounts.');
    if(ids.some(id=>id.length>200))throw new ValidationError('Invalid hierarchy account ID.');
    if(body.confirm!=='DEACTIVATE')throw new ValidationError('Type DEACTIVATE to confirm account deactivation.');
    let deactivated=0,sessionsRevoked=0;const skipped=[];
    const run=this.db.transaction(()=>{
      for(const id of ids){
        const row=this.db.get("SELECT u.id,u.company_id FROM users u WHERE u.id=? AND u.hierarchy_role IN ('agency','sub_agency') AND upper(coalesce(u.status,''))='ACTIVE' AND NOT EXISTS(SELECT 1 FROM agency_administrators aa WHERE aa.user_id=u.id AND upper(aa.status)='ACTIVE') AND NOT EXISTS(SELECT 1 FROM agencies a WHERE a.company_id=u.company_id)",[id]);
        if(!row){skipped.push({id,reason:'Account is no longer an active orphaned hierarchy account.'});continue;}
        const result=this.db.run("UPDATE users SET status='INACTIVE',updated_at=CURRENT_TIMESTAMP WHERE id=? AND upper(coalesce(status,''))='ACTIVE'",id);
        if(!Number(result.changes||0)){skipped.push({id,reason:'Account status changed before deactivation.'});continue;}
        deactivated++;
        if(this.tableExists('auth_sessions'))sessionsRevoked+=Number(this.db.run('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL',id).changes||0);
      }
      this.audit(userId,'STORAGE_ORPHAN_HIERARCHY_USERS_DEACTIVATED','storage_cleanup','hierarchy-users',{requested:ids.length,deactivated,sessionsRevoked,skipped:skipped.length});
    });
    run();return {deactivated,sessionsRevoked,skipped};
  }
  suspendReviewUsers(userId,body) {
    const ids=Array.isArray(body.ids)?[...new Set(body.ids.map(String))]:[];
    if(!ids.length||ids.length>500)throw new ValidationError('Select between 1 and 500 review-only user IDs.');
    if(ids.some(id=>id.length>200))throw new ValidationError('Invalid review-only user ID.');
    if(body.confirm!=='SUSPEND')throw new ValidationError('Type SUSPEND to confirm record suspension.');
    let suspended=0,sessionsRevoked=0;const skipped=[];
    const run=this.db.transaction(()=>{
      for(const id of ids){
        const row=this.db.get("SELECT u.id,u.status,u.hierarchy_role,u.company_id FROM users u WHERE u.id=? AND upper(coalesce(u.status,'')) IN ('ACTIVE','INACTIVE') AND (upper(coalesce(u.status,''))='INACTIVE' OR (u.hierarchy_role IN ('agency','sub_agency') AND NOT EXISTS(SELECT 1 FROM agency_administrators aa WHERE aa.user_id=u.id AND upper(aa.status)='ACTIVE') AND NOT EXISTS(SELECT 1 FROM agencies a WHERE a.company_id=u.company_id)))",[id]);
        if(!row){skipped.push({id,reason:'User is no longer an eligible review-only record.'});continue;}
        const result=this.db.run("UPDATE users SET status='SUSPENDED',updated_at=CURRENT_TIMESTAMP WHERE id=? AND upper(coalesce(status,'')) IN ('ACTIVE','INACTIVE')",id);
        if(!Number(result.changes||0)){skipped.push({id,reason:'User status changed before suspension.'});continue;}
        suspended++;
        if(this.tableExists('auth_sessions'))sessionsRevoked+=Number(this.db.run('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL',id).changes||0);
      }
      this.audit(userId,'STORAGE_REVIEW_USERS_SUSPENDED','storage_cleanup','review-users',{requested:ids.length,suspended,sessionsRevoked,skipped:skipped.length});
    });
    run();return {suspended,sessionsRevoked,skipped};
  }
  hardDeleteSuspendedUsers(userId,body) {
    const ids=Array.isArray(body.ids)?[...new Set(body.ids.map(String))]:[];
    if(!ids.length||ids.length>500)throw new ValidationError('Select between 1 and 500 suspended user IDs.');
    if(ids.some(id=>id.length>200))throw new ValidationError('Invalid suspended user ID.');
    if(body.confirm!=='HARD DELETE')throw new ValidationError('Type HARD DELETE to confirm permanent user deletion.');
    let deleted=0;const skipped=[];
    const run=this.db.transaction(()=>{
      for(const id of ids){
        const row=this.db.get("SELECT id FROM users WHERE id=? AND upper(coalesce(status,''))='SUSPENDED'",[id]);
        if(!row){skipped.push({id,reason:'User is no longer suspended; only suspended users can be permanently deleted.'});continue;}
        try{
          this.db.exec('SAVEPOINT storage_user_hard_delete');
          const result=this.db.run("DELETE FROM users WHERE id=? AND upper(coalesce(status,''))='SUSPENDED'",id);
          if(!Number(result.changes||0))throw new Error('User status changed before deletion.');
          this.db.exec('RELEASE SAVEPOINT storage_user_hard_delete');deleted++;
        }catch(err){
          try{this.db.exec('ROLLBACK TO SAVEPOINT storage_user_hard_delete');this.db.exec('RELEASE SAVEPOINT storage_user_hard_delete');}catch{}
          skipped.push({id,reason:/constraint|foreign key/i.test(err.message)?'Related records prevent deletion; this user was preserved.':'Delete failed; this user was preserved.'});
        }
      }
      this.audit(userId,'STORAGE_SUSPENDED_USERS_HARD_DELETED','storage_cleanup','suspended-users',{requested:ids.length,deleted,skipped:skipped.length});
    });
    run();return {deleted,skipped};
  }
  hardDeleteSelectedNonAdminUsers(userId,body) {
    const ids=Array.isArray(body.ids)?[...new Set(body.ids.map(String))]:[];
    if(!ids.length||ids.length>500)throw new ValidationError('Select between 1 and 500 user IDs.');
    if(ids.some(id=>id.length>200))throw new ValidationError('Invalid user ID.');
    if(body.confirm!=='HARD DELETE')throw new ValidationError('Type HARD DELETE to confirm permanent user deletion.');
    let deleted=0;const skipped=[];
    const run=this.db.transaction(()=>{
      for(const id of ids){
        const row=this.db.get("SELECT id FROM users WHERE id=? AND id<>'admin' AND upper(coalesce(role,'')) NOT IN ('ADMIN','PLATFORM_ADMIN','SYSTEM_ADMIN','SUPER_ADMIN')",[id]);
        if(!row){skipped.push({id,reason:'User is missing or protected as an administrator.'});continue;}
        try{
          this.db.exec('SAVEPOINT storage_non_admin_user_delete');
          const result=this.db.run("DELETE FROM users WHERE id=? AND id<>'admin' AND upper(coalesce(role,'')) NOT IN ('ADMIN','PLATFORM_ADMIN','SYSTEM_ADMIN','SUPER_ADMIN')",id);
          if(!Number(result.changes||0))throw new Error('User changed before deletion.');
          this.db.exec('RELEASE SAVEPOINT storage_non_admin_user_delete');deleted++;
        }catch(err){
          try{this.db.exec('ROLLBACK TO SAVEPOINT storage_non_admin_user_delete');this.db.exec('RELEASE SAVEPOINT storage_non_admin_user_delete');}catch{}
          skipped.push({id,reason:/constraint|foreign key/i.test(err.message)?'Related records prevent deletion; this user was preserved.':'Delete failed; this user was preserved.'});
        }
      }
      this.audit(userId,'STORAGE_NON_ADMIN_USERS_HARD_DELETED','storage_cleanup','non-admin-users',{requested:ids.length,deleted,skipped:skipped.length});
    });
    run();return {deleted,skipped};
  }
  audit(userId,action,entityType,entityId,detail) {
    if(!this.tableExists('audit_logs'))return;
    this.db.run('INSERT INTO audit_logs(id,company_id,user_id,action,entity_type,entity_id,new_values_json,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)',generateId('aud'),'default',userId,action,entityType,entityId,JSON.stringify(detail||{}));
  }
  optimize(userId,confirm) {
    if(confirm!=='DELETE')throw new ValidationError('Type DELETE to confirm SQLite optimization.');
    const before=this.sqliteMetrics().databaseSizeBytes;
    this.db.exec('VACUUM');
    try{this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}
    const after=this.sqliteMetrics().databaseSizeBytes;
    this.audit(userId,'STORAGE_DATABASE_VACUUM','storage','sqlite',{beforeBytes:before,afterBytes:after});
    return {beforeBytes:before,afterBytes:after};
  }
  clearStaleSessions(userId,confirm) {
    if(confirm!=='DELETE')throw new ValidationError('Type DELETE to confirm stale session cleanup.');
    if(!this.tableExists('auth_sessions'))return {deleted:0};
    const result=this.db.run("DELETE FROM auth_sessions WHERE datetime(expires_at)<=datetime('now') OR (revoked_at IS NOT NULL AND datetime(revoked_at)<=datetime('now','-30 days'))");
    const deleted=Number(result.changes||0);
    this.audit(userId,'STORAGE_STALE_SESSIONS_CLEARED','storage','auth_sessions',{deleted});
    return {deleted};
  }
  async retryCloudSync(userId,body) {
    const ids=Array.isArray(body.agencyIds)?[...new Set(body.agencyIds.map(String))]:[];
    if(!ids.length||ids.length>500)throw new ValidationError('Select between 1 and 500 pending or failed sync items.');
    if(body.confirm!=='RETRY')throw new ValidationError('Confirm the selected cloud sync retry.');
    if(!this.tableExists('cloud_sync_status'))return {retried:0,results:[]};
    const existing=this.db.all("SELECT agency_id FROM cloud_sync_status WHERE status IN ('PENDING','FAILED') AND agency_id IN ("+ids.map(()=>'?').join(',')+")",ids).map(r=>r.agency_id);
    if(!existing.length)return {retried:0,results:[]};
    const results=await retryPending(this.db,{agencyIds:existing});
    this.audit(userId,'STORAGE_CLOUD_SYNC_RETRIED','storage','cloud-sync',{requested:ids.length,retried:results.length});
    return {retried:results.length,results};
  }
}

function upperStatus(value){return String(value||'').trim().toUpperCase();}

module.exports={StorageService,TERMINAL_DEAL_STATUSES};
