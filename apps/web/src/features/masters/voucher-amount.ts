/**
 * Tally's figure with its sign dropped -- text in, text out.
 *
 * Tally writes a credit as a negative figure and marks the same line Cr. Where
 * a reading already carries the Dr/Cr marker, the sign is the direction said
 * twice, once as a word and once as a symbol, and reads as a subtraction that
 * is not there. The printed voucher has always shown the magnitude beside the
 * marker (`voucherPaper` in shared); this is how the screen agrees with it.
 *
 * Not `Math.abs(Number(...))`: a voucher amount is an exact decimal held as a
 * string end to end (D-01), and a round trip through a float is exactly the
 * arithmetic this application promises never to do to Tally's numbers.
 */
export function magnitudeOf(amount: string): string {
  return amount.startsWith('-') ? amount.slice(1) : amount;
}
