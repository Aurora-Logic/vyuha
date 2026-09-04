import { useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DefinitionLink } from '@/components/shared/definition-panel';
import { HeatmapTable } from '@/components/shared/heatmap-table';
import { heatGridOf } from '@/components/shared/heat-grid';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { MatrixGrid } from '@/components/shared/matrix-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatCount, formatDate, formatMoney, formatMoneyShort } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { ExportButton } from './export-button';
import { rangeFromParams } from './period';
import { PeriodRangeField } from './period-field';
import { useAbcXyz, useCohorts, useConcentration, usePivot, usePriceBands, type AbcXyzData, type PriceBandData } from './use-cfo';

/**
 * The analytics depth (Phase 5 without the valuation decision): price
 * bands and the realisation gap, seasonality, ABC-XYZ, cohort retention,
 * and concentration. Each one answers a stocking, pricing or risk
 * question a distributor actually asks.
 */

const BAND_COLUMNS: RecordColumn<PriceBandData>[] = [
  { key: 'item', header: 'Item', cell: (row) => row.item },
  { key: 'net', header: 'Net', cell: (row) => formatMoney(row.net), numeric: true },
  { key: 'min', header: 'Min', cell: (row) => formatMoney(row.min), numeric: true, secondary: true },
  { key: 'median', header: 'Median', cell: (row) => formatMoney(row.median), numeric: true },
  { key: 'max', header: 'Max', cell: (row) => formatMoney(row.max), numeric: true, secondary: true },
  { key: 'recoverable', header: 'Recoverable at median', cell: (row) => (Number(row.recoverable) > 0 ? <span className="tabular-nums">{formatMoney(row.recoverable)}</span> : '—'), numeric: true },
];

type AbcCell = AbcXyzData['cells'][number];

export function AnalyticsPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const bands = usePriceBands(range, { enabled: canView });
  const seasonality = usePivot(range, { rows: 'category', columns: 'month', metric: 'net', top: 10 }, {}, { enabled: canView });
  const abc = useAbcXyz({ enabled: canView });
  const cohorts = useCohorts({ enabled: canView });
  const concentration = useConcentration({ enabled: canView });
  const [openCell, setOpenCell] = useState<AbcCell | null>(null);

  if (!canView) {
    return (
      <>
        <PageHeader description="Pricing, stocking and risk, answered from the fact." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view analytics</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const recoverableTotal = (bands.data ?? []).reduce((sum, b) => sum + Number(b.recoverable), 0);
  const conc = concentration.data;
  const seasonGrid = seasonality.data === undefined
    ? null
    : heatGridOf(
        seasonality.data.cells.map((cell) => ({
          category: seasonality.data?.rows.find((r) => r.key === cell.row)?.label ?? cell.row,
          month: cell.column,
          value: cell.value,
        })),
      );
  const cohortGrid = cohorts.data === undefined || cohorts.data.length === 0
    ? null
    : heatGridOf(
        cohorts.data.flatMap((row) =>
          row.retention.map((pct, offset) => ({ category: `${row.cohort} (${String(row.size)})`, month: `M+${String(offset).padStart(2, '0')}`, value: pct })),
        ),
      );

  return (
    <>
      <PageHeader description="Pricing, stocking and risk: bands of what each SKU really sold at, when each category sells, which items deserve stock, whether new customers stay, and how much a handful of names carries." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={bands.isFetching} onClick={() => { void bands.refetch(); void seasonality.refetch(); void abc.refetch(); void cohorts.refetch(); void concentration.refetch(); }}>
            <ArrowsClockwiseIcon />
          </Button>
          <PeriodRangeField range={range} />
          <span className="text-muted-foreground text-xs tabular-nums">{formatDate(range.from)} → {formatDate(range.to)}; grids read trailing twelve months</span>
          <span className="ml-auto"><ExportButton report="analytics" range={range} /></span>
        </div>

        {conc ? (
          <KpiGrid
            columns={4}
            tiles={[
              { label: 'Top-5 share', value: `${String(conc.top5Pct)}%`, note: conc.top5PctLy === null ? 'trailing 12m' : `was ${String(conc.top5PctLy)}% a year ago`, info: <DefinitionLink id="C10" /> },
              { label: 'Top-10 share', value: `${String(conc.top10Pct)}%` },
              { label: 'HHI', value: formatCount(conc.hhi), note: conc.hhi > 2500 ? 'concentrated' : 'diversified', info: <DefinitionLink id="C11" /> },
              { label: 'Recoverable at median', value: formatMoney(recoverableTotal.toFixed(2)), note: 'below-median lines, this period', info: <DefinitionLink id="M11" /> },
            ]}
          />
        ) : null}

        <Tabs defaultValue="bands">
          <TabsList>
            <TabsTrigger value="bands">Price bands</TabsTrigger>
            <TabsTrigger value="seasonality">Seasonality</TabsTrigger>
            <TabsTrigger value="abc">ABC-XYZ</TabsTrigger>
            <TabsTrigger value="cohorts">Cohorts</TabsTrigger>
          </TabsList>

          <TabsContent value="bands" className="flex flex-col gap-3">
            <SectionHeading title="What each SKU actually sold at" note="Three or more priced lines per SKU; the gap prices every below-median line at the median." action={<DefinitionLink id="M10" />} />
            {bands.isPending ? <Skeleton className="h-48" /> : null}
            {bands.error ? <QueryErrorAlert error={bands.error} subject="price bands" onRetry={() => void bands.refetch()} /> : null}
            {bands.data && bands.data.length === 0 ? <p className="text-muted-foreground text-sm">No SKU has three priced lines in this period.</p> : null}
            {bands.data && bands.data.length > 0 ? (
              <RecordTable columns={BAND_COLUMNS} rows={[...bands.data]} rowKey={(r) => r.itemId} mobilePrimary={(r) => r.item} mobileSupporting={(r) => `median ${formatMoney(r.median)} · ${Number(r.recoverable) > 0 ? `${formatMoney(r.recoverable)} recoverable` : 'holds its price'}`} />
            ) : null}
          </TabsContent>

          <TabsContent value="seasonality" className="flex flex-col gap-3">
            <SectionHeading title="When each category sells" note="Net sales by category and month; stocking and campaign timing follow it." />
            {seasonality.isPending ? <Skeleton className="h-48" /> : null}
            {seasonGrid ? <HeatmapTable grid={seasonGrid} rowLabel="Category" format={(v) => formatMoneyShort(v)} /> : null}
          </TabsContent>

          <TabsContent value="abc" className="flex flex-col gap-3">
            <SectionHeading title="Revenue contribution against demand steadiness" note="AX never runs out; CZ is ordered against demand only. A cell opens its items." action={<DefinitionLink id="R05" />} />
            {abc.isPending ? <Skeleton className="h-48" /> : null}
            {abc.data ? (
              <MatrixGrid
                rows={(['A', 'B', 'C'] as const).map((k) => ({ key: k, label: `${k} — ${k === 'A' ? 'top 80% of revenue' : k === 'B' ? 'next 15%' : 'the tail'}` }))}
                columns={(['X', 'Y', 'Z'] as const).map((k) => ({ key: k, label: `${k} ${k === 'X' ? '(steady)' : k === 'Y' ? '(variable)' : '(erratic)'}` }))}
                cellOf={(a, x) => {
                  const cell = abc.data.cells.find((c) => c.abc === a && c.xyz === x);
                  return cell === undefined ? undefined : { count: cell.count, amount: Number(cell.net) };
                }}
                onCell={(a, x) => {
                  const cell = abc.data.cells.find((c) => c.abc === a && c.xyz === x);
                  if (cell && cell.count > 0) setOpenCell(cell);
                }}
                totals
              />
            ) : null}
          </TabsContent>

          <TabsContent value="cohorts" className="flex flex-col gap-3">
            <SectionHeading title="Do newly won customers stay?" note="Each row a first-purchase month; each cell the share still buying n months on." />
            {cohorts.isPending ? <Skeleton className="h-48" /> : null}
            {cohortGrid ? <HeatmapTable grid={cohortGrid} rowLabel="Cohort" format={(v) => `${String(Math.round(v))}%`} columnLabel={(k) => k} /> : <p className="text-muted-foreground text-sm">No cohort young enough to read yet.</p>}
          </TabsContent>
        </Tabs>
      </div>

      <Sheet open={openCell !== null} onOpenChange={(next) => { if (!next) setOpenCell(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{openCell ? `${openCell.abc}${openCell.xyz} — ${formatCount(openCell.count)} items` : ''}</SheetTitle>
            <SheetDescription>{openCell ? `${formatMoney(openCell.net)} of trailing-12-month net` : ''}</SheetDescription>
          </SheetHeader>
          {openCell ? (
            <div className="overflow-y-auto px-4 pb-6">
              <RecordTable
                columns={[
                  { key: 'item', header: 'Item', cell: (r: AbcCell['items'][number]) => r.item },
                  { key: 'net', header: 'Net (12m)', cell: (r: AbcCell['items'][number]) => formatMoney(r.net), numeric: true },
                ]}
                rows={[...openCell.items]}
                rowKey={(r) => r.itemId}
                mobilePrimary={(r) => r.item}
                mobileSupporting={(r) => formatMoney(r.net)}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
