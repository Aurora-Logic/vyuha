import { ArrowsClockwiseIcon, LockKeyIcon, PackageIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { ExportButton } from './export-button';
import { rangeFromParams } from './period';
import { PeriodRangeField } from './period-field';
import { deltaText, usePurchases, type PurchaseReadData } from './use-cfo';

/**
 * The purchase side (W-series, commissioned 28 Aug 2026): what was bought,
 * from whom, what is owed, and the cash cycle when all three legs exist.
 * The payable book states its basis -- a running balance, not a bill-wise
 * ageing -- and a missing cycle leg is named, never imputed.
 */

type VendorRow = PurchaseReadData['byVendor'][number];
type PayableRow = PurchaseReadData['payables']['rows'][number];

const VENDOR_COLUMNS: RecordColumn<VendorRow>[] = [
  { key: 'vendor', header: 'Vendor', cell: (row) => row.vendor },
  { key: 'net', header: 'Purchases', cell: (row) => formatMoney(row.net), numeric: true },
  { key: 'ly', header: 'Same days LY', cell: (row) => formatMoney(row.lastYear), numeric: true, secondary: true },
  { key: 'share', header: 'Share', cell: (row) => `${row.sharePct.toFixed(1)}%`, numeric: true },
];

const PAYABLE_COLUMNS: RecordColumn<PayableRow>[] = [
  { key: 'vendor', header: 'Vendor', cell: (row) => row.vendor },
  { key: 'payable', header: 'Payable', cell: (row) => formatMoney(row.payable), numeric: true },
];

const days = (value: number | null): string => (value === null ? EMPTY_VALUE : `${String(value)} d`);

export function PurchasesPage() {
  const canView = usePermission(PERMISSIONS.CFO_RECEIVABLES_VIEW);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const query = usePurchases(range, { enabled: canView });

  if (!canView) {
    return (
      <>
        <PageHeader description="Purchases, the payable book and the cash cycle." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the purchase side</EmptyTitle>
            <EmptyDescription>Vendor balances sit with the receivable book: this needs the cfo.receivables.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        description="What was bought and from whom, the payable book on its stated basis, and the cash cycle when every leg is real."
        action={
          <span className="flex items-center gap-2">
            <ExportButton report="purchases" range={range} />
            <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
              <ArrowsClockwiseIcon />
            </Button>
          </span>
        }
      />
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <PeriodRangeField range={range} />
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="purchases" onRetry={() => void query.refetch()} /> : null}

        {data && data.purchases.vouchers === 0 && Number(data.payables.total) === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageIcon />
              </EmptyMedia>
              <EmptyTitle>No purchase vouchers in this period</EmptyTitle>
              <EmptyDescription>
                The sync carries whatever Tally sends; if purchases never appear, ask the agent to include Purchase, Payment and Debit Note voucher types.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {data && (data.purchases.vouchers > 0 || Number(data.payables.total) !== 0) ? (
          <>
            <KpiGrid
              columns={3}
              tiles={[
                { label: 'Purchases', value: formatMoney(data.purchases.net), note: deltaText(data.purchases.delta) },
                { label: 'Vendors billed', value: String(data.purchases.vendors), note: `${String(data.purchases.vouchers)} vouchers` },
                { label: 'Payables', value: formatMoney(data.payables.total), note: 'running book' },
              ]}
            />

            <section className="flex flex-col gap-3">
              <SectionHeading
                title="Cash cycle"
                note="Collecting plus stock, less vendor credit. A leg that cannot be computed is named, not imputed."
              />
              <KpiGrid
                columns={4}
                tiles={[
                  { label: 'DSO', value: days(data.cycle.dsoDays), note: 'collecting' },
                  { label: 'DIO', value: days(data.cycle.dioDays), note: 'in stock, at item cost' },
                  { label: 'DPO', value: days(data.cycle.dpoDays), note: 'vendor credit' },
                  { label: 'Cash cycle', value: days(data.cycle.cccDays), note: 'DSO + DIO − DPO' },
                ]}
              />
              {data.cycle.notes.map((note) => (
                <p key={note} className="text-muted-foreground text-xs">{note}</p>
              ))}
            </section>

            <section className="flex flex-col gap-3">
              <SectionHeading title="By vendor" note="The period against the same days last year." />
              {data.byVendor.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing bought in this period.</p>
              ) : (
                <RecordTable
                  columns={VENDOR_COLUMNS}
                  rows={[...data.byVendor]}
                  rowKey={(row) => row.partyId}
                  onRowActivate={(row) => void navigate(`/masters/vouchers?party=${row.partyId}`)}
                  mobilePrimary={(row) => row.vendor}
                  mobileSupporting={(row) => `${formatMoney(row.net)} · ${row.sharePct.toFixed(1)}% of purchases`}
                />
              )}
            </section>

            <section className="flex flex-col gap-3">
              <SectionHeading title="Payable book" note={data.payables.basis} />
              {data.payables.rows.length === 0 ? (
                <p className="text-muted-foreground text-sm">No vendor carries a balance.</p>
              ) : (
                <RecordTable
                  columns={PAYABLE_COLUMNS}
                  rows={[...data.payables.rows]}
                  rowKey={(row) => row.partyId}
                  onRowActivate={(row) => void navigate(`/masters/vouchers?party=${row.partyId}`)}
                  mobilePrimary={(row) => row.vendor}
                  mobileSupporting={(row) => `${formatMoney(row.payable)} payable`}
                />
              )}
            </section>
          </>
        ) : null}
      </div>
    </>
  );
}
