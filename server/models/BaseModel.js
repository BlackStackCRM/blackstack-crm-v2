const { formatCurrency: formatCurrencyUtil, validateCurrency } = require('../utils/currency');

class BaseModel {
  static tableName = '';
  static fields = [];

  static toJSON(record) {
    if (!record) return null;
    const obj = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'password_hash' && key !== 'salt') {
        obj[key] = value;
      }
    }
    return obj;
  }

  static sanitize(record) {
    if (!record) return null;
    const sanitized = { ...record };
    delete sanitized.password_hash;
    return sanitized;
  }

  static formatDate(dateStr) {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return date.toISOString();
  }

  static formatCurrency(amount, currency = 'USD') {
    return formatCurrencyUtil(amount, currency);
  }
}

module.exports = { BaseModel };
