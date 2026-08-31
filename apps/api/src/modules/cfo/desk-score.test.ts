import { describe, expect, it } from 'vitest';

import { CLASS_MULTIPLIER, deskScore } from './desk-score.js';

const base = {
  value12m: 0,
  maxValue12m: 4_000_000,
  daysOverdue: 0,
  daysPastGap: 0,
  brokenPromises: 0,
  utilisationPct: 0,
  opportunityValue: 0,
  maxOpportunityValue: 0,
  onCooldown: false,
};

describe('deskScore (O2)', () => {
  it('at the same urgency, the 40-lakh customer outranks the 8,000-rupee one by the value weight', () => {
    const big = deskScore({ ...base, value12m: 4_000_000, daysOverdue: 60 });
    const small = deskScore({ ...base, value12m: 8_000, daysOverdue: 60 });
    expect(big.breakdown.value).toBe(35);
    expect(big.score - small.score).toBeGreaterThan(14);
    // The log scale keeps the small book worth something rather than nothing,
    // which is what lets a loud clock still surface it.
    expect(small.breakdown.value).toBeGreaterThan(15);
    expect(small.breakdown.value).toBeLessThan(25);
  });

  it('urgency is whichever clock is loudest', () => {
    const overdue = deskScore({ ...base, daysOverdue: 45, daysPastGap: 6 });
    expect(overdue.breakdown.urgency).toBe(15);
    const quiet = deskScore({ ...base, daysOverdue: 9, daysPastGap: 60 });
    expect(quiet.breakdown.urgency).toBe(30);
  });

  it('risk saturates at two broken promises or double the limit', () => {
    expect(deskScore({ ...base, brokenPromises: 2 }).breakdown.risk).toBe(20);
    expect(deskScore({ ...base, brokenPromises: 1 }).breakdown.risk).toBe(10);
    expect(deskScore({ ...base, utilisationPct: 150 }).breakdown.risk).toBe(10);
    expect(deskScore({ ...base, utilisationPct: 80 }).breakdown.risk).toBe(0);
  });

  it('cooldown takes forty points and the score never goes below zero', () => {
    const hot = deskScore({ ...base, value12m: 100_000, daysOverdue: 90 });
    const cooled = deskScore({ ...base, value12m: 100_000, daysOverdue: 90, onCooldown: true });
    expect(hot.score - cooled.score).toBe(40);
    expect(deskScore({ ...base, onCooldown: true }).score).toBe(0);
  });

  it('opportunity is zero until it is priced, and the breakdown says so by being zero', () => {
    expect(deskScore({ ...base, opportunityValue: 1000, maxOpportunityValue: 0 }).breakdown.opportunity).toBe(0);
    expect(deskScore({ ...base, opportunityValue: 500, maxOpportunityValue: 1000 }).breakdown.opportunity).toBe(7.5);
  });

  it('the customer class leans the list toward key accounts (P6)', () => {
    const plain = deskScore({ ...base, value12m: 400_000 });
    const key = deskScore({ ...base, value12m: 400_000, classMultiplier: CLASS_MULTIPLIER['A+'] });
    const cash = deskScore({ ...base, value12m: 400_000, classMultiplier: CLASS_MULTIPLIER.D });
    expect(key.breakdown.value).toBeGreaterThan(plain.breakdown.value);
    expect(cash.breakdown.value).toBeCloseTo(plain.breakdown.value / 2, 0);
    // A multiplier never pushes the factor past its ceiling.
    expect(deskScore({ ...base, value12m: 4_000_000, classMultiplier: 1.5 }).breakdown.value).toBe(35);
  });
});
