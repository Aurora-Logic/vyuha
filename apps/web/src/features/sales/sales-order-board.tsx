import { PackageIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

import { KanbanBoard, type KanbanLane } from '@/components/shared/kanban-board';
import { StatusBadge } from '@/components/shared/status-badge';
import { STATUS_ICONS, statusTone, type StatusTone } from '@/components/shared/status-tone';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatMoney } from '@/lib/format';
import { FULFILMENT_STATES, FULFILMENT_STATE_LABELS, SYNC_STATE_LABELS } from '@vyuha/shared';

import type { EstimateSummary } from './types';
import { useSalesOrders } from './use-estimates';

/**
 * The fulfilment board (owner, 22 Aug): confirmed orders as cards, standing in
 * the lane of the stage their lines have reached — open, picking, awaiting
 * invoice, ready to dispatch, partially dispatched, closed, short-closed.
 *
 * Read-only on purpose. A lane is a fact derived from the order's lines
 * (REQ-AA-02), not a place you drop a card: you move an order by packing,
 * invoicing and dispatching it, and the board follows. So the cards open the
 * order but do not drag — the honest model, and it keeps a stray drop from
 * implying a state the numbers don't support.
 */

/** The lane header chip's colour, from the one status-tone vocabulary. */
const LANE_ACCENT: Record<StatusTone, string> = {
  info: 'bg-info/15 text-info',
  warning: 'bg-warning/15 text-warning',
  success: 'bg-success/15 text-success',
  destructive: 'bg-destructive/15 text-destructive',
  secondary: 'bg-secondary text-secondary-foreground',
  outline: 'bg-muted text-muted-foreground',
  default: 'bg-primary/15 text-primary',
};

// One reach for the board: enough confirmed orders to fill the lanes without
// paging. The header says when it was capped.
const BOARD_SIZE = 100;

export function SalesOrderBoard({ canView }: { canView: boolean }) {
  const navigate = useNavigate();
  const query = useSalesOrders({ page: 1, pageSize: BOARD_SIZE, status: 'CONFIRMED' }, { enabled: canView });
  const rows = query.data?.data ?? [];

  if (query.isError) {
    return <QueryErrorAlert error={query.error} subject="the orders" onRetry={() => void query.refetch()} />;
  }
  if (query.isPending) return <BoardSkeleton />;

  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PackageIcon />
          </EmptyMedia>
          <EmptyTitle>No orders in fulfilment</EmptyTitle>
          <EmptyDescription>A confirmed order stands here on the stage its lines have reached. Confirm an order to start.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const lanes: KanbanLane<EstimateSummary>[] = FULFILMENT_STATES.map((state) => {
    const items = rows.filter((order) => order.fulfilment === state);
    const Glyph = STATUS_ICONS[state];
    return {
      id: state,
      label: FULFILMENT_STATE_LABELS[state],
      title: (
        <span className="flex items-center gap-1.5">
          {Glyph ? <Glyph aria-hidden /> : null}
          {FULFILMENT_STATE_LABELS[state]}
        </span>
      ),
      items,
      total: items.length,
      accent: LANE_ACCENT[statusTone(state)],
      muted: state === 'short_closed',
    };
  });

  return (
    <KanbanBoard
      lanes={lanes}
      readOnly
      itemKey={(order) => order.id}
      itemLaneId={(order) => order.fulfilment ?? 'open'}
      itemLabel={(order) => `${order.number} for ${order.customerName}`}
      onOpen={(order) => {
        void navigate(`/sales/orders/${order.id}`);
      }}
      ariaLabel="Confirmed orders by fulfilment stage"
      overflowHint="the list"
      renderItem={(order) => (
        <>
          <span className="flex w-full items-center justify-between gap-2">
            <span className="font-medium tabular-nums">{order.number}</span>
            <StatusBadge state={order.syncState} label={SYNC_STATE_LABELS[order.syncState]} />
          </span>
          <span className="text-muted-foreground w-full truncate text-xs">{order.customerName}</span>
          <span className="w-full text-xs font-medium tabular-nums">{formatMoney(order.grandTotal)}</span>
        </>
      )}
    />
  );
}

function BoardSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the board" className="flex gap-3 overflow-hidden">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} aria-hidden className="bg-muted/40 flex w-72 shrink-0 flex-col gap-1.5 rounded-lg p-1.5">
          <Skeleton className="mb-1 h-5 w-28" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  );
}
