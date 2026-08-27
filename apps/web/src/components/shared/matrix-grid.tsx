import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { formatCount, formatMoneyShort } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The one matrix (CFO brief Q2): a grid of cells, each carrying count and
 * rupees, each clickable to the named list behind it. Colour is intensity
 * of a single hue and carries magnitude only; a cell with 40 customers
 * worth two lakh and one with 3 worth eighty must never look alike, which
 * is why both figures are always printed. Empty cells can be styled as
 * opportunity (the penetration grid) rather than absence.
 */

export interface MatrixAxisItem {
  readonly key: string;
  readonly label: string;
}

export interface MatrixCellValue {
  readonly count: number;
  readonly amount: number;
}

export interface MatrixGridProps {
  readonly rows: readonly MatrixAxisItem[];
  readonly columns: readonly MatrixAxisItem[];
  readonly cellOf: (row: string, column: string) => MatrixCellValue | undefined;
  readonly onCell?: (row: string, column: string) => void;
  /** The hue a cell wears, and how loud; default fresh-1 at a share of the largest amount. */
  readonly toneOf?: (row: string, column: string) => { tone: string; emphasis: number };
  /** Empty cells read as opportunity: outlined, clickable, with a caption. */
  readonly emptyLabel?: string;
  readonly columnHeader?: (column: MatrixAxisItem) => ReactNode;
  readonly rowHeader?: (row: MatrixAxisItem) => ReactNode;
  readonly totals?: boolean;
  readonly className?: string;
}

export function MatrixGrid({ rows, columns, cellOf, onCell, toneOf, emptyLabel, columnHeader, rowHeader, totals = false, className }: MatrixGridProps) {
  let max = 1;
  for (const r of rows) for (const c of columns) max = Math.max(max, cellOf(r.key, c.key)?.amount ?? 0);
  const rowTotal = (row: string): MatrixCellValue =>
    columns.reduce((acc, c) => {
      const v = cellOf(row, c.key);
      return { count: acc.count + (v?.count ?? 0), amount: acc.amount + (v?.amount ?? 0) };
    }, { count: 0, amount: 0 });
  const columnTotal = (column: string): MatrixCellValue =>
    rows.reduce((acc, r) => {
      const v = cellOf(r.key, column);
      return { count: acc.count + (v?.count ?? 0), amount: acc.amount + (v?.amount ?? 0) };
    }, { count: 0, amount: 0 });
  const columnCount = columns.length + (totals ? 1 : 0);

  return (
    <div className={cn('overflow-x-auto', className)}>
      <div className="grid gap-1" style={{ gridTemplateColumns: `9rem repeat(${String(columnCount)}, minmax(5.5rem, 1fr))`, minWidth: `${String(9 + columnCount * 6)}rem` }}>
        <span />
        {columns.map((c) => (
          <span key={c.key} className="text-muted-foreground pb-1 text-center text-xs font-medium">
            {columnHeader ? columnHeader(c) : c.label}
          </span>
        ))}
        {totals ? <span className="text-muted-foreground pb-1 text-center text-xs font-medium">Total</span> : null}
        {rows.map((r) => (
          <div key={r.key} className="contents">
            <span className="text-muted-foreground flex min-w-0 items-center truncate text-xs">{rowHeader ? rowHeader(r) : r.label}</span>
            {columns.map((c) => {
              const cell = cellOf(r.key, c.key);
              const empty = cell === undefined || cell.count === 0;
              const tone = toneOf?.(r.key, c.key) ?? { tone: 'var(--fresh-1)', emphasis: 0.35 };
              const strength = empty ? 0 : Math.max(0.08, ((cell.amount) / max) * tone.emphasis);
              const clickable = onCell !== undefined && (!empty || emptyLabel !== undefined);
              return (
                <Button
                  key={c.key}
                  variant="outline"
                  disabled={!clickable}
                  onClick={() => {
                    onCell?.(r.key, c.key);
                  }}
                  aria-label={`${r.label} × ${c.label}: ${empty ? (emptyLabel ?? 'none') : `${formatCount(cell.count)}, ${formatMoneyShort(cell.amount)}`}`}
                  className={cn('h-auto flex-col items-start gap-0.5 px-3 py-2', empty && emptyLabel === undefined && 'opacity-50', empty && emptyLabel !== undefined && 'border-dashed')}
                  style={empty ? undefined : { backgroundColor: `color-mix(in oklab, ${tone.tone} ${String(Math.round(strength * 100))}%, transparent)` }}
                >
                  {empty ? (
                    <span className="text-muted-foreground text-xs">{emptyLabel ?? '—'}</span>
                  ) : (
                    <>
                      <span className="text-base font-semibold tabular-nums">{formatCount(cell.count)}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">{formatMoneyShort(cell.amount)}</span>
                    </>
                  )}
                </Button>
              );
            })}
            {totals ? (
              <span className="flex flex-col items-start justify-center px-3 py-2 text-xs tabular-nums">
                <span className="font-semibold">{formatCount(rowTotal(r.key).count)}</span>
                <span className="text-muted-foreground">{formatMoneyShort(rowTotal(r.key).amount)}</span>
              </span>
            ) : null}
          </div>
        ))}
        {totals ? (
          <div className="contents">
            <span className="text-muted-foreground flex items-center text-xs font-medium">Total</span>
            {columns.map((c) => (
              <span key={c.key} className="flex flex-col items-start px-3 py-2 text-xs tabular-nums">
                <span className="font-semibold">{formatCount(columnTotal(c.key).count)}</span>
                <span className="text-muted-foreground">{formatMoneyShort(columnTotal(c.key).amount)}</span>
              </span>
            ))}
            <span />
          </div>
        ) : null}
      </div>
    </div>
  );
}
