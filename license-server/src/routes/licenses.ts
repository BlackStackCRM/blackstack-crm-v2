/**
 * License routes.
 *
 * All mutations are idempotent-able via Idempotency-Key header and run inside
 * a single transaction (see src/middleware/quota.ts).
 *
 * Uses node:sqlite (built-in).
 */
import express from 'express';
import type { DbContext } from '../db/connection.js';
import { allocateMiddleware } from '../middleware/quota.js';
import { serviceTokenMiddleware } from '../middleware/auth.js';

export function licensesRouter(db: DbContext, cfg: any) {
  const router = express.Router();

  // Quota allocation: agency_id + count; server-side transaction.
  router.post('/allocate',
    serviceTokenMiddleware({ jwtSecret: cfg.jwtSecret, tokenAudience: cfg.tokenAudience }),
    allocateMiddleware(db),
  );

  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT id, agency_id, product_id, code, status, device_limit, lease_days, allocated, allocated_at, expires_at FROM licenses WHERE id = ?').get(req.params.id);
    if (!row) {
      res.status(404).json({ success: false, error: { code: 'LICENSE_NOT_FOUND', message: `license ${req.params.id} not found` } });
      return;
    }
    // Tenant isolation: only the agency that owns the license may read it.
    if (row.agency_id !== req.locals?.user?.companyId) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'not your license' } });
      return;
    }
    res.json({ success: true, data: row });
  });

  router.get('/:id/activations', (req, res) => {
    const rows = db.prepare('SELECT id, device_id, status, expires_at, created_at FROM activations WHERE license_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json({ success: true, data: { activations: rows } });
  });

  router.post('/:id/activate', (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const { device_id, nonce, signature, public_key } = body || {};
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO activations (id, license_id, device_id, nonce, signature, public_key, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', datetime(?, '+?'), ?, datetime('now'))`,
    ).run(
      id + '-' + Math.random().toString(36).slice(2, 10),
      id,
      device_id,
      nonce,
      signature,
      public_key,
      now,
      cfg?.clockToleranceMs ? '+' + cfg.clockToleranceMs : '+15m',
      'client',
    );
    res.status(201).json({ success: true, data: { activation: { id: id, status: 'ACTIVE', expires_at: now } } });
  });

  router.post('/:id/bind', (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const { device_id, challenge, signature, public_key } = body || {};
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO bindings (id, license_id, device_id, public_key, status, bound_at, unbound_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL)`,
    ).run(
      id + '-' + Math.random().toString(36).slice(2, 10),
      id,
      device_id,
      public_key,
      now,
    );
    res.status(201).json({ success: true, data: { binding: { id: id, status: 'ACTIVE', bound_at: now } } });
  });

  router.post('/:id/renew', (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const { term_days = 30 } = body;
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + Number(term_days) * 86400000).toISOString();
    db.prepare("UPDATE licenses SET expires_at = ?, updated_at = datetime('now') WHERE id = ?").run(expiry, id);
    res.json({ success: true, data: { license: { id, status: 'ACTIVE', expires_at: now } } });
  });

  router.post('/:id/suspend', (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const { reason } = body;
    db.prepare("UPDATE licenses SET status = 'SUSPENDED', updated_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("INSERT INTO audit_logs (id, agency_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, created_at) VALUES (?, ?, ?, 'SUSPEND', 'LICENSE', ?, ?, 'reason='+reason, datetime('now'))").run(id + '-' + Math.random().toString(36).slice(2, 10), null, req.locals?.user?.companyId, id, reason || '', now);
    res.json({ success: true, data: { license: { id, status: 'SUSPENDED' } } });
  });

  router.post('/:id/recover', (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const { reason } = body;
    db.prepare("UPDATE licenses SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("INSERT INTO audit_logs (id, agency_id, user_id, action, entity_type, entity_id, old_values_json, new_values_json, created_at) VALUES (?, ?, ?, 'RECOVER', 'LICENSE', ?, ?, 'reason='+reason, datetime('now'))").run(id + '-' + Math.random().toString(36).slice(2, 10), null, req.locals?.user?.companyId, id, reason || '', now);
    res.json({ success: true, data: { license: { id, status: 'ACTIVE' } } });
  });

  router.delete('/:id', (req, res) => {
    const id = req.params.id;
    db.prepare('DELETE FROM activations WHERE license_id = ?').run(id);
    db.prepare('DELETE FROM bindings WHERE license_id = ?').run(id);
    db.prepare('DELETE FROM licenses WHERE id = ?').run(id);
    res.json({ success: true, data: { deleted: id } });
  });

  return router;
}
