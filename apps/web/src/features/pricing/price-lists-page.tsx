import { LockKeyIcon, PlusIcon, TagIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { StatusBadge } from '@/components/shared/status-badge';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, PRICE_LIST_STATES, PRICE_LIST_STATE_LABELS, type PriceListState, type PriceListSummary } from '@vyuha/shared';

import { RateSimulator } from './rate-simulator';
import { usePriceLists } from './use-pricing';

/**
 * Area AN: the price lists Vyuha owns (docs/11 D-49), every version of
 * each, and the simulator beside them. Tally's pulled price levels are no
 * longer shown: two pricing sources is the same mistake as two ledgers.
 */

const COLUMNS: RecordColumn<PriceListSummary>[] = [
  { key: 'name', header: 'Price list', cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'version', header: 'Version', cell: (row) => `v${String(row.version)}`, numeric: true },
  { key: 'state', header: 'State', cell: (row) => <StatusBadge state={row.state} label={PRICE_LIST_STATE_LABELS[row.state]} /> },
  { key: 'effective', header: 'Effective', cell: (row) => `${formatDate(row.effectiveFrom)}${row.effectiveTo ? ` – ${formatDate(row.effectiveTo)}` : ' onward'}`, className: 'tabular-nums' },
  { key: 'lines', header: 'Lines', cell: (row) => String(row.lineCount), numeric: true },
  { key: 'assignments', header: 'Assigned to', cell: (row) => String(row.assignmentCount), numeric: true, secondary: true },
  { key: 'approved', header: 'Approved', cell: (row) => (row.approvedAt ? `${formatDate(row.approvedAt.slice(0, 10))}${row.approvedByName ? ` · ${row.approvedByName}` : ''}` : EMPTY_VALUE), secondary: true },
];

const ALL = 'all';

export function PriceListsPage() {
  const canView = usePermission(PERMISSIONS.MASTERS_TALLY_VIEW);
  const canManage = usePermission(PERMISSIONS.PRICING_MANAGE);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'simulate' ? 'simulate' : 'lists';
  const stateParam = searchParams.get('state');
  const state = PRICE_LIST_STATES.find((s) => s === stateParam);
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const query = usePriceLists({ page, pageSize: 25, ...(state ? { state } : {}) }, { enabled: canView });
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;

  if (!canView) {
    return (
      <>
        <PageHeader description="The price lists this organisation owns, and what they resolve." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view price lists</EmptyTitle>
            <EmptyDescription>This needs masters.tally.view — rates are commercial terms, so they are not shown more widely.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Vyuha's price lists: versioned, approved into force, and the floor on every sales line. A change is a new version; the old one is kept so every invoice stays explainable."
        action={
          canManage ? (
            <Button size="sm" nativeButton={false} render={<Link to="/masters/price-lists/new" />}>
              <PlusIcon data-icon="inline-start" />
              New price list
            </Button>
          ) : undefined
        }
      />

      <Tabs
        value={tab}
        onValueChange={(next) => {
          setSearchParams(
            (current) => {
              const out = new URLSearchParams(current);
              if (next === 'simulate') out.set('tab', 'simulate');
              else out.delete('tab');
              return out;
            },
            { replace: true },
          );
        }}
        className="gap-4"
      >
        <TabsList>
          <TabsTrigger value="lists">Lists</TabsTrigger>
          <TabsTrigger value="simulate">Simulator</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'simulate' ? (
        <RateSimulator />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={state ?? ALL}
              onValueChange={(next) => {
                setSearchParams(
                  (current) => {
                    const out = new URLSearchParams(current);
                    if (next === null || next === ALL) out.delete('state');
                    else out.set('state', next);
                    out.delete('page');
                    return out;
                  },
                  { replace: true },
                );
              }}
            >
              <SelectTrigger aria-label="Filter by state" className="w-full sm:w-48">
                <SelectValue>{(current: string) => (current === ALL ? 'Every state' : PRICE_LIST_STATE_LABELS[current as PriceListState])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>Every state</SelectItem>
                  {PRICE_LIST_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {PRICE_LIST_STATE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {query.isPending ? (
            <div role="status" aria-busy="true" aria-label="Loading price lists" className="border">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} aria-hidden className="flex min-h-11 items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
                  <Skeleton className="h-3 w-44 shrink-0" />
                  <Skeleton className="hidden h-3 w-24 shrink-0 sm:block" />
                  <Skeleton className="ml-auto h-3 w-20 shrink-0" />
                </div>
              ))}
            </div>
          ) : null}
          {query.isError ? (
            <QueryErrorAlert
              error={query.error}
              subject="price lists"
              onRetry={() => {
                void query.refetch();
              }}
            />
          ) : null}
          {query.isSuccess && rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TagIcon />
                </EmptyMedia>
                <EmptyTitle>{state ? `No ${PRICE_LIST_STATE_LABELS[state].toLowerCase()} price list` : 'No price lists yet'}</EmptyTitle>
                <EmptyDescription>{canManage ? 'Draft one: a name, the dates it runs, the lines, and who it applies to. It goes to the inbox for approval.' : "Until one is approved, every line takes the item's rate from Tally."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {rows.length > 0 ? (
            <>
              <RecordTable
                columns={COLUMNS}
                rows={rows}
                rowKey={(row) => row.id}
                mobilePrimary={(row) => `${row.name} v${String(row.version)}`}
                mobileStatus={(row) => <StatusBadge state={row.state} label={PRICE_LIST_STATE_LABELS[row.state]} />}
                mobileSupporting={(row) => `${formatDate(row.effectiveFrom)}${row.effectiveTo ? ` – ${formatDate(row.effectiveTo)}` : ' onward'} · ${String(row.lineCount)} line${row.lineCount === 1 ? '' : 's'}`}
                onRowActivate={(row) => {
                  void navigate(`/masters/price-lists/${row.id}`);
                }}
              />
              {meta !== null && meta.total > meta.pageSize ? <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} /> : null}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
