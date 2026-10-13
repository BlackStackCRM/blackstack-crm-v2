/**
 * Central currency constants and validation.
 * ISO 4217 currency codes supported by the CRM.
 */

const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
};

const CURRENCY_NAMES = {
  USD: 'US Dollar',
  EUR: 'Euro',
  GBP: 'Pound Sterling',
  INR: 'Indian Rupee',
};

const CURRENCY_LOCALES = {
  USD: 'en-US',
  EUR: 'en-EU',
  GBP: 'en-GB',
  INR: 'en-IN',
};

const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_SYMBOLS);

/**
 * Validate that a currency code is supported.
 * Returns the code if valid, or 'USD' as default.
 */
function validateCurrency(code) {
  if (code && CURRENCY_SYMBOLS[code]) return code;
  return 'USD';
}

/**
 * Format an amount with the proper locale and symbol.
 */
function formatCurrency(amount = 0, currency = 'USD') {
  const code = validateCurrency(currency);
  const locale = CURRENCY_LOCALES[code] || 'en-US';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
    }).format(amount || 0);
  } catch {
    // Fallback: manual formatting
    const symbol = CURRENCY_SYMBOLS[code] || code;
    return `${symbol}${(amount || 0).toLocaleString()}`;
  }
}

module.exports = {
  CURRENCY_SYMBOLS,
  CURRENCY_NAMES,
  CURRENCY_LOCALES,
  SUPPORTED_CURRENCIES,
  validateCurrency,
  formatCurrency,
};
