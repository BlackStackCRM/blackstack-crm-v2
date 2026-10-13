const { generateId } = require('../utils/generateId');

class OpeningBalanceRepository {
  constructor(conn) {
    this.conn = conn;
  }

  // ─── Opening Balance Header ─────────────────────────────────────────

  findById(id, companyId) {
    return this.conn.get(
      `SELECT ob.*, fy.name as financial_year_name, fy.start_date as fy_start_date, fy.end_date as fy_end_date
       FROM opening_balances ob
       JOIN financial_years fy ON ob.financial_year_id = fy.id
       WHERE ob.id = ? AND ob.company_id = ?`,
      [id, companyId]
    );
  }

  findByFinancialYear(financialYearId, companyId) {
    return this.conn.get(
      `SELECT * FROM opening_balances
       WHERE financial_year_id = ? AND company_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [financialYearId, companyId]
    );
  }

  findAll(companyId, filters = {}) {
    let sql = `SELECT ob.*, fy.name as financial_year_name FROM opening_balances ob
       JOIN financial_years fy ON ob.financial_year_id = fy.id
       WHERE ob.company_id = ?`;
    const params = [companyId];
    if (filters.status) {
      sql += ` AND ob.status = ?`;
      params.push(filters.status);
    }
    sql += ` ORDER BY ob.created_at DESC`;
    return this.conn.all(sql, params);
  }

  create(companyId, financialYearId, openingDate, referenceNumber, userId) {
    const id = generateId('ob');
    const now = new Date().toISOString();
    this.conn.prepare(`
      INSERT INTO opening_balances
        (id, company_id, financial_year_id, opening_date, reference_number,
         status, total_debit, total_credit, difference,
         created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'DRAFT', 0, 0, 0, ?, ?, ?, ?)
    `).run(id, companyId, financialYearId, openingDate, referenceNumber, userId, userId, now, now);
    return id;
  }

  updateTotals(openingBalanceId, totalDebit, totalCredit) {
    const difference = parseFloat(totalDebit) - parseFloat(totalCredit);
    this.conn.prepare(`
      UPDATE opening_balances
      SET total_debit = ?, total_credit = ?, difference = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(totalDebit, totalCredit, difference, openingBalanceId);
  }

  updateStatus(openingBalanceId, status, userId) {
    const now = new Date().toISOString();
    const field = status.toLowerCase() + '_at';
    const byField = status.toLowerCase() + '_by';
    // Only set timestamp/by fields for FINALIZED and POSTED
    if (status === 'FINALIZED') {
      this.conn.prepare(`
        UPDATE opening_balances SET status = ?, finalized_by = ?, finalized_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, userId, now, openingBalanceId);
    } else if (status === 'POSTED') {
      this.conn.prepare(`
        UPDATE opening_balances SET status = ?, posted_by = ?, posted_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, userId, now, openingBalanceId);
    } else {
      this.conn.prepare(`
        UPDATE opening_balances SET status = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, userId, openingBalanceId);
    }
  }

  setJournalEntry(openingBalanceId, journalEntryId) {
    this.conn.prepare(`
      UPDATE opening_balances SET journal_entry_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(journalEntryId, openingBalanceId);
  }

  updateOpenDate(openingBalanceId, openingDate, userId) {
    this.conn.prepare(`
      UPDATE opening_balances SET opening_date = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(openingDate, userId, openingBalanceId);
  }

  delete(id, companyId) {
    return this.conn.prepare(`DELETE FROM opening_balances WHERE id = ? AND company_id = ?`).run(id, companyId);
  }

  // ─── Opening Balance Lines ──────────────────────────────────────────

  findLines(openingBalanceId) {
    return this.conn.all(`
      SELECT obl.*, a.code, a.name, a.type, a.debit_credit_nature
      FROM opening_balance_lines obl
      JOIN accounts a ON obl.account_id = a.id
      WHERE obl.opening_balance_id = ?
      ORDER BY a.code
    `, [openingBalanceId]);
  }

  addLine(openingBalanceId, accountId, debit, credit, description, companyId) {
    const id = generateId('obl');
    this.conn.prepare(`
      INSERT INTO opening_balance_lines (id, opening_balance_id, account_id, debit, credit, description, company_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, openingBalanceId, accountId, debit, credit, description, companyId);
    return id;
  }

  updateLine(id, debit, credit, description) {
    this.conn.prepare(`
      UPDATE opening_balance_lines SET debit = ?, credit = ?, description = ?
      WHERE id = ?
    `).run(debit, credit, description, id);
  }

  deleteLine(id) {
    return this.conn.prepare(`DELETE FROM opening_balance_lines WHERE id = ?`).run(id);
  }

  deleteAllLines(openingBalanceId) {
    return this.conn.prepare(`DELETE FROM opening_balance_lines WHERE opening_balance_id = ?`).run(openingBalanceId);
  }

  // ─── Validation helpers ─────────────────────────────────────────────

  getAccountDetails(accountId, companyId) {
    return this.conn.get(
      `SELECT id, code, name, type, is_group, allow_direct_posting, is_active, is_system,
              debit_credit_nature, account_group_id
       FROM accounts WHERE id = ? AND company_id = ?`,
      [accountId, companyId]
    );
  }

  hasExistingJournalEntry(openingBalanceId) {
    const row = this.conn.get(
      `SELECT journal_entry_id FROM opening_balances WHERE id = ? AND journal_entry_id IS NOT NULL`,
      [openingBalanceId]
    );
    return row ? row.journal_entry_id : null;
  }

  // ─── Balance calculation ──────────────────────────────────────────────

  getAccountBalance(accountId, companyId) {
    const row = this.conn.get(
      `SELECT
         COALESCE(SUM(debit_amount), 0) - COALESCE(SUM(credit_amount), 0) AS balance
       FROM journal_entry_lines
       WHERE account_id = ? AND company_id = ?`,
      [accountId, companyId]
    );
    return row ? parseFloat(row.balance) : 0;
  }

  // ─── Reference number generation ──────────────────────────────────────

  nextReferenceNumber(companyId, financialYear) {
    // Generate: OB-FY2026-27-001
    const fyName = financialYear || '';
    const fyCode = fyName.replace(/[^0-9]/g, '').substring(0, 4);
    const count = this.conn.get(
      `SELECT COUNT(*) as c FROM opening_balances WHERE reference_number LIKE ? AND company_id = ?`,
      [`OB-${fyCode}%`, companyId]
    ).c;
    const num = String(count + 1).padStart(3, '0');
    return `OB-${fyCode}-${num}`;
  }
}

module.exports = { OpeningBalanceRepository };
