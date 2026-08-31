import { describe, expect, it } from 'vitest';

import { categoryOf } from './category.js';

describe('categoryOf', () => {
  it('reads the five categories off an item name, MCCB before MCB', () => {
    expect(categoryOf('MCB 6A SP C-curve')).toBe('MCB');
    expect(categoryOf('MCCB 100A 3P 25kA')).toBe('MCCB');
    expect(categoryOf('RCCB 40A 30mA 4P')).toBe('RCCB');
    expect(categoryOf('ACB 800A 3P EDO')).toBe('ACB');
    expect(categoryOf('APFC Panel 100 kVAr')).toBe('PQ');
    expect(categoryOf('Moulded Case Circuit Breaker 250A')).toBe('MCCB');
  });

  it('is honest about what it cannot place', () => {
    expect(categoryOf('Cable tie 200mm')).toBe('Other');
    expect(categoryOf('')).toBe('Other');
    expect(categoryOf(null)).toBe('Other');
    // "MCBOX" is not an MCB: the word boundary matters.
    expect(categoryOf('MCBOX enclosure')).toBe('Other');
  });
});
