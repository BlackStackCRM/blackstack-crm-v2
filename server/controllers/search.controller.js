const { getConn } = require('../utils/db');
const { ValidationError } = require('../utils/errors');
const { successResponse } = require('../utils/response');

const SEARCHERS = {
  contacts: {
    select: 'SELECT id, first_name, last_name, email, phone, job_title FROM contacts',
    fields: ['first_name', 'last_name', 'email', 'phone', 'job_title']
  },
  organizations: {
    select: 'SELECT id, name, industry, email, phone FROM organizations',
    fields: ['name', 'industry', 'email', 'phone']
  },
  deals: {
    select: 'SELECT id, title, value, status FROM deals',
    fields: ['title']
  },
  invoices: {
    select: 'SELECT id, invoice_number, status, total FROM invoices',
    fields: ['invoice_number']
  },
  bills: {
    select: 'SELECT id, bill_number, status, total FROM bills',
    fields: ['bill_number']
  },
  tasks: {
    select: 'SELECT id, title, status, due_date FROM tasks',
    fields: ['title']
  },
  notes: {
    select: 'SELECT id, title FROM notes',
    fields: ['title']
  },
  products: {
    select: 'SELECT id, name, sku, price FROM products',
    fields: ['name', 'sku', 'description']
  }
};

class SearchController {
  constructor() {
    this.conn = getConn();
  }

  async search(req, res, next) {
    try {
      const q = (req.query.q || '').toString().trim();
      const type = req.query.type ? req.query.type.toString().toLowerCase() : null;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);

      if (!q) throw new ValidationError('Query parameter q is required');

      const types = type && SEARCHERS[type] ? [type] : Object.keys(SEARCHERS);
      const results = {};
      const s = `%${q}%`;

      for (const t of types) {
        const cfg = SEARCHERS[t];
        const where = cfg.fields.map(f => `${f} LIKE ?`).join(' OR ');
        const params = cfg.fields.map(() => s);
        results[t] = this.conn.all(`${cfg.select} WHERE company_id = ? AND (${where}) ORDER BY created_at DESC LIMIT ?`, [req.user.companyId, ...params, limit]);
      }

      res.json(successResponse({ query: q, results }));
    } catch (err) { next(err); }
  }
}

module.exports = { SearchController };