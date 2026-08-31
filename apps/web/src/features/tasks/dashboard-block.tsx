import type { ReactNode } from 'react';

import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * One block on a dashboard, in the shape Notion uses (owner, 31 Aug 2026:
 * "refer notion dashboard").
 *
 * What that reference actually is, read off the real thing rather than
 * remembered: a grid of small bordered blocks, each with a quiet labelled
 * strip at the top carrying an icon, a name and the block's own controls, and
 * the content beneath it. The label is small and muted — it names the block
 * without competing with what is in it, which is why a Notion dashboard reads
 * as its numbers and not as its furniture.
 *
 * One level deep, always. CLAUDE.md §3 forbids a card inside a card, and a
 * block holding another block is exactly that; a block holds a chart, a list
 * or a number, and never a second block.
 */
export function DashboardBlock({
  icon,
  label,
  note,
  action,
  span,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  /** A word on what the block counts, where the label alone would be ambiguous. */
  readonly note?: string;
  /** The block's own control, at the right of its strip — a period, a filter. */
  readonly action?: ReactNode;
  /** `wide` takes both columns on a desktop; everything is one column on a phone. */
  readonly span?: 'wide';
  readonly children: ReactNode;
}) {
  return (
    <Card size="sm" className={cn('min-w-0', span === 'wide' && 'lg:col-span-2')}>
      <CardHeader className="border-b pb-3">
        <CardTitle className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <span aria-hidden className="[&_svg]:size-3.5">
            {icon}
          </span>
          {label}
          {note === undefined ? null : <span className="text-muted-foreground/70 font-normal">· {note}</span>}
        </CardTitle>
        {action === undefined ? null : <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

/**
 * The number a block exists to show.
 *
 * Big, tabular and alone. Notion's dashboard puts one figure in the middle of
 * a block and nothing else, which is what makes it readable across a room;
 * the label is already in the block's strip, so repeating it here would be
 * saying the same thing twice in two sizes.
 */
export function BlockNumber({
  value,
  caption,
  captionTone,
}: {
  readonly value: string;
  readonly caption?: string;
  /**
   * The warning belongs to the caption, never to the figure.
   *
   * Seventeen open tasks is not a problem; six of them being late is. Painting
   * the 17 amber because six are overdue tells the reader the wrong number is
   * wrong -- it was on screen for one screenshot and read as "17 is bad".
   */
  readonly captionTone?: 'warning';
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-3xl leading-none font-semibold tabular-nums">{value}</span>
      {caption === undefined ? null : (
        <span className={cn('text-xs', captionTone === 'warning' ? 'text-warning' : 'text-muted-foreground')}>
          {caption}
        </span>
      )}
    </div>
  );
}

/** Two or four figures side by side inside one block, where one number would under-tell. */
export function BlockFigures({
  figures,
}: {
  readonly figures: readonly { label: string; value: string; tone?: 'warning' }[];
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
      {figures.map((figure) => (
        <div key={figure.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground text-xs">{figure.label}</dt>
          <dd
            className={cn(
              'text-xl leading-none font-semibold tabular-nums',
              figure.tone === 'warning' && 'text-warning',
            )}
          >
            {figure.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
