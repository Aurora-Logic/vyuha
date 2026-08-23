import { useEffect, useState } from 'react';
import { FileTextIcon, GearIcon, KanbanIcon, ListIcon, LockKeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams, Link } from 'react-router';

import { PersonChip } from '@/components/shared/person';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { useUrlSort } from '@/components/shared/use-url-sort';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { StatusBadge } from '@/components/shared/status-badge';
import { DOCUMENT_ICONS } from '@/components/shared/entity-icons';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { SalesOrderBoard } from './sales-order-board';
import { formatDate, formatMoney, EMPTY_VALUE } from '@/lib/format';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { ESTIMATE_SORT_FIELDS, PERMISSIONS, SALES_DOCUMENT_STATUS_LABELS, SALES_ORDER_STATUSES, SYNC_STATES, SYNC_STATE_LABELS, type DocumentSyncState, type SalesOrderStatus } from '@vyuha/shared';

import { SyncStateBadge } from './sales-order-sheet';
import { FulfilmentBadge } from './fulfilment-badge';
import type { EstimateSummary } from './types';
import { useSalesOrders } from './use-estimates';

/**
 * Sales orders (REQ-W-03) with their sync state in the register (REQ-W-06):
 * a status filter and a Tally-state filter, and the sheet the route opens.
 */

const ALL = '__all__';

const COLUMNS: RecordColumn<EstimateSummary>[] = [
  { key: 'number', header: 'Number', sortField: 'number', cell: (row) => (
    <span className="inline-flex items-center gap-1.5 font-medium tabular-nums [&_svg]:size-3.5">
      <DOCUMENT_ICONS.sales_order aria-hidden className="text-muted-foreground" />
      {row.number}
    </span>
  ) },
  { key: 'customer', header: 'Customer', cell: (row) => row.customerName, sortField: 'customerName' },
  { key: 'date', header: 'Date', cell: (row) => formatDate(row.date), className: 'tabular-nums', sortField: 'date' },
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge state={row.status} label={SALES_DOCUMENT_STATUS_LABELS[row.status]} /> },
  { key: 'fulfilment', header: 'Fulfilment', cell: (row) => (row.fulfilment ? <FulfilmentBadge state={row.fulfilment} /> : EMPTY_VALUE) },
  { key: 'sync', header: 'Tally', cell: (row) => <SyncStateBadge record={row} /> },
  { key: 'total', header: 'Total', cell: (row) => formatMoney(row.grandTotal), numeric: true, sortField: 'grandTotal' },
  { key: 'owner', header: 'Owner', cell: (row) => <PersonChip name={row.ownerName} />, secondary: true },
];

function ListSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading sales orders" className="border">
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

function isStatus(value: string | null): value is SalesOrderStatus {
  return SALES_ORDER_STATUSES.some((s) => s === value);
}

export function SalesOrdersPage() {
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const canApproveDiscount = usePermission(PERMISSIONS.SALES_DISCOUNT_APPROVE);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const q = searchParams.get('q') ?? '';
  const statusParam = searchParams.get('status');
  const status = isStatus(statusParam) ? statusParam : undefined;
  const syncParam = searchParams.get('sync');
  const syncState = SYNC_STATES.find((s) => s === syncParam);
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const dealParam = searchParams.get('deal') ?? '';
  const partyParam = searchParams.get('party') ?? '';

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

  // The register and the fulfilment board draw the same orders two ways; the
  // board loads its own confirmed set, so the list query rests while it shows.
  const [view, setView] = useState<'list' | 'board'>('list');
  const { sort, activeSort, onSortChange } = useUrlSort(ESTIMATE_SORT_FIELDS);
  const query = useSalesOrders(
    { page, ...(q ? { q } : {}), ...(status ? { status } : {}), ...(syncState ? { syncState } : {}), ...(dealParam ? { dealId: dealParam } : {}), ...(partyParam ? { partyId: partyParam } : {}), ...(sort ? { sort } : {}) },
    { enabled: canView && view === 'list' },
  );
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;

  // The creator is a page of its own — the paper is the editor.
  function startNew() {
    const presets = new URLSearchParams();
    if (dealParam) presets.set('deal', dealParam);
    if (partyParam) presets.set('party', partyParam);
    const search = presets.toString();
    void navigate(`/sales/orders/new${search ? `?${search}` : ''}`);
  }

  useShortcut({
    id: 'sales.orders.create',
    keys: 'alt+c',
    label: 'New sales order',
    scope: 'screen',
    when: () => canCreate,
    run: startNew,
  });

  if (!canView) {
    return (
      <>
        <PageHeader description="Sales orders: what was ordered, and whether Tally has it." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view sales orders</EmptyTitle>
            <EmptyDescription>This needs sales.document.view.self or sales.document.view.all — the Sales role carries it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const filtered = Boolean(q) || status !== undefined || syncState !== undefined || Boolean(dealParam || partyParam);

  return (
    <>
      <PageHeader
        description="Confirmed orders push to Tally as Sales Order vouchers, one voucher per request. The Tally column is the agent's word, never inferred."
        action={
          canCreate || canApproveDiscount ? (
            <>
              {canApproveDiscount ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Sales settings"
                  nativeButton={false}
                  render={<Link to="/settings?tab=sales" />}
                >
                  <GearIcon data-icon="inline-start" />
                  <span className="hidden sm:inline">Settings</span>
                </Button>
              ) : null}
              {canCreate ? (
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New sales order
                  <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="order-search" label="Search sales orders" value={draft} onValueChange={setDraft} placeholder="Number or customer" />
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
            <SelectTrigger className="w-40" aria-label="Status">
              <SelectValue>{(value: string) => (value === ALL ? 'Any status' : SALES_DOCUMENT_STATUS_LABELS[value as SalesOrderStatus])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {SALES_ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SALES_DOCUMENT_STATUS_LABELS[s]}
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

          {/* Pushed to the end: the toggle changes how the same orders are
              drawn, so it sits with the view, not the filters. */}
          <ToggleGroup
            variant="outline"
            aria-label="View"
            className="ms-auto"
            value={[view]}
            onValueChange={(next: string[]) => {
              const chosen = next[0];
              if (chosen === 'list' || chosen === 'board') setView(chosen);
            }}
          >
            <ToggleGroupItem value="list" aria-label="List view">
              <ListIcon />
            </ToggleGroupItem>
            <ToggleGroupItem value="board" aria-label="Fulfilment board">
              <KanbanIcon />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {view === 'board' ? <SalesOrderBoard canView={canView} /> : null}

        {view === 'list' && query.isPending ? <ListSkeleton /> : null}
        {view === 'list' && query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="sales orders"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {view === 'list' && query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileTextIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No sales order matches that' : 'No sales orders yet'}</EmptyTitle>
              <EmptyDescription>{filtered ? 'Try another status or clear the search.' : canCreate ? 'Raise the first one, or convert an accepted estimate.' : 'Sales orders appear here as the sales team raises them.'}</EmptyDescription>
            </EmptyHeader>
            {!filtered && canCreate ? (
              <EmptyContent>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New sales order
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {view === 'list' && rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              sort={activeSort}
              onSortChange={onSortChange}
              mobilePrimary={(row) => `${row.number} · ${row.customerName}`}
              mobileStatus={(row) => <SyncStateBadge record={row} />}
              mobileSupporting={(row) => `${formatDate(row.date)} · ${formatMoney(row.grandTotal)} · ${SYNC_STATE_LABELS[row.syncState]}`}
              onRowActivate={(row) => {
                void navigate(`/sales/orders/${row.id}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} /> : null}
          </>
        ) : null}
      </div>
    </>
  );
}
