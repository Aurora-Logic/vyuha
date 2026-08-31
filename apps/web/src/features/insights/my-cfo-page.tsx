import { ArrowsClockwiseIcon, UserCircleIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';
import { z } from 'zod';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { DefinitionLink } from '@/components/shared/definition-panel';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';
import { EMPTY_VALUE, formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import type { Metric } from './api';
import { deltaReadingSchema, deltaText } from './use-cfo';
import { MetricChart } from './metric-card';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';

/**
 * My CFO (brief G3): what each person sees about their own book -- the
 * screen that makes the sales team open the module voluntarily. Five cards,
 * the pacing line, then the customers themselves. What is not knowable yet
 * says so rather than pretending: real profit awaits the valuation
 * decision (M1); a period without a target says so instead of faking 100%.
 */

const deltaSchema = deltaReadingSchema;

const myCfoSchema = z.object({
  bookSize: z.number(),
  mySales: z.string(),
  salesDelta: deltaSchema,
  myCollections: z.string(),
  myOverdue: z.string(),
  overdueParties: z.number(),
  delayCostPerYear: z.string(),
  target: z.string().nullable(),
  achievementPct: z.number().nullable(),
  marginPct: z.number().nullable(),
  pacing: z.array(z.object({ t: z.string(), cumulative: z.number(), lastYear: z.number() })),
  customers: z.array(
    z.object({
      partyId: z.string(),
      party: z.string(),
      thisPeriod: z.string(),
      lastYear: z.string(),
      change: deltaSchema,
      overdue: z.string(),
      daysOverdue: z.number(),
      daysSinceLastOrder: z.number().nullable(),
    }),
  ),
});

type MyCfoData = z.infer<typeof myCfoSchema>;

function useMyCfo(range: { from: string; to: string }, enabled: boolean): UseQueryResult<MyCfoData, Error> {
  return useQuery({
    enabled,
    queryKey: ['cfo', 'me', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/me?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(myCfoSchema, body, 'my figures');
    },
    staleTime: 60_000,
  });
}

/** Q1.1 spoken aloud: a percentage only where the base could carry one. */
function pacingMetric(data: MyCfoData): Metric {
  return {
    key: 'my-pacing',
    label: 'My pacing',
    hint: 'My cumulative net sales through the period, against the same days last year.',
    unit: 'money',
    headline: data.mySales,
    series: [
      { key: 'cumulative', label: 'This period' },
      { key: 'lastYear', label: 'Last year' },
    ],
    points: data.pacing,
  };
}

export function MyCfoPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const range = rangeFromParams(searchParams);
  const query = useMyCfo(range, canView);

  if (!canView) {
    return (
      <>
        <PageHeader description="Your book: sales, collections, overdue, and the customers behind them." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserCircleIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view My CFO</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;

  const CUSTOMER_COLUMNS: RecordColumn<MyCfoData['customers'][number]>[] = [
    { key: 'party', header: 'Customer', cell: (row) => row.party },
    { key: 'thisPeriod', header: 'This period', cell: (row) => formatMoney(row.thisPeriod), numeric: true },
    { key: 'lastYear', header: 'Last year', cell: (row) => formatMoney(row.lastYear), numeric: true, secondary: true },
    { key: 'change', header: 'Change', cell: (row) => deltaText(row.change) },
    { key: 'overdue', header: 'Overdue', cell: (row) => (Number(row.overdue) > 0 ? formatMoney(row.overdue) : EMPTY_VALUE), numeric: true },
    { key: 'daysOverdue', header: 'Days', cell: (row) => (row.daysOverdue > 0 ? formatCount(row.daysOverdue) : EMPTY_VALUE), numeric: true, secondary: true },
    {
      key: 'lastOrder',
      header: 'Last order',
      cell: (row) => (row.daysSinceLastOrder === null ? EMPTY_VALUE : `${formatCount(row.daysSinceLastOrder)}d ago`),
      secondary: true,
    },
  ];

  return (
    <>
      <PageHeader description="Your book: sales against last year, collections, the overdue money, and the customers behind it all." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            <ArrowsClockwiseIcon />
          </Button>
          <DateRangeField
            label="Period"
            value={rangeAsPickerValue(range)}
            presets={INSIGHT_PRESETS}
            onValueChange={(next) => {
              if (!next.from || !next.to) return;
              const from = toApiDate(next.from);
              const to = toApiDate(next.to);
              setSearchParams(
                (current) => {
                  const params = new URLSearchParams(current);
                  params.set('from', from);
                  params.set('to', to);
                  return params;
                },
                { replace: true },
              );
            }}
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)}
          </span>
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.isError ? (
          <QueryErrorAlert error={query.error} subject="my figures" onRetry={() => void query.refetch()} />
        ) : null}

        {data && data.bookSize === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UserCircleIcon />
              </EmptyMedia>
              <EmptyTitle>No customers in your book yet</EmptyTitle>
              <EmptyDescription>
                Your book is the parties you are relationship manager on. Once customers are assigned to
                you, their sales, collections and overdue money appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {data && data.bookSize > 0 ? (
          <>
            <KpiGrid
              columns={6}
              tiles={[
                { label: 'My sales', value: formatMoney(data.mySales), note: deltaText(data.salesDelta) },
                { label: 'My collections', value: formatMoney(data.myCollections) },
                { label: 'My overdue book', value: formatMoney(data.myOverdue), note: `${formatCount(data.overdueParties)} parties` },
                { label: 'Their delay costs / yr', value: formatMoney(data.delayCostPerYear), info: <DefinitionLink id="D17" /> },
                data.target !== null && data.achievementPct !== null
                  ? { label: 'Target progress', value: `${data.achievementPct}%`, note: `of ${formatMoney(data.target)}` }
                  // Honest placeholders, not fakes (brief G3 rows the
                  // module cannot fill yet say why).
                  : { label: 'Target progress', value: EMPTY_VALUE, note: 'No target set for this period' },
                data.marginPct !== null
                  ? { label: 'Margin %', value: `${String(data.marginPct)}%`, note: 'own book, costed grains', info: <DefinitionLink id="M07" /> }
                  : { label: 'Margin %', value: EMPTY_VALUE, note: 'No costed grains in the period', info: <DefinitionLink id="M07" /> },
              ]}
            />

            {data.pacing.length > 0 ? (
              <Card data-metric="my-pacing">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">My pacing</CardTitle>
                </CardHeader>
                <CardContent>
                  <MetricChart metric={pacingMetric(data)} kind="line" options={{ legend: true, dataLabels: false }} className="h-52" />
                </CardContent>
              </Card>
            ) : null}

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">My customers</p>
              <RecordTable
                columns={CUSTOMER_COLUMNS}
                rows={[...data.customers]}
                rowKey={(row) => row.partyId}
              onRowActivate={(row) => void navigate(`/masters/vouchers?party=${row.partyId}&from=${range.from}&to=${range.to}`)}
                mobilePrimary={(row) => row.party}
                mobileSupporting={(row) => `${formatMoney(row.thisPeriod)} · ${deltaText(row.change)}`}
              />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
