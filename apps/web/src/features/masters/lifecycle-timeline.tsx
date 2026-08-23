import { Fragment, useState } from 'react';
import { BookOpenTextIcon, CheckCircleIcon, HandGrabbingIcon, PackageIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { DOCUMENT_ICONS } from '@/components/shared/entity-icons';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemSeparator, ItemTitle } from '@/components/ui/item';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatDate, formatMoney, humaniseEnum } from '@/lib/format';
import { LIFECYCLE_EVENT_LABELS, type LifecycleEvent, type LifecycleEventKind } from '@vyuha/shared';

/**
 * The timeline a lifecycle is read on: newest first, grouped by month, one
 * glyph per kind, every row a door to the document it names. The filter
 * is three words, not ten checkboxes: what was sold, what was bought, what
 * Tally says.
 */
const ICONS: Record<LifecycleEventKind, typeof PackageIcon> = {
  estimate: DOCUMENT_ICONS.estimate,
  order: DOCUMENT_ICONS.sales_order,
  pick: HandGrabbingIcon,
  pack: PackageIcon,
  dispatch: DOCUMENT_ICONS.dispatch,
  delivery: CheckCircleIcon,
  invoice: DOCUMENT_ICONS.invoice,
  purchase_order: DOCUMENT_ICONS.purchase_order,
  grn: DOCUMENT_ICONS.grn,
  voucher: BookOpenTextIcon,
};

const SIDES = {
  all: null,
  sales: new Set<LifecycleEventKind>(['estimate', 'order', 'pick', 'pack', 'dispatch', 'delivery', 'invoice']),
  purchase: new Set<LifecycleEventKind>(['purchase_order', 'grn']),
  tally: new Set<LifecycleEventKind>(['voucher']),
} as const;
type Side = keyof typeof SIDES;

function monthOf(at: string): string {
  return new Date(at).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export function LifecycleTimeline({ events, title = 'Timeline' }: { events: readonly LifecycleEvent[]; title?: string }) {
  const [side, setSide] = useState<Side>('all');
  const shown = SIDES[side] === null ? events : events.filter((event) => SIDES[side]?.has(event.kind));
  const months = new Map<string, LifecycleEvent[]>();
  for (const event of shown) {
    const key = monthOf(event.at);
    months.set(key, [...(months.get(key) ?? []), event]);
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title={title}
        note={`${String(shown.length)} of ${String(events.length)} events, newest first. Every row opens the document.`}
        action={
          <ToggleGroup
            variant="outline"
            aria-label="Which events"
            value={[side]}
            onValueChange={(next: string[]) => {
              const value = next[0];
              if (value === 'all' || value === 'sales' || value === 'purchase' || value === 'tally') setSide(value);
            }}
          >
            <ToggleGroupItem value="all" size="sm">All</ToggleGroupItem>
            <ToggleGroupItem value="sales" size="sm">Sales</ToggleGroupItem>
            <ToggleGroupItem value="purchase" size="sm">Purchase</ToggleGroupItem>
            <ToggleGroupItem value="tally" size="sm">Tally</ToggleGroupItem>
          </ToggleGroup>
        }
      />
      {shown.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Nothing yet</EmptyTitle>
            <EmptyDescription>{events.length === 0 ? 'Nothing in the system has touched this record.' : 'Nothing on this side. Try All.'}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        [...months.entries()].map(([month, entries]) => (
          <section key={month} className="flex flex-col gap-1.5">
            <h3 className="text-muted-foreground text-xs font-medium">{month}</h3>
            <ItemGroup role="list" className="gap-0 border">
              {entries.map((event, index) => {
                const Glyph = ICONS[event.kind];
                return (
                  <Fragment key={`${event.kind}-${event.id}-${event.at}`}>
                    {index > 0 ? <ItemSeparator className="my-0" /> : null}
                    <Item size="sm" role="listitem" className="min-h-11 rounded-none" render={<Link to={event.href} />}>
                      <Glyph aria-hidden className="text-muted-foreground size-4 shrink-0" />
                      <ItemContent className="min-w-0 gap-0.5">
                        <ItemTitle className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate">{event.title}</span>
                          <span className="text-muted-foreground shrink-0 text-xs font-normal">{LIFECYCLE_EVENT_LABELS[event.kind]}</span>
                        </ItemTitle>
                        <ItemDescription className="truncate">
                          <span className="tabular-nums">{formatDate(event.at.slice(0, 10))}</span>
                          {event.detail ? ` · ${event.detail}` : ''}
                        </ItemDescription>
                      </ItemContent>
                      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums">
                        {event.quantity !== null ? <span>{event.quantity.replace(/\.?0+$/u, '')}{event.unit ? ` ${event.unit}` : ''}</span> : null}
                        {event.amount !== null ? <span className="text-muted-foreground">{formatMoney(event.amount)}</span> : null}
                        {event.state ? <Badge variant="outline">{humaniseEnum(event.state)}</Badge> : null}
                      </div>
                    </Item>
                  </Fragment>
                );
              })}
            </ItemGroup>
          </section>
        ))
      )}
    </section>
  );
}
