import { useEffect, useState } from 'react';
import { ArrowsClockwiseIcon, BooksIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useSearchParams, useNavigate } from 'react-router';

import { DuplicateBadge } from '@/components/shared/duplicate-badge';
import { DUPLICATE_ROW_CLASS } from '@/components/shared/duplicate-flag';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatMoney, formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { useParties, type Party } from './use-parties';

/**
 * REQ-R-01: the parties projection, read-only end to end. There is no create
 * button and no edit affordance anywhere on this screen, and that absence is
 * the requirement (REQ-R-04, permanent): a new customer is created in Tally,
 * where the accountant works, and appears here on the next pull.
 *
 * Filter state lives in the URL, like the employee register: a filtered list
 * must be a pasteable link and must survive a reload.
 */

const ALL_GROUPS = '__all__';

/** Tally's two party ledger sides (08 §3). */
const LEDGER_SIDES = ['Sundry Debtors', 'Sundry Creditors'] as const;

const COLUMNS: RecordColumn<Party>[] = [
  {
    key: 'name',
    header: 'Party',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-medium">{row.name}</span>
        {row.absentInTally ? <Badge variant="outline">Absent in Tally</Badge> : null}
      </span>
    ),
  },
  { key: 'group', header: 'Ledger side', cell: (row) => row.parentGroup, secondary: true },
  { key: 'gstin', header: 'GSTIN', cell: (row) => row.gstin ?? EMPTY_VALUE, className: 'tabular-nums' },
  {
    key: 'credit',
    header: 'Credit limit',
    // Tally's figure verbatim; this application never does arithmetic on it.
    cell: (row) => formatMoney(row.creditLimit),
    numeric: true,
  },
  {
    key: 'creditDays',
    header: 'Credit days',
    cell: (row) => (row.creditDays === null ? EMPTY_VALUE : String(row.creditDays)),
    numeric: true,
    secondary: true,
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
    <div role="status" aria-busy="true" aria-label="Loading parties" className="border">
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

export function PartiesPage() {
  const navigate = useNavigate();
  const canView = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const parentGroup = searchParams.get('group') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const [draft, setDraft] = useState(q);
  // The employees register's sync pattern, for the same reason it exists
  // there: Go To navigates to this route with a new ?q while the component
  // is already mounted, and a draft that ignored the change would debounce
  // the incoming filter straight back out of the URL.
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

  const query = useParties(
    { page, ...(q ? { q } : {}), ...(parentGroup ? { parentGroup } : {}) },
    { enabled: canView, prefetchNext: true },
  );
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;

  if (!canView) {
    return (
      <>
        <PageHeader description="Customers and vendors, pulled from TallyPrime." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the Tally masters</EmptyTitle>
            <EmptyDescription>
              This needs the masters.tally.view permission. Parties carry credit limits and
              balances, so the list is not shown more widely.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Customers and vendors, pulled from TallyPrime. Read-only: a party is created and edited in Tally, and arrives here on the next sync."
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
            id="party-search"
            label="Search parties"
            value={draft}
            onValueChange={setDraft}
            placeholder="Name, alias or GSTIN"
          />
          <Select
            value={parentGroup === '' ? ALL_GROUPS : parentGroup}
            onValueChange={(value) => {
              setSearchParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (value === null || value === ALL_GROUPS) next.delete('group');
                  else next.set('group', value);
                  next.delete('page');
                  return next;
                },
                { replace: true },
              );
            }}
          >
            <SelectTrigger className="w-44" aria-label="Ledger side">
              <SelectValue>{(value: string) => (value === ALL_GROUPS ? 'Both ledger sides' : value)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_GROUPS}>Both ledger sides</SelectItem>
              {LEDGER_SIDES.map((side) => (
                <SelectItem key={side} value={side}>
                  {side}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {query.isPending ? <ListSkeleton /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="parties"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BooksIcon />
              </EmptyMedia>
              <EmptyTitle>{q || parentGroup ? 'No party matches that' : 'No parties yet'}</EmptyTitle>
              <EmptyDescription>
                {q || parentGroup
                  ? 'Try a different name, alias or GSTIN, or clear the ledger-side filter.'
                  : 'Parties arrive when the Tally agent completes its first pull. Set up the connection under Administration, then run a pull from the Integrations screen.'}
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

              rowClassName={(row) => (row.duplicate ? DUPLICATE_ROW_CLASS : undefined)}

              rowLeading={(row) => (row.duplicate ? <DuplicateBadge flag={row.duplicate} /> : null)}
              mobilePrimary={(row) => row.name}
              onRowActivate={(row) => {
                void navigate(`/masters/parties/${row.id}`);
              }}
              mobileStatus={(row) =>
                row.absentInTally ? <Badge variant="outline">Absent</Badge> : row.duplicate ? <Badge variant="destructive">Duplicate?</Badge> : null
              }
              mobileSupporting={(row) =>
                `${row.parentGroup}${row.gstin === null ? '' : ` · ${row.gstin}`}`
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
