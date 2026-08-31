import { describe, expect, it } from 'vitest';

import { formatCell, formatHeadline, formatTick } from './units';

/**
 * The unit formatting every metric surface shares. Money goes through the
 * product's own formatter (rupee symbol, Indian grouping, exact text in), so
 * what these tests hold is the routing: each unit reaches the right printer
 * and a blank headline stays a dash rather than becoming "NaN".
 */
describe('formatHeadline', () => {
  it('prints money exactly as the API summed it', () => {
    expect(formatHeadline('money', '1200.75')).toBe('₹1,200.75');
    expect(formatHeadline('money', '275788.00')).toBe('₹2,75,788.00');
  });

  it('prints minutes as hours and minutes, and zero as the dash', () => {
    expect(formatHeadline('minutes', '90')).toBe('1h 30m');
    expect(formatHeadline('minutes', '0')).toBe('—');
  });

  it('prints counts grouped and percent with its sign', () => {
    expect(formatHeadline('count', '5000')).toBe('5,000');
    expect(formatHeadline('percent', '12')).toBe('12%');
  });

  it('prints a blank headline as the dash, never NaN', () => {
    expect(formatHeadline('minutes', '')).toBe('—');
    expect(formatHeadline('count', '')).toBe('—');
  });
});

describe('formatTick', () => {
  it('shortens money to the Indian short scale for an axis', () => {
    expect(formatTick('money', 933103)).toBe('₹9.3L');
    expect(formatTick('money', 1200)).toBe('₹1.2k');
  });

  it('keeps counts whole', () => {
    expect(formatTick('count', 45)).toBe('45');
  });
});

describe('formatCell', () => {
  it('formats by the column unit, falling back to grouped counts', () => {
    expect(formatCell('money', '1000.50')).toBe('₹1,000.50');
    expect(formatCell(undefined, 21)).toBe('21');
    expect(formatCell(undefined, 'party')).toBe('party');
    expect(formatCell(undefined, '')).toBe('—');
  });
});
