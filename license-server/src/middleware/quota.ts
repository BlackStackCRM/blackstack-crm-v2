/**
 * Allocation and idempotency middleware for POST /api/licenses.
 *
 * Agency quota (§7 of the phase-1 architecture) is `license_quota`, set by
 * the Mother Company. Allocation must atomically check and increment agency
 * usage. The phase-2 license.db schema defines no quota row or cache mapping;
 * `licenses.device_limit` is per-license device capacity and is not agency
 * quota. The legacy row-sum check below therefore remains unresolved against
 * the authoritative quota model.
 *
 * Idempotency (§6.4): a same-key, same-payload repeat returns the stored
 * status and response without another allocation. The allocation and record
 * writes share one transaction.
 */

import type { Response, Request, NextFunction } from 'express';
import {
  getRecord,
  setRecord,
  computeFingerprint,
  createIdempotencyTable,
} from '../idempotency.js';

export interface DbContext {
  prepare: (sql: string) => any;
  run: (sql: string, ...params: any[]) => any;
  get: (sql: string, ...params: any[]) => any;
  all: (sql: string, ...params: any[]) => any;
  transaction: (fn: () => void) => () => void;
  close: () => void;
}

export function allocateMiddleware(db: DbContext) {
  // Ensure the idempotency table exists (once per DB bootstrap).
  createIdempotencyTable(db);

  return (
    req: Request & { locals: { user: { companyId: string } } },
    res: Response,
    next: NextFunction,
  ): void => {
    // 0. Read the Idempotency-Key header (optional, per spec §6.4).
    const idempotencyKey =
      (req.headers as any)?.['idempotency-key'] as string | undefined;

    const body = req.body as any;
    if (!body || !body.agency_id || !body.product_id || !Number.isInteger(body.count) || body.count < 1) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'agency_id, product_id and count (positive integer) are required' },
      });
      return;
    }
    const { agency_id, product_id, count } = body;

    // Track whether we opened a transaction, so we can roll back only when
    // a transaction is actually active (fail-closed, never double-rollback).
    let txActive = false;

    const begin = () => {
      db.prepare('BEGIN IMMEDIATE').run();
      txActive = true;
    };
    const commit = () => {
      db.prepare('COMMIT').run();
      txActive = false;
    };
    const rollback = () => {
      if (txActive) {
        db.prepare('ROLLBACK').run();
        txActive = false;
      }
    };

    begin();
    try {
      // 1. Idempotency check — inside the transaction so concurrent requests
      //    with the same key cannot both pass and both allocate.
      let recordStatus = 201;
      let recordBody: any;
      let isReplay = false;
      if (idempotencyKey) {
        const payload = {
          agency_id,
          product_id,
          count,
        };
        const fingerprint = computeFingerprint(payload);
        const existing = getRecord(db, idempotencyKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            rollback();
            res.status(409).json({
              success: false,
              error: {
                code: 'IDEMPOTENCY_KEY_REUSED',
                message: 'idempotency key already used with a different payload',
              },
            });
            return;
          }
          // getRecord returns the parsed response body. Reuse it directly;
          // repeats neither allocate again nor consume quota again.
          recordStatus = existing.status;
          recordBody = existing.body;
          isReplay = true;
        }
      }

      // Only a new request reaches the quota path; a replay must not consume
      // agency quota or create additional license rows.
      if (!isReplay) {
        // Legacy implementation: this sums per-license device capacity. It is
        // not the specified agency license_quota; see the module note above.
        const quota = db.prepare(
          `SELECT COALESCE(SUM(l.device_limit - l.allocated), 0) AS available
           FROM licenses l
           WHERE l.agency_id = ?
             AND l.status = ?`,
        ).get(agency_id, 'ACTIVE') as { available: number };

        if (quota.available < count) {
          rollback();
          res.status(409).json({
            success: false,
            error: { code: 'QUOTA_EXCEEDED', message: 'agency allocation exceeds quota', available: quota.available, needed: count },
          });
          return;
        }
      }

      // 3. Allocate `count` new entitlement licenses (one seat each).
      const codes: string[] = [];
      const now = new Date().toISOString();
      if (!isReplay) {
        for (let i = 0; i < count; i++) {
          let code: string;
          do {
            code = `LIC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
          } while (db.prepare('SELECT 1 FROM licenses WHERE code = ?').get(code));
          codes.push(code);
          db.prepare(
            `INSERT INTO licenses (id, agency_id, product_id, code, device_limit, lease_days, allocated, allocated_at, created_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
          ).run(
            code,
            agency_id,
            product_id || 'bscrm',
            code,
            1,
            30,
            req.locals.user.companyId,
            now,
          );
        }

        // 4. No-op: spec §3.3 says allocated is NOT incremented on allocate
        //    (only on bind/activate). The quota check is a guard that the
        //    number of unallocated seats is >= count, so allocate never
        //    decrements the quota. Seats are consumed on activate, not on
        //    allocation.
        // if (agency_id) {
        //   db.prepare(
        //     `UPDATE licenses
        //      SET allocated = allocated + 1,
        //          allocated_at = ?,
        //          updated_at = datetime('now')
        //      WHERE id = 'LIC-1'`,
        //   ).run(now);
        // }
      }

      // 5. Record idempotency inside the SAME transaction (before COMMIT).
      if (idempotencyKey && !isReplay && recordStatus === 201) {
        const reqBody = req.body as any;
        const payload = {
          agency_id: reqBody.agency_id,
          product_id: reqBody.product_id,
          count: reqBody.count,
        };
        setRecord(db, {
          key: idempotencyKey,
          fingerprint: computeFingerprint(payload),
          status: 201,
          body: {
            success: true,
            data: { licenses: codes.map((c) => ({ id: c, code: c, status: 'ACTIVE', device_limit: 1, lease_days: 30, allocated: 0, allocated_at: now, expires_at: null })) },
          },
          createdLicenseIds: codes,
          createdAt: now,
        });
      }

      if (isReplay) {
        commit();
        res.status(recordStatus).json(recordBody);
      } else {
        commit();
        res.status(201).json({
          success: true,
          data: { licenses: codes.map((c) => ({ id: c, code: c, status: 'ACTIVE', device_limit: 1, lease_days: 30, allocated: 0, allocated_at: now, expires_at: null })) },
        });
      }
    } catch (err) {
      rollback();
      console.error('[quota] middleware error:', err);
      throw err;
    }
  };
}
