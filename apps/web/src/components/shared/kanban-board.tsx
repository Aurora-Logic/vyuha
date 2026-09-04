import { Fragment, useState, type ReactNode } from 'react';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * Lanes of cards with drag-between-lanes (REQ-V-03 for tasks, the deal
 * pipeline for CRM). One composition for both so the drag behaviour, the
 * empty lane, the "and N more" line and the keyboard path exist once.
 *
 * Native drag and drop rather than a library (CLAUDE.md §6: no dependency
 * without asking), and no ambition beyond "drop on a lane" — ordering within
 * a lane is the sort the query already applies. A card is a shadcn Button,
 * so opening one never needs a mouse; moving without one is the list view's
 * promise, kept there (REQ-V-05).
 *
 * The look is the grouped-board idiom (Notion's): lanes are soft surfaces,
 * not boxes — the group's name sits in a tinted chip, the cards are the only
 * bordered things, rounded and lifted a little on hover.
 */

export interface KanbanLane<T> {
  readonly id: string;
  /** The lane's accessible name; `title` may dress it with an icon. */
  readonly label: string;
  readonly title: ReactNode;
  /** Right-aligned in the header: a count, a total. */
  readonly meta?: ReactNode;
  readonly items: readonly T[];
  /** Beyond `items` when the lane was capped. */
  readonly total: number;
  readonly muted?: boolean;
  /** Colour classes for the header chip ("bg-tint-1/15 text-tint-1"); a quiet grey without. */
  readonly accent?: string;
}

interface KanbanBoardProps<T> {
  lanes: readonly KanbanLane<T>[];
  itemKey: (item: T) => string;
  itemLaneId: (item: T) => string;
  itemLabel: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /**
   * A right-click menu for a card. Given, the card becomes a context-menu
   * trigger; omitted, it is the plain card it always was, so a board that
   * has no per-card actions grows no menu that opens onto nothing.
   */
  renderMenu?: (item: T) => ReactNode;
  onOpen: (item: T) => void;
  /** Omitted on a read-only board, where a lane is a fact about the item, not a place to drop it. */
  onMove?: (item: T, laneId: string) => void;
  moving?: boolean;
  /** A board whose lanes are derived (an order's fulfilment stage): cards open, but do not drag. */
  readOnly?: boolean;
  ariaLabel: string;
  /** Where the list rendering lives, for the "and N more" line. */
  overflowHint?: string;
  /**
   * The phone layout: lanes as vertical collapsible sections instead of a row
   * that scrolls sideways. A card opens on tap; it does not drag (a phone has
   * no drag), so it is moved through its card menu. Off by default -- the
   * desktop board is the horizontal one it has always been.
   */
  stacked?: boolean;
  /**
   * A per-card class, merged over the card's own background -- for marking one
   * kind of item (an order tinted blue) so it is spotted among the rest.
   */
  itemClassName?: (item: T) => string | undefined;
}

export function KanbanBoard<T>({
  lanes,
  itemKey,
  itemLaneId,
  itemLabel,
  renderItem,
  renderMenu,
  onOpen,
  onMove,
  moving = false,
  readOnly = false,
  ariaLabel,
  overflowHint = 'see the list',
  stacked = false,
  itemClassName,
}: KanbanBoardProps<T>) {
  const [dragging, setDragging] = useState<T | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // The cards of one lane: the empty note, each card, and the "and N more"
  // line. Written once and used by both layouts. A card drags only on the
  // horizontal board -- a phone has no drag, so a stacked lane moves a card
  // through its menu instead, and the drop-target height is not reserved.
  const laneCards = (lane: KanbanLane<T>) => (
    <div className={cn('flex flex-col gap-1.5', !stacked && 'min-h-24')}>
      {lane.items.length === 0 ? (
        <p className="text-muted-foreground px-1 py-3 text-center text-xs">Nothing here</p>
      ) : null}
      {lane.items.map((item) => {
        const card = (
          <div
            draggable={!readOnly && !stacked}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', itemKey(item));
              setDragging(item);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            className={cn('bg-background border-border/60 rounded-md border shadow-xs transition-shadow hover:shadow-sm', itemClassName?.(item), dragging !== null && itemKey(dragging) === itemKey(item) && 'opacity-50')}
          >
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpen(item);
              }}
              className="h-auto w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left whitespace-normal"
              aria-label={`Open ${itemLabel(item)}`}
            >
              {renderItem(item)}
            </Button>
          </div>
        );
        const menu = renderMenu?.(item);
        return menu === undefined ? (
          <Fragment key={itemKey(item)}>{card}</Fragment>
        ) : (
          // The trigger *is* the card, so right-clicking anywhere on it opens
          // the menu -- wrapping it in another element would put a second box
          // around every card.
          <ContextMenu key={itemKey(item)}>
            <ContextMenuTrigger render={card} />
            <ContextMenuContent className="w-52">{menu}</ContextMenuContent>
          </ContextMenu>
        );
      })}
      {lane.total > lane.items.length ? (
        <p className="text-muted-foreground px-1 py-1 text-center text-xs">
          and {lane.total - lane.items.length} more — {overflowHint}
        </p>
      ) : null}
    </div>
  );

  // The phone board: lanes as collapsible sections, all open to start, read
  // top to bottom instead of scrolling sideways. Accordion is the one
  // sanctioned height animation and carries the disclosure a11y for free.
  if (stacked) {
    return (
      <Accordion
        multiple
        defaultValue={lanes.map((lane) => lane.id)}
        data-guide="screen.board"
        aria-label={ariaLabel}
        className="flex flex-col gap-2"
      >
        {lanes.map((lane) => (
          <AccordionItem
            key={lane.id}
            value={lane.id}
            className={cn('bg-muted/40 rounded-lg border-0 px-1.5', lane.muted && 'bg-muted/20')}
          >
            <AccordionTrigger className="items-center hover:no-underline">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className={cn('flex min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-xs font-medium', lane.accent ?? 'bg-muted text-muted-foreground')}>{lane.title}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">{lane.meta ?? lane.total}</span>
              </span>
            </AccordionTrigger>
            <AccordionContent>{laneCards(lane)}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    );
  }

  return (
    <ScrollArea data-guide="screen.board" className="w-full">
      <div className="flex min-w-max gap-3 pb-3" role="list" aria-label={ariaLabel}>
        {lanes.map((lane) => (
          <section
            key={lane.id}
            role="listitem"
            aria-label={`${lane.label}, ${String(lane.total)} item${lane.total === 1 ? '' : 's'}`}
            className={cn(
              'bg-muted/40 flex w-72 shrink-0 flex-col rounded-lg p-1.5',
              lane.muted && 'bg-muted/20',
              over === lane.id && dragging !== null && itemLaneId(dragging) !== lane.id && 'ring-ring/40 bg-accent/50 ring-2',
            )}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (over !== lane.id) setOver(lane.id);
            }}
            onDragLeave={() => {
              if (over === lane.id) setOver(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null && itemLaneId(dragging) !== lane.id && !moving) onMove?.(dragging, lane.id);
              setDragging(null);
              setOver(null);
            }}
          >
            <header className="flex items-center justify-between gap-2 px-1 pt-0.5 pb-1.5">
              <span className={cn('flex min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-xs font-medium', lane.accent ?? 'bg-muted text-muted-foreground')}>{lane.title}</span>
              <span className="text-muted-foreground shrink-0 pr-1 text-xs tabular-nums">{lane.meta ?? lane.total}</span>
            </header>
            {laneCards(lane)}
          </section>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
