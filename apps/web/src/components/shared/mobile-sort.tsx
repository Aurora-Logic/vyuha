import { useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, ArrowsDownUpIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

import type { RecordColumn, RecordSort } from './record-table';

/**
 * Sorting on a phone.
 *
 * Below md the RecordTable header row is not rendered at all, so the control
 * the desktop sorts with does not exist -- a register that can be ordered on
 * one screen and not the other is not the same screen twice. This chip names
 * the current order and opens a sheet of the sortable columns; tapping a
 * column orders by it ascending, the same as a first press on its header,
 * and tapping the one already chosen flips it.
 *
 * It lives in the page's toolbar, at the end of the row the filters wrap
 * onto (`ml-auto`), rather than above the list: a bordered band of its own
 * cost every list a row of chrome before its first record, and a chip on
 * its own row cost nearly as much (owner, 9 Sep 2026). A source test holds
 * every sortable screen to placing it.
 *
 * There is deliberately no way back to the unsorted order: the header cannot
 * clear a sort either, and offering it on one branch only would be the
 * asymmetry this control exists to remove.
 */
export function MobileSortChip<T>({ columns, sort, onSortChange, className }: { columns: readonly RecordColumn<T>[]; sort: RecordSort | null | undefined; onSortChange: (next: RecordSort) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const sortable = columns.filter((column) => column.sortField !== undefined);
  const chosen = sort == null ? undefined : sortable.find((column) => column.sortField === sort.field);
  if (sortable.length === 0) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn('text-muted-foreground text-xs md:hidden', className)}
        onClick={() => {
          setOpen(true);
        }}
      >
        <ArrowsDownUpIcon data-icon="inline-start" />
        Sort{chosen === undefined ? '' : `: ${chosen.header}`}
        {sort == null || chosen === undefined ? null : sort.descending ? <ArrowDownIcon data-icon="inline-end" aria-label="descending" /> : <ArrowUpIcon data-icon="inline-end" aria-label="ascending" />}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="gap-0">
          <SheetHeader className="border-b">
            <SheetTitle>Sort</SheetTitle>
            <SheetDescription>Tap a column to order by it; tap it again to flip the direction.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {sortable.map((column) => {
              const active = sort != null && sort.field === column.sortField;
              return (
                <Button
                  key={column.key}
                  variant="ghost"
                  aria-pressed={active}
                  className={cn('min-h-11 w-full justify-between px-3', !active && 'font-normal')}
                  onClick={() => {
                    onSortChange({ field: column.sortField ?? '', descending: active && sort != null ? !sort.descending : false });
                    setOpen(false);
                  }}
                >
                  <span>{column.header}</span>
                  {active && sort != null ? (
                    <span className="text-muted-foreground flex items-center gap-1 text-xs font-normal">
                      {sort.descending ? 'Descending' : 'Ascending'}
                      {sort.descending ? <ArrowDownIcon /> : <ArrowUpIcon />}
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
