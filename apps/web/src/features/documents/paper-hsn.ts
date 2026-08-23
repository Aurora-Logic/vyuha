import type { PaperLine } from './paper';

/**
 * The HSN/SAC summary a tax invoice prints beneath its lines.
 *
 * In its own module because `paper.tsx` may only export components (the
 * fast-refresh rule), and because the total this produces is the one the
 * summary must print: `taxable` sums each line's `amount`, which is NET of
 * that line's discount. The document's `totals.subtotal` is GROSS, and
 * printing that under this column made the Total disagree with the rows
 * above it on every discounted invoice.
 */
export interface HsnRow {
  readonly hsn: string;
  readonly taxable: number;
  readonly ratePct: number;
  readonly tax: number;
}

export function hsnSummary(lines: readonly PaperLine[]): HsnRow[] {
  const byKey = new Map<string, HsnRow>();
  for (const line of lines) {
    const key = `${line.hsnCode}|${line.taxPct}`;
    const current = byKey.get(key) ?? { hsn: line.hsnCode, taxable: 0, ratePct: Number(line.taxPct), tax: 0 };
    byKey.set(key, { ...current, taxable: current.taxable + Number(line.amount ?? 0), tax: current.tax + Number(line.taxAmount ?? 0) });
  }
  return [...byKey.values()];
}

/**
 * CGST and SGST from one tax amount.
 *
 * GST is charged as a single rate and only split in two on the page, so the
 * halves are derived together: one is rounded and the other is the remainder.
 * Rounding each independently makes them disagree with the total they came
 * from by a paisa whenever that total has an odd number of them -- 9.01
 * printed as 4.51 and 4.51, and the invoice added up to 9.02.
 */
export function taxHalves(total: number): { readonly cgst: number; readonly sgst: number } {
  const cgst = Math.round((total / 2) * 100) / 100;
  return { cgst, sgst: Math.round((total - cgst) * 100) / 100 };
}

/**
 * The CGST and SGST columns of the HSN summary, and the totals that must add
 * up to them.
 *
 * The Total row printed half of the document's tax rather than the sum of the
 * halves printed above it, so the column did not add up to its own total even
 * once each row was split correctly.
 */
export function hsnHalves(rows: readonly HsnRow[]): {
  readonly perRow: readonly { readonly cgst: number; readonly sgst: number }[];
  readonly cgstTotal: number;
  readonly sgstTotal: number;
} {
  const perRow = rows.map((row) => taxHalves(row.tax));
  const sum = (pick: (half: { cgst: number; sgst: number }) => number): number =>
    Math.round(perRow.reduce((running, half) => running + pick(half), 0) * 100) / 100;
  return { perRow, cgstTotal: sum((half) => half.cgst), sgstTotal: sum((half) => half.sgst) };
}
