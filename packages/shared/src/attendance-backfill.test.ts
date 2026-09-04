import { describe, expect, it } from 'vitest';

import { MAX_ABSENT_BACKFILL_DAYS, backfillDates, markAbsentBackfillSchema } from './attendance.js';

/**
 * The absent backfill's arithmetic and its refusals.
 *
 * Tested here rather than through the endpoint because the endpoint queues
 * real sweeps: an earlier attempt to assert the happy path that way ran six of
 * them against every organisation in the shared test database.
 */

describe('backfillDates', () => {
  it('includes both ends of the range', () => {
    expect(backfillDates('2026-08-01', '2026-08-05')).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
  });

  it('counts a single day as one, not as zero', () => {
    expect(backfillDates('2026-08-09', '2026-08-09')).toEqual(['2026-08-09']);
  });

  it('crosses a month and a year without dropping or repeating a day', () => {
    expect(backfillDates('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
    expect(backfillDates('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('crosses a leap day', () => {
    expect(backfillDates('2028-02-27', '2028-03-01')).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('steps in UTC, so a DST change costs no day and repeats none', () => {
    // India has no DST, but the server that runs this need not be in India.
    const dates = backfillDates('2026-03-27', '2026-03-31');
    expect(dates).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('returns nothing for a range that runs backwards', () => {
    // The schema refuses this first; the function does not invent days either.
    expect(backfillDates('2026-08-10', '2026-08-01')).toEqual([]);
  });
});

describe('markAbsentBackfillSchema', () => {
  it('accepts a plain range', () => {
    expect(markAbsentBackfillSchema.safeParse({ from: '2026-08-01', to: '2026-08-05' }).success).toBe(true);
  });

  it('refuses a range that runs backwards', () => {
    expect(markAbsentBackfillSchema.safeParse({ from: '2026-08-10', to: '2026-08-01' }).success).toBe(false);
  });

  it('refuses a range longer than the cap, and accepts one just inside it', () => {
    // Somebody typing the wrong year gets an error rather than years of jobs.
    const from = '2026-01-01';
    const justInside = new Date(Date.parse(`${from}T00:00:00Z`) + (MAX_ABSENT_BACKFILL_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const justOver = new Date(Date.parse(`${from}T00:00:00Z`) + MAX_ABSENT_BACKFILL_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(markAbsentBackfillSchema.safeParse({ from, to: justInside }).success).toBe(true);
    expect(markAbsentBackfillSchema.safeParse({ from, to: justOver }).success).toBe(false);
  });

  it('refuses something that is not a date at all', () => {
    expect(markAbsentBackfillSchema.safeParse({ from: 'yesterday', to: '2026-08-01' }).success).toBe(false);
  });
});
