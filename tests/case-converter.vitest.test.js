/**
 * Case converter round-trip tests (audit fix #8).
 *
 * Covers server/utils/caseConverter.js — camelToSnake / snakeToCamel — with a
 * round-trip fixture plus arrays, nulls, Dates, and nested objects.
 */
import { describe, it, expect } from 'vitest';
import { camelToSnake, snakeToCamel } from '../server/utils/caseConverter.js';

const FIXTURE = {
  companyId: 'c1',
  contactId: null,
  organizationId: 'org1',
  createdAt: new Date('2026-01-02T03:04:05Z'),
  notes: ['firstNote', 'secondNote'],
  address: {
    streetLine1: '1 Main St',
    postalCode: '12345',
    extraInfo: null,
  },
  items: [
    { unitPrice: 10, taxRate: 0.1, tags: ['aTag', 'bTag'] },
    { unitPrice: 20, taxRate: 0.2, tags: [] },
  ],
};

describe('caseConverter round-trip', () => {
  it('camelToSnake converts keys recursively', () => {
    const snake = camelToSnake(FIXTURE);
    expect(snake).toHaveProperty('company_id', 'c1');
    expect(snake).toHaveProperty('contact_id', null);
    expect(snake).toHaveProperty('address.street_line1', '1 Main St');
    expect(snake.items[0]).toHaveProperty('unit_price', 10);
    expect(Array.isArray(snake.notes)).toBe(true);
  });

  it('snakeToCamel converts keys recursively', () => {
    const snake = camelToSnake(FIXTURE);
    const camel = snakeToCamel(snake);
    expect(camel).toHaveProperty('companyId', 'c1');
    expect(camel).toHaveProperty('contactId', null);
    expect(camel).toHaveProperty('address.streetLine1', '1 Main St');
    expect(camel.items[1]).toHaveProperty('taxRate', 0.2);
    expect(Array.isArray(camel.notes)).toBe(true);
    expect(camel.notes).toEqual(['firstNote', 'secondNote']);
  });

  it('round-trips without data loss (arrays, nulls, Dates, nesting)', () => {
    const camel = snakeToCamel(camelToSnake(FIXTURE));
    expect(camel).toEqual(FIXTURE);
  });

  it('preserves non-object values and handles null inputs', () => {
    expect(camelToSnake(null)).toBeNull();
    expect(camelToSnake('string')).toBe('string');
    expect(snakeToCamel(null)).toBeNull();
    expect(snakeToCamel(42)).toBe(42);
    expect(camelToSnake([])).toEqual([]);
    expect(snakeToCamel([{ firstKey: 1 }, { secondKey: 2 }])).toEqual([{ firstKey: 1 }, { secondKey: 2 }]);
  });
});
