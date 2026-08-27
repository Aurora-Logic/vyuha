import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@vyuha/shared';
import { usePermission } from '@/lib/session/permissions';
import { BooksIcon, LightbulbIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useParams } from 'react-router';

import { HeatmapTable } from '@/components/shared/heatmap-table';
import { KpiGrid, type KpiTileProps } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { PortalLinkPanel } from '@/features/portal/portal-link-panel';
import { RmPanel } from './rm-panel';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ClassBadge, GradeBadge } from '@/components/shared/customer-badges';
import { DateField } from '@/features/attendance/pickers';
import { assignClass, usePartyClass, useTiers } from '@/features/insights/use-cfo';
import { toApiDate } from '@/features/insights/period';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatDate, formatMoney, formatMoneyShort } from '@/lib/format';
import type { PartyAnalytics, PartyItemRow, PartyRole } from '@vyuha/shared';

import { RankingChart, RateRadial, TrendChart } from './lifecycle-charts';
import { LifecycleFilter } from './lifecycle-filter';
import { COMPARE_LABELS } from './lifecycle-period';
import { heatGridFromCells, partyInsights, partyTrend, rankingSeries, trendReadable, vendorTrend } from './lifecycle-series';
import { LifecycleTimeline } from './lifecycle-timeline';
import { useLifecyclePeriod } from './use-lifecycle-period';
import { usePartyAnalytics } from './use-lifecycle-analytics';
import { usePartyLifecycle } from './use-lifecycle';

/**
 * One party's life (owner, 22 Aug 2026): the decisions this page changes
 * are whom to call this week, how much credit to extend, and whether a
 * vendor is worth keeping. As a customer: what it bought, what it paid,
 * how fast it was served, whether it has gone quiet by its own rhythm
 * (D-46). As a vendor: what it supplied, at what rate against the best,
 * how late, how much was rejected. Receivables ageing and DSO need
 * bill-wise allocations the system does not hold, so they are named as
 * absent rather than approximated.
 */
const ROLE_LABELS: Record<PartyRole, string> = { customer: 'Customer', vendor: 'Vendor', both: 'Customer and vendor', none: 'Party' };

function qty(value: number, unit: string | null = null): string {
  const text = value.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return unit ? `${text} ${unit}` : text;
}

function rate(value: number | null): string {
  return value === null ? EMPTY_VALUE : formatMoney(value);
}

function days(value: number): string {
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 1 })} d`;
}

const BOUGHT_COLUMNS: RecordColumn<PartyItemRow>[] = [
  { key: 'name', header: 'Item', cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'quantity', header: 'Quantity', cell: (row) => qty(row.quantity, row.unit), numeric: true },
  { key: 'value', header: 'Value', cell: (row) => formatMoney(row.value), numeric: true },
  { key: 'documents', header: 'Orders', cell: (row) => String(row.documents), numeric: true },
  { key: 'lastRate', header: 'Last rate', cell: (row) => rate(row.lastRate), numeric: true },
  { key: 'lastAt', header: 'Last', cell: (row) => formatDate(row.lastAt), className: 'tabular-nums', secondary: true },
];

const SUPPLIED_COLUMNS: RecordColumn<PartyItemRow>[] = [
  { key: 'name', header: 'Item', cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'quantity', header: 'Quantity', cell: (row) => qty(row.quantity, row.unit), numeric: true },
  { key: 'value', header: 'Value', cell: (row) => formatMoney(row.value), numeric: true },
  { key: 'lastRate', header: 'Last rate', cell: (row) => rate(row.lastRate), numeric: true },
  {
    key: 'variance',
    header: 'Vs best',
    cell: (row) => (row.variancePct === null ? EMPTY_VALUE : row.variancePct <= 0 ? <Badge variant="outline">Best</Badge> : <span className="text-destructive">+{String(row.variancePct)}%</span>),
    numeric: true,
  },
  { key: 'lastAt', header: 'Last', cell: (row) => formatDate(row.lastAt), className: 'tabular-nums', secondary: true },
];

export function PartyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const period = useLifecyclePeriod();
  const lifecycle = usePartyLifecycle(id ?? null);
  const analytics = usePartyAnalytics(id ?? null, period.query);
  const canSeeClass = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const canAssignClass = usePermission(PERMISSIONS.CFO_TIER_ASSIGN);
  const partyClass = usePartyClass(id ?? null, { enabled: canSeeClass });
  const tiers = useTiers({ enabled: canSeeClass });
  const queryClient = useQueryClient();
  // P7: never mid-month -- a change defaults to the first of next month.
  const [classDraft, setClassDraft] = useState<{ tierCode: string; reason: string; effectiveFrom: Date } | null>(null);
  const [savingClass, setSavingClass] = useState(false);

  async function saveClass() {
    if (id === undefined || classDraft === null || classDraft.tierCode === '' || classDraft.reason.trim() === '') return;
    setSavingClass(true);
    try {
      await assignClass(id, { tierCode: classDraft.tierCode, reason: classDraft.reason.trim(), effectiveFrom: toApiDate(classDraft.effectiveFrom) });
      await queryClient.invalidateQueries({ queryKey: ['cfo'] });
      toast.add({ type: 'success', title: `Class ${classDraft.tierCode} from ${toApiDate(classDraft.effectiveFrom)}` });
      setClassDraft(null);
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not change the class', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setSavingClass(false);
    }
  }

  if (lifecycle.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the party" className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }
  if (lifecycle.isError) {
    return (
      <QueryErrorAlert
        error={lifecycle.error}
        subject="this party"
        onRetry={() => {
          void lifecycle.refetch();
        }}
      />
    );
  }

  const { party, role, events } = lifecycle.data;
  const facts = [party.alias, party.parentGroup, party.gstin ? `GSTIN ${party.gstin}` : null].filter((f): f is string => f !== null && f !== '');
  const compareLabel = period.compare === 'off' ? null : COMPARE_LABELS[period.compare];
  const a = analytics.data;

  return (
    <>
      <PageHeader
        eyebrow={ROLE_LABELS[role]}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{party.name}</span>
            {canSeeClass && partyClass.data ? (
              <span className="flex items-center gap-1">
                <ClassBadge
                  code={partyClass.data.current?.tierCode ?? null}
                  label={tiers.data?.find((t) => t.code === partyClass.data?.current?.tierCode)?.label}
                  token={tiers.data?.find((t) => t.code === partyClass.data?.current?.tierCode)?.colourToken}
                />
                <GradeBadge grade={partyClass.data.grade?.grade ?? null} risk={partyClass.data.grade?.risk} />
              </span>
            ) : null}
            {party.absentInTally ? <Badge variant="destructive">Gone from Tally</Badge> : null}
          </span>
        }
        description={facts.join(' · ')}
        action={
          <span className="flex items-center gap-2">
            {canAssignClass ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const now = new Date();
                  setClassDraft({ tierCode: '', reason: '', effectiveFrom: new Date(now.getFullYear(), now.getMonth() + 1, 1) });
                }}
              >
                Set class
              </Button>
            ) : null}
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/masters/parties" />}>
              <BooksIcon data-icon="inline-start" />
              All parties
            </Button>
          </span>
        }
      />

      {canSeeClass && partyClass.data && partyClass.data.history.length > 0 ? (
        <p className="text-muted-foreground -mt-2 mb-4 text-xs">
          Class history:{' '}
          {partyClass.data.history
            .map((h) => `${h.tierCode} from ${h.effectiveFrom}${h.effectiveTo ? ` to ${h.effectiveTo}` : ''} (${h.assignedBy}: ${h.reason})`)
            .join(' · ')}
        </p>
      ) : null}

      <Dialog open={classDraft !== null} onOpenChange={(open) => { if (!open) setClassDraft(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set customer class</DialogTitle>
            <DialogDescription>A class drives credit terms and discount authority, so it needs a reason and takes effect on a date -- history is never rewritten.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Class</FieldLabel>
            <Select value={classDraft?.tierCode ?? ''} onValueChange={(v) => { setClassDraft((d) => (d === null ? d : { ...d, tierCode: v === null ? '' : String(v) })); }}>
              <SelectTrigger aria-label="Class">
                <SelectValue placeholder="Pick a class">
                  {(v: string) => (v === '' ? 'Pick a class' : `${v} · ${tiers.data?.find((t) => t.code === v)?.label ?? ''}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(tiers.data ?? []).map((t) => (
                  <SelectItem key={t.code} value={t.code}>{t.code} · {t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="class-reason">Reason</FieldLabel>
            <Textarea id="class-reason" rows={2} maxLength={500} value={classDraft?.reason ?? ''} onChange={(e) => { setClassDraft((d) => (d === null ? d : { ...d, reason: e.target.value })); }} />
          </Field>
          {classDraft ? (
            <DateField label="Effective from" showLabel value={classDraft.effectiveFrom} onValueChange={(date) => { setClassDraft((d) => (d === null ? d : { ...d, effectiveFrom: date })); }} />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setClassDraft(null); }}>Cancel</Button>
            <Button disabled={savingClass || (classDraft?.tierCode ?? '') === '' || (classDraft?.reason.trim() ?? '') === ''} onClick={() => void saveClass()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LifecycleFilter period={period} />

      {analytics.isError ? (
        <QueryErrorAlert
          error={analytics.error}
          subject="the period's figures"
          onRetry={() => {
            void analytics.refetch();
          }}
        />
      ) : null}
      {a === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading the period" className="flex flex-col gap-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <PartyAnalyticsBody a={a} role={role} compareLabel={compareLabel} ready={!analytics.isPlaceholderData} onItem={(itemId) => void navigate(`/masters/items/${itemId}`)} />
      )}

      <section className="flex flex-col gap-3">
        <SectionHeading title="Held in Tally" note={`Pulled ${formatDate(party.lastPulledAt.slice(0, 10))}.`} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Address</dt>
          <dd className="whitespace-pre-line">{party.address ?? EMPTY_VALUE}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="break-all">{party.email ?? EMPTY_VALUE}</dd>
          <dt className="text-muted-foreground">Phone</dt>
          <dd className="tabular-nums">{party.phone ?? EMPTY_VALUE}</dd>
          <dt className="text-muted-foreground">Credit</dt>
          <dd className="tabular-nums">
            {party.creditLimit ? formatMoney(party.creditLimit) : EMPTY_VALUE}
            {party.creditDays !== null ? ` · ${String(party.creditDays)} days` : ''}
          </dd>
          <dt className="text-muted-foreground">Opening balance</dt>
          <dd className="tabular-nums">{party.openingBalance ? formatMoney(party.openingBalance) : EMPTY_VALUE}</dd>
        </dl>
      </section>

      <RmPanel partyId={party.id} />

      <PortalLinkPanel partyId={party.id} partyName={party.name} />

      <LifecycleTimeline events={events} />
    </>
  );
}

function PartyAnalyticsBody({ a, role, compareLabel, ready, onItem }: { a: PartyAnalytics; role: PartyRole; compareLabel: string | null; ready: boolean; onItem: (id: string) => void }) {
  const withDelta = (tile: Omit<KpiTileProps, 'current' | 'previous'>, figure: { value: number; previous: number | null }): KpiTileProps => ({ ...tile, current: figure.value, previous: figure.previous });
  const c = a.customer;
  const v = a.vendor;
  const showCustomer = c !== null && (role === 'customer' || role === 'both' || role === 'none');
  const showVendor = v !== null && (role === 'vendor' || role === 'both');
  const insights = partyInsights({ customer: showCustomer ? c : null, vendor: showVendor ? v : null });
  const grid = heatGridFromCells(a.heat);
  const periodNote = compareLabel === null ? 'In the period.' : `In the period, against the ${compareLabel.toLowerCase()}.`;

  return (
    <>
      {showCustomer && c !== null ? (
        <>
          <section className="flex flex-col gap-3">
            <SectionHeading title="As a customer" note={periodNote} />
            <KpiGrid
              tiles={[
                withDelta({ label: 'Revenue (Tally)', value: formatMoney(c.revenue.value), format: formatMoney }, c.revenue),
                withDelta({ label: 'Invoices', value: String(c.invoices.value), format: String }, c.invoices),
                withDelta({ label: 'Average invoice', value: formatMoney(c.averageInvoice.value), format: formatMoney }, c.averageInvoice),
                withDelta({ label: 'Collected', value: formatMoney(c.collected.value), format: formatMoney }, c.collected),
                withDelta({ label: 'Orders', value: String(c.orders.value), format: String }, c.orders),
                withDelta({ label: 'Ordered value', value: formatMoney(c.orderedValue.value), format: formatMoney }, c.orderedValue),
                withDelta({ label: 'Fulfilment', value: `${String(c.fulfilmentPct.value)}%`, format: (x) => `${String(x)} pts` }, c.fulfilmentPct),
                withDelta({ label: 'Partial shipments', value: `${String(c.partialShipmentPct.value)}%`, format: (x) => `${String(x)} pts`, lowerIsBetter: true }, c.partialShipmentPct),
                withDelta({ label: 'Dispatch lead time', value: c.leadTimeMedianDays.value > 0 ? days(c.leadTimeMedianDays.value) : EMPTY_VALUE, format: days, lowerIsBetter: true, note: 'median, order to first dispatch' }, c.leadTimeMedianDays),
                withDelta({ label: 'Slowest tenth', value: c.leadTimeP90Days.value > 0 ? days(c.leadTimeP90Days.value) : EMPTY_VALUE, format: days, lowerIsBetter: true, note: 'p90' }, c.leadTimeP90Days),
                withDelta({ label: 'Share of revenue', value: `${String(c.revenueSharePct.value)}%`, format: (x) => `${String(x)} pts` }, c.revenueSharePct),
                { label: 'Open orders', value: String(c.openOrders), note: 'now' },
                { label: 'Last order', value: c.lastOrderAt ? formatDate(c.lastOrderAt) : 'never', note: c.daysSinceLastOrder === null ? undefined : `${String(c.daysSinceLastOrder)} days ago` },
                { label: 'Usual gap', value: c.medianOrderGapDays === null ? EMPTY_VALUE : days(c.medianOrderGapDays), note: c.medianOrderGapDays === null ? 'under three orders' : c.dormant ? 'gone quiet' : 'on rhythm' },
              ]}
            />
          </section>
        </>
      ) : null}

      {showVendor && v !== null ? (
        <section className="flex flex-col gap-3">
          <SectionHeading title="As a vendor" note={periodNote} />
          <KpiGrid
            tiles={[
              withDelta({ label: 'Purchase orders', value: String(v.purchaseOrders.value), format: String }, v.purchaseOrders),
              withDelta({ label: 'Purchased value', value: formatMoney(v.purchasedValue.value), format: formatMoney }, v.purchasedValue),
              withDelta({ label: 'Ordered', value: qty(v.orderedQty.value), format: qty }, v.orderedQty),
              withDelta({ label: 'Received', value: qty(v.receivedQty.value), format: qty }, v.receivedQty),
              withDelta({ label: 'Receipts', value: String(v.receipts.value), format: String }, v.receipts),
              withDelta({ label: 'Rejected', value: `${String(v.rejectedPct.value)}%`, format: (x) => `${String(x)} pts`, lowerIsBetter: true }, v.rejectedPct),
              withDelta({ label: 'Lead time', value: v.leadTimeMedianDays.value > 0 ? days(v.leadTimeMedianDays.value) : EMPTY_VALUE, format: days, lowerIsBetter: true, note: v.promisedDays === null ? 'median, PO to first receipt' : `median; ${String(v.promisedDays)} promised` }, v.leadTimeMedianDays),
              { label: 'Open POs', value: String(v.openPurchaseOrders), note: v.lastPurchaseAt ? `last PO ${formatDate(v.lastPurchaseAt)}` : 'now' },
            ]}
          />
        </section>
      ) : null}

      {insights.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading title="What the period says" icon={<LightbulbIcon />} />
          <ul className="flex flex-col gap-1 text-sm">
            {insights.map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-muted-foreground">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showCustomer && c !== null ? <CustomerCharts a={a} compareLabel={compareLabel} ready={ready} fulfilment={c.fulfilmentPct} /> : null}
      {showVendor && v !== null ? <VendorCharts a={a} compareLabel={compareLabel} ready={ready} /> : null}

      {grid.rows.length > 0 ? (
        <section className="flex min-w-0 flex-col gap-2">
          <SectionHeading title={showCustomer ? 'What it buys, by month' : 'What it supplies, by month'} note="Quantity by item and month, top eight items." />
          <HeatmapTable grid={grid} rowLabel="Item" format={(x) => qty(x)} onRow={onItem} />
        </section>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-2">
        {showCustomer ? (
          <section className="flex min-w-0 flex-col gap-3">
            <SectionHeading title="Items bought" note="Top eight by value in the period." />
            {a.itemsBought.length === 0 ? (
              <p className="text-muted-foreground text-sm">No order in the period.</p>
            ) : (
              <RecordTable
                columns={BOUGHT_COLUMNS}
                rows={[...a.itemsBought]}
                rowKey={(row) => row.id ?? row.name}
                mobilePrimary={(row) => row.name}
                mobileSupporting={(row) => `${qty(row.quantity, row.unit)} · ${formatMoney(row.value)} · last ${rate(row.lastRate)}`}
                onRowActivate={(row) => {
                  if (row.id !== null) onItem(row.id);
                }}
              />
            )}
          </section>
        ) : null}
        {showVendor ? (
          <section className="flex min-w-0 flex-col gap-3">
            <SectionHeading title="Items supplied" note="Top eight by value; rate against the best any vendor gave." />
            {a.itemsSupplied.length === 0 ? (
              <p className="text-muted-foreground text-sm">No purchase order in the period.</p>
            ) : (
              <RecordTable
                columns={SUPPLIED_COLUMNS}
                rows={[...a.itemsSupplied]}
                rowKey={(row) => row.id ?? row.name}
                mobilePrimary={(row) => row.name}
                mobileSupporting={(row) => `${qty(row.quantity, row.unit)} · ${formatMoney(row.value)} · last ${rate(row.lastRate)}${row.variancePct !== null && row.variancePct > 0 ? ` · +${String(row.variancePct)}% vs best` : ''}`}
                onRowActivate={(row) => {
                  if (row.id !== null) onItem(row.id);
                }}
              />
            )}
          </section>
        ) : null}
      </div>

      {a.absent.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Not shown: {a.absent.map((k) => `${k.label} (needs ${k.needs})`).join('; ')}.
        </p>
      ) : null}
    </>
  );
}

function CustomerCharts({ a, compareLabel, ready, fulfilment }: { a: PartyAnalytics; compareLabel: string | null; ready: boolean; fulfilment: { value: number; previous: number | null } }) {
  const trend = partyTrend(a);
  const items = rankingSeries(a.itemsBought, (r) => r.value);
  return (
    <>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {trendReadable(trend) ? (
          <TrendChart title="Billed and collected, by month" note={compareLabel === null ? "From Tally's vouchers." : `From Tally's vouchers. Dashed: ${compareLabel.toLowerCase()}.`} points={trend} labels={{ a: 'Billed', b: 'Collected' }} compareLabel={compareLabel} format={formatMoney} axisFormat={formatMoneyShort} ready={ready} />
        ) : (
          <section className="flex flex-col gap-2">
            <SectionHeading title="Billed and collected, by month" note="Not enough months with movement in this period to read a trend." />
          </section>
        )}
        <RateRadial title="Fulfilment" note="Dispatched as a share of ordered, in the period." pct={fulfilment.value} previousPct={fulfilment.previous} label="fulfilled" ready={ready} />
      </div>
      {items.length > 0 ? <RankingChart title="What it buys" note="By order value in the period." points={items} valueLabel="Value" format={formatMoney} ready={ready} /> : null}
    </>
  );
}

function VendorCharts({ a, compareLabel, ready }: { a: PartyAnalytics; compareLabel: string | null; ready: boolean }) {
  const trend = vendorTrend(a);
  const items = rankingSeries(a.itemsSupplied, (r) => r.value);
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {trendReadable(trend) ? (
        <TrendChart title="Purchased and received, by month" note={compareLabel === null ? undefined : `Dashed: ${compareLabel.toLowerCase()}.`} points={trend} labels={{ a: 'Purchased (value)', b: 'Received (qty)' }} compareLabel={compareLabel} format={(x) => x.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ready={ready} />
      ) : (
        <section className="flex flex-col gap-2">
          <SectionHeading title="Purchased and received, by month" note="Not enough months with movement in this period to read a trend." />
        </section>
      )}
      {items.length > 0 ? <RankingChart title="What it supplies" note="By purchase value in the period." points={items} valueLabel="Value" format={formatMoney} ready={ready} /> : null}
    </div>
  );
}
