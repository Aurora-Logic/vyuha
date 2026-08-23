import { describe, expect, it } from 'vitest';

import { trimZeros } from './types';

/**
 * The bug this pins: a rate of 4850 was written into the box as 485. The
 * trim was meant to turn 4000.00 into 4000, and read the last digit of a
 * whole number as a trailing zero to drop.
 */
describe('trimZeros', () => {
  it('drops only the zeros after a decimal point', () => {
    expect(trimZeros('4000.00')).toBe('4000');
    expect(trimZeros('4100.50')).toBe('4100.5');
    expect(trimZeros('0.50')).toBe('0.5');
  });

  it('never touches a whole number, whatever it ends in', () => {
    expect(trimZeros('4850')).toBe('4850');
    expect(trimZeros('100')).toBe('100');
    expect(trimZeros('10')).toBe('10');
    expect(trimZeros('0')).toBe('0');
  });
});
