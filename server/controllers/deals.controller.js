const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { validateCurrency, SUPPORTED_CURRENCIES } = require('../utils/currency');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { EventHooksService } = require('../services/event-hooks.service');
const { assertTenantRefs } = require('../utils/tenantScope');

class DealsController {
  constructor() {
    this.conn = getConn();
    this.hooks = new EventHooksService();
  }

  _getDefaultCurrency(companyId) {
    const row = this.conn.get('SELECT value FROM system_metadata WHERE key = ?', ['default_currency']);
    return validateCurrency(row ? row.value : 'USD');
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, status, stage_id, pipeline_id, contact_id, organization_id } = req.query;

      const where = [];
      const params = [];
      where.push('d.company_id = ?');
      params.push(req.user.companyId);
      if (search) { where.push('title LIKE ?'); params.push(`%${search}%`); }
      if (status) { where.push('d.status = ?'); params.push(status); }
      if (stage_id) { where.push('stage_id = ?'); params.push(stage_id); }
      if (pipeline_id) { where.push('pipeline_id = ?'); params.push(pipeline_id); }
      if (contact_id) { where.push('contact_id = ?'); params.push(contact_id); }
      if (organization_id) { where.push('organization_id = ?'); params.push(organization_id); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT d.*, c.first_name, c.last_name, o.name as organization_name
         FROM deals d
         LEFT JOIN contacts c ON c.id = d.contact_id AND c.company_id = d.company_id
         LEFT JOIN organizations o ON o.id = d.organization_id AND o.company_id = d.company_id
         ${whereSql} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM deals d ${whereSql}`, params).total;

      res.json(paginatedResponse(items, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get(`
        SELECT d.*,
          c.first_name || ' ' || c.last_name AS contact_name,
          c.id AS contact_id,
          o.name AS organization_name,
          o.id AS organization_id
        FROM deals d
        LEFT JOIN contacts c ON d.contact_id = c.id AND c.company_id = d.company_id
        LEFT JOIN organizations o ON d.organization_id = o.id AND o.company_id = d.company_id
        WHERE d.id = ? AND d.company_id = ?
        LIMIT 1
      `, [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Deal', req.params.id);
      res.json(successResponse(item));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const { title, description, contact_id, organization_id, pipeline_id, stage_id, value, currency, probability, expected_close_date, notes } = req.body;
      if (!title) throw new ValidationError('Title is required');
      if (!contact_id) throw new ValidationError('contact_id is required');
      if (!stage_id) throw new ValidationError('stage_id is required');
      const stage = this.conn.get('SELECT id FROM pipeline_stages WHERE id = ? AND company_id = ?', [stage_id, req.user.companyId]);
      if (!stage) throw new ValidationError('Invalid stage_id: stage does not exist or does not belong to this company');
      assertTenantRefs(this.conn, req.user.companyId, { contact_id, organization_id });

      const id = req.body.id ? undefined : generateId('deal');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      const validatedCurrency = currency && SUPPORTED_CURRENCIES.includes(currency) ? currency : (this._getDefaultCurrency(req.user.companyId));
      this.conn.run(`
        INSERT INTO deals (id, company_id, title, description, contact_id, organization_id, pipeline_id, stage_id, value, currency, probability, expected_close_date, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, title, description, contact_id, organization_id, pipeline_id, stage_id, value || 0, validatedCurrency, probability || 0, expected_close_date, req.body.status || 'OPEN', notes || null, now, now]);

      res.status(201).json(successResponse(this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [id, req.user.companyId]), 201));

      const deal = this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [id, req.user.companyId]);
      this.hooks.onDealCreated(req.user.companyId, deal);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Deal', req.params.id);

      const allowed = ['title', 'description', 'contact_id', 'organization_id', 'pipeline_id', 'stage_id', 'value', 'currency', 'probability', 'expected_close_date', 'status', 'lost_reason', 'notes'];
      const sets = [];
      const params = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      // Validate stage_id if provided
      if (req.body.stage_id) {
        const stage = this.conn.get('SELECT id FROM pipeline_stages WHERE id = ? AND company_id = ?', [req.body.stage_id, req.user.companyId]);
        if (!stage) throw new ValidationError('Invalid stage_id');
      }

      // Validate contact_id and organization_id if provided
      assertTenantRefs(this.conn, req.user.companyId, { contact_id: req.body.contact_id, organization_id: req.body.organization_id });

      // Validate pipeline_id if provided
      if (req.body.pipeline_id) {
        const pipeline = this.conn.get('SELECT id FROM pipelines WHERE id = ? AND company_id = ?', [req.body.pipeline_id, req.user.companyId]);
        if (!pipeline) throw new ValidationError('Invalid pipeline_id');
      }

      const now = new Date().toISOString();
      this.conn.run(`UPDATE deals SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params, now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }

  /**
   * Tables that must not be silently destroyed when a deal is deleted.
   *
   * CRM-04. `tasks`, `activities` and `appointments` are all ON DELETE CASCADE
   * from `deals`, so a bare DELETE used to destroy them with no warning and no
   * error — the outcome depended entirely on which unrelated child rows happened
   * to exist. This mirrors the policy already established for contacts
   * (server/controllers/contacts.controller.js).
   *
   * `invoices` / `payments` are RESTRICT at the schema level; they are listed so
   * the 409 names them instead of surfacing a raw SQLite message.
   */
  static DELETE_BLOCKERS = [
    { table: 'tasks',        label: 'task(s)' },
    { table: 'activities',   label: 'activity(ies)' },
    { table: 'appointments', label: 'appointment(s)' },
    { table: 'notes',        label: 'note(s)' },
    { table: 'invoices',     label: 'invoice(s)' },
    { table: 'payments',     label: 'payment(s)' },
  ];

  /** @returns {Array<{table:string,label:string,count:number}>} blockers */
  _dealDependents(dealId, companyId) {
    const found = [];
    for (const { table, label } of DealsController.DELETE_BLOCKERS) {
      try {
        const row = this.conn.get(
          `SELECT COUNT(*) AS c FROM ${table} WHERE deal_id = ?${table === 'payments' ? ' AND company_id = ?' : ''}`,
          table === 'payments' ? [dealId, companyId] : [dealId],
        );
        if (row && row.c > 0) found.push({ table, label, count: row.c });
      } catch { /* table absent in this schema — not a blocker */ }
    }
    return found;
  }

  /**
   * Permanently delete a deal, refusing when anything still references it.
   *
   * The dependency check and the DELETE run inside ONE `BEGIN IMMEDIATE`
   * transaction, so a dependency created between the check and the DELETE cannot
   * be silently lost — SQLite holds the write lock for the duration. A deal with
   * no dependents is still permanently deleted; no soft delete is introduced.
   */
  async remove(req, res, next) {
    const { AppError } = require('../utils/errors');
    try {
      // conn.transaction(fn) RETURNS a wrapper; it must be invoked.
      const runTx = this.conn.transaction(() => {
        const exists = this.conn.get(
          'SELECT COUNT(*) AS c FROM deals WHERE id = ? AND company_id = ?',
          [req.params.id, req.user.companyId],
        );
        if (!exists || exists.c === 0) throw new NotFoundError('Deal', req.params.id);

        const blockers = this._dealDependents(req.params.id, req.user.companyId);
        if (blockers.length) {
          const summary = blockers.map((b) => `${b.count} ${b.label}`).join(', ');
          throw new AppError(
            `Deal cannot be deleted because related records exist: ${summary}. `
            + 'Delete or reassign them first.',
            'ENTITY_HAS_DEPENDENCIES',
            409,
          );
        }

        const res2 = this.conn.run(
          'DELETE FROM deals WHERE id = ? AND company_id = ?',
          [req.params.id, req.user.companyId],
        );
        if (res2.changes === 0) throw new NotFoundError('Deal', req.params.id);
        return true;
      });

      const outcome = runTx();
      res.json(successResponse({ id: req.params.id, deleted: Boolean(outcome) }));
    } catch (err) {
      if (err.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY/i.test(String(err.message || ''))) {
        return next(new AppError(
          'Deal cannot be deleted because other records still reference it.',
          'ENTITY_HAS_DEPENDENCIES',
          409,
        ));
      }
      next(err);
    }
  }

  /**
   * CRM-03 — lifecycle policy for deal stage changes.
   *
   * `stage_id` was previously validated for EXISTENCE only, so any stage could
   * move to any other in any direction: a deal could regress from Closing back
   * to Discovery, skip stages, or be re-staged after being marked WON or LOST.
   *
   * Two rules, both derived from data already in the schema rather than invented:
   *   * `pipeline_stages.stage_order` defines funnel order, so a move may go
   *     forward or stay put, never backward.
   *   * `pipeline_stages.is_won` / `is_lost` mark terminal stages, and a deal
   *     whose `status` is already WON or LOST is closed — neither may be
   *     re-staged. Reopening is an explicit, separate route (`POST /:id/reopen`).
   */
  _assertStageTransition(companyId, dealId, nextStageId) {
    // Required here, not in the caller: `require` inside a method body is scoped to
    // that method, so a helper cannot see it. (This was a real ReferenceError:
    // the 409 surfaced as INTERNAL_ERROR.)
    const { AppError } = require('../utils/errors');
    const deal = this.conn.get(
      'SELECT id, stage_id, status FROM deals WHERE id = ? AND company_id = ?',
      [dealId, companyId],
    );
    // A phantom deal must be a 404, not a silent "success" that updated 0 rows.
    if (!deal) throw new NotFoundError('Deal', dealId);

    const from = deal.stage_id;
    if (from === nextStageId) return deal; // no-op re-stage is allowed

    if (deal.status === 'WON' || deal.status === 'LOST') {
      throw new AppError(
        `Deal is ${deal.status} and its stage can no longer be changed. `
        + 'Use POST /api/deals/:id/reopen to reopen it first.',
        'INVALID_STATE_TRANSITION',
        409,
      );
    }

    if (from) {
      const a = this.conn.get('SELECT stage_order FROM pipeline_stages WHERE id = ? AND company_id = ?', [from, companyId]);
      const b = this.conn.get('SELECT stage_order FROM pipeline_stages WHERE id = ? AND company_id = ?', [nextStageId, companyId]);
      if (a && b && b.stage_order < a.stage_order) {
        throw new AppError(
          `Invalid stage transition: cannot move backwards from order ${a.stage_order} to ${b.stage_order}.`,
          'INVALID_STATE_TRANSITION',
          409,
        );
      }
    }
    return deal;
  }

  async updateStage(req, res, next) {
    const { AppError } = require('../utils/errors');
    try {
      const { stage_id } = req.body;
      if (!stage_id) throw new ValidationError('stage_id is required');
      const stage = this.conn.get('SELECT * FROM pipeline_stages WHERE id = ? AND company_id = ?', [stage_id, req.user.companyId]);
      if (!stage) throw new NotFoundError('PipelineStage', stage_id);

      // CRM-03: validate the TRANSITION, not just that the stage exists.
      const oldStage = this._assertStageTransition(req.user.companyId, req.params.id, stage_id).stage_id;

      const now = new Date().toISOString();
      const res2 = this.conn.run('UPDATE deals SET stage_id = ?, probability = ?, updated_at = ? WHERE id = ? AND company_id = ?',
        [stage_id, stage.probability, now, req.params.id, req.user.companyId]);
      if (res2.changes === 0) throw new NotFoundError('Deal', req.params.id);
      const deal = this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      res.json(successResponse(deal));
      this.hooks.onDealStageChanged(req.user.companyId, req.params.id, oldStage, stage_id);
    } catch (err) { next(err); }
  }

  async markWon(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Deal', req.params.id);

      const now = new Date().toISOString();
      this.conn.run(`UPDATE deals SET status = ?, actual_close_date = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
        ['WON', now.slice(0, 10), now, req.params.id, req.user.companyId]);

      const stage = this.conn.get('SELECT pipeline_id FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (stage?.pipeline_id) {
        this.conn.run('UPDATE deals SET pipeline_id = ? WHERE id = ? AND company_id = ?', [stage.pipeline_id, req.params.id, req.user.companyId]);
      }

      res.json(successResponse(this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
      this.hooks.onDealWon(req.user.companyId, req.params.id);
    } catch (err) { next(err); }
  }

  async markLost(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Deal', req.params.id);

      const { lost_reason } = req.body;
      const now = new Date().toISOString();
      this.conn.run(`UPDATE deals SET status = ?, lost_reason = ?, actual_close_date = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
        ['LOST', lost_reason || null, now.slice(0, 10), now, req.params.id, req.user.companyId]);

      res.json(successResponse(this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
      this.hooks.onDealLost(req.user.companyId, req.params.id);
    } catch (err) { next(err); }
  }

  async markReopen(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Deal', req.params.id);

      const now = new Date().toISOString();
      this.conn.run(`UPDATE deals SET status = ?, actual_close_date = NULL, lost_reason = NULL, updated_at = ? WHERE id = ? AND company_id = ?`,
        ['OPEN', now, req.params.id, req.user.companyId]);
      res.json(successResponse(this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId])));
    } catch (err) { next(err); }
  }
}

module.exports = { DealsController };