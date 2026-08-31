import { LockKeyIcon, ScanIcon, TruckIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { FulfilmentTabs } from './fulfilment-tabs';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { DOCUMENT_ICONS } from '@/components/shared/entity-icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { useSearchDraft } from '@/lib/use-search-draft';
import { DISPATCH_MODES, DISPATCH_MODE_LABELS, PERMISSIONS, SYNC_STATES, SYNC_STATE_LABELS, type DispatchMode, type DocumentSyncState } from '@vyuha/shared';

import { SyncStateBadge } from './sales-order-sheet';
import type { Dispatch } from './types';
import { useDispatches } from './use-dispatches';

/**
 * REQ-AA-23: the dispatch board, the logistics team's home screen —
 * everything in flight, newest first, by mode and by Tally state, with the
 * customer notification's state beside each. `?order=` narrows it to one
 * order's history (REQ-AA-31), which is how the order sheet links here.
 */

const ALL = '__all__';

/** REQ-AA-27 in one cell: how many of the composed messages have gone. */
function NotificationSummary({ row }: { row: Dispatch }) {
  const sent = row.notifications.filter((n) => n.status === 'sent').length;
  const failed = row.notifications.filter((n) => n.status === 'failed').length;
  const total = row.notifications.length;
  if (total === 0) return <Badge variant="outline">No message</Badge>;
  if (failed > 0) return <Badge variant="destructive">{`${String(failed)} failed`}</Badge>;
  if (sent === total) return <Badge>Customer told</Badge>;
  return <Badge variant="outline">{`${String(total - sent)} to send`}</Badge>;
}

const COLUMNS: RecordColumn<Dispatch>[] = [
  { key: 'number', header: 'Number', cell: (row) => (
    <span className="inline-flex items-center gap-1.5 font-medium tabular-nums [&_svg]:size-3.5">
      <DOCUMENT_ICONS.dispatch aria-hidden className="text-muted-foreground" />
      {row.number}
    </span>
  ) },
  { key: 'order', header: 'Order', cell: (row) => <span className="tabular-nums">{row.orderNumber}</span> },
  { key: 'customer', header: 'Customer', cell: (row) => row.customerName },
  { key: 'mode', header: 'Mode', cell: (row) => DISPATCH_MODE_LABELS[row.mode] },
  { key: 'when', header: 'Dispatched', cell: (row) => formatRelativeAge(row.dispatchedAt), className: 'tabular-nums' },
  { key: 'sync', header: 'Tally', cell: (row) => <SyncStateBadge record={row} /> },
  { key: 'notify', header: 'Notification', cell: (row) => <NotificationSummary row={row} /> },
  { key: 'by', header: 'By', cell: (row) => row.dispatchedByName ?? '', secondary: true },
];

/** `stage="delivered"` is the Delivered screen: the same list, only what the customer has signed for. */
export function DispatchesPage({ stage }: { stage?: 'delivered' } = {}) {
  const delivered = stage === 'delivered';
  // P8-5: dispatches are the floor's list, gated like their endpoint.
  const canView = usePermission(PERMISSIONS.SALES_FULFIL);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const q = searchParams.get('q') ?? '';
  const modeParam = searchParams.get('mode');
  const mode = DISPATCH_MODES.find((m) => m === modeParam);
  const syncParam = searchParams.get('sync');
  const syncState = SYNC_STATES.find((s) => s === syncParam);
  const orderParam = searchParams.get('order') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const [draft, setDraft] = useSearchDraft();

  const query = useDispatches({ page, ...(q ? { q } : {}), delivered: delivered ? 'yes' : 'no', ...(mode ? { mode } : {}), ...(syncState ? { syncState } : {}), ...(orderParam ? { documentId: orderParam } : {}) }, { enabled: canView });
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;
  function setParam(name: string, value: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null || value === ALL) next.delete(name);
        else next.set(name, value);
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  }

  if (!canView) {
    return (
      <>
        <PageHeader description={delivered ? 'Every dispatch the customer has signed for, newest first.' : 'Every dispatch in flight: mode, LR, photographs, and whether the customer has been told.'} />
        <FulfilmentTabs current={delivered ? 'delivered' : 'dispatched'} />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>{delivered ? 'Nothing delivered yet' : 'You cannot view dispatches'}</EmptyTitle>
            <EmptyDescription>{delivered ? 'A dispatch arrives here once it is scanned and marked delivered at the door.' : 'This needs sales.document.view.self or sales.document.view.all — the Sales role carries it.'}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const filtered = Boolean(q) || mode !== undefined || syncState !== undefined || Boolean(orderParam);

  return (
    <>
      <PageHeader
        description="Every dispatch, newest first. Each is its own record with its own lines; it pushes to Tally as a Delivery Note, the customer's mail goes by itself, and WhatsApp is one tap."
        action={
          // D-47: the scan is one tap from the screens a person holds a box on.
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/sales/scan" />}>
            <ScanIcon data-icon="inline-start" />
            Scan a slip
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="dispatch-search" label="Search dispatches" value={draft} onValueChange={setDraft} placeholder="Number, order, customer or LR" />
          <Select
            value={mode ?? ALL}
            onValueChange={(value: string | null) => {
              setParam('mode', value);
            }}
          >
            <SelectTrigger className="w-44" aria-label="Mode">
              <SelectValue>{(value: string) => (value === ALL ? 'Any mode' : DISPATCH_MODE_LABELS[value as DispatchMode])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any mode</SelectItem>
              {DISPATCH_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {DISPATCH_MODE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={syncState ?? ALL}
            onValueChange={(value: string | null) => {
              setParam('sync', value);
            }}
          >
            <SelectTrigger className="w-44" aria-label="Tally state">
              <SelectValue>{(value: string) => (value === ALL ? 'Any Tally state' : SYNC_STATE_LABELS[value as DocumentSyncState])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any Tally state</SelectItem>
              {SYNC_STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SYNC_STATE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {orderParam ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setParam('order', null);
              }}
            >
              <ACTION_ICONS.clearFilters data-icon="inline-start" />
              One order only — show all
            </Button>
          ) : null}
        </div>

        {query.isPending ? <ListSkeleton rows={4} label="Loading dispatches" /> : null}
        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="dispatches"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TruckIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No dispatch matches that' : 'Nothing dispatched yet'}</EmptyTitle>
              <EmptyDescription>
                {orderParam ? (
                  <>
                    Nothing has left against this order yet.{' '}
                    <Link to={`/sales/orders/${orderParam}`} className="underline-offset-4 hover:underline">
                      Open the order
                    </Link>{' '}
                    to dispatch what an invoice covers.
                  </>
                ) : filtered ? (
                  'Try another mode or clear the search.'
                ) : (
                  'A dispatch is made from a sales order once an invoice covers the quantity. Open the order and choose Dispatch.'
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => `${row.number} · ${row.customerName}`}
              mobileStatus={(row) => <NotificationSummary row={row} />}
              mobileSupporting={(row) => `${row.orderNumber} · ${DISPATCH_MODE_LABELS[row.mode]} · ${formatRelativeAge(row.dispatchedAt)} · ${SYNC_STATE_LABELS[row.syncState]}`}
              onRowActivate={(row) => {
                void navigate(`/sales/dispatches/${row.id}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} /> : null}
          </>
        ) : null}
      </div>

    </>
  );
}
