import { useEffect, useState } from 'react';
import { GearIcon, LockKeyIcon, PlusIcon, ShoppingCartIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams, Link } from 'react-router';

import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { DOCUMENT_ICONS } from '@/components/shared/entity-icons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { SyncStateBadge } from '@/features/sales/sales-order-sheet';
import { EMPTY_VALUE, formatDate, formatMoney } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import {
  PERMISSIONS,
  PO_FULFILMENT_LABELS,
  PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_STATUS_LABELS,
  SYNC_STATES,
  SYNC_STATE_LABELS,
  type DocumentSyncState,
  type PurchaseOrderStatus,
} from '@vyuha/shared';

import type { PurchaseOrderSummary } from './types';
import { usePurchaseOrders } from './use-purchase';

/**
 * Purchase orders (REQ-X-13) with both their states in the register: the
 * document's and Tally's (REQ-X-17), and the fulfilment derived from the
 * lines (REQ-X-20). Filters by status and Tally state; a row opens the
 * order's page, where the paper is the editor.
 */

const ALL = '__all__';

const COLUMNS: RecordColumn<PurchaseOrderSummary>[] = [
  { key: 'number', header: 'Number', cell: (row) => (
    <span className="inline-flex items-center gap-1.5 font-medium tabular-nums [&_svg]:size-3.5">
      <DOCUMENT_ICONS.purchase_order aria-hidden className="text-muted-foreground" />
      {row.number}
    </span>
  ) },
  { key: 'vendor', header: 'Vendor', cell: (row) => row.vendorName },
  { key: 'date', header: 'Date', cell: (row) => formatDate(row.date), className: 'tabular-nums' },
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge state={row.status} label={PURCHASE_ORDER_STATUS_LABELS[row.status]} /> },
  {
    key: 'fulfilment',
    header: 'Received',
    cell: (row) => (row.status === 'CONFIRMED' ? <StatusBadge state={row.fulfilment} label={PO_FULFILMENT_LABELS[row.fulfilment]} /> : <span className="text-muted-foreground">{EMPTY_VALUE}</span>),
  },
  { key: 'sync', header: 'Tally', cell: (row) => <SyncStateBadge record={row} /> },
  { key: 'total', header: 'Total', cell: (row) => formatMoney(row.grandTotal), numeric: true },
  { key: 'expected', header: 'Expected', cell: (row) => formatDate(row.expectedDate), secondary: true, className: 'tabular-nums' },
];

function ListSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading purchase orders" className="border">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} aria-hidden className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="hidden h-3 w-40 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-3 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function isStatus(value: string | null): value is PurchaseOrderStatus {
  return PURCHASE_ORDER_STATUSES.some((s) => s === value);
}

export function PurchaseOrdersPage() {
  const canView = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
  const canCreate = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_CREATE);
  const canApprove = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_APPROVE);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const q = searchParams.get('q') ?? '';
  const statusParam = searchParams.get('status');
  const status = isStatus(statusParam) ? statusParam : undefined;
  const syncParam = searchParams.get('sync');
  const syncState = SYNC_STATES.find((s) => s === syncParam);
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const partyParam = searchParams.get('party') ?? '';
  const salesOrderParam = searchParams.get('salesOrder') ?? '';

  const [draft, setDraft] = useState(q);
  const [syncedQ, setSyncedQ] = useState(q);
  if (syncedQ !== q) {
    setSyncedQ(q);
    if (draft.trim() !== q) setDraft(q);
  }
  useEffect(() => {
    if (draft.trim() === q) return undefined;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          const value = draft.trim();
          if (value) next.set('q', value);
          else next.delete('q');
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, q, setSearchParams]);

  const query = usePurchaseOrders(
    { page, ...(q ? { q } : {}), ...(status ? { status } : {}), ...(syncState ? { syncState } : {}), ...(partyParam ? { partyId: partyParam } : {}), ...(salesOrderParam ? { salesOrderId: salesOrderParam } : {}) },
    { enabled: canView },
  );
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;

  // The creator is a page of its own — the paper is the editor.
  function startNew() {
    const presets = new URLSearchParams();
    if (partyParam) presets.set('party', partyParam);
    if (salesOrderParam) presets.set('salesOrder', salesOrderParam);
    const search = presets.toString();
    void navigate(`/purchase/orders/new${search ? `?${search}` : ''}`);
  }

  useShortcut({
    id: 'purchase.orders.create',
    keys: 'alt+c',
    label: 'New purchase order',
    scope: 'screen',
    when: () => canCreate,
    run: startNew,
  });

  if (!canView) {
    return (
      <>
        <PageHeader description="Purchase orders: what was ordered from whom, what has arrived, and whether Tally has it." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view purchase orders</EmptyTitle>
            <EmptyDescription>This needs purchase.document.view — the Purchase role carries it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const filtered = Boolean(q) || status !== undefined || syncState !== undefined || Boolean(partyParam || salesOrderParam);

  return (
    <>
      <PageHeader
        description="Confirmed orders push to Tally as Purchase Order vouchers. Received is derived from the lines, never stored; the Tally column is the agent's word."
        action={
          canCreate || canApprove ? (
            <>
              {canApprove ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Purchase settings"
                  nativeButton={false}
                  render={<Link to="/settings?tab=purchase" />}
                >
                  <GearIcon data-icon="inline-start" />
                  <span className="hidden sm:inline">Settings</span>
                </Button>
              ) : null}
              {canCreate ? (
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New purchase order
                  <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="po-search" label="Search purchase orders" value={draft} onValueChange={setDraft} placeholder="Number or vendor" />
          <Select
            value={status ?? ALL}
            onValueChange={(value: string | null) => {
              setSearchParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (value === null || value === ALL) next.delete('status');
                  else next.set('status', value);
                  next.delete('page');
                  return next;
                },
                { replace: true },
              );
            }}
          >
            <SelectTrigger className="w-44" aria-label="Status">
              <SelectValue>{(value: string) => (value === ALL ? 'Any status' : PURCHASE_ORDER_STATUS_LABELS[value as PurchaseOrderStatus])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {PURCHASE_ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PURCHASE_ORDER_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={syncState ?? ALL}
            onValueChange={(value: string | null) => {
              setSearchParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (value === null || value === ALL) next.delete('sync');
                  else next.set('sync', value);
                  next.delete('page');
                  return next;
                },
                { replace: true },
              );
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
        </div>

        {query.isPending ? <ListSkeleton /> : null}
        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="purchase orders"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShoppingCartIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No purchase order matches that' : 'No purchase orders yet'}</EmptyTitle>
              <EmptyDescription>{filtered ? 'Try another status or clear the search.' : canCreate ? 'Raise one from the requirements queue, or standalone here.' : 'Purchase orders appear here as the purchase team raises them.'}</EmptyDescription>
            </EmptyHeader>
            {!filtered && canCreate ? (
              <EmptyContent>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New purchase order
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => `${row.number} · ${row.vendorName}`}
              mobileStatus={(row) => <SyncStateBadge record={row} />}
              mobileSupporting={(row) => `${formatDate(row.date)} · ${formatMoney(row.grandTotal)} · ${PURCHASE_ORDER_STATUS_LABELS[row.status]}${row.status === 'CONFIRMED' ? ` · ${PO_FULFILMENT_LABELS[row.fulfilment]}` : ''}`}
              onRowActivate={(row) => {
                void navigate(`/purchase/orders/${row.id}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} /> : null}
          </>
        ) : null}
      </div>
    </>
  );
}
