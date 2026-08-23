import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ArrowDownIcon, ArrowUpIcon, ArrowsDownUpIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';

import { cn } from '@/lib/utils';

export interface RecordColumn<T> {
  key: string;
  header: string;
  /** A glyph the column's subject wears in its cells (the flag), so the header agrees with them. */
  headerIcon?: ReactNode;
  cell: (row: T) => ReactNode;
  /** Right-align and use tabular numerals (PRD §6.3). */
  numeric?: boolean;
  /** Hidden below 1280px per the responsive rules in PRD §6.5. */
  secondary?: boolean;
  className?: string;
  /** Present when this column can order the rows; the header becomes the control. */
  sortField?: string;
}

export interface RecordSort {
  readonly field: string;
  readonly descending: boolean;
}

interface RecordTableProps<T> {
  columns: RecordColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Mobile card line one: the primary identifier. */
  mobilePrimary: (row: T) => ReactNode;
  /** Mobile card line one, right side: usually a status pill. */
  mobileStatus?: (row: T) => ReactNode;
  /** Mobile card line two: two supporting fields. */
  mobileSupporting?: (row: T) => ReactNode;
  onRowActivate?: (row: T) => void;
  /** 15 REQ-AO-06: a surface a row wears (a duplicate's destructive tint); merged after the table's own. */
  rowClassName?: (row: T) => string | undefined;
  /** A mark before the first cell, and before the card's title: an icon with its own name, never colour alone. */
  rowLeading?: (row: T) => ReactNode;
  emptyState?: ReactNode;
  /** The current order and its setter; header clicks toggle a column, first ascending. */
  sort?: RecordSort | null;
  onSortChange?: (next: RecordSort) => void;
}

/**
 * The one table pattern (CLAUDE.md §3 rule 4).
 *
 * PRD §6.5: below 768px a table becomes stacked record rows — primary
 * identifier plus status pill on line one, two supporting fields on line two —
 * and never a horizontal scroll of a wide table. Both renderings come from one
 * component so a screen cannot implement only half of the rule.
 *
 * The table sits directly on the page surface with a single outer border, not
 * inside a Card (PRD §6.2, no box-in-box).
 */
export function RecordTable<T>({
  columns,
  rows,
  rowKey,
  mobilePrimary,
  mobileStatus,
  mobileSupporting,
  onRowActivate,
  emptyState,
  sort,
  onSortChange,
  rowClassName,
  rowLeading,
}: RecordTableProps<T>) {
  if (rows.length === 0 && emptyState) {
    return <div className="border">{emptyState}</div>;
  }

  return (
    <>
      {/* Desktop and tablet */}
      {/* Both branches carry an anchor and both are always in the DOM — only
          CSS decides which is visible. The guide picks between them by width,
          the same way it chooses the sidebar or the bottom bar. */}
      <div data-guide="screen.table" className="hidden overflow-x-auto border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => {
                const sortable = column.sortField !== undefined && onSortChange !== undefined;
                const isActive = sortable && sort != null && sort.field === column.sortField;
                return (
                  <TableHead
                    key={column.key}
                    aria-sort={isActive ? (sort.descending ? 'descending' : 'ascending') : undefined}
                    className={cn(
                      column.numeric && 'text-right tabular-nums',
                      column.secondary && 'hidden xl:table-cell',
                      column.className,
                    )}
                  >
                    {sortable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn('-mx-2 h-7 gap-1 px-2 font-normal', column.numeric && 'flex-row-reverse', isActive && 'font-medium')}
                        onClick={() => {
                          const field = column.sortField ?? '';
                          onSortChange({ field, descending: isActive ? !sort.descending : false });
                        }}
                      >
                        {column.headerIcon ? <span aria-hidden className="[&_svg]:size-3.5">{column.headerIcon}</span> : null}
                        {column.header}
                        {isActive ? sort.descending ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" /> : <ArrowsDownUpIcon className="size-3 opacity-40" />}
                      </Button>
                    ) : column.headerIcon ? (
                      <span className="inline-flex items-center gap-1 [&_svg]:size-3.5">
                        <span aria-hidden>{column.headerIcon}</span>
                        {column.header}
                      </span>
                    ) : (
                      column.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                // The row's own surface after the hover tint, not before it: a
                // duplicate stays marked while the pointer is on it.
                className={cn(onRowActivate && 'cursor-pointer active:bg-muted', rowClassName?.(row))}
                tabIndex={onRowActivate ? 0 : undefined}
                onClick={onRowActivate ? () => { onRowActivate(row); } : undefined}
                onKeyDown={
                  onRowActivate
                    ? (event) => {
                        // PRD §6.4: Enter drills into the focused row.
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          onRowActivate(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((column, columnIndex) => (
                  <TableCell
                    key={column.key}
                    className={cn(
                      column.numeric && 'text-right tabular-nums',
                      column.secondary && 'hidden xl:table-cell',
                      column.className,
                    )}
                  >
                    {columnIndex === 0 && rowLeading ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        {rowLeading(row)}
                        <span className="min-w-0">{column.cell(row)}</span>
                      </span>
                    ) : (
                      column.cell(row)
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Below 768px. Built from shadcn's Item rather than hand-rolled row
          markup — the registry already models exactly this shape, and a
          bespoke version would drift from it the first time the theme moves
          (CLAUDE.md §3 rule 1). */}
      {/* role="presentation" overrides ItemGroup's built-in role="list". A list
          whose children are all role="button" has no listitem in it, so a
          screen reader announces an empty list — worse than the plain container
          this replaced. The rows carry the semantics; the group is visual.

          gap-0 because ItemGroup spaces its children by default, which left the
          separators floating in 10px of nothing instead of dividing flush rows. */}
      <ItemGroup
        role="presentation"
        data-guide="screen.table-cards"
        className="gap-0 border md:hidden"
      >
        {rows.map((row, index) => (
          <Fragment key={rowKey(row)}>
            {index > 0 ? <ItemSeparator className="my-0" /> : null}
            <Item
              size="sm"
              role={onRowActivate ? 'button' : undefined}
              tabIndex={onRowActivate ? 0 : undefined}
              onClick={onRowActivate ? () => { onRowActivate(row); } : undefined}
              onKeyDown={
                onRowActivate
                  ? (event: ReactKeyboardEvent<HTMLDivElement>) => {
                      // PRD §6.4: Enter drills into the focused row. Space is
                      // included because the row advertises role="button", and
                      // a control that claims that role has to honour both.
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowActivate(row);
                      }
                    }
                  : undefined
              }
              className={cn('min-h-11 rounded-none', onRowActivate && 'cursor-pointer hover:bg-muted/50 active:bg-muted', rowClassName?.(row))}
            >
              <ItemContent className="min-w-0 gap-0.5">
                {/* w-full min-w-0 overrides ItemTitle's base w-fit, which would
                    otherwise size to the text and push a long name past 360px
                    (measured: an estimate customer name overflowed to 366). */}
                <ItemTitle className="flex w-full min-w-0 items-center gap-1.5">
                  {rowLeading?.(row)}
                  <span className="min-w-0 truncate">{mobilePrimary(row)}</span>
                </ItemTitle>
                {mobileSupporting ? (
                  <ItemDescription className="w-full min-w-0 truncate text-xs">
                    {mobileSupporting(row)}
                  </ItemDescription>
                ) : null}
              </ItemContent>
              {mobileStatus ? <ItemActions>{mobileStatus(row)}</ItemActions> : null}
            </Item>
          </Fragment>
        ))}
      </ItemGroup>
    </>
  );
}
