import { useState } from 'react';
import { ArrowsClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { PolarAngleAxis, PolarGrid, Radar, RadarChart } from 'recharts';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
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
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_VALUE, formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { useMe } from '@/lib/session/use-session';

import type { Metric } from './api';
import { BridgeWaterfall, MovementMatrix } from './growth-charts';
import { PeriodRangeField } from './period-field';
import { STATES } from './movement-states';
import { MetricChart } from './metric-card';
import { rangeFromParams } from './period';
import { deltaText, useScorecard, type MovementCell, type ScorecardData } from './use-cfo';

/**
 * The person scorecard (brief G4): Sales, Customers, Collections, Activity
 * as tabs, and the six-axis radar against the team. Someone up on sales who
 * has lost four accounts is not performing well, and only this screen shows
 * it. Every figure is the league's engine scoped to their book (B3).
 */

const RADAR_CONFIG = {
  mine: { label: 'This person', color: 'var(--fresh-1)' },
  team: { label: 'Team average', color: 'var(--fresh-4)' },
} satisfies ChartConfig;

function personLabel(data: Pick<ScorecardData, 'ownerRef' | 'ownerEmail'>): string {
  if (data.ownerRef === 'HOUSE') return 'House';
  const local = data.ownerEmail?.split('@')[0];
  return local !== undefined && local !== '' ? local : 'Former user';
}

function ageingMetric(ageing: Record<string, string>): Metric {
  const buckets = ['current', '0-30', '31-60', '61-90', '91-180', '180+'];
  return {
    key: 'my-ageing',
    label: 'Ageing',
    hint: 'Receivables ageing buckets for this person',
    unit: 'money',
    headline: buckets.reduce((sum, b) => sum + Number(ageing[b] ?? 0), 0).toFixed(2),
    series: [{ key: 'value', label: 'Outstanding' }],
    points: buckets.map((b) => ({ t: b, value: Number(ageing[b] ?? 0) })),
    xKind: 'category',
  };
}

const PARTY_COLUMNS: RecordColumn<MovementCell['parties'][number]>[] = [
  { key: 'party', header: 'Customer', cell: (row) => row.party },
  { key: 'thisYear', header: 'This period', cell: (row) => formatMoney(row.thisYear), numeric: true },
  { key: 'lastYear', header: 'Last year', cell: (row) => formatMoney(row.lastYear), numeric: true },
];

function TeamRadar({ radar }: { radar: ScorecardData['radar'] }) {
  const data = radar.map((a) => ({ axis: a.axis, mine: a.mine ?? 0, team: a.team ?? 0 }));
  const withheld = radar.filter((a) => a.mine === null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Against the team</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={RADAR_CONFIG} className="mx-auto aspect-square max-h-72 w-full">
          <RadarChart data={data}>
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11 }} />
            <PolarGrid />
            <Radar dataKey="team" fill="var(--color-team)" fillOpacity={0.25} stroke="var(--color-team)" />
            <Radar dataKey="mine" fill="var(--color-mine)" fillOpacity={0.45} stroke="var(--color-mine)" />
            <ChartLegend content={<ChartLegendContent />} />
          </RadarChart>
        </ChartContainer>
        {withheld.length > 0 ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {withheld.map((a) => `${a.axis}: ${a.note ?? 'not yet knowable'}`).join(' · ')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ScorecardPage() {
  const params = useParams<{ ownerRef: string }>();
  const ownerRef = params.ownerRef ?? '';
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const me = useMe().data;
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const canTeam = usePermission(PERMISSIONS.CFO_TEAM_VIEW);
  const isSelf = me?.user.id !== undefined && ownerRef === `user:${me.user.id}`;
  const allowed = canView && (canTeam || isSelf);
  const [searchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const query = useScorecard(ownerRef, range, { enabled: allowed && ownerRef !== '' });
  const [openCell, setOpenCell] = useState<MovementCell | null>(null);

  if (!allowed) {
    return (
      <>
        <PageHeader description="One person's full performance." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot open this scorecard</EmptyTitle>
            <EmptyDescription>Your own needs cfo.sales.view; anyone else&rsquo;s needs cfo.team.view.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        title={data ? personLabel(data) : 'Scorecard'}
        description="Sales, customers, collections and activity for one person, against the team."
        action={
          <Button variant="outline" size="sm" onClick={() => void navigate('/reports/team')}>
            League table
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <ArrowsClockwiseIcon />
          </Button>
          <PeriodRangeField range={range} />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)} vs the same days last year
          </span>
        </div>

        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.error ? <QueryErrorAlert error={query.error} subject="scorecard" onRetry={() => void query.refetch()} /> : null}

        {data ? (
          <>
            <KpiGrid
              columns={5}
              tiles={[
                { label: 'Sales', value: formatMoney(data.row.sales), note: deltaText(data.row.salesDelta), info: <DefinitionLink id="R05" /> },
                {
                  label: 'Target',
                  value: data.row.achievementPct === null ? EMPTY_VALUE : `${String(data.row.achievementPct)}%`,
                  note: data.row.target === null ? 'No target set' : `of ${formatMoney(data.row.target)}`,
                },
                { label: 'Collections', value: formatMoney(data.row.collections) },
                { label: 'Overdue in book', value: formatMoney(data.row.overdue), info: <DefinitionLink id="D10" /> },
                { label: 'Book', value: formatCount(data.row.bookSize), note: `of a team of ${formatCount(data.teamSize)}` },
              ]}
            />

            <Tabs defaultValue="sales">
              <TabsList>
                <TabsTrigger value="sales">Sales</TabsTrigger>
                <TabsTrigger value="customers">Customers</TabsTrigger>
                <TabsTrigger value="collections">Collections</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="sales" className="flex flex-col gap-4">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
                  <div className="flex flex-col gap-2">
                    <SectionHeading title="Their growth bridge" description="Did their growth come from price, volume, or new customers?" />
                    {data.bridge.reconciliationError > 0.01 ? (
                      <Empty className="border">
                        <EmptyHeader>
                          <EmptyTitle>The bridge did not reconcile</EmptyTitle>
                          <EmptyDescription>Its factors do not sum to the change; the drawing is withheld.</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <BridgeWaterfall bridge={data.bridge} />
                    )}
                  </div>
                  <TeamRadar radar={data.radar} />
                </div>
              </TabsContent>

              <TabsContent value="customers" className="flex flex-col gap-2">
                <SectionHeading title="Their movement matrix" description="Up on sales but losing accounts shows here and nowhere else." />
                <MovementMatrix cells={data.movement.cells} onCell={setOpenCell} />
              </TabsContent>

              <TabsContent value="collections" className="flex flex-col gap-4">
                <KpiGrid
                  columns={3}
                  tiles={[
                    { label: 'Promises kept', value: formatCount(data.promises.kept) },
                    { label: 'Promises broken', value: formatCount(data.promises.broken) },
                    { label: 'Promises open', value: formatCount(data.promises.open) },
                  ]}
                />
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm font-medium">Their ageing</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <MetricChart metric={ageingMetric(data.ageing)} kind="bar" options={{ legend: false, dataLabels: true }} className="h-52" />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="activity" className="flex flex-col gap-4">
                <KpiGrid
                  columns={3}
                  tiles={[
                    { label: 'Tasks assigned', value: formatCount(data.activity.assigned) },
                    { label: 'Tasks closed', value: formatCount(data.activity.closed) },
                    {
                      label: 'Closed',
                      value: data.activity.assigned === 0 ? EMPTY_VALUE : `${String(Math.round((data.activity.closed / data.activity.assigned) * 100))}%`,
                    },
                  ]}
                />
                <p className="text-muted-foreground text-sm">Calls logged and quote conversion arrive with the CRM activity log; attendance is context only and lives in its own module.</p>
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </div>

      <Sheet open={openCell !== null} onOpenChange={(open) => { if (!open) setOpenCell(null); }}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{openCell ? `${STATES.find((s) => s.key === openCell.state)?.label ?? openCell.state} · ${openCell.band} band` : ''}</SheetTitle>
            <SheetDescription>{openCell ? `${formatCount(openCell.count)} customers · ${formatMoney(openCell.amount)}` : ''}</SheetDescription>
          </SheetHeader>
          {openCell ? (
            <div className="overflow-y-auto px-4 pb-6">
              <RecordTable
                columns={PARTY_COLUMNS}
                rows={[...openCell.parties]}
                rowKey={(row) => row.partyId}
                onRowActivate={(row) => void navigate(`/masters/vouchers?party=${row.partyId}&from=${range.from}&to=${range.to}`)}
                mobilePrimary={(row) => row.party}
                mobileSupporting={(row) => `${formatMoney(row.thisYear)} now · ${formatMoney(row.lastYear)} last year`}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
