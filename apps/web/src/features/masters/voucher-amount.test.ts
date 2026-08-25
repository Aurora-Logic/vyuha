import { describe, expect, it } from 'vitest';

import { formatMoney } from '@/lib/format';

import { magnitudeOf } from './voucher-amount';

/**
 * Owner, 23 Aug 2026: "amount is showing in negative".
 *
 * Tally writes a credit as a negative figure and marks the same line Cr. The
 * voucher sheet printed both, so a credit read "Cr −₹4,150.50" -- the
 * direction stated twice, once as a word and once as a sign, which looks like
 * a subtraction that is not there. The printed voucher has always shown the
 * magnitude beside the marker; this is the sheet agreeing with the paper.
 *
 * The strings below are the real shapes in the projection, not invented ones:
 * `-4150.5` and `-720` are what the ledger lines of INV-0042 and INV-P1 hold.
 */
describe('magnitudeOf', () => {
  it('drops the sign Tally puts on a credit', () => {
    expect(formatMoney(magnitudeOf('-4150.5'))).toBe('₹4,150.50');
    expect(formatMoney(magnitudeOf('-720'))).toBe('₹720.00');
  });

  it('leaves a debit exactly as it arrived', () => {
    expect(formatMoney(magnitudeOf('9440'))).toBe('₹9,440.00');
    expect(formatMoney(magnitudeOf('275788.00'))).toBe('₹2,75,788.00');
  });

  it('keeps the figure exact rather than routing it through a float', () => {
    // The reason this is string surgery and not Math.abs(Number(x)): a rupee
    // figure long enough to lose a paisa in a double is the one figure an
    // accountant checks against Tally. 9007199254740993 is the first integer
    // a double cannot hold.
    expect(magnitudeOf('-9007199254740993.55')).toBe('9007199254740993.55');
    expect(magnitudeOf('-0.005')).toBe('0.005');
  });

  it('is unmoved by a figure that is already bare', () => {
    expect(magnitudeOf('0')).toBe('0');
    expect(magnitudeOf('')).toBe('');
  });
});
