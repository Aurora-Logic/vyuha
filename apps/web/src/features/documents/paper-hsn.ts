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
