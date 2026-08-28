import { useEffect, useState } from 'react';
import { PackageIcon, PrinterIcon, ScanIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { FulfilmentTabs } from './fulfilment-tabs';
import { PersonChip } from '@/components/shared/person';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SearchField } from '@/components/shared/search-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import type { PackRecord } from './types';
import { usePackedList } from './use-fulfilment';

/**
 * Packed (D-47, owner): every pack across the orders this person may see,
 * newest first — the boxes that wait between packing and the door. Each
 * row is the packing slip's door, and printing its slips is one tap; the
 * scan sits in the header because this is the screen a box is found on.
 */

function PrintSlips({ pack }: { pack: PackRecord }) {
  return (
    <Button
      size="sm"
      variant="outline"
      nativeButton={false}
      render={<a href={`/print/packs/${pack.id}`} target="_blank" rel="noreferrer" />}
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <PrinterIcon data-icon="inline-start" />
      Print slips
    </Button>
  );
}

const COLUMNS: RecordColumn<PackRecord>[] = [
  { key: 'slip', header: 'Slip', cell: (pack) => <span className="tabular-nums font-medium">{pack.slipNumber}</span> },
  { key: 'customer', header: 'Customer', cell: (pack) => pack.customerName },
  { key: 'order', header: 'Order', cell: (pack) => <span className="tabular-nums">{pack.orderNumber}</span> },
  { key: 'boxes', header: 'Boxes', numeric: true, cell: (pack) => pack.boxCount },
  { key: 'lines', header: 'Lines', numeric: true, secondary: true, cell: (pack) => pack.lines.length },
  { key: 'packed', header: 'Packed', cell: (pack) => <span className="flex items-center gap-1.5"><PersonChip name={pack.packedByName ?? 'Someone'} tiny />{formatRelativeAge(pack.packedAt)}</span> },
  { key: 'print', header: '', className: 'w-36 text-right', cell: (pack) => <PrintSlips pack={pack} /> },
];

export function PackedPage() {
  const navigate = useNavigate();
  // P8-5: sight and act are both sales.fulfil here (the scan behind the
  // action button is a fulfilment route too).
  const canView = usePermission(PERMISSIONS.SALES_FULFIL);
  const canCreate = canView;
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const [draft, setDraft] = useState(q);
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
  const packs = usePackedList({ page, ...(q ? { q } : {}) });
  const rows = packs.data?.data ?? [];
  const meta = packs.data?.meta ?? null;

  if (!canView) {
    return (
      <>
        <PageHeader description="The boxes that wait between packing and the door." />
        <FulfilmentTabs current="packed" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WarningCircleIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view packs</EmptyTitle>
            <EmptyDescription>This needs sales.document.view.self or sales.document.view.all.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Every pack across your orders, newest first — the boxes that wait between packing and the door. Tap one for its slip; print the slips from the row."
        action={
          canCreate ? (
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/sales/scan" />}>
              <ScanIcon data-icon="inline-start" />
              Scan a slip
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="packed-search" label="Search packs" value={draft} onValueChange={setDraft} placeholder="Order number or customer" />
        </div>

        {packs.isPending ? <ListSkeleton rows={6} label="Loading packed boxes" /> : null}
        {packs.isError ? (
          <QueryErrorAlert
            error={packs.error}
            subject="packed boxes"
            onRetry={() => {
              void packs.refetch();
            }}
          />
        ) : null}
        {packs.isSuccess ? (
          <>
            <RecordTable
              columns={COLUMNS}
              rows={rows}
              rowKey={(pack) => pack.id}
              onRowActivate={(pack) => {
                void navigate(`/sales/packs/${pack.id}`);
              }}
              mobilePrimary={(pack) => `${pack.customerName} · ${pack.slipNumber}`}
              mobileStatus={(pack) => (
                <Badge variant="outline">
                  <PackageIcon />
                  {pack.boxCount} box{pack.boxCount === 1 ? '' : 'es'}
                </Badge>
              )}
              mobileSupporting={(pack) => (
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {pack.orderNumber} · packed {formatRelativeAge(pack.packedAt)}
                    {pack.packedByName ? ` by ${pack.packedByName}` : ''}
                  </span>
                  <PrintSlips pack={pack} />
                </span>
              )}
              emptyState={
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <PackageIcon />
                    </EmptyMedia>
                    <EmptyTitle>{q ? 'No pack matches' : 'Nothing packed yet'}</EmptyTitle>
                    <EmptyDescription>{q ? 'Try another order number or customer.' : 'Packs appear here the moment the pick queue packs something.'}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              }
            />
            {meta !== null && meta.total > meta.pageSize ? <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} /> : null}
          </>
        ) : null}
      </div>
    </>
  );
}
