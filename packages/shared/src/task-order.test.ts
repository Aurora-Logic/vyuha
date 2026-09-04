import { describe, expect, it } from 'vitest';

import { taskLineAmount, taskOrderTotal, type TaskItemView } from './tasks.js';

/**
 * The task's order arithmetic. This is money, so it is integer paise
 * throughout: `0.1 + 0.2` is not `0.3`, and a total that is a hair out is a
 * total somebody has to explain to a customer.
 */

const line = (over: Partial<TaskItemView> = {}): TaskItemView => ({
  itemId: 'i-1',
  itemName: 'MCB 16A',
  quantity: '1',
  rate: '100.00',
  discountPct: '0',
  amount: '100.00',
  ...over,
});

describe('taskLineAmount', () => {
  it('multiplies quantity by rate', () => {
    expect(taskLineAmount('3', '250.00', '0')).toBe('750.00');
  });

  it('takes the discount off', () => {
    expect(taskLineAmount('2', '100.00', '10')).toBe('180.00');
  });

  it('is exact where a float would not be', () => {
    // 0.1 + 0.2 territory: three at 10.10 is 30.30, not 30.299999999999997.
    expect(taskLineAmount('3', '10.10', '0')).toBe('30.30');
    expect(taskLineAmount('1', '0.10', '0')).toBe('0.10');
  });

  it('handles fractional quantities to three decimals', () => {
    expect(taskLineAmount('2.5', '40.00', '0')).toBe('100.00');
    expect(taskLineAmount('0.333', '300.00', '0')).toBe('99.90');
  });

  it('handles a fractional discount', () => {
    expect(taskLineAmount('1', '100.00', '12.5')).toBe('87.50');
  });

  it('gives a full discount away rather than a negative line', () => {
    expect(taskLineAmount('4', '50.00', '100')).toBe('0.00');
  });

  it('has no amount until somebody prices it', () => {
    // An enquiry is a real state, not a zero.
    expect(taskLineAmount('3', null, '0')).toBeNull();
  });
});

describe('taskOrderTotal', () => {
  it('adds the priced lines', () => {
    expect(
      taskOrderTotal([
        line({ amount: '750.00' }),
        line({ itemId: 'i-2', amount: '180.50' }),
      ]),
    ).toBe('930.50');
  });

  it('adds in paise, so a long list does not drift', () => {
    const many = Array.from({ length: 10 }, () => line({ amount: '0.10' }));
    expect(taskOrderTotal(many)).toBe('1.00');
  });

  it('ignores the unpriced lines rather than counting them as zero', () => {
    expect(taskOrderTotal([line({ amount: '100.00' }), line({ itemId: 'i-2', rate: null, amount: null })])).toBe(
      '100.00',
    );
  });

  it('has no total when nothing is priced', () => {
    expect(taskOrderTotal([line({ rate: null, amount: null })])).toBeNull();
    expect(taskOrderTotal([])).toBeNull();
  });
});

describe('the sizes the fields actually allow', () => {
  it('is exact at a magnitude that overflows a float', () => {
    // The reviewer's case: 1e8 x 1e8 = 1e16, past Number.MAX_SAFE_INTEGER
    // (9.007e15). `Number.isFinite` stays true through that, so a float
    // returned a wrong rupee figure with nothing to catch it.
    expect(taskLineAmount('100000', '1000000.00', '0')).toBe('100000000000.00');
  });

  it('is exact at the largest values the schema permits', () => {
    // 12 integer digits of quantity, 14 of rate.
    expect(taskLineAmount('999999999999', '99999999999999.99', '0')).toBe(
      '99999999999899990000000000.01',
    );
  });

  it('rounds a discount half-up rather than drifting', () => {
    // 1 x 0.05 at 50% is 0.025, which rounds to 0.03, not 0.02.
    expect(taskLineAmount('1', '0.05', '50')).toBe('0.03');
  });

  it('refuses a value that is not a number rather than inventing one', () => {
    expect(taskLineAmount('', '100.00', '0')).toBeNull();
    expect(taskLineAmount('.', '100.00', '0')).toBeNull();
    expect(taskLineAmount('1', 'abc', '0')).toBeNull();
    expect(taskLineAmount('-1', '100.00', '0')).toBeNull();
  });

  it('totals a long list of large lines without drifting', () => {
    const big = Array.from({ length: 200 }, () => line({ amount: '99999999.99' }));
    expect(taskOrderTotal(big)).toBe('19999999998.00');
  });
});
