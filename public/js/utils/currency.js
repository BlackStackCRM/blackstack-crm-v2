/**
 * Central currency utility for the frontend.
 * Provides supported currency list, validation, and locale-aware formatting.
 */
window.Currency = {
  SYMBOLS: {
    USD: '$',
    EUR: '€',
    GBP: '£',
    INR: '₹',
  },

  NAMES: {
    USD: 'US Dollar',
    EUR: 'Euro',
    GBP: 'Pound Sterling',
    INR: 'Indian Rupee',
  },

  LOCALES: {
    USD: 'en-US',
    EUR: 'en-EU',
    GBP: 'en-GB',
    INR: 'en-IN',
  },

  /**
   * All supported currency codes as an array.
   * @returns {string[]}
   */
  getSupported() {
    return Object.keys(this.SYMBOLS);
  },

  /**
   * Validate a currency code. Returns it if valid, 'USD' if not.
   */
  validate(code) {
    if (code && this.SYMBOLS[code]) return code;
    return 'INR';
  },

  /**
   * Format an amount with locale-aware currency formatting.
   * @param {number} amount
   * @param {string} currency - ISO 4217 code (e.g. 'INR')
   * @returns {string}
   */
  format(amount = 0, currency = 'INR') {
    const code = this.validate(currency);
    const locale = this.LOCALES[code] || 'en-US';
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: code,
      }).format(amount || 0);
    } catch (e) {
      // Fallback: manual formatting
      const symbol = this.SYMBOLS[code] || code;
      return `${symbol}${(amount || 0).toLocaleString()}`;
    }
  },

  /**
   * Generate <option> elements for a currency <select>.
   * @returns {string}
   */
  currencyOptions(selected = '') {
    return this.getSupported().map(code => {
      const label = `${this.NAMES[code]} (${this.SYMBOLS[code]} ${code})`;
      return `<option value="${code}" ${code === selected ? 'selected' : ''}>${label}</option>`;
    }).join('');
  },
};
