import { ArrowCounterClockwiseIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';

import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import type { ReportColumnSpec } from '@vyuha/shared';

/**
 * F12, "configure current screen (columns, view)" (PRD §6.4).
 *
 * A popover on a desktop and a bottom Sheet on a phone, for the reason
 * CLAUDE.md §3 gives about pickers: a seventeen-item checklist in a popover
 * anchored to a toolbar button is unusable at 360px. The two surfaces have
 * different structure and dismissal, so this switches on `useIsMobile()`
 * rather than on a CSS breakpoint.
 *
 * The last visible column cannot be turned off. A table with no columns is not
 * a configuration anyone wants, and the alternative -- silently falling back
 * to the defaults -- would look like the checkbox not working.
 *
 * The list is one hit target per row rather than a checkbox with a label
 * beside it: the row is what the eye reads as the thing to press, and a 24px
 * checkbox inside a 44px row is a target that misses under a thumb. The row
 * carries the hover, gated behind a fine pointer so a tap does not leave one
 * row looking chosen (`@media (hover: hover)`), and the press answers with the
 * background rather than a transform, because a row that scales inside a
 * scrolling list reads as a glitch rather than as feedback.
 */

interface ColumnChooserProps {
  columns: readonly ReportColumnSpec[];
  visible: readonly string[];
  onVisibleChange: (next: string[]) => void;
  onReset: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The report's own defaults, so Reset can say when it would do nothing. */
  defaults?: readonly string[];
}

export function ColumnChooser({
  columns,
  visible,
  onVisibleChange,
  onReset,
  open,
  onOpenChange,
  defaults,
}: ColumnChooserProps) {
  const isMobile = useIsMobile();
  const chosen = new Set(visible);
  const isLast = chosen.size <= 1;
  const atDefaults =
    defaults !== undefined &&
    defaults.length === visible.length &&
    defaults.every((key) => chosen.has(key));

  function toggle(key: string, next: boolean) {
    if (!next && chosen.has(key) && isLast) return;
    const kept = columns
      .map((column) => column.key)
      .filter((candidate) =>
        candidate === key ? next : chosen.has(candidate),
      );
    onVisibleChange(kept);
  }

  const trigger = (
    <Button variant="outline" className="gap-2">
      <SlidersHorizontalIcon data-icon="inline-start" />
      <span className="hidden sm:inline">Columns</span>
      <span className="text-muted-foreground tabular-nums">
        {chosen.size}/{columns.length}
      </span>
      <ShortcutHint keys="f12" className="hidden md:inline-flex" />
    </Button>
  );

  const body = (
    <div className="flex flex-col">
      {columns.map((column) => {
        const checked = chosen.has(column.key);
        const locked = checked && isLast;
        return (
          <Label
            key={column.key}
            htmlFor={`column-${column.key}`}
            className={cn(
              'flex min-h-11 cursor-pointer items-center gap-3 px-2 font-normal transition-colors duration-100 md:min-h-9',
              'hover:[@media(hover:hover)and(pointer:fine)]:bg-accent',
              locked && 'cursor-not-allowed opacity-60',
            )}
          >
            <Checkbox
              id={`column-${column.key}`}
              checked={checked}
              disabled={locked}
              onCheckedChange={(next: boolean) => {
                toggle(column.key, next);
              }}
            />
            <span className="min-w-0 flex-1 truncate">{column.header}</span>
          </Label>
        );
      })}
    </div>
  );

  const reset = (
    <Button
      variant="ghost"
      size="sm"
      className="gap-2"
      disabled={atDefaults}
      onClick={onReset}
    >
      <ArrowCounterClockwiseIcon data-icon="inline-start" />
      Reset to defaults
    </Button>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger render={trigger} />
        <SheetContent side="bottom" className="max-h-[85vh] gap-0">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>Columns</SheetTitle>
            <SheetDescription>
              {chosen.size} of {columns.length} shown. The last one cannot be turned off.
            </SheetDescription>
          </SheetHeader>
          {/* min-h-0 so the list scrolls instead of pushing the footer off. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">{body}</div>
          <SheetFooter className="shrink-0 border-t">{reset}</SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      {/* p-0 so the rows reach the edges: a full-width hover band reads as a
          list, and an inset one reads as a stack of loose controls. */}
      <PopoverContent align="end" className="w-64 gap-0 p-0">
        <div className="flex items-baseline justify-between border-b px-3 py-2">
          <PopoverTitle className="text-xs font-medium">Columns</PopoverTitle>
          <PopoverDescription className="text-muted-foreground text-[0.6875rem] tabular-nums">
            {chosen.size} of {columns.length}
          </PopoverDescription>
        </div>
        {/* A plain scroller rather than ScrollArea: the overlay scrollbar sat
            over the last row's label, and a list this short does not need one. */}
        <div className="max-h-80 overflow-y-auto py-1">{body}</div>
        <div className="border-t px-1 py-1">{reset}</div>
      </PopoverContent>
    </Popover>
  );
}
