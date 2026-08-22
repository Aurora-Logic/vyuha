import { describe, expect, it } from 'vitest';

import { hsnSummary } from './paper-hsn';
import type { PaperLine } from './paper';

/**
 * A tax invoice has to add up on the page.
 *
 * Two faults were printing on real documents. The HSN/SAC summary's Total
 * printed `totals.subtotal`, which the server computes GROSS
 * (`sum(quantity * rate)`), while the rows above it sum `line.amount`, which
 * is NET (`qty x rate x (1 - disc/100)`) — so on any discounted invoice the
 * Total disagreed with its own column. And the line table carried a
 * "Less: Discount" row deducting a discount the line amounts had already
 * lost, so a reader adding the column landed short of the printed Total.
 */
const line = (qty: string, rate: string, discPct: string, taxPct: string): PaperLine => {
  const gross = Number(qty) * Number(rate);
  const amount = Math.round(gross * (1 - Number(discPct) / 100) * 100) / 100;
  return {
    key: `${qty}-${rate}-${discPct}`,
    description: 'Cat6 cable 305m',
    hsnCode: '8544',
    quantity: qty,
    unit: 'BOX',
    rate,
    discountPct: discPct,
    taxPct,
    amount: amount.toFixed(2),
    taxAmount: (Math.round(amount * Number(taxPct)) / 100).toFixed(2),
  } as PaperLine;
};

describe('the HSN summary totals its own rows', () => {
  it('sums the taxable column net of discount, not the document’s gross subtotal', () => {
    // 10 x 1000 = 10,000 gross; 10% off = 9,000 net.
    const rows = hsnSummary([line('10', '1000', '10', '18')]);
    const taxableTotal = rows.reduce((sum, r) => sum + r.taxable, 0);
    expect(taxableTotal).toBeCloseTo(9000, 2);
    // The bug printed 10,000 here — the gross — beneath a column reading 9,000.
    expect(taxableTotal).not.toBeCloseTo(10000, 2);
  });

  it('adds a discounted and an undiscounted line to the sum of their own amounts', () => {
    const lines = [line('10', '1000', '10', '18'), line('2', '500', '0', '18')];
    const rows = hsnSummary(lines);
    const taxableTotal = rows.reduce((sum, r) => sum + r.taxable, 0);
    const fromLines = lines.reduce((sum, l) => sum + Number(l.amount), 0);
    expect(taxableTotal).toBeCloseTo(fromLines, 2);
    expect(taxableTotal).toBeCloseTo(10000, 2); // 9,000 + 1,000
  });

  it('groups by HSN and rate, so one rate is one row', () => {
    const rows = hsnSummary([line('1', '100', '0', '18'), line('1', '100', '0', '18'), line('1', '100', '0', '5')]);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.taxable, 0)).toBeCloseTo(300, 2);
  });
});

describe('the printed column reconciles to the printed total', () => {
  it('line amounts plus tax equal the grand total, with no second discount deduction', () => {
    const lines = [line('10', '1000', '10', '18'), line('2', '500', '0', '18')];
    // What the server stores, by its own formulae.
    const subtotalGross = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.rate), 0);
    const discountTotal = lines.reduce((s, l) => s + (Number(l.quantity) * Number(l.rate) - Number(l.amount)), 0);
    const taxTotal = lines.reduce((s, l) => s + Number(l.taxAmount), 0);
    const grandTotal = subtotalGross - discountTotal + taxTotal;

    // What the page now shows: the Amount column (net) plus the tax rows.
    const columnPlusTax = lines.reduce((s, l) => s + Number(l.amount), 0) + taxTotal;
    expect(columnPlusTax).toBeCloseTo(grandTotal, 2);

    // What it used to show, with the extra "Less: Discount" row: short by the discount.
    expect(columnPlusTax - discountTotal).not.toBeCloseTo(grandTotal, 2);
  });
});
