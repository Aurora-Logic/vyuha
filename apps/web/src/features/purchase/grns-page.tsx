import { useState } from 'react';
import { LockKeyIcon, PackageIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PersonChip } from '@/components/shared/person';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { DOCUMENT_ICONS } from '@/components/shared/entity-icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { SyncStateBadge } from '@/features/sales/sales-order-sheet';
import { formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import type { Grn } from './types';
import { useGrns } from './use-purchase';

/**
 * Goods receipts (REQ-X-19…X-22): each one a Receipt Note in Tally, with
 * what still waits on a person — a receipt short of the orders behind it
 * (REQ-X-27) — worn as a badge so it is not found by opening every row.
 * The list is the newest two hundred; the page window is cut here.
 */

const PAGE_SIZE = 25;

function PendingBadge({ grn }: { grn: Grn }) {
  if (grn.pendingAllocations.length === 0) return null;
  return <Badge variant="destructive">{String(grn.pendingAllocations.length)} pending allocation{grn.pendingAllocations.length === 1 ? '' : 's'}</Badge>;
}

const COLUMNS: RecordColumn<Grn>[] = [
  { key: 'number', header: 'Number', cell: (row) => (
    <span className="inline-flex items-center gap-1.5 font-medium tabular-nums [&_svg]:size-3.5">
      <DOCUMENT_ICONS.grn aria-hidden className="text-muted-foreground" />
      {row.number}
    </span>
  ) },
  { key: 'po', header: 'Purchase order', cell: (row) => <span className="tabular-nums">{row.purchaseOrderNumber}</span> },
  { key: 'vendor', header: 'Vendor', cell: (row) => row.vendorName },
  { key: 'received', header: 'Received', cell: (row) => formatRelativeAge(row.receivedAt), className: 'tabular-nums' },
  { key: 'sync', header: 'Tally', cell: (row) => <SyncStateBadge record={row} /> },
  { key: 'pending', header: 'Allocation', cell: (row) => <PendingBadge grn={row} /> },
  { key: 'by', header: 'Received by', cell: (row) => <PersonChip name={row.receivedByName} />, secondary: true },
];

export function GrnsPage() {
  const canView = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const po = searchParams.get('po') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const query = useGrns({ ...(po ? { purchaseOrderId: po } : {}) }, { enabled: canView });

  const needle = q.trim().toLowerCase();
  const all = (query.data ?? []).filter((row) => needle === '' || [row.number, row.purchaseOrderNumber, row.vendorName].some((text) => text.toLowerCase().includes(needle)));
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (!canView) {
    return (
      <>
        <PageHeader description="Goods receipts: what arrived against each purchase order, and whether Tally has the Receipt Note." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view goods receipts</EmptyTitle>
            <EmptyDescription>This needs purchase.document.view — the Purchase role carries it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const filtered = needle !== '' || po !== '';

  return (
    <>
      <PageHeader description="Each receipt pushes to Tally as a Receipt Note; the accountant books the bill against it. A receipt short of the orders waiting on it asks for an allocation here." />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="grn-search" label="Search goods receipts" value={q} onValueChange={setQ} placeholder="GRN, PO or vendor" />
          {po ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchParams(
                  (current) => {
                    const next = new URLSearchParams(current);
                    next.delete('po');
                    next.delete('page');
                    return next;
                  },
                  { replace: true },
                );
              }}
            >
              <ACTION_ICONS.clearFilters data-icon="inline-start" />
              One purchase order — clear
            </Button>
          ) : null}
        </div>

        {query.isPending ? <ListSkeleton rows={4} label="Loading goods receipts" /> : null}
        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="goods receipts"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && all.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No receipt matches that' : 'Nothing received yet'}</EmptyTitle>
              <EmptyDescription>{filtered ? 'Clear the search or the purchase order filter.' : 'Receipts are recorded from a confirmed purchase order: open it and press Receive.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => `${row.number} · ${row.purchaseOrderNumber}`}
              mobileStatus={(row) => (
                <>
                  <PendingBadge grn={row} />
                  <SyncStateBadge record={row} />
                </>
              )}
              mobileSupporting={(row) => `${row.vendorName} · ${formatRelativeAge(row.receivedAt)}`}
              onRowActivate={(row) => {
                void navigate(`/purchase/grns/${row.id}`);
              }}
            />
            {all.length > PAGE_SIZE ? <RecordPagination page={page} pageSize={PAGE_SIZE} total={all.length} /> : null}
          </>
        ) : null}
      </div>

    </>
  );
}
