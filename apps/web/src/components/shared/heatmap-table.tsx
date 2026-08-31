import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { heatmapStep, type HeatGrid } from './heat-grid';

/** The heatmap's six shades: nothing, then the theme's sequential ramp light to dark. */
const HEAT_STEPS = ['bg-muted', 'bg-[var(--chart-1)]', 'bg-[var(--chart-2)]', 'bg-[var(--chart-3)]', 'bg-[var(--chart-4)]', 'bg-[var(--chart-5)]'] as const;

/**
 * A category × month grid (dataviz: the dense-grid form). The first
 * column sticks so the rows keep their names while the months scroll on
 * a phone; every cell is a button with the value in its name, so a screen
 * reader and a finger both get the number; a row can be a door.
 */
export function HeatmapTable({ grid, rowLabel, format, columnLabel, onRow }: { grid: HeatGrid; rowLabel: string; format?: (value: number) => string; /** Column keys are YYYY-MM by default; a caller with day or bucket keys prints them its own way. */ columnLabel?: (key: string) => string; onRow?: (rowId: string) => void }) {
  const show = format ?? ((value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 3 }));
  const head = columnLabel ?? ((month: string) => `${month.slice(5)}/${month.slice(2, 4)}`);
  return (
    <div className="overflow-x-auto">
      <Table className="w-auto min-w-full border-separate border-spacing-0.5 text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-muted-foreground bg-background sticky left-0 h-7 pr-2 text-left font-normal">{rowLabel}</TableHead>
            {grid.months.map((month) => (
              <TableHead key={month} className="text-muted-foreground h-7 min-w-12 text-center font-normal tabular-nums">
                {head(month)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {grid.rows.map((row) => (
            <TableRow key={row.category} className="hover:bg-transparent">
              <TableHead scope="row" className="bg-background sticky left-0 h-7 max-w-40 truncate pr-2 text-left font-normal">
                {onRow !== undefined && row.rowId !== '' ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="text-foreground h-auto max-w-full justify-start truncate px-0 font-normal"
                    onClick={() => {
                      onRow(row.rowId);
                    }}
                  >
                    {row.category}
                  </Button>
                ) : (
                  row.category
                )}
              </TableHead>
              {row.cells.map((value, index) => (
                <TableCell key={grid.months[index]} className="h-7 p-0">
                  <Button
                    variant="ghost"
                    aria-label={`${row.category}, ${grid.months[index] ?? ''}: ${value === null ? 'nothing' : show(value)}`}
                    title={value === null ? '' : show(value)}
                    className={cn('block h-7 w-full min-w-12 cursor-default rounded-none p-0', HEAT_STEPS[heatmapStep(value, grid.max)])}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
