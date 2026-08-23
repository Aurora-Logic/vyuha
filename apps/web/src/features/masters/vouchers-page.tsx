import { useEffect, useState, type ReactNode } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon, ReceiptIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatDate, formatMoney, formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { useVoucher, useVouchers, type Voucher } from './use-vouchers';
import { VoucherPaperPreview } from './voucher-paper-preview';

/**
 * The books (Phase 6c): every voucher pulled from Tally, newest first, and
 * one voucher with its lines in a sheet. Read-only, like every projection —
 * a voucher is written in Tally. `/masters/vouchers/:id` opens the sheet
 * directly, which is where Go To lands (09 §6).
 */

const COLUMNS: RecordColumn<Voucher>[] = [
  { key: 'date', header: 'Date', cell: (row) => formatDate(row.date), className: 'tabular-nums' },
  { key: 'type', header: 'Type', cell: (row) => row.voucherType },
  {
    key: 'number',
    header: 'Number',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-medium tabular-nums">{row.voucherNumber || EMPTY_VALUE}</span>
        {row.isCancelled ? <Badge variant="outline">Cancelled</Badge> : null}
      </span>
    ),
  },
  { key: 'party', header: 'Party', cell: (row) => row.partyName || EMPTY_VALUE, secondary: true },
  // Tally's figure verbatim; this application never does arithmetic on it.
  { key: 'amount', header: 'Amount', cell: (row) => formatMoney(row.amount), numeric: true },
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
    <div role="status" aria-busy="true" aria-label="Loading vouchers" className="border">
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-20 shrink-0" />
          <Skeleton className="hidden h-3 w-32 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
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
                    <span className="shrink-0 tabular-nums">{formatMoney(line.amount)}</span>
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
    { page, ...(q ? { q } : {}), ...(includeCancelled ? { includeCancelled: true } : {}) },
    { enabled: canView, prefetchNext: true },
  );
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
        <div className="flex flex-wrap items-center gap-4">
          <SearchField
            id="voucher-search"
            label="Search vouchers"
            value={draft}
            onValueChange={setDraft}
            placeholder="Number, party or narration"
          />
          <div className="flex items-center gap-2">
            <Switch
              id="show-cancelled"
              checked={includeCancelled}
              onCheckedChange={(checked) => {
                setSearchParams(
                  (current) => {
                    const next = new URLSearchParams(current);
                    if (checked) next.set('cancelled', '1');
                    else next.delete('cancelled');
                    next.delete('page');
                    return next;
                  },
                  { replace: true },
                );
              }}
            />
            <Label htmlFor="show-cancelled" className="text-sm">
              Show cancelled
            </Label>
          </div>
        </div>

        {query.isPending ? <ListSkeleton /> : null}

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
              <EmptyTitle>{q ? 'No voucher matches that' : 'No vouchers yet'}</EmptyTitle>
              <EmptyDescription>
                {q
                  ? 'Try a voucher number, a party name, or a word from the narration.'
                  : 'Vouchers arrive as Tally changes — OpsTally delivers each one as it is written. Nothing has been delivered for this organisation yet.'}
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
