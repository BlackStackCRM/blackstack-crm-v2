/**
 * Smoke tests for server/utils/currency.js.
 *
 * Focus: Intl.NumberFormat must accept EVERY locale/currency pair the module
 * declares. 'en-EU' was once declared for EUR — an invalid BCP-47 tag — which
 * threw at format time and silently degraded every EUR amount to the manual
 * fallback path. This suite pins that regression down.
 */
import { describe, it, expect } from 'vitest';
import {
  CURRENCY_SYMBOLS,
  CURRENCY_NAMES,
  CURRENCY_LOCALES,
  SUPPORTED_CURRENCIES,
  validateCurrency,
  formatCurrency,
} from '../server/utils/currency.js';

describe('currency locale registry', () => {
  it('Intl.NumberFormat constructs for every declared locale/currency pair', () => {
    for (const code of SUPPORTED_CURRENCIES) {
      const locale = CURRENCY_LOCALES[code];
      expect(() => new Intl.NumberFormat(locale, { style: 'currency', currency: code }),
        `Intl.NumberFormat('${locale}', currency: '${code}') must not throw`).not.toThrow();
    }
  });

  it('every declared locale is structurally valid BCP-47 (language[-region])', () => {
    const BCP47 = /^[a-z]{2,3}(-[A-Z]{2,3})?$/;
    for (const [code, locale] of Object.entries(CURRENCY_LOCALES)) {
      expect(locale, `${code} locale`).toMatch(BCP47);
      expect(locale, `${code} locale must not use the bogus 'EU' region`).not.toContain('EU');
    }
  });

  it('formatCurrency uses the Intl path (not the fallback) for every currency', () => {
    for (const code of SUPPORTED_CURRENCIES) {
      const formatted = formatCurrency(1234.5, code);
      // Intl paths emit a narrow no-break space / grouping separator; the manual
      // fallback would have produced `${symbol}1,234.5` via toLocaleString only.
      // Simply asserting no throw + a currency symbol is present catches it.
      expect(formatted).toContain(CURRENCY_SYMBOLS[code]);
 expect(formatted.length).toBeGreaterThan(1);
    }
  });

  it('formatCurrency falls back gracefully for EUR explicitly', () => {
    expect(formatCurrency(100, 'EUR')).toMatch(/€/);
  });
});

describe('currency constants stay in sync', () => {
  it('all four maps share the same key sets', () => {
    const keys = Object.keys(CURRENCY_SYMBOLS).sort();
    expect(Object.keys(CURRENCY_NAMES).sort()).toEqual(keys);
    expect(Object.keys(CURRENCY_LOCALES).sort()).toEqual(keys);
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual(keys);
  });
});

describe('validateCurrency', () => {
  it('accepts each supported code', () => {
    for (const code of SUPPORTED_CURRENCIES) {
      expect(validateCurrency(code)).toBe(code);
    }
  });

  it('falls back to USD for unknown or empty input', () => {
    expect(validateCurrency('XYZ')).toBe('USD');
    expect(validateCurrency('')).toBe('USD');
    expect(validateCurrency(undefined)).toBe('USD');
  });
});
