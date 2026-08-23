import { describe, expect, it } from 'vitest';

import { monthLabel, short } from './dashboard-v2.format';

describe('monthLabel', () => {
  it('names the month', () => {
    expect(monthLabel('2026-07')).toBe('Jul');
    expect(monthLabel('2025-12')).toBe('Dec');
  });

  it('carries the year on January, so a twelve-month axis says where it turns over', () => {
    expect(monthLabel('2026-01')).toBe('Jan 26');
  });

  it('leaves anything that is not a month key alone', () => {
    // The first three characters of "2026-07" are "202" -- the bug this exists
    // to stop coming back.
    expect(monthLabel('Igatpuri Cables and Controls')).toBe('Igatpuri Cables and Controls');
    expect(monthLabel('')).toBe('');
    expect(monthLabel('2026-13')).toBe('2026-13');
  });
});

describe('short', () => {
  it('uses the Indian short scale', () => {
    expect(short(933103)).toBe('9.3L');
    expect(short(12_500_000)).toBe('1.3Cr');
    expect(short(4200)).toBe('4.2k');
    expect(short(850)).toBe('850');
  });

  it('trims a trailing zero and keeps the sign', () => {
    expect(short(100_000)).toBe('1L');
    expect(short(-250_000)).toBe('−2.5L');
  });

  it('holds at zero', () => {
    expect(short(0)).toBe('0');
  });
});
