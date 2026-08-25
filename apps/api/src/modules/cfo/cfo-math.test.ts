import { describe, expect, it } from 'vitest';

import { bucketFor, daysOverdueOn, dueDateFor } from './cfo-math.js';

describe('the ageing buckets, by due date (brief D02)', () => {
  it('a bill due today is current, not 0-30', () => {
    expect(daysOverdueOn('2026-08-20', '2026-08-20')).toBe(0);
    expect(bucketFor(0)).toBe('current');
  });

  it('a bill not yet due is 0 days overdue, never negative', () => {
    expect(daysOverdueOn('2026-08-20', '2026-09-01')).toBe(0);
  });

  it('a bill with no due date cannot age', () => {
    expect(daysOverdueOn('2026-08-20', null)).toBe(0);
  });

  it('each bucket keeps its own last day and hands the next day over', () => {
    expect(bucketFor(1)).toBe('0-30');
    expect(bucketFor(30)).toBe('0-30');
    expect(bucketFor(31)).toBe('31-60');
    expect(bucketFor(60)).toBe('31-60');
    expect(bucketFor(61)).toBe('61-90');
    expect(bucketFor(90)).toBe('61-90');
    expect(bucketFor(91)).toBe('91-180');
    expect(bucketFor(180)).toBe('91-180');
    expect(bucketFor(181)).toBe('180+');
  });

  it('counts days overdue from the due date in calendar days', () => {
    expect(daysOverdueOn('2026-08-20', '2026-08-15')).toBe(5);
    expect(daysOverdueOn('2026-08-20', '2026-07-11')).toBe(40);
  });

  it('due dates come from the bill date plus the credit days', () => {
    expect(dueDateFor('2026-07-01', 10)).toBe('2026-07-11');
    expect(dueDateFor('2026-07-01', 0)).toBe('2026-07-01');
    // Month and year boundaries are plain calendar arithmetic.
    expect(dueDateFor('2026-12-25', 10)).toBe('2027-01-04');
  });
});
