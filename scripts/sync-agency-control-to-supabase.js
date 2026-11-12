/**
 * Sync local Agency Control link tables to Supabase.
 *
 * Tables:
 *   - agency_parent_relationships
 *   - customer_tenant_agencies
 *   - customer_tenant_agency_history
 *
 * Uses localIdToCloudUuid() for agency FK mapping.
 * company_id / user_id fields are copied as-is (TEXT).
 */

require('dotenv').config();
const DatabaseSync = require('node:sqlite').DatabaseSync;
const { getSupabaseClient } = require('../server/config/supabase');
const { localIdToCloudUuid } = require('../server/services/supabase.service');

const DB_PATH = 'data/blackstack-crm.db';

async function sync() {
  const db = new DatabaseSync(DB_PATH);
  const sb = getSupabaseClient();

  // 0. Ensure parent companies exist in Supabase first to satisfy FKs.
  const companyRows = db.prepare('SELECT id, name, status FROM companies').all();
  console.log(`[SYNC] companies: ${companyRows.length} rows`);
  for (const row of companyRows) {
    const payload = {
      id: row.id,
      name: row.name,
      status: row.status || 'ACTIVE',
    };
    const { error } = await sb
      .from('companies')
      .upsert([payload], { onConflict: 'id' });
    if (error) {
      console.error('[SYNC] company upsert failed:', row.id, error.message);
    }
  }

  // 0.5. Ensure local agencies exist in Supabase before agency link tables.
  const { agencyToCloud } = require('../server/services/supabase.service');
  const agencyRows = db.prepare('SELECT * FROM agencies').all();
  console.log(`[SYNC] agencies: ${agencyRows.length} rows`);
  const companyIds = new Set(companyRows.map((r) => r.id));
  for (const agency of agencyRows) {
    const payload = agencyToCloud(agency);
    const { error } = await sb
      .from('agencies')
      .upsert([payload], { onConflict: 'id' });
    if (error) {
      console.error('[SYNC] agency upsert failed:', agency.id, error.message);
    }
    if (agency.company_id) companyIds.add(agency.company_id);
    if (agency.provider_company_id) companyIds.add(agency.provider_company_id);
  }

  // 0.6. Ensure any agency-linked companies exist too.
  console.log(`[SYNC] agency-linked companies: ${companyIds.size} ids`);
  for (const id of companyIds) {
    const payload = { id, name: id, status: 'ACTIVE' };
    const { error } = await sb
      .from('companies')
      .upsert([payload], { onConflict: 'id' });
    if (error) {
      console.error('[SYNC] linked company upsert failed:', id, error.message);
    }
  }

  // 1. agency_parent_relationships
  const parentRels = db.prepare('SELECT * FROM agency_parent_relationships').all();
  console.log(`[SYNC] agency_parent_relationships: ${parentRels.length} rows`);
  for (const row of parentRels) {
    const payload = {
      child_agency_id: localIdToCloudUuid(row.child_agency_id),
      parent_agency_id: localIdToCloudUuid(row.parent_agency_id),
      created_by: row.created_by || null,
      created_at: row.created_at || new Date().toISOString(),
    };
    const { error } = await sb
      .from('agency_parent_relationships')
      .upsert([payload], { onConflict: 'child_agency_id' });
    if (error) {
      console.error('[SYNC] parent rel upsert failed:', error.message);
    }
  }

  // 2. customer_tenant_agencies
  const customers = db.prepare('SELECT * FROM customer_tenant_agencies').all();
  console.log(`[SYNC] customer_tenant_agencies: ${customers.length} rows`);
  for (const row of customers) {
    const payload = {
      company_id: row.company_id,
      agency_id: localIdToCloudUuid(row.agency_id),
      provider_company_id: row.provider_company_id,
      assigned_by: row.assigned_by || null,
      assigned_at: row.assigned_at || new Date().toISOString(),
    };
    const { error } = await sb
      .from('customer_tenant_agencies')
      .upsert([payload], { onConflict: 'company_id' });
    if (error) {
      console.error('[SYNC] customer tenant upsert failed:', error.message);
    }
  }

  // 3. customer_tenant_agency_history
  const histories = db.prepare('SELECT * FROM customer_tenant_agency_history').all();
  console.log(`[SYNC] customer_tenant_agency_history: ${histories.length} rows`);
  for (const row of histories) {
    const payload = {
      id: row.id,
      company_id: row.company_id,
      old_agency_id: row.old_agency_id ? localIdToCloudUuid(row.old_agency_id) : null,
      new_agency_id: localIdToCloudUuid(row.new_agency_id),
      changed_by: row.changed_by || null,
      changed_at: row.changed_at || new Date().toISOString(),
    };
    const { error } = await sb
      .from('customer_tenant_agency_history')
      .upsert([payload], { onConflict: 'id' });
    if (error) {
      console.error('[SYNC] customer history upsert failed:', error.message);
    }
  }

  console.log('[SYNC] Done.');
}

sync().catch((err) => {
  console.error('[SYNC] Fatal error:', err);
  process.exit(1);
});
