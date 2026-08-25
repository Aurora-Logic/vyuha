import { ArrowRightIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { REPORT_DEFINITIONS, type DashboardKpiMetric, type DashboardLayout, type DashboardTile, type Paginated } from '@vyuha/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import type { DateRange } from 'react-day-picker';
import { useNavigate } from 'react-router';

import { ChartCard } from '@/components/shared/chart-card';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { KpiGrid, type KpiTileProps } from '@/components/shared/kpi-grid';
import { useChartIntro } from '@/components/shared/use-chart-motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardAction } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EMPTY_VALUE } from '@/lib/format';

import { useReportCatalogue, useReportRows } from './api';
import { DASHBOARD_KPIS, type KpiMetricSpec } from './dashboard-kpis';
import { periodParams } from './period';
import { GenericReportChart, type ChartDrill } from './report-charts';
import { healTileForm } from './dashboard-heal';
import { resolveChartForm } from './report-series';
import type { ReportRowView } from './types';

/**
 * A stored board, drawn: one tile per entry, each the shared ChartCard around
 * the generic chart engine, reading the same rows endpoint the report shell
 * reads. Nothing here computes a figure -- a tile is an arrangement of a
 * report, not a different truth about it.
 *
 * A tile whose report is missing from the caller's catalogue renders nothing
 * at all. The catalogue is the server's answer to "which reports may this
 * person read", so an absent tile is absent the way a hidden menu entry is
 * hidden -- an error card would advertise a thing the person cannot open.
 */
export function TileGrid({
  layout,
  range,
  animate = true,
}: {
  layout: DashboardLayout;
  range: DateRange;
  animate?: boolean;
}) {
  const catalogue = useReportCatalogue();

  if (catalogue.isPending) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {layout.tiles.map((tile, index) => (
          <Skeleton
            key={`${String(index)}-${tile.reportKey}`}
            className={tile.wide ? 'aspect-video w-full lg:col-span-2' : 'aspect-video w-full'}
          />
        ))}
      </div>
    );
  }

  if (catalogue.isError) {
    return (
      <Alert variant="destructive">
        <WarningCircleIcon />
        <AlertTitle>The report list could not be loaded</AlertTitle>
        <AlertDescription>
          {catalogue.error.message}
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void catalogue.refetch();
            }}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const allowed = new Set(catalogue.data.map((definition) => definition.key));
  // A KPI tile is absent the same way a chart tile is: by what the catalogue
  // says its *registry* report is, so a stale stored reportKey cannot show a
  // figure the person may not read.
  const kpis = layout.tiles.filter(
    (tile) => tile.kind === 'kpi' && tile.metric !== undefined && allowed.has(DASHBOARD_KPIS[tile.metric].reportKey),
  );
  const visible = layout.tiles.filter((tile) => tile.kind === 'chart' && allowed.has(tile.reportKey));

  if (visible.length === 0 && kpis.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-sm">
        Nothing on this board is visible to you. Customise it, or ask an administrator to widen
        your reports.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {kpis.length > 0 ? <KpiStrip tiles={kpis} range={range} /> : null}
      {visible.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visible.map((tile, index) => (
            // Bounded per tile: a tile is stored configuration, which makes it
            // untrusted input to the renderer, and one bad tile must cost one
            // card, never the board.
            <ErrorBoundary key={`${String(index)}-${tile.reportKey}`} resetKey={`${tile.reportKey}-${tile.form}`}>
              <DashboardTileCard tile={tile} range={range} animate={animate} />
            </ErrorBoundary>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type KpiRows = UseQueryResult<Paginated<ReportRowView>, Error>;

/**
 * One metric's page of rows, from the registry's own report and params --
 * never the stored tile's, so a tile saved before a metric moved reports
 * still states the figure the registry defines today.
 */
function useKpiRows(metric: DashboardKpiMetric, range: DateRange, enabled: boolean): KpiRows {
  const spec = DASHBOARD_KPIS[metric];
  return useReportRows(
    spec.reportKey,
    { page: 1, pageSize: 200, ...periodParams(spec.reportKey, range), ...spec.params },
    { enabled },
  );
}

/**
 * The chosen headline figures as one strip above the chart grid, in their
 * stored order. Six static hooks rather than one per chosen tile, because the
 * metric set is closed and the tile count is not -- a person adding a figure
 * must not change the number of hooks a render makes.
 */
function KpiStrip({ tiles, range }: { tiles: readonly DashboardTile[]; range: DateRange }) {
  const navigate = useNavigate();
  const chosen = new Set(tiles.map((tile) => tile.metric));
  const readings: Record<DashboardKpiMetric, KpiRows> = {
    'invoiced-period': useKpiRows('invoiced-period', range, chosen.has('invoiced-period')),
    'receivables-exposure': useKpiRows('receivables-exposure', range, chosen.has('receivables-exposure')),
    'credit-breaches': useKpiRows('credit-breaches', range, chosen.has('credit-breaches')),
    'revenue-going-quiet': useKpiRows('revenue-going-quiet', range, chosen.has('revenue-going-quiet')),
    'dead-stock-value': useKpiRows('dead-stock-value', range, chosen.has('dead-stock-value')),
    'below-reorder': useKpiRows('below-reorder', range, chosen.has('below-reorder')),
  };

  const open = (spec: KpiMetricSpec): void => {
    // The figure's period travels with the drill, bent into what the target
    // can answer for -- the same rule every chart tile follows.
    const params = new URLSearchParams(spec.drillQuery);
    for (const [key, value] of Object.entries(periodParams(spec.reportKey, range))) {
      params.set(key, value);
    }
    void navigate(`/reports?${params.toString()}`);
  };

  if (tiles.some((tile) => tile.metric !== undefined && readings[tile.metric].isPending)) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <Skeleton key={tile.metric} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const figures = tiles.flatMap((tile): KpiTileProps[] => {
    if (tile.metric === undefined) return [];
    const spec = DASHBOARD_KPIS[tile.metric];
    const query = readings[tile.metric];
    const label = tile.label ?? spec.label;
    if (query.isError) {
      // The tile stands with an honest dash: a figure that silently vanishes
      // reads as a board the person never chose.
      return [{ label, value: EMPTY_VALUE, note: 'This figure could not be loaded.', onOpen: () => { open(spec); } }];
    }
    if (query.data === undefined) return [];
    const reading = spec.compute(query.data.data, query.data.meta);
    return [{ label, value: reading.value, note: reading.note, onOpen: () => { open(spec); } }];
  });

  return <KpiGrid tiles={figures} columns={6} />;
}

function DashboardTileCard({
  tile,
  range,
  animate,
}: {
  tile: DashboardTile;
  range: DateRange;
  animate: boolean;
}) {
  const navigate = useNavigate();
  const definition = REPORT_DEFINITIONS[tile.reportKey];
  const rows = useReportRows(tile.reportKey, {
    page: 1,
    pageSize: 200,
    ...periodParams(tile.reportKey, range),
    ...tile.filters,
  });
  const intro = useChartIntro(rows.isSuccess);

  const title = tile.label ?? definition.label;
  const points = rows.data?.data ?? [];

  const open = (extra: Readonly<Record<string, string>> = {}): void => {
    // The period travels with every drill, bent into what the target can
    // answer for -- the overview's own open() learned this the hard way: a
    // tile that dropped it would land the reader on a different range than
    // the one the tile was drawn over.
    const params = new URLSearchParams({ report: tile.reportKey });
    for (const [key, value] of Object.entries(tile.filters)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    for (const [key, value] of Object.entries(periodParams(tile.reportKey, range))) {
      params.set(key, value);
    }
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    void navigate(`/reports?${params.toString()}`);
  };

  const drill = (segment: ChartDrill): void => {
    // The clicked value becomes the matching filter where the report has one
    // (the shell's drillToSegment mapping); a segment that cannot narrow
    // honestly still opens the report over the same period.
    const can = (name: string): boolean => (definition.filters as readonly string[]).includes(name);
    if (segment.categoryKey === 'voucherType' && can('voucherType')) open({ voucherType: segment.category });
    else if (segment.categoryKey === 'ledgerName' && can('ledgerName')) open({ ledgerName: segment.category });
    else if ((segment.categoryKey === 'item' || segment.categoryKey === 'itemName') && can('itemName')) open({ itemName: segment.category });
    else if (segment.categoryKey === 'partyName' && can('partyId') && segment.rowId !== null) open({ partyId: segment.rowId });
    else open();
  };

  const action = (
    <CardAction>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          open();
        }}
      >
        Open report
        <ArrowRightIcon data-icon="inline-end" />
      </Button>
    </CardAction>
  );

  if (rows.isPending) {
    return (
      <ChartCard title={title} action={action} wide={tile.wide} pending>
        {null}
      </ChartCard>
    );
  }

  if (rows.isError) {
    return (
      <ChartCard title={title} action={action} wide={tile.wide}>
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>This tile could not be loaded</AlertTitle>
          <AlertDescription>
            {rows.error.message}
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                void rows.refetch();
              }}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </ChartCard>
    );
  }

  if (points.length === 0) {
    return (
      <ChartCard title={title} action={action} wide={tile.wide} empty emptyNote="Nothing in this period.">
        {null}
      </ChartCard>
    );
  }

  const spec = resolveChartForm(tile.reportKey, definition, points);
  const healed = healTileForm(tile, definition, points);
  if (spec === null) {
    return (
      <ChartCard title={title} action={action} wide={tile.wide}>
        <p className="text-muted-foreground py-8 text-sm">
          This report reads as a table. Open it to see the rows.
        </p>
      </ChartCard>
    );
  }

  return (
    <GenericReportChart
      reportKey={tile.reportKey}
      definition={definition}
      rows={points}
      animate={animate && intro}
      onDrill={drill}
      form={healed.form}
      footnote={healed.footnote}
      title={title}
      action={action}
      wide={tile.wide}
    />
  );
}
