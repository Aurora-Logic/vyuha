import { useParty } from './use-parties';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowsClockwiseIcon, FunnelSimpleXIcon, LockKeyIcon, ReceiptIcon, XIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { DateRange } from 'react-day-picker';

import { ListSkeleton } from '@/components/shared/list-skeleton';
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { DASHBOARD_PRESETS } from '@/lib/range-presets';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatCount, formatDate, formatMoney, formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, VOUCHER_SORT_FIELDS } from '@vyuha/shared';

import { magnitudeOf } from './voucher-amount';
import { useVoucher, useVouchers, useVoucherTypes, type Voucher } from './use-vouchers';
import { VoucherPaperPreview } from './voucher-paper-preview';
import { CompanyFilter } from './company-filter';

/**
 * The books (Phase 6c): every voucher pulled from Tally, newest first, and
 * one voucher with its lines in a sheet. Read-only, like every projection —
 * a voucher is written in Tally. `/masters/vouchers/:id` opens the sheet
 * directly, which is where Go To lands (09 §6).
 */

/**
 * The register's columns. Every `sortField` is a key the server knows
 * (VOUCHER_SORT_FIELDS): the register pages at twenty-five, so a header that
 * reordered the rows in hand would sort a twenty-fifth of the books and read
 * as wrong. "As of" carries no sort because every row on a page was pulled by
 * the same sync and would order arbitrarily.
 */
const COLUMNS: RecordColumn<Voucher>[] = [
  { key: 'date', header: 'Date', cell: (row) => formatDate(row.date), className: 'tabular-nums', sortField: 'date' },
  { key: 'type', header: 'Type', cell: (row) => row.voucherType, sortField: 'type' },
  {
    key: 'number',
    header: 'Number',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-medium tabular-nums">{row.voucherNumber || EMPTY_VALUE}</span>
        {row.isCancelled ? <Badge variant="outline">Cancelled</Badge> : null}
      </span>
    ),
    sortField: 'number',
  },
  { key: 'party', header: 'Party', cell: (row) => row.partyName || EMPTY_VALUE, secondary: true, sortField: 'party' },
  // Tally's figure verbatim; this application never does arithmetic on it.
  { key: 'amount', header: 'Amount', cell: (row) => formatMoney(row.amount), numeric: true, sortField: 'amount' },
  {
    key: 'pulled',
    header: 'As of',
    cell: (row) => formatRelativeAge(row.lastPulledAt),
    className: 'tabular-nums',
    secondary: true,
  },
];

/** The type filter's "no type chosen" value; Select has no empty option. */
const ALL_TYPES = '\u0000all';

/** A YYYY-MM-DD search param, parsed as a local date the calendar can hold. */
function fromDateParam(value: string | null): Date | undefined {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toDateParam(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function VoucherSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const isMobile = useIsMobile();
  const detail = useVoucher(id);
  const voucher = detail.data;

  return (
    <Sheet
      open={id !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-xl">
        <SheetHeader className="shrink-0 border-b">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {voucher ? (
              <>
                <span>{voucher.voucherType}</span>
                <span className="tabular-nums">{voucher.voucherNumber || EMPTY_VALUE}</span>
                {voucher.isCancelled ? <Badge variant="outline">Cancelled</Badge> : null}
              </>
            ) : (
              'Voucher'
            )}
          </SheetTitle>
          <SheetDescription>
            {voucher ? `${formatDate(voucher.date)} · ${voucher.partyName || 'no party'}` : 'Loading'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {detail.isError ? (
            <QueryErrorAlert error={detail.error} subject="voucher" onRetry={() => void detail.refetch()} />
          ) : null}
          {voucher ? (
            <>
              {/* Owner, 22 Aug 2026: the voucher on the organisation's paper, here -- print, PDF, Excel. */}
              <div className="mb-4">
                <VoucherPaperPreview voucher={voucher} />
              </div>
              <dl className="divide-border divide-y">
                <Row label="Amount">
                  <span className="tabular-nums">{formatMoney(voucher.amount)}</span>
                </Row>
                {voucher.narration ? <Row label="Narration">{voucher.narration}</Row> : null}
                <Row label="As of">{formatRelativeAge(voucher.lastPulledAt)}</Row>
              </dl>
              {/* Lines in Tally's order: ledger entries then inventory, exactly as
                  the voucher was written. Debit side per Tally's own flag. */}
              <ul className="mt-4 divide-y border">
                {voucher.lines.map((line) => (
                  <li key={line.lineNo} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      {line.kind === 'ledger' ? (
                        <>
                          <span>{line.ledgerName}</span>
                          <span className="text-muted-foreground ml-2 text-xs">
                            {line.isDeemedPositive === true ? 'Dr' : line.isDeemedPositive === false ? 'Cr' : ''}
                          </span>
                        </>
                      ) : (
                        <>
                          <span>{line.stockItemName}</span>
                          <span className="text-muted-foreground ml-2 text-xs">
                            {[line.actualQty, line.rate === null ? null : `@ ${formatMoney(line.rate)}`]
                              .filter((part): part is string => part !== null && part !== '')
                              .join(' ')}
                          </span>
                        </>
                      )}
                    </span>
                    {/* The magnitude, because the Dr/Cr beside the name already
                        says the direction. Tally writes a credit negative, and
                        printing both read as "Cr minus four thousand" -- the
                        sign twice, once as a word and once as a symbol. The
                        printed voucher has always shown the magnitude; this is
                        the same voucher agreeing with itself. */}
                    <span className="shrink-0 tabular-nums">{formatMoney(magnitudeOf(line.amount))}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function VouchersPage() {
  const canView = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();

  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const includeCancelled = searchParams.get('cancelled') === '1';
  const voucherType = searchParams.get('type') ?? '';
  // R1: a drill from a customer cell arrives here with the party fixed.
  const partyId = searchParams.get('party') ?? '';
  const company = searchParams.get('company') ?? '';
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';
  const sort = searchParams.get('sort') ?? '';
  const sortField = sort.startsWith('-') ? sort.slice(1) : sort;
  // A hand-edited or stale `?sort=` must not paint an arrow on a header the
  // server will not honour, so the control only shows a term the API accepts.
  const activeSort = (VOUCHER_SORT_FIELDS as readonly string[]).includes(sortField)
    ? { field: sortField, descending: sort.startsWith('-') }
    : null;
  const period: DateRange = { from: fromDateParam(from || null), to: fromDateParam(to || null) };
  const hasFilters = q !== '' || voucherType !== '' || company !== '' || from !== '' || to !== '' || includeCancelled || partyId !== '';
  const drillParty = useParty(partyId === '' ? null : partyId);

  /** Every filter writes through here: one page reset, one replace, one place to read. */
  function setParams(edit: (next: URLSearchParams) => void) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        edit(next);
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  }

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

  const query = useVouchers(
    {
      page,
      ...(q ? { q } : {}),
      ...(voucherType ? { voucherType } : {}),
      ...(partyId ? { partyId } : {}),
      ...(company ? { connectionId: company } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(includeCancelled ? { includeCancelled: true } : {}),
      ...(activeSort ? { sort } : {}),
    },
    { enabled: canView, prefetchNext: true },
  );

  const types = useVoucherTypes({ enabled: canView });
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta ?? null;
  const openId = params.id ?? null;

  if (!canView) {
    return (
      <>
        <PageHeader description="Vouchers pulled from TallyPrime." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view vouchers</EmptyTitle>
            <EmptyDescription>
              This needs the receivables.view permission. Vouchers are money moving, so they are
              shown to accounts and sales management, not to everyone who may look up a party.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Every voucher pulled from TallyPrime, newest first. Read-only: a voucher is written in Tally and arrives here on the next sync."
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
        {/* One row of filters above the register, wrapping on a phone rather
            than scrolling: search, then the two narrowings an accountant
            reaches for first -- which book, and over what period. */}
        <div className="flex flex-wrap items-center gap-2">
          <CompanyFilter
            value={company}
            onValueChange={(cid) => {
              setParams((next) => {
                if (cid) next.set('company', cid);
                else next.delete('company');
              });
            }}
          />
          <SearchField
            id="voucher-search"
            label="Search vouchers"
            value={draft}
            onValueChange={setDraft}
            placeholder="Number, party or narration"
          />
          <Select
            value={voucherType === '' ? ALL_TYPES : voucherType}
            onValueChange={(value) => {
              setParams((next) => {
                if (value === null || value === ALL_TYPES) next.delete('type');
                else next.set('type', String(value));
              });
            }}
          >
            <SelectTrigger className="w-44" aria-label="Voucher type">
              <SelectValue>{(value: string) => (value === ALL_TYPES ? 'All types' : value)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES}>All types</SelectItem>
              {(types.data ?? []).map((facet) => (
                <SelectItem key={facet.voucherType} value={facet.voucherType}>
                  <span className="flex w-full items-center justify-between gap-4">
                    <span>{facet.voucherType}</span>
                    <span className="text-muted-foreground tabular-nums">{formatCount(facet.count)}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DateRangeField
            label="Period"
            value={period}
            presets={DASHBOARD_PRESETS}
            onValueChange={(next) => {
              setParams((params) => {
                if (next.from) params.set('from', toDateParam(next.from));
                else params.delete('from');
                if (next.to) params.set('to', toDateParam(next.to));
                else params.delete('to');
              });
            }}
          />
          <div className="flex min-h-9 items-center gap-2">
            <Switch
              id="show-cancelled"
              checked={includeCancelled}
              onCheckedChange={(checked) => {
                setParams((next) => {
                  if (checked) next.set('cancelled', '1');
                  else next.delete('cancelled');
                });
              }}
            />
            <Label htmlFor="show-cancelled" className="text-sm">
              Show cancelled
            </Label>
          </div>
          {/* Only once something is narrowed: a permanent Clear on an unfiltered
              register is a control that does nothing, which teaches the reader
              to stop trusting the row. The sort is deliberately not cleared --
              it is how the register is being read, not what it is showing. */}
          {partyId !== '' ? (
            <Badge variant="secondary" className="gap-1 pr-1">
              {drillParty.data?.name ?? 'Customer'}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove the customer filter"
                onClick={() => {
                  setParams((next) => {
                    next.delete('party');
                  });
                }}
              >
                <XIcon />
              </Button>
            </Badge>
          ) : null}
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft('');
                setParams((next) => {
                  next.delete('q');
                  next.delete('type');
                  next.delete('from');
                  next.delete('to');
                  next.delete('cancelled');
                  next.delete('party');
                });
              }}
            >
              <FunnelSimpleXIcon data-icon="inline-start" />
              Clear filters
            </Button>
          ) : null}
        </div>

        {query.isPending ? <ListSkeleton rows={5} label="Loading vouchers" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="vouchers"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ReceiptIcon />
              </EmptyMedia>
              <EmptyTitle>{hasFilters ? 'No voucher matches these filters' : 'No vouchers yet'}</EmptyTitle>
              <EmptyDescription>
                {hasFilters
                  ? 'Widen the period, choose another type, or clear the filters. A cancelled voucher stays hidden until the switch is on.'
                  : 'Vouchers arrive as Tally changes — OpsTally delivers each one as it is written. Nothing has been delivered for this organisation yet.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <RecordTable
              columns={COLUMNS}
              sort={activeSort}
              onSortChange={(next) => {
                setParams((params) => {
                  params.set('sort', next.descending ? `-${next.field}` : next.field);
                });
              }}
              rows={rows}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => `${row.voucherType} ${row.voucherNumber}`.trim()}
              mobileStatus={(row) => (row.isCancelled ? <Badge variant="outline">Cancelled</Badge> : null)}
              mobileSupporting={(row) => `${formatDate(row.date)} · ${row.partyName || 'no party'} · ${formatMoney(row.amount)}`}
              onRowActivate={(row) => {
                void navigate(`/masters/vouchers/${row.id}${window.location.search}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? (
              <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} />
            ) : null}
          </>
        ) : null}
      </div>

      <VoucherSheet
        id={openId}
        onClose={() => {
          void navigate(`/masters/vouchers${window.location.search}`);
        }}
      />
    </>
  );
}
