import { ArrowSquareOutIcon, LockKeyIcon, PrinterIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatCount, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { MovementMatrix } from './growth-charts';
import {
  deltaText,
  useBrands,
  useCfoReceivables,
  useExceptions,
  useGrowthBridge,
  useMargin,
  useMovement,
  useNarrative,
  usePurchases,
  useSalesAnalysis,
} from './use-cfo';

/**
 * Part L's acceptance test: the monthly close pack is a single PDF the CA
 * can work from directly. This page is that document -- every figure
 * fetched from the same endpoints the screens use, arranged for paper.
 * Print through the browser (the house PDF pattern, REQ-W-01): the
 * toolbar hides itself, sections avoid page breaks, and what is missing
 * from the data says so instead of pretending (purchases, GST returns).
 */

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const year = y ?? new Date().getFullYear();
  const mon = (m ?? 1) - 1;
  const last = new Date(year, mon + 1, 0).getDate();
  const mm = String(mon + 1).padStart(2, '0');
  return { from: `${String(year)}-${mm}-01`, to: `${String(year)}-${mm}-${String(last).padStart(2, '0')}` };
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + by, 1);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function defaultMonth(): string {
  return shiftMonth(`${String(new Date().getFullYear())}-${String(new Date().getMonth() + 1).padStart(2, '0')}`, -1);
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y ?? 2026, (m ?? 1) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/** Print-safe figures: the shadcn Table, first column left, the rest right-aligned numerals. */
function PackTable({ head, rows }: { head: readonly string[]; rows: readonly (readonly string[])[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h, i) => (
              <TableHead key={h} className={i > 0 ? 'text-right' : undefined}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {row.map((cell, i) => (
                <TableCell key={i} className={i > 0 ? 'text-right tabular-nums' : undefined}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ClosePackSections({ month }: { month: string }) {
  const range = monthRange(month);
  const prior = monthRange(shiftMonth(month, -1));
  const lastYear = monthRange(shiftMonth(month, -12));
  const canReceivables = usePermission(PERMISSIONS.CFO_RECEIVABLES_VIEW);
  const canMargin = usePermission(PERMISSIONS.CFO_MARGIN_VIEW);
  const canBrands = usePermission(PERMISSIONS.CFO_BRAND_VIEW);
  const canExceptions = usePermission(PERMISSIONS.CFO_EXCEPTIONS_VIEW);

  const narrative = useNarrative(range);
  const now = useSalesAnalysis(range, {});
  const prev = useSalesAnalysis(prior, {});
  const ly = useSalesAnalysis(lastYear, {});
  const bridge = useGrowthBridge(range);
  const movement = useMovement(range);
  const receivables = useCfoReceivables(range, { enabled: canReceivables });
  const receivablesPrev = useCfoReceivables(prior, { enabled: canReceivables });
  const margin = useMargin(range, {}, { enabled: canMargin });
  const brands = useBrands(range, { enabled: canBrands });
  const exceptions = useExceptions(range, { enabled: canExceptions });
  const purchase = usePurchases(range, { enabled: canReceivables });

  const pending = narrative.isPending || now.isPending || bridge.isPending;
  const num = (v: string | undefined) => (v === undefined ? EMPTY_VALUE : formatMoney(v));
  const int = (v: number | null | undefined) => (v === undefined || v === null ? EMPTY_VALUE : formatCount(v));

  if (pending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (narrative.error) {
    return <QueryErrorAlert error={narrative.error} subject="close pack" onRetry={() => void narrative.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3 break-inside-avoid">
        <SectionHeading title="Narrative" note="Computed from the month's own figures; the generator may not state a number it was not given." />
        <p className="text-sm font-medium">{narrative.data?.headline}</p>
        {(narrative.data?.right.length ?? 0) > 0 ? (
          <div>
            <p className="text-sm font-medium">Went right</p>
            <ul className="ml-5 list-disc text-sm">
              {narrative.data?.right.map((r) => (<li key={r.name}>{r.name}: {r.detail}</li>))}
            </ul>
          </div>
        ) : null}
        {(narrative.data?.wrong.length ?? 0) > 0 ? (
          <div>
            <p className="text-sm font-medium">Went wrong</p>
            <ul className="ml-5 list-disc text-sm">
              {narrative.data?.wrong.map((r) => (<li key={r.name}>{r.name}: {r.detail}</li>))}
            </ul>
          </div>
        ) : null}
        {(narrative.data?.cash.length ?? 0) > 0 ? (
          <div>
            <p className="text-sm font-medium">Cash</p>
            <ul className="ml-5 list-disc text-sm">
              {narrative.data?.cash.map((line) => (<li key={line}>{line}</li>))}
            </ul>
          </div>
        ) : null}
        {(narrative.data?.actions.length ?? 0) > 0 ? (
          <div>
            <p className="text-sm font-medium">Do this week</p>
            <ol className="ml-5 list-decimal text-sm">
              {narrative.data?.actions.map((a) => (<li key={a.text}>{a.text} — {a.owner}</li>))}
            </ol>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 break-inside-avoid">
        <SectionHeading title="Register" note="This month, the month before, and the same month last year, from the same endpoints the screens read." />
        <PackTable
          head={['Measure', monthLabel(month), monthLabel(shiftMonth(month, -1)), monthLabel(shiftMonth(month, -12))]}
          rows={[
            ['Net sales', num(now.data?.summary.net), num(prev.data?.summary.net), num(ly.data?.summary.net)],
            ['Vs same days LY', now.data ? deltaText(now.data.summary.delta) : EMPTY_VALUE, prev.data ? deltaText(prev.data.summary.delta) : EMPTY_VALUE, ly.data ? deltaText(ly.data.summary.delta) : EMPTY_VALUE],
            ['Customers billed', int(now.data?.summary.customers), int(prev.data?.summary.customers), int(ly.data?.summary.customers)],
            ['Vouchers', int(now.data?.summary.vouchers), int(prev.data?.summary.vouchers), int(ly.data?.summary.vouchers)],
            ...(canReceivables
              ? [
                  ['Outstanding at month end', num(receivables.data?.outstanding), num(receivablesPrev.data?.outstanding), EMPTY_VALUE],
                  ['Of which overdue', num(receivables.data?.overdue), num(receivablesPrev.data?.overdue), EMPTY_VALUE],
                  ['DSO (countback)', int(receivables.data?.dsoCountback), int(receivablesPrev.data?.dsoCountback), EMPTY_VALUE],
                  ['CEI', int(receivables.data?.cei), int(receivablesPrev.data?.cei), EMPTY_VALUE],
                  ['Average days delinquent', int(receivables.data?.addDays), int(receivablesPrev.data?.addDays), EMPTY_VALUE],
                ]
              : []),
          ]}
        />
        <p className="text-muted-foreground text-xs">Receivable snapshots begin with this system, so the last-year column fills in as history accrues.</p>
      </section>

      <section className="flex flex-col gap-3 break-inside-avoid">
        <SectionHeading title="Revenue bridge" note="Last year to this year in five factors; the reconciliation error is shown, not hidden." />
        {bridge.data ? (
          <PackTable
            head={['Factor', 'Amount']}
            rows={[
              ['Same days last year', formatMoney(bridge.data.lastYear.toFixed(2))],
              ['Volume', formatMoney(bridge.data.volumeEffect.toFixed(2))],
              ['Price', formatMoney(bridge.data.priceEffect.toFixed(2))],
              ['Mix', formatMoney(bridge.data.mixEffect.toFixed(2))],
              ['New customers', formatMoney(bridge.data.newCustomerEffect.toFixed(2))],
              ['Lost customers', formatMoney(bridge.data.lostCustomerEffect.toFixed(2))],
              ['This year', formatMoney(bridge.data.thisYear.toFixed(2))],
              ['Reconciliation error', formatMoney(bridge.data.reconciliationError.toFixed(2))],
            ]}
          />
        ) : null}
      </section>

      {canMargin ? (
        <section className="flex flex-col gap-3 break-inside-avoid">
          <SectionHeading title="Margin waterfall" note="Landed cost is the Tally item master's cost price, the confirmed basis (M1, closed 28 Aug 2026)." />
          {margin.data ? (
            <>
              <PackTable head={['Step', 'Amount']} rows={margin.data.waterfall.map((w) => [w.label, formatMoney(w.amount)])} />
              <p className="text-muted-foreground text-xs">{margin.data.coveragePct.toFixed(1)}% of net is costed; the uncosted wedge is named in the waterfall.</p>
            </>
          ) : margin.isPending ? <Skeleton className="h-40" /> : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-3 break-inside-avoid">
        <SectionHeading title="Movement matrix" note="Every customer in a band and a state; the cells are named lists on the screen." />
        {movement.data ? <MovementMatrix cells={movement.data.cells} onCell={() => undefined} /> : null}
      </section>

      {canReceivables ? (
        <section className="flex flex-col gap-3 break-inside-avoid">
          <SectionHeading title="Ageing" note="The book by bucket at the latest snapshot in the month, and the ten most overdue by cost." />
          {receivables.data ? (
            <>
              <PackTable
                head={['Bucket', 'Outstanding']}
                rows={Object.entries(receivables.data.buckets).map(([bucket, amount]) => [bucket, formatMoney(amount)])}
              />
              <PackTable
                head={['Customer', 'Outstanding', 'Overdue', 'Days overdue', 'Cost per year']}
                rows={receivables.data.topOverdue.slice(0, 10).map((r) => [r.party, formatMoney(r.outstanding), formatMoney(r.overdue), String(r.daysOverdue), formatMoney(r.costPerYear)])}
              />
              <p className="text-muted-foreground text-xs">An ECL provision needs loss-history rates the CA has not set yet; the ageing above is the input that computation will use.</p>
            </>
          ) : null}
        </section>
      ) : null}

      {canReceivables ? (
        <section className="flex flex-col gap-3 break-inside-avoid">
          <SectionHeading title="Working capital" note="Purchases, the payable book on its stated running-book basis, and the cash cycle when every leg is real." />
          {purchase.data ? (
            <>
              <PackTable
                head={['Measure', 'Value']}
                rows={[
                  ['Purchases in the month', formatMoney(purchase.data.purchases.net)],
                  ['Same days last year', formatMoney(purchase.data.purchases.lastYear)],
                  ['Payables (running book)', formatMoney(purchase.data.payables.total)],
                  ['DSO', purchase.data.cycle.dsoDays === null ? EMPTY_VALUE : `${String(purchase.data.cycle.dsoDays)} days`],
                  ['DIO', purchase.data.cycle.dioDays === null ? EMPTY_VALUE : `${String(purchase.data.cycle.dioDays)} days`],
                  ['DPO', purchase.data.cycle.dpoDays === null ? EMPTY_VALUE : `${String(purchase.data.cycle.dpoDays)} days`],
                  ['Cash cycle', purchase.data.cycle.cccDays === null ? EMPTY_VALUE : `${String(purchase.data.cycle.cccDays)} days`],
                ]}
              />
              {purchase.data.cycle.notes.map((note) => (
                <p key={note} className="text-muted-foreground text-xs">{note}</p>
              ))}
            </>
          ) : null}
        </section>
      ) : null}

      {canBrands ? (
        <section className="flex flex-col gap-3 break-inside-avoid">
          <SectionHeading title="Brand and scheme position" note="Net by brand against last year, and where each active slab stands." />
          {brands.data ? (
            <>
              <PackTable
                head={['Brand', 'Net', 'Last year', 'Delta', 'Share']}
                rows={brands.data.brands.map((b) => [b.brand, formatMoney(b.net), formatMoney(b.lastYear), deltaText(b.delta), `${b.sharePct.toFixed(1)}%`])}
              />
              {brands.data.brands.some((b) => b.slabs.length > 0) ? (
                <PackTable
                  head={['Slab', 'Progress', 'Distance', 'Days left']}
                  rows={brands.data.brands.flatMap((b) => b.slabs.filter((sl) => sl.active).map((sl) => [`${b.brand} — ${sl.label}`, formatMoney(sl.progress), formatMoney(sl.distance), String(sl.daysLeft)]))}
                />
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {canExceptions ? (
        <section className="flex flex-col gap-3 break-inside-avoid">
          <SectionHeading title="Exceptions" note="What looked wrong in the month's vouchers, by check." />
          {exceptions.data ? (
            <PackTable
              head={['Check', 'Rows', 'Note']}
              rows={exceptions.data.checks.map((c) => [c.label, c.available ? String(c.rows.length) : EMPTY_VALUE, c.available ? c.hint : (c.note ?? 'Needs data the projection does not carry yet.')])}
            />
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-3 break-inside-avoid">
        <SectionHeading title="Compliance" note="Stated, not padded." />
        <p className="text-muted-foreground text-sm">
          GST and statutory exposure need the returns feed, which is not connected; MSME ageing needs vendor registration flags from purchases, which the Tally projection does not carry yet. Both land here the day their data does.
        </p>
      </section>
    </div>
  );
}

export function ClosePackPage() {
  const canView = usePermission(PERMISSIONS.CFO_EXPORT);
  const [searchParams, setSearchParams] = useSearchParams();
  const month = searchParams.get('month') ?? defaultMonth();
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(defaultMonth(), -i));

  if (!canView) {
    return (
      <>
        <PageHeader description="The monthly close pack." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot open the close pack</EmptyTitle>
            <EmptyDescription>This needs the cfo.export permission; the pack is the CA-facing bundle.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="The single document the CA works from on the 3rd working day: register, bridges, movement, ageing, brand position, exceptions and the narrative."
        action={
          <span className="flex items-center gap-2">
            <Select
              value={month}
              onValueChange={(value) => {
                if (value === null) return;
                setSearchParams((current) => {
                  const next = new URLSearchParams(current);
                  next.set('month', value);
                  return next;
                }, { replace: true });
              }}
            >
              <SelectTrigger className="w-44" aria-label="Month">
                <SelectValue>{(value: string) => monthLabel(value)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {months.map((m) => (<SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => { window.open(`/print/close-pack?month=${month}`, '_blank', 'noopener'); }}>
              <PrinterIcon data-icon="inline-start" />
              Print or save PDF
            </Button>
          </span>
        }
      />
      <ClosePackSections month={month} />
    </>
  );
}

/** The bare route at /print/close-pack: the pack and nothing else, for the browser's print dialog. */
export function ClosePackPrintPage() {
  const canView = usePermission(PERMISSIONS.CFO_EXPORT);
  const [searchParams] = useSearchParams();
  const month = searchParams.get('month') ?? defaultMonth();
  if (!canView) {
    return <p className="p-8 text-sm">The close pack needs the cfo.export permission.</p>;
  }
  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-black">
      <div className="print-hidden mb-4 flex items-center justify-between">
        <p className="text-muted-foreground text-sm">Use the browser's print dialog to save as PDF.</p>
        <span className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { window.close(); }}>
            <ArrowSquareOutIcon data-icon="inline-start" />
            Close
          </Button>
          <Button size="sm" onClick={() => { window.print(); }}>
            <PrinterIcon data-icon="inline-start" />
            Print
          </Button>
        </span>
      </div>
      <h1 className="mb-1 text-xl font-semibold">Monthly close pack — {monthLabel(month)}</h1>
      <p className="text-muted-foreground mb-6 text-sm">Prepared from the live book; every figure is the one its screen shows.</p>
      <ClosePackSections month={month} />
    </div>
  );
}
