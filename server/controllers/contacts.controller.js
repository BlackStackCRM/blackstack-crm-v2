const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { successResponse, paginatedResponse } = require('../utils/response');
const { getPagination } = require('../utils/helpers');
const { EventHooksService } = require('../services/event-hooks.service');
const { assertTenantRefs } = require('../utils/tenantScope');

class ContactsController {
  constructor() {
    this.conn = getConn();
    this.hooks = new EventHooksService();
  }

  async list(req, res, next) {
    try {
      const { limit, offset, page } = getPagination(req);
      const { search, status, organization_id } = req.query;

      const where = [];
      const params = [];
      where.push('c.company_id = ?');
      params.push(req.user.companyId);
      if (search) {
        where.push('(c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)');
        const s = `%${search}%`;
        params.push(s, s, s, s);
      }
      if (status) { where.push('status = ?'); params.push(status.toUpperCase()); }
      if (organization_id) { where.push('c.organization_id = ?'); params.push(organization_id); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // JOIN organizations to get org name, and fetch tags per contact
      const items = this.conn.all(`
        SELECT c.*, o.name as organization_name
        FROM contacts c
        LEFT JOIN organizations o ON c.organization_id = o.id AND o.company_id = c.company_id
        ${whereSql}
        ORDER BY c.created_at DESC LIMIT ? OFFSET ?
      `, [...params, limit, offset]);
      const itemsWithTags = items.map(item => {
        const tags = this.conn.all(
          'SELECT t.id, t.name, t.color FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ? AND t.company_id = ?',
          [item.id, req.user.companyId]
        );
        return {
          ...item,
          // Convert snake_case DB columns to camelCase for frontend compatibility
          firstName: item.first_name,
          lastName: item.last_name,
          jobTitle: item.job_title,
          organizationId: item.organization_id,
          customerStatus: item.customer_status,
          leadStatus: item.lead_status,
          nextAction: item.next_action,
          nextActionDue: item.next_action_due,
          ownerId: item.owner_id,
          leadScore: item.lead_score,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          organization: item.organization_name ? { name: item.organization_name } : null,
          tags: tags || []
        };
      });

      const total = this.conn.get(`SELECT COUNT(*) as total FROM contacts c ${whereSql}`, params).total;

      res.json(paginatedResponse(itemsWithTags, total, page, limit));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const item = this.conn.get(`
        SELECT c.*, o.name as organization_name
        FROM contacts c
        LEFT JOIN organizations o ON c.organization_id = o.id AND o.company_id = c.company_id
        WHERE c.id = ? AND c.company_id = ? LIMIT 1
      `, [req.params.id, req.user.companyId]);
      if (!item) throw new NotFoundError('Contact', req.params.id);

      // Fetch tags
      const tags = this.conn.all(
        'SELECT t.id, t.name, t.color FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ? AND t.company_id = ?',
        [req.params.id, req.user.companyId]
      );

      const result = {
        ...item,
        // Convert snake_case DB columns to camelCase for frontend compatibility
        firstName: item.first_name,
        lastName: item.last_name,
        jobTitle: item.job_title,
        organizationId: item.organization_id,
        customerStatus: item.customer_status,
        leadStatus: item.lead_status,
        nextAction: item.next_action,
        nextActionDue: item.next_action_due,
        ownerId: item.owner_id,
        leadScore: item.lead_score,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        organization: item.organization_name ? { name: item.organization_name } : null,
        tags: tags || []
      };

      res.json(successResponse(result));
    } catch (err) { next(err); }
  }

  async tags(req, res, next) {
    try {
      const items = this.conn.all('SELECT id, name, color FROM tags WHERE company_id = ? ORDER BY name', [req.user.companyId]);
      res.json(successResponse(items));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      // Accept both camelCase (from frontend) and snake_case (from DB/API) field names
      const { first_name, firstName, last_name, lastName, email, phone, job_title, jobTitle, organization_id, organizationId, address, city, state, postal_code, postalCode, country, notes, status, tags } = req.body;
      if (!first_name && !firstName) throw new ValidationError('First name is required');
      const fn = first_name || firstName;
      const ln = last_name || lastName;
      const jt = job_title || jobTitle;
      const oid = organization_id || organizationId;
      const pc = postal_code || postalCode;
      const tagList = Array.isArray(tags) ? tags : (tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : []);
      assertTenantRefs(this.conn, req.user.companyId, { organization_id: oid });

      const id = req.body.id ? undefined : generateId('cnt');
      if (req.body.id) throw new ValidationError('id must not be supplied by the client');
      const now = new Date().toISOString();
      this.conn.run(`
        INSERT INTO contacts (id, company_id, first_name, last_name, email, phone, job_title, organization_id, address, city, state, postal_code, country, notes, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.user.companyId, fn, ln, email, phone, jt, oid, address, city, state, pc, country, notes || null, status || 'ACTIVE', now, now]);

      // Return the created contact with camelCase fields + organization name + tags
      const created = this.conn.get('SELECT * FROM contacts WHERE id = ? AND company_id = ?', [id, req.user.companyId]);
      const org = created.organization_id ? this.conn.get('SELECT id, name FROM organizations WHERE id = ? AND company_id = ?', [created.organization_id, req.user.companyId]) : null;

      // Create/link tags
      const savedTags = [];
      for (const tagName of tagList) {
        if (!tagName) continue;
        const existingTag = this.conn.get('SELECT id, name, color FROM tags WHERE name = ? AND company_id = ?', [tagName, req.user.companyId]);
        let tag;
        if (existingTag) {
          tag = existingTag;
        } else {
          const tagId = generateId('tag');
          this.conn.run(
            'INSERT INTO tags (id, company_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
            [tagId, req.user.companyId, tagName, '#3b82f6', now]
          );
          tag = { id: tagId, name: tagName, color: '#3b82f6' };
        }
        this.conn.run('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)', [id, tag.id]);
        savedTags.push({ id: tag.id, name: tag.name, color: tag.color });
      }

      res.status(201).json(successResponse({
        ...created,
        firstName: created.first_name,
        lastName: created.last_name,
        jobTitle: created.job_title,
        organizationId: created.organization_id,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
        organization: org ? { name: org.name } : null,
        tags: savedTags
      }, 201));

      this.hooks.onContactCreated(req.user.companyId, { id, first_name: fn, last_name: ln, email, phone });
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const existing = this.conn.get('SELECT id FROM contacts WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      if (!existing) throw new NotFoundError('Contact', req.params.id);

      // Map camelCase frontend fields to snake_case DB columns
      const fieldMap = {
        firstName: 'first_name', lastName: 'last_name', jobTitle: 'job_title',
        organizationId: 'organization_id', postalCode: 'postal_code',
        address: 'address', city: 'city', state: 'state', country: 'country',
        notes: 'notes', status: 'status', email: 'email', phone: 'phone'
      };
      const allowed = ['first_name', 'last_name', 'email', 'phone', 'job_title', 'organization_id', 'address', 'city', 'state', 'postal_code', 'country', 'notes', 'status'];
      const sets = [];
      const params_ = [];
      for (const f of allowed) {
        if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params_.push(req.body[f]); }
      }
      // Also check camelCase versions
      for (const [camel, snake] of Object.entries(fieldMap)) {
        if (req.body[camel] !== undefined && req.body[snake] === undefined) {
          if (camel === 'organizationId') {
            assertTenantRefs(this.conn, req.user.companyId, { organization_id: req.body[camel] });
          }
          sets.push(`${snake} = ?`);
          params_.push(req.body[camel]);
        }
      }
      if (req.body.organization_id !== undefined || req.body.organizationId !== undefined) {
        assertTenantRefs(this.conn, req.user.companyId, { organization_id: req.body.organization_id || req.body.organizationId });
      }
      if (!sets.length && req.body.tags === undefined) throw new ValidationError('No fields to update');

      const now = new Date().toISOString();
      if (sets.length) {
        this.conn.run(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`, [...params_, now, req.params.id, req.user.companyId]);
      }

      // Handle tags update if provided
      let tagsResult = null;
      if (req.body.tags !== undefined) {
        const tagList = Array.isArray(req.body.tags) ? req.body.tags : (req.body.tags ? req.body.tags.split(',').map(s => s.trim()).filter(Boolean) : []);

        // Remove all existing tags for this contact
        this.conn.run('DELETE FROM contact_tags WHERE contact_id = ?', [req.params.id]);

        // Create/link tags
        const savedTags = [];
        for (const tagName of tagList) {
          if (!tagName) continue;
          const existingTag = this.conn.get('SELECT id, name, color FROM tags WHERE name = ? AND company_id = ?', [tagName, req.user.companyId]);
          let tag;
          if (existingTag) {
            tag = existingTag;
          } else {
            const tagId = generateId('tag');
            this.conn.run(
              'INSERT INTO tags (id, company_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
              [tagId, req.user.companyId, tagName, '#3b82f6', now]
            );
            tag = { id: tagId, name: tagName, color: '#3b82f6' };
          }
          this.conn.run('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)', [req.params.id, tag.id]);
          savedTags.push({ id: tag.id, name: tag.name, color: tag.color });
        }
        tagsResult = savedTags;
      }

      // Fetch the updated contact data
      const updated = this.conn.get('SELECT * FROM contacts WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
      const org = updated.organization_id ? this.conn.get('SELECT id, name FROM organizations WHERE id = ? AND company_id = ?', [updated.organization_id, req.user.companyId]) : null;
      const tags = tagsResult !== null ? tagsResult : this.conn.all('SELECT t.id, t.name, t.color FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ? AND t.company_id = ?', [req.params.id, req.user.companyId]);
      res.json(successResponse({
        ...updated,
        firstName: updated.first_name,
        lastName: updated.last_name,
        jobTitle: updated.job_title,
        organizationId: updated.organization_id,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
        organization: org ? { name: org.name } : null,
        tags: tags || []
      }));
    } catch (err) { next(err); }
  }

  /**
   * Child tables that must block a contact delete.
   *
   * PHASE 3 / CRM-01. Before this change the delete was a bare
   * `DELETE FROM contacts WHERE id = ? AND company_id = ?`, so the outcome
   * depended entirely on which unrelated child rows happened to exist:
   * `notes` is ON DELETE RESTRICT and blocked the delete, while `deals`,
   * `tasks`, `activities` and `appointments` are ON DELETE CASCADE and were
   * silently destroyed. A user deleting a contact with live deals got a success
   * response and lost their pipeline.
   *
   * `bills` / `payments` are already RESTRICT at the schema level and are
   * listed here so the 409 names them rather than surfacing a bare SQLite
   * message. CRM-04 (deals/organizations) is out of scope for this step.
   */
  static DELETE_BLOCKERS = [
    { table: 'deals',         label: 'deal(s)' },
    { table: 'tasks',         label: 'task(s)' },
    { table: 'activities',    label: 'activity(ies)' },
    { table: 'appointments',  label: 'appointment(s)' },
    { table: 'notes',         label: 'note(s)' },
    { table: 'customers',     label: 'customer record(s)' },
    { table: 'bills',         label: 'bill(s)' },
    { table: 'payments',      label: 'payment(s)' },
  ];

  /** @returns {Array<{table:string,label:string,count:number}>} blocking tables */
  _contactDependents(contactId, companyId) {
    const found = [];
    for (const { table, label } of ContactsController.DELETE_BLOCKERS) {
      try {
        const row = this.conn.get(
          `SELECT COUNT(*) AS c FROM ${table} WHERE contact_id = ?${table === 'bills' || table === 'payments' ? ' AND company_id = ?' : ''}`,
          table === 'bills' || table === 'payments' ? [contactId, companyId] : [contactId],
        );
        if (row && row.c > 0) found.push({ table, label, count: row.c });
      } catch { /* table absent in this schema — not a blocker */ }
    }
    return found;
  }

  /**
   * Permanently delete a contact, refusing when anything still references it.
   *
   * The dependency check and the DELETE run inside ONE `BEGIN IMMEDIATE`
   * transaction. A pre-check alone would be racy: a dependency created between
   * the check and the DELETE would still be cascade-deleted. Inside the
   * transaction SQLite holds the write lock, so that window does not exist, and
   * any FK violation raised by the DELETE itself still rolls the whole thing back.
   *
   * A contact with no dependents is still permanently deleted — the existing
   * BlackStack permanent-deletion requirement is unchanged. No soft delete is
   * introduced.
   */
  async remove(req, res, next) {
    const { AppError } = require('../utils/errors');
    try {
      // conn.transaction(fn) RETURNS a wrapper; it does not execute `fn`.
      // The wrapper must be invoked, otherwise nothing runs at all.
      const runTx = this.conn.transaction(() => {
        const exists = this.conn.get(
          'SELECT COUNT(*) AS c FROM contacts WHERE id = ? AND company_id = ?',
          [req.params.id, req.user.companyId],
        );
        if (!exists || exists.c === 0) throw new NotFoundError('Contact', req.params.id);

        const blockers = this._contactDependents(req.params.id, req.user.companyId);
        if (blockers.length) {
          const summary = blockers.map((b) => `${b.count} ${b.label}`).join(', ');
          throw new AppError(
            `Contact cannot be deleted because it still has ${summary}. `
            + 'Remove or reassign those records first.',
            'ENTITY_HAS_DEPENDENCIES',
            409,
          );
        }

        const result = this.conn.run(
          'DELETE FROM contacts WHERE id = ? AND company_id = ?',
          [req.params.id, req.user.companyId],
        );
        if (result.changes === 0) throw new NotFoundError('Contact', req.params.id);
        return true;
      });

      const outcome = runTx();
      res.json(successResponse({ id: req.params.id, deleted: Boolean(outcome) }));
    } catch (err) {
      // Defence in depth: if any FK still refuses, surface the same actionable
      // 409 rather than a raw SQLite message. Nothing has been committed.
      if (err.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY/i.test(String(err.message || ''))) {
        return next(new AppError(
          'Contact cannot be deleted because other records still reference it.',
          'ENTITY_HAS_DEPENDENCIES',
          409,
        ));
      }
      next(err);
    }
  }
}

module.exports = { ContactsController };