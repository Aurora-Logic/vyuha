import { useEffect, useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon, PackageIcon } from '@phosphor-icons/react';
import { useSearchParams, useNavigate } from 'react-router';

import { DuplicateBadge } from '@/components/shared/duplicate-badge';
import { DUPLICATE_ROW_CLASS } from '@/components/shared/duplicate-flag';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { useUrlSort } from '@/components/shared/use-url-sort';
import { SearchField } from '@/components/shared/search-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, STOCK_ITEM_SORT_FIELDS } from '@vyuha/shared';

import { useStockItems, type StockItem } from './use-stock-items';

/**
 * REQ-R-02, the same contract as the parties screen: read-only end to end,
 * filter state in the URL. The GST rate renders exactly as Tally holds it.
 */

const COLUMNS: RecordColumn<StockItem>[] = [
  {
    key: 'name',
    header: 'Item',
    sortField: 'name',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-medium">{row.name}</span>
        {row.absentInTally ? <Badge variant="outline">Absent in Tally</Badge> : null}
      </span>
    ),
  },
  { key: 'group', header: 'Stock group', cell: (row) => row.parentGroup, secondary: true },
  { key: 'unit', header: 'Unit', cell: (row) => row.unit },
  {
    key: 'gst',
    header: 'GST rate',
    sortField: 'gstRate',
    cell: (row) => (row.gstRate === null ? EMPTY_VALUE : `${row.gstRate}%`),
    numeric: true,
  },
  {
    key: 'pulled',
    header: 'As of',
    cell: (row) => formatRelativeAge(row.lastPulledAt),
    className: 'tabular-nums',
    secondary: true,
  },
];

function ListSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading stock items" className="border">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-44 shrink-0" />
          <Skeleton className="hidden h-3 w-24 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-3 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function StockItemsPage() {
  const navigate = useNavigate();
  const canView = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const [draft, setDraft] = useState(q);
  // The same incoming-filter sync the parties screen carries, for the same
  // reason: Go To can navigate here with a fresh ?q while mounted.
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

  const { sort, activeSort, onSortChange } = useUrlSort(STOCK_ITEM_SORT_FIELDS);
  const query = useStockItems({ page, ...(q ? { q } : {}), ...(sort ? { sort } : {}) }, { enabled: canView, prefetchNext: true });
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;

  if (!canView) {
    return (
      <>
        <PageHeader description="Stock items, pulled from TallyPrime." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the Tally masters</EmptyTitle>
            <EmptyDescription>
              This needs the masters.tally.view permission, the same key the rest of the Masters
              module is gated on.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Stock items, pulled from TallyPrime. Read-only: an item is created and edited in Tally, and arrives here on the next sync."
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            <ArrowsClockwiseIcon data-icon="inline-start" />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            id="stock-item-search"
            label="Search stock items"
            value={draft}
            onValueChange={setDraft}
            placeholder="Name or alias"
          />
        </div>

        {query.isPending ? <ListSkeleton /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="stock items"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageIcon />
              </EmptyMedia>
              <EmptyTitle>{q ? 'No item matches that' : 'No stock items yet'}</EmptyTitle>
              <EmptyDescription>
                {q
                  ? 'Try a different name or alias.'
                  : 'Stock items arrive when the Tally agent completes its first pull. Run a pull from the Integrations screen.'}
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
              sort={activeSort}
              onSortChange={onSortChange}
              rowClassName={(row) => (row.duplicate ? DUPLICATE_ROW_CLASS : undefined)}

              rowLeading={(row) => (row.duplicate ? <DuplicateBadge flag={row.duplicate} /> : null)}
              mobilePrimary={(row) => row.name}
              onRowActivate={(row) => {
                void navigate(`/masters/items/${row.id}`);
              }}
              mobileStatus={(row) =>
                row.absentInTally ? <Badge variant="outline">Absent</Badge> : row.duplicate ? <Badge variant="destructive">Duplicate?</Badge> : null
              }
              mobileSupporting={(row) =>
                `${row.parentGroup} · ${row.unit}${row.gstRate === null ? '' : ` · GST ${row.gstRate}%`}`
              }
            />
            {meta !== null && meta.total > meta.pageSize ? (
              <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} />
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
