const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');

class OrganizationsController {
  constructor() {
    this.conn = getConn();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, status, industry } = req.query;

      const where = [];
      const params = [];
      where.push('company_id = ?');
      params.push(req.user.companyId);
      if (search) { where.push('(name LIKE ? OR email LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (industry) { where.push('industry = ?'); params.push(industry); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const items = this.conn.all(
        `SELECT * FROM organizations ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = this.conn.get(`SELECT COUNT(*) as total FROM organizations ${whereSql}`, params).total;

      // Enhance items with contactCount, activeDeals, activeValue + camelCase fields
      const itemsWithCounts = items.map(org => {
        const contactCount = this.conn.get('SELECT COUNT(*) as c FROM contacts WHERE organization_id = ? AND company_id = ?', [org.id, req.user.companyId]).c;
        const activeDeals = this.conn.all("SELECT * FROM deals WHERE organization_id = ? AND company_id = ? AND status NOT IN ('LOST', 'WON', 'CANCELLED')", [org.id, req.user.companyId]);
        const activeValue = activeDeals.reduce((sum, d) => sum + (d.value || 0), 0);
        return {
          ...org,
          companyId: org.company_id,
          postalCode: org.postal_code,
          createdAt: org.created_at,
          updatedAt: org.updated_at,
          contactCount: contactCount,
          activeDeals: activeDeals.length,
          activeValue: activeValue
        };
      });

      res.json(paginatedResponse(itemsWithCounts, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get('SELECT * FROM organizations WHERE id = ? AND company_id = ? LIMIT 1', [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Organization', req.params.id);

      const contactCount = this.conn.get('SELECT COUNT(*) as c FROM contacts WHERE organization_id = ? AND company_id = ?', [req.params.id, req.user.companyId]).c;
      const activeDeals = this.conn.all("SELECT * FROM deals WHERE organization_id = ? AND company_id = ? AND status NOT IN ('LOST', 'WON', 'CANCELLED')", [req.params.id, req.user.companyId]);
      const activeValue = activeDeals.reduce((sum, d) => sum + (d.value || 0), 0);

      res.json(successResponse({
        ...item,
        companyId: item.company_id,
        postalCode: item.postal_code,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        contactCount: contactCount,
        activeDeals: activeDeals.length,
        activeValue: activeValue
      }));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      // Accept both camelCase (from frontend) and snake_case (from API) field names
      const { name, industry, website, email, phone, address, city, state, country, postal_code, postalCode, notes, status } = req.body;
      if (!name) throw new ValidationError('Name is required');

      const id = req.body.id ? undefined : generateId('org');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO organizations (id, company_id, name, industry, website, email, phone, address, city, state, country, postal_code, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, name, industry, website, email, phone, address, city, state, country || 'US', postal_code || postalCode, status || 'ACTIVE', notes || null, now, now]);

      // Return with camelCase fields
      const created = this.conn.get('SELECT * FROM organizations WHERE id = ? AND company_id = ?', [id, req.user.companyId]);
      res.status(201).json(successResponse({
        ...created,
        companyId: created.company_id,
        postalCode: created.postal_code,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
        contactCount: 0,
        activeDeals: 0,
        activeValue: 0
      }, 201));
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM organizations WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Organization', req.params.id);

      // Map camelCase frontend fields to snake_case DB columns
      const fieldMap = {
        postalCode: 'postal_code',
      };
      const allowed = ['name', 'industry', 'website', 'email', 'phone', 'address', 'city', 'state', 'country', 'postal_code', 'status', 'notes'];
      const sets = [];
      const params_ = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params_.push(req.body[f]); }
      }
      // Also check camelCase versions
      for (const [camel, snake] of Object.entries(fieldMap)) {
        if (req.body[camel] !== undefined && req.body[snake] === undefined) {
          sets.push(`${snake} = ?`);
          params_.push(req.body[camel]);
        }
      }
      if (!sets.length) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      this.conn.run(`UPDATE organizations SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params_, now, req.params.id, req.user.companyId]);

      // Return with camelCase fields + computed values
      const updated = this.conn.get('SELECT * FROM organizations WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      const contactCount = this.conn.get('SELECT COUNT(*) as c FROM contacts WHERE organization_id = ? AND company_id = ?', [req.params.id, req.user.companyId]).c;
      const activeDeals = this.conn.all("SELECT value FROM deals WHERE organization_id = ? AND company_id = ? AND status NOT IN ('LOST', 'WON', 'CANCELLED')", [req.params.id, req.user.companyId]);
      const activeValue = activeDeals.reduce((sum, d) => sum + (d.value || 0), 0);
      res.json(successResponse({
        ...updated,
        companyId: updated.company_id,
        postalCode: updated.postal_code,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
        contactCount: contactCount,
        activeDeals: activeDeals.length,
        activeValue: activeValue
      }));
    } catch (err) { next(err); }
  }

  /**
   * Records that must not be silently dismantled when an organization is deleted.
   *
   * CRM-04. Deleting an organization used to produce a partial, inconsistent
   * teardown:
   *   * `contacts.organization_id` and `deals.organization_id` are SET NULL, so
   *     those rows SURVIVED but silently lost their owner;
   *   * `activities.organization_id` is CASCADE, so activities were DESTROYED.
   * Same request, two different outcomes, no warning.
   *
   * This mirrors the policy established for contacts and deals: refuse, name the
   * blockers, and change nothing.
   */
  static DELETE_BLOCKERS = [
    { table: 'contacts',    label: 'contact(s)' },
    { table: 'deals',       label: 'deal(s)' },
    { table: 'activities',  label: 'activity(ies)' },
    { table: 'tasks',       label: 'task(s)' },
    { table: 'appointments', label: 'appointment(s)' },
    { table: 'invoices',    label: 'invoice(s)' },
  ];

  /** @returns {Array<{table:string,label:string,count:number}>} blockers */
  _organizationDependents(orgId, companyId) {
    const found = [];
    for (const { table, label } of OrganizationsController.DELETE_BLOCKERS) {
      try {
        const row = this.conn.get(
          `SELECT COUNT(*) AS c FROM ${table} WHERE organization_id = ?`,
          [orgId],
        );
        if (row && row.c > 0) found.push({ table, label, count: row.c });
      } catch { /* table absent in this schema — not a blocker */ }
    }
    return found;
  }

  /**
   * Permanently delete an organization, refusing when anything still references it.
   *
   * Dependency check and DELETE share ONE `BEGIN IMMEDIATE` transaction so a row
   * created between check and delete cannot be silently orphaned. An organization
   * with no dependents is still permanently deleted; no soft delete is introduced.
   */
  async remove(req, res, next) {
    const { AppError } = require('../utils/errors');
    try {
      const runTx = this.conn.transaction(() => {
        const exists = this.conn.get(
          'SELECT COUNT(*) AS c FROM organizations WHERE id = ? AND company_id = ?',
          [req.params.id, req.user.companyId],
        );
        if (!exists || exists.c === 0) throw new NotFoundError('Organization', req.params.id);

        const blockers = this._organizationDependents(req.params.id, req.user.companyId);
        if (blockers.length) {
          const summary = blockers.map((b) => `${b.count} ${b.label}`).join(', ');
          throw new AppError(
            `Organization cannot be deleted because related records exist: ${summary}. `
            + 'Reassign them to another organization first.',
            'ENTITY_HAS_DEPENDENCIES',
            409,
          );
        }

        const res2 = this.conn.run(
          'DELETE FROM organizations WHERE id = ? AND company_id = ?',
          [req.params.id, req.user.companyId],
        );
        if (res2.changes === 0) throw new NotFoundError('Organization', req.params.id);
        return true;
      });

      const outcome = runTx();
      res.json(successResponse({ id: req.params.id, deleted: Boolean(outcome) }));
    } catch (err) {
      if (err.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY/i.test(String(err.message || ''))) {
        return next(new AppError(
          'Organization cannot be deleted because other records still reference it.',
          'ENTITY_HAS_DEPENDENCIES',
          409,
        ));
      }
      next(err);
    }
  }
}

module.exports = { OrganizationsController };