import { FileTextIcon, LockKeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';

import { PersonChip } from '@/components/shared/person';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { useUrlSort } from '@/components/shared/use-url-sort';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { DOCUMENT_ICONS } from '@/components/shared/entity-icons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatDate, formatMoney } from '@/lib/format';
import { useSearchDraft } from '@/lib/use-search-draft';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { ESTIMATE_SORT_FIELDS, ESTIMATE_STATUSES, SALES_DOCUMENT_STATUS_LABELS, PERMISSIONS, type EstimateStatus } from '@vyuha/shared';

import type { EstimateSummary } from './types';
import { useEstimates } from './use-estimates';

/**
 * Estimates (REQ-W-01): the register, and the sheet the route opens. Filter
 * state in the URL as everywhere; `?new=1` opens a fresh draft, with
 * `company`, `party` and `deal` carried in when raised from a record.
 */

const ALL = '__all__';

const COLUMNS: RecordColumn<EstimateSummary>[] = [
  { key: 'number', header: 'Number', sortField: 'number', cell: (row) => (
    <span className="inline-flex items-center gap-1.5 font-medium tabular-nums [&_svg]:size-3.5">
      <DOCUMENT_ICONS.estimate aria-hidden className="text-muted-foreground" />
      {row.number}
    </span>
  ) },
  { key: 'customer', header: 'Customer', cell: (row) => row.customerName, sortField: 'customerName' },
  { key: 'date', header: 'Date', cell: (row) => formatDate(row.date), className: 'tabular-nums', sortField: 'date' },
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge state={row.status} label={SALES_DOCUMENT_STATUS_LABELS[row.status]} /> },
  { key: 'total', header: 'Total', cell: (row) => formatMoney(row.grandTotal), numeric: true, sortField: 'grandTotal' },
  { key: 'valid', header: 'Valid until', cell: (row) => formatDate(row.validUntil), className: 'tabular-nums', secondary: true },
  { key: 'owner', header: 'Owner', cell: (row) => <PersonChip name={row.ownerName} />, secondary: true },
];

function isStatus(value: string | null): value is EstimateStatus {
  return ESTIMATE_STATUSES.some((s) => s === value);
}

export function EstimatesPage() {
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { sort, activeSort, onSortChange } = useUrlSort(ESTIMATE_SORT_FIELDS);

  const q = searchParams.get('q') ?? '';
  const statusParam = searchParams.get('status');
  const status = isStatus(statusParam) ? statusParam : undefined;
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const dealParam = searchParams.get('deal') ?? '';
  const companyParam = searchParams.get('company') ?? '';
  const partyParam = searchParams.get('party') ?? '';

  const [draft, setDraft] = useSearchDraft();

  const query = useEstimates(
    { page, ...(q ? { q } : {}), ...(status ? { status } : {}), ...(dealParam ? { dealId: dealParam } : {}), ...(companyParam ? { companyId: companyParam } : {}), ...(partyParam ? { partyId: partyParam } : {}), ...(sort ? { sort } : {}) },
    { enabled: canView },
  );
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;

  // The creator is a page of its own — the paper is the editor — reached with whatever the list was filtered by.
  function startNew() {
    const presets = new URLSearchParams();
    if (dealParam) presets.set('deal', dealParam);
    if (companyParam) presets.set('company', companyParam);
    if (partyParam) presets.set('party', partyParam);
    const search = presets.toString();
    void navigate(`/sales/estimates/new${search ? `?${search}` : ''}`);
  }

  useShortcut({
    id: 'sales.estimates.create',
    keys: 'alt+c',
    label: 'New estimate',
    scope: 'screen',
    when: () => canCreate,
    run: startNew,
  });


  if (!canView) {
    return (
      <>
        <PageHeader description="Estimates: what was quoted, to whom, and whether it was accepted." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view estimates</EmptyTitle>
            <EmptyDescription>This needs sales.document.view.self or sales.document.view.all — the Sales role carries it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const filtered = Boolean(q) || status !== undefined || Boolean(dealParam || companyParam || partyParam);

  return (
    <>
      <PageHeader
        description="Vyuha-owned quotes. Never pushed to Tally; an accepted estimate is what a sales order is raised from."
        action={
          canCreate ? (
            <Button size="sm" onClick={startNew}>
              <PlusIcon data-icon="inline-start" />
              New estimate
              <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField id="estimate-search" label="Search estimates" value={draft} onValueChange={setDraft} placeholder="Number or customer" />
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
              <SelectValue>{(value: string) => (value === ALL ? 'Any status' : SALES_DOCUMENT_STATUS_LABELS[value as EstimateStatus])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {ESTIMATE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SALES_DOCUMENT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {query.isPending ? <ListSkeleton rows={4} label="Loading estimates" /> : null}
        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="estimates"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileTextIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No estimate matches that' : 'No estimates yet'}</EmptyTitle>
              <EmptyDescription>{filtered ? 'Try another status or clear the search.' : canCreate ? 'Raise the first one — a customer and a line are enough.' : 'Estimates appear here as the sales team raises them.'}</EmptyDescription>
            </EmptyHeader>
            {!filtered && canCreate ? (
              <EmptyContent>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New estimate
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
              sort={activeSort}
              onSortChange={onSortChange}
              mobilePrimary={(row) => `${row.number} · ${row.customerName}`}
              mobileStatus={(row) => <StatusBadge state={row.status} label={SALES_DOCUMENT_STATUS_LABELS[row.status]} />}
              mobileSupporting={(row) => `${formatDate(row.date)} · ${formatMoney(row.grandTotal)}`}
              onRowActivate={(row) => {
                void navigate(`/sales/estimates/${row.id}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} /> : null}
          </>
        ) : null}
      </div>

    </>
  );
}
