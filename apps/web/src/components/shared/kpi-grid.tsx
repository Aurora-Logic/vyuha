import type React from 'react';
import type { ReactNode } from 'react';
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from '@phosphor-icons/react';

import { deltaOf } from '@/lib/period-compare';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The figures a record or a dashboard opens with: label over value, and
 * beneath it either the change against the comparison period (absolute and
 * percent, or "new" when the base was zero -- never an infinite percent) or a
 * line of context.
 *
 * A Card each, three across, matching every chart on the page. It used to be
 * one bordered strip divided into cells, which was a second card pattern in a
 * product that has one, and at six across a rupee amount wrapped inside its
 * own cell.
 */

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  /** The raw numbers, when a comparison is shown; the delta is derived here so every tile reads it the same way. */
  current?: number;
  previous?: number | null;
  /** The figure's own formatter, for the absolute change. */
  format?: (value: number) => string;
  /** True when a fall is good news (lead time, rejections, shortages). */
  lowerIsBetter?: boolean;
  /** A word under the value: "approx.", "now", the period. */
  note?: string;
  /** Where the figure comes from. A tile with one is a link. */
  onOpen?: () => void;
  /** The glyph the figure's subject wears elsewhere (the flag). */
  icon?: ReactNode;
}

export function KpiGrid({ tiles, columns = 3, className }: { tiles: readonly KpiTileProps[]; columns?: 3 | 4 | 6; className?: string }) {
  return (
    <dl
      className={cn(
        // Six is the dashboard strip: a full set of headline figures in one
        // band on a wide screen, stepping down through three to the phone's
        // two without any tile dropping below a readable width.
        'grid grid-cols-2 gap-3',
        columns === 6 ? 'sm:grid-cols-3 xl:grid-cols-6' : columns === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {tiles.map((tile) => (
        <KpiTile key={tile.label} {...tile} />
      ))}
    </dl>
  );
}

export function KpiTile({ label, value, current, previous, format, lowerIsBetter = false, note, onOpen, icon }: KpiTileProps) {
  const delta = current !== undefined && previous !== undefined && previous !== null ? deltaOf(current, previous) : null;
  const good = delta === null ? null : delta.direction === 'flat' ? null : (delta.direction === 'up') !== lowerIsBetter;
  return (
    <Card
      className={cn(
        'min-w-0 gap-1 px-4 py-3.5',
        onOpen !== undefined && 'hover:bg-accent/40 focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2',
      )}
      {...(onOpen === undefined
        ? {}
        : {
            role: 'link',
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen();
              }
            },
          })}
    >
      {/*
        Wrapping, not truncated. Two tiles across a 360px phone leaves about
        130px of label, and "Receivables exposure" cut to "Receivables ex..."
        tells the reader less than a second line does.
      */}
      <dt className="text-muted-foreground text-xs leading-tight text-balance">
        {icon === undefined ? null : (
          <span aria-hidden className="mr-1 inline-flex align-[-2px] [&_svg]:size-3">
            {icon}
          </span>
        )}
        {label}
      </dt>
      {/*
        A step smaller on a phone, and never truncated: a rupee figure cut in
        the middle is a wrong number, not a shortened one. Twenty pixels of
        "24,78,282.20" does not fit half a phone; eighteen does.
      */}
      <dd className="text-lg leading-tight font-semibold tabular-nums sm:text-xl">{value}</dd>
      {delta !== null ? (
        <dd
          className={cn('flex items-center gap-1 text-[0.6875rem] tabular-nums', good === null ? 'text-muted-foreground' : good ? 'text-success' : 'text-destructive')}
          aria-label={`Change against the comparison period: ${deltaText(delta.absolute, delta.pct, delta.label, format)}`}
        >
          {delta.direction === 'up' ? <ArrowUpRightIcon /> : delta.direction === 'down' ? <ArrowDownRightIcon /> : <MinusIcon />}
          {deltaText(delta.absolute, delta.pct, delta.label, format)}
        </dd>
      ) : note ? (
        <dd className="text-muted-foreground text-[0.6875rem] leading-snug text-pretty">{note}</dd>
      ) : null}
    </Card>
  );
}

function deltaText(absolute: number, pct: number | null, label: 'new' | 'none' | null, format?: (value: number) => string): string {
  if (label === 'new') return 'new';
  if (label === 'none') return 'no change';
  const abs = (format ?? ((v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })))(Math.abs(absolute));
  const sign = absolute > 0 ? '+' : absolute < 0 ? '−' : '';
  return pct === null ? `${sign}${abs}` : `${sign}${abs} (${sign}${String(Math.abs(pct))}%)`;
}
