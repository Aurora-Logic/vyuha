import { describe, expect, it } from 'vitest';

import { overridePayload, parseDaysInput, parseRateInput, splitSettings } from './overrides-model';
import type { InterestPartySetting } from './use-interest';

function setting(partial: Partial<InterestPartySetting>): InterestPartySetting {
  return {
    partyId: 'p1',
    partyName: 'Asha Traders',
    parentGroup: 'Sundry Debtors',
    tallyCreditDays: null,
    creditDaysOverride: null,
    interestRateOverride: null,
    creditTermsMissing: true,
    ...partial,
  };
}

describe('parseRateInput', () => {
  it('reads empty as a clear and a decimal as itself', () => {
    expect(parseRateInput('  ')).toEqual({ kind: 'clear' });
    expect(parseRateInput('14.5')).toEqual({ kind: 'set', value: 14.5 });
  });

  it('refuses what the API would refuse, before the request leaves', () => {
    expect(parseRateInput('-1').kind).toBe('invalid');
    expect(parseRateInput('101').kind).toBe('invalid');
    expect(parseRateInput('twelve').kind).toBe('invalid');
  });
});

describe('parseDaysInput', () => {
  it('takes whole days inside the year, zero included', () => {
    expect(parseDaysInput('0')).toEqual({ kind: 'set', value: 0 });
    expect(parseDaysInput('365')).toEqual({ kind: 'set', value: 365 });
    expect(parseDaysInput('')).toEqual({ kind: 'clear' });
  });

  it('refuses fractions and out-of-range days', () => {
    expect(parseDaysInput('30.5').kind).toBe('invalid');
    expect(parseDaysInput('366').kind).toBe('invalid');
    expect(parseDaysInput('-7').kind).toBe('invalid');
  });
});

describe('overridePayload', () => {
  it('sends null for the cleared half, so it falls back rather than sticks', () => {
    expect(overridePayload({ kind: 'set', value: 14 }, { kind: 'clear' })).toEqual({
      interestRateOverride: 14,
      creditDaysOverride: null,
    });
  });

  it('refuses both empty and anything invalid — Remove is the honest clear-all', () => {
    expect(overridePayload({ kind: 'clear' }, { kind: 'clear' })).toBeNull();
    expect(overridePayload({ kind: 'invalid' }, { kind: 'set', value: 30 })).toBeNull();
  });
});

describe('splitSettings', () => {
  it('lists a rate-only override in both lists: the rate is set, the terms are still missing', () => {
    const rateOnly = setting({ interestRateOverride: '14.00' });
    const termsSet = setting({ partyId: 'p2', creditDaysOverride: 45, creditTermsMissing: false });
    const bare = setting({ partyId: 'p3' });
    const { overridden, missing } = splitSettings([rateOnly, termsSet, bare]);
    expect(overridden.map((row) => row.partyId)).toEqual(['p1', 'p2']);
    expect(missing.map((row) => row.partyId)).toEqual(['p1', 'p3']);
  });
});
