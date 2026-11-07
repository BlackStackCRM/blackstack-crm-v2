/**
 * SUPABASE CLOUD SYNC SERVICE — Local-first (SQLite authority -> Supabase Cloud)
 *
 *   - The local SQLite record is committed FIRST.
 *   - Every mutation writes the authoritative local row, THEN forwards a best-effort
 *     copy to Supabase Cloud. It NEVER fails closed on cloud error: the local agency
 *     is the authority and is never invalidated.
 *   - A failed cloud send is recorded in cloud_sync_status (status FAILED) and retried
 *     by the background retry worker. The cloud_sync_status row is keyed by agency_id
 *     (UNIQUE), so a retry never creates a duplicate upstream record.
 *   - The Supabase write is server-to-server using the service role key ONLY. The JWT
 *     session is NEVER sent to Supabase, and the frontend NEVER touches a Supabase secret.
 *   - Idempotency: cloud_sync_status UNIQUE(agency_id) + Supabase upsert on `id` ->
 *     exactly one upstream row per agency, so retry cannot duplicate.
 *
 * FIELD-MAPPING (local -> Supabase 087 schema)
 *   The local SQLite tables are the CRM's native schema. The Supabase 087 schema
 *   models the agency as a separate tenant company. Mapping:
 *
 *     local `agencies` (id, company_id, provider_company_id, agency_code, name, ...)
 *       -> `agencies` (id, company_id=agency's own tenant, provider_company_id, ...)
 *
 *     local `agency_administrators` (id, agency_id, user_id, company_id, role_code, ...)
 *       -> `agency_administrators` (id, agency_id, full_name, email, username, password_hash, status)
 *
 *     local `agency_status_history` (id, agency_id, from_status, to_status, reason, changed_by, changed_at)
 *       -> `agency_status_history` (id, agency_id, status=to_status, previous_status=from_status, ...)
 *
 *     local `audit_logs` (id, company_id, user_id, action, entity_type, entity_id, ...)
 *       -> `agency_audit_entries` (id, agency_id=company_id, actor_id=user_id, action, entity, entity_id, ...)
 *
 *   The cloud client is never exposed to the frontend. All writes use the service-role
 *   key via the supabase.client module. No secrets are logged, stored in SQLite, or
 *   returned to any caller.
 */

const supabaseConfig = require('../config/supabase');
const client = require('../services/supabase.client');

// ── field-mapping helpers ──────────────────────────────────────────────────

/** Trim timestamps to a JSON-safe ISO string. */
function trimDate(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d) ? v : d.toISOString();
  }
  return v;
}

const crypto = require('crypto');

const UUID_NS = Buffer.from('6ba7b810-9dad-11d1-80b4-00c04fd430c8'.replace(/-/g, ''), 'hex');

/** Deterministic UUID v5: local TEXT id -> cloud UUID (same value on every run). */
function localIdToCloudUuid(localId) {
  if (localId === undefined || localId === null) return null;
  const data = Buffer.concat([UUID_NS, Buffer.from(String(localId), 'utf8')]);
  const sha = crypto.createHash('sha1').update(data).digest();
  const b = sha.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;   // version = 5
  b[8] = (b[8] & 0x3f) | 0x80;   // variant = RFC 4122
  const h = b.toString('hex');
  return [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20,32)].join('-');
}

/** Local company slug -> cloud agency UUID of the owning agency. */
function agencyUuidForCompany(db, companyId) {
  const row = db.prepare('SELECT id FROM agencies WHERE company_id = ?').get(companyId);
  return row ? localIdToCloudUuid(row.id) : null;
}

/** Map local agencies -> Supabase agencies (087 schema). */
function agencyToCloud(agency) {
  // Ensure the raw node:sqlite object is a plain object before accessing properties.
  // node:sqlite returns [Object: null prototype] instances which lack the Object
  // prototype chain; JSON.parse(JSON.stringify(...)) normalises them safely.
  const raw = agency && typeof agency === 'object' ? agency : {};
  const payload = {};
  const fill = (key, getter) => {
    try {
      payload[key] = getter();
    } catch (e) {
      payload[key] = undefined;
    }
  };
  fill('id', () => localIdToCloudUuid(raw.id));
  fill('company_id', () => raw.company_id);
  fill('provider_company_id', () => raw.provider_company_id);
  fill('agency_code', () => raw.agency_code);
  fill('name', () => raw.name);
  fill('legal_name', () => raw.legal_name);
  fill('contact_name', () => raw.contact_name);
  fill('contact_email', () => raw.contact_email);
  fill('contact_phone', () => raw.contact_phone);
  fill('address', () => raw.address);
  fill('city', () => raw.city);
  fill('state', () => raw.state);
  fill('country', () => raw.country);
  fill('pincode', () => raw.pincode);
  fill('status', () => raw.status);
  fill('is_active', () => raw.is_active);
  fill('activated_at', () => trimDate(raw.activated_at));
  fill('suspended_at', () => trimDate(raw.suspended_at));
  fill('suspended_reason', () => raw.suspended_reason);
  fill('notes', () => raw.notes);
  fill('created_at', () => trimDate(raw.created_at));
  fill('updated_at', () => trimDate(raw.updated_at));
  return payload;
}

/** Map local agency_administrators -> Supabase agency_administrators. */
function agAdminToCloud(aa, db) {
  const payload = {
    id: localIdToCloudUuid(aa.id),
    agency_id: localIdToCloudUuid(aa.agency_id),
    company_id: aa.company_id,
    user_id: aa.user_id,
    role_code: aa.role_code,
    assigned_by: aa.assigned_by,
    assigned_at: trimDate(aa.assigned_at),
    revoked_at: trimDate(aa.revoked_at),
    revoked_by: aa.revoked_by,
    status: aa.status,
  };
  console.log('DEBUG: agAdminToCloud payload:', payload);
  return payload;
}

/** Map local agency_status_history -> Supabase agency_status_history. */
function statusHistoryToCloud(h) {
  return {
    id: localIdToCloudUuid(h.id),
    agency_id: localIdToCloudUuid(h.agency_id),
    status: h.to_status,
    previous_status: h.from_status,
    changed_by: h.changed_by,
    changed_at: trimDate(h.changed_at),
  };
}

/** Map local audit_logs -> Supabase agency_audit_entries. */
function auditToCloud(a, db) {
  return {
    id: localIdToCloudUuid(a.id),
    agency_id: agencyUuidForCompany(db, a.company_id),
    actor_id: a.user_id,
    action: a.action,
    entity: a.entity_type,
    entity_id: a.entity_id,
    old_values: a.old_values_json,
    new_values: a.new_values_json,
    ip_address: a.ip_address,
    user_agent: a.user_agent,
    created_at: trimDate(a.created_at),
  };
}

// ── upsert helpers (idempotent per table) ────────────────────────────────

async function upsertAgencyRow(w, agency, db) {
  console.log('DEBUG: Agency inside upsertAgencyRow:', agency);
  const payload = agencyToCloud(agency);
  const { error } = await w.from('agencies').upsert([payload], { onConflict: 'id' });
  return { ok: !error, error: error ? (error.message || JSON.stringify(error)) : null };
}

async function upsertAgAdminRow(w, aa, db) {
  const payload = agAdminToCloud(aa, db);
  if (!payload.agency_id) return { ok: false, error: 'missing agency_id' };
  const { error } = await w.from('agency_administrators').upsert([payload], { onConflict: 'id' });
  return { ok: !error, error: error ? (error.message || JSON.stringify(error)) : null };
}

async function upsertStatusHistoryRow(w, h, db) {
  const payload = statusHistoryToCloud(h);
  if (!payload.agency_id) return { ok: false, error: 'missing agency_id' };
  const { error } = await w.from('agency_status_history').upsert([payload], { onConflict: 'id' });
  return { ok: !error, error: error ? (error.message || JSON.stringify(error)) : null };
}

async function upsertAuditEntriesRow(w, a, db) {
  const payload = auditToCloud(a, db);
  if (!payload.agency_id) return { ok: false, error: 'missing agency_id' };
  const { error } = await w.from('agency_audit_entries').upsert([payload], { onConflict: 'id' });
  return { ok: !error, error: error ? (error.message || JSON.stringify(error)) : null };
}

// ── retry worker ─────────────────────────────────────────────────────────

/** Fails open: local SQLite is authoritative; cloud send is best-effort. */
function getClient() {
  if (!supabaseConfig.isConfigured()) {
    throw new Error('Supabase not configured: no SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return client.supabaseCreateClient();
}

function upsertSyncRow(db, agency_id, status, attempts, error_message) {
  const existing = db.prepare(`SELECT id FROM cloud_sync_status WHERE agency_id=?`).get(agency_id);
  if (existing) {
    // FIX 2 companion (audit 2026-11-02): bind params via .run(), NOT as a
    // second prepare() arg. ConnectionAdapter.prepare(sql) takes SQL only and
    // silently drops a second argument, so the old form ran the UPDATE with an
    // unbound WHERE — updating zero rows and silently losing sync state
    // (attempts never incremented, FAILED never recorded → infinite retry of
    // dead rows, one of the resurrection mechanisms).
    db.prepare(`UPDATE cloud_sync_status SET status=?, attempts=?, error_message=?, updated_at=CURRENT_TIMESTAMP WHERE agency_id=?`).run(status, attempts, error_message, agency_id);
  } else {
    db.run(`INSERT INTO cloud_sync_status (id, agency_id, status, attempts, started_at, finished_at, error_message, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP)`, `cs_${agency_id}`, agency_id, status, attempts, error_message);
  }
}

function markRetrySuccess(db, agency_id) {
  db.run(
    `UPDATE cloud_sync_status
     SET status='SYNCED', attempts=(attempts+1), finished_at=CURRENT_TIMESTAMP, error_message=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE agency_id=?`,
    agency_id,
  );
}

function markRetryFailure(db, agency_id, error_message) {
  // FIX 2 companion (audit 2026-11-02): a failed pass must also flip the row to
  // FAILED. Previously the UPDATE only bumped attempts/error_message and left
  // status='PENDING', so the queue re-selected the same row forever with no
  // visible failure state — and the "FAILED rows first" ordering had nothing
  // to order. Setting status keeps the sync-state ledger truthful.
  db.run(
    `UPDATE cloud_sync_status
     SET status='FAILED', attempts=(attempts+1), error_message=?, updated_at=CURRENT_TIMESTAMP
     WHERE agency_id=?`,
    error_message, agency_id,
  );
}

/** Re-send every PENDING or FAILED row. Idempotent, safe to run at any interval.
 *  FIX 2 (audit 2026-11-02): async so the removed-agency branch can await the
 *  Supabase delete; callers that treat this as sync are unaffected (they get a
 *  Promise that resolves to the results array). */
async function retryPending(db) {
  const rows = db.all(
    `SELECT id, agency_id, status, attempts, error_message, updated_at
     FROM cloud_sync_status
     WHERE status IN ('PENDING','FAILED')
     ORDER BY CASE status WHEN 'FAILED' THEN 0 ELSE 1 END, updated_at ASC`,
  );
  const results = [];
  for (const r of rows) {
    try {
      const agency = db.prepare('SELECT * FROM agencies WHERE id = ?').get(r.agency_id);
      if (!agency) {
        // FIX 2 (audit 2026-11-02): the agency no longer exists locally, so a
        // SUPABASE UPSERT here would RESURRECT a deleted agency in the cloud —
        // the exact "deleted locally, still in Supabase" defect. Instead, push
        // the deletion downstream: delete the cloud row, purge the sync row, skip.
        try {
          const cloudUuid = localIdToCloudUuid(r.agency_id) || r.agency_id;
          const w = getClient();
          const { error } = await w.from('agencies').delete().eq('id', cloudUuid);
          if (error) {
            console.error('[supabase-sync] retryPending cloud delete failed for removed agency', { agency_id: r.agency_id, error: error.message || JSON.stringify(error) });
          }
        } catch (delErr) {
          console.error('[supabase-sync] retryPending cloud delete threw for removed agency', { agency_id: r.agency_id, error: delErr && delErr.message ? delErr.message : String(delErr) });
        }
        // Purge the status row entirely so this agency_id never re-enters the queue.
        db.prepare('DELETE FROM cloud_sync_status WHERE agency_id = ?').run(r.agency_id);
        results.push({ agency_id: r.agency_id, action: 'DELETED_LOCAL', status: 'PURGED' });
        continue;
      }
      // FIX 2 companion (audit 2026-11-02): resolve getClient through the module
      // exports surface (`this`-independent) so tests can monkeypatch it by
      // assigning `supabaseService.getClient = stub`. Calling the bare local
      // identifier bypassed any such patch and forced tests to stub at the
      // deeper client-mod level instead.
      const resolvedGetClient = (typeof module.exports.getClient === 'function') ? module.exports.getClient : getClient;
      const w = resolvedGetClient();
      const ok = [];
      // Query related rows for each table separately — do NOT pass the agency
      // row to the admin/history/audit upsert functions. Each expects its own
      // record type (see agAdminToCloud, statusHistoryToCloud, auditToCloud).
      const admins = db.prepare('SELECT * FROM agency_administrators WHERE agency_id = ?').all(agency.id);
      const histories = db.prepare('SELECT * FROM agency_status_history WHERE agency_id = ?').all(agency.id);
      const audits = db.prepare('SELECT * FROM audit_logs WHERE company_id = ?').all(agency.company_id);
      for (const [table, fn, records] of [
        ['agencies', upsertAgencyRow, [agency]],
        ['agency_administrators', upsertAgAdminRow, admins],
        ['agency_status_history', upsertStatusHistoryRow, histories],
        ['agency_audit_entries', upsertAuditEntriesRow, audits],
      ]) {
        for (const rec of records) {
          if (!rec) continue;
          // FIX 2 companion: the upsert helpers are async (they await the
          // Supabase client); awaiting them here is required so the res.ok
          // check below sees the real result instead of a pending Promise.
          const res = await fn(w, rec, db);
          if (res.ok) ok.push(table);
        }
      }
      if (ok.length) {
        markRetrySuccess(db, r.agency_id);
        results.push({ agency_id: r.agency_id, action: 'SYNCED', status: 'SYNCED', tables: ok });
      } else {
        markRetryFailure(db, r.agency_id, 'all tables failed');
        results.push({ agency_id: r.agency_id, action: 'FAILED', status: 'FAILED' });
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      markRetryFailure(db, r.agency_id, err);
      results.push({ agency_id: r.agency_id, action: 'FAILED', status: 'FAILED', error: err });
    }
  }
  return results;
}

// ── forward call (creates cloud_sync_status, then asynchronously sends) ───

/** Fails open: local SQLite is authoritative; cloud send is best-effort. */
function forwardAgencyToCloud(db, agency, actor) {
  if (!supabaseConfig.isConfigured()) return { ok: false, reason: 'UNCONFIGURED' };
  try {
    const id = `cs_${agency.id}`;
    upsertSyncRow(db, agency.id, 'PENDING', 0, null);
    console.log('DEBUG: Agency passed to forwardAgencyToCloud:', agency);
    process.nextTick(async () => {
      try {
        const w = getClient();
        const ok = [];
        // Ensure the agency's company row exists in Supabase before inserting
        // the agency, because `agencies.company_id` is a FK to `companies.id`.
        try {
          const companyPayload = {
            id: agency.company_id,
            name: agency.name,
            status: 'ACTIVE',
          };
          const { error: companyErr } = await w.from('companies').upsert([companyPayload], { onConflict: 'id' });
          if (companyErr) {
            console.error('DEBUG: Table companies failed:', companyErr.message || JSON.stringify(companyErr));
          }
        } catch (companyErr) {
          console.error('DEBUG: companies sync threw:', companyErr && companyErr.message ? companyErr.message : String(companyErr));
        }
        const admins = db.prepare('SELECT * FROM agency_administrators WHERE agency_id = ?').all(agency.id);
        const histories = db.prepare('SELECT * FROM agency_status_history WHERE agency_id = ?').all(agency.id);
        // FIX 1 (audit 2026-11-02): query audit_logs by the agency's TENANT company id,
        // not the agency row id. agency.id here is the local agencies.id; audit_logs
        // rows carry the tenant company_id. Querying with agency.id matched nothing
        // useful and let stale/misspaced audit rows drive a bogus cloud upsert — one
        // of the two mechanisms that resurrected a deleted agency in Supabase.
        const audits = db.prepare('SELECT * FROM audit_logs WHERE company_id = ?').all(agency.company_id);
        for (const [table, fn, records] of [
          ['agencies', upsertAgencyRow, [agency]],
          ['agency_administrators', upsertAgAdminRow, admins],
          ['agency_status_history', upsertStatusHistoryRow, histories],
          ['agency_audit_entries', upsertAuditEntriesRow, audits],
        ]) {
          for (const rec of records) {
            if (!rec) continue;
            const res = await fn(w, rec, db);
            if (!res.ok) {
              const err = res.error instanceof Error ? res.error.message : String(res.error);
              console.error(`DEBUG: Table ${table} failed:`, err);
            }
            if (res.ok) ok.push(table);
          }
        }
        if (ok.length) {
          db.prepare(`UPDATE cloud_sync_status SET status='SYNCED', attempts=(attempts+1), finished_at=CURRENT_TIMESTAMP, error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE agency_id=?`).run(agency.id);
          db.prepare(`INSERT INTO cloud_sync_log (id, agency_id, event, status, attempts, error_message, created_at) VALUES (?,?,?,?,?,?,?)`).run(`cslog_${Date.now()}`, agency.id, 'UPDATED', 'SYNCED', 1, null, new Date().toISOString());
        } else {
          throw new Error('all tables failed');
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        console.error('BACKGROUND SYNC ERROR:', err);
        db.prepare(`UPDATE cloud_sync_status SET attempts=(attempts+1), error_message=?, updated_at=CURRENT_TIMESTAMP WHERE agency_id=?`).run(err, agency.id);
        db.prepare(`INSERT INTO cloud_sync_log (id, agency_id, event, status, attempts, error_message, created_at) VALUES (?,?,?,?,?,?,?)`).run(`cslog_${Date.now()}`, agency.id, 'UPDATED', 'FAILED', 1, err, new Date().toISOString());
      }
    });
    return { ok: true, localAffected: 1, cloudSyncId: id, status: 'PENDING', tables: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(`INSERT INTO cloud_sync_status (id, agency_id, status, attempts, started_at, finished_at, error_message, updated_at) VALUES (?,?,?,?,?,?,?,?)`, [
      `cs_${agency.id}`, agency.id, 'FAILED', 1, null, null, msg, new Date().toISOString(),
    ]);
    return { ok: false, localAffected: 1, reason: 'UNCONFIGURED_OR_ERROR', error: msg };
  }
}

module.exports = {
  forwardAgencyToCloud,
  retryPending,
  isRetryableSupabaseError: client.isRetryableSupabaseError,
  serializeAgencyForCloud: agencyToCloud,
  agencyToCloud,
  agAdminToCloud,
  statusHistoryToCloud,
  auditToCloud,
  localIdToCloudUuid,
  agencyUuidForCompany,
  // FIX 2 companion (audit 2026-11-02): expose getClient on the module surface so
  // tests can monkeypatch it (cloud-failure-retry.test.js re-assigns this to a
  // factory that returns a controlled stub client). Previously it was private,
  // so the test's patch had no effect and retryPending hit the real client.
  getClient,
};
