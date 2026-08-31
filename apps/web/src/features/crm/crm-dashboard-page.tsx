import { ChartLineUpIcon, ClockCountdownIcon, HandshakeIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { useChartIntro } from '@/components/shared/use-chart-motion';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatMoney } from '@/lib/format';

import { ChartSkeleton, OutcomesChart, OwnerLoadChart, StageFunnelChart } from './analytics-charts';
import { crmInsights, funnelSeries, outcomeSeries, ownerSeries, readableWinRate } from './analytics-series';
import { useCrmAnalytics, usePipelines } from './use-deals';

/**
 * REQ-U-10: the CRM dashboard.
 *
 * Six questions in one screen, in the order somebody asks them: what is the
 * pipeline worth, what needs me today, where are deals piling up, what have
 * we been closing, and who is carrying it.
 *
 * No card inside a card (CLAUDE.md §3 rule 3): the page is header, then
 * toolbar, then sections separated by headings and rules on the page's own
 * surface. The stat row is typography on that surface, not five little
 * boxes.
 */

const MONTH_CHOICES = ['3', '6', '12'] as const;
const DEFAULT_MONTHS = '6';

function money(value: string): string {
  const amount = formatMoney(value);
  return amount.endsWith('.00') ? amount.slice(0, -3) : amount;
}

/**
 * One figure and its name. Deliberately not a Card: five cards in a row is
 * the box-in-box the constitution forbids, and the numbers read better as
 * typography with space around them than as five outlined rectangles.
 */
function Stat({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: 'warning' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={
          tone === 'warning'
            ? 'text-warning text-xl font-semibold tabular-nums'
            : 'text-xl font-semibold tabular-nums'
        }
      >
        {value}
      </span>
    </div>
  );
}

export function CrmDashboardPage() {
  const [params, setParams] = useSearchParams();
  const pipelineId = params.get('pipelineId') ?? undefined;
  const months = params.get('months') ?? DEFAULT_MONTHS;

  const pipelines = usePipelines();
  const { data, isPending, isError, error, refetch } = useCrmAnalytics({
    pipelineId,
    months: Number(months),
  });
  // Once, on the first paint after the data lands; never again, so changing
  // the period is not a wait.
  const animate = useChartIntro(data !== undefined);

  function setParam(key: string, value: string | null): void {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="CRM"
        title="Dashboard"
        description="The pipeline as it stands, and what has closed."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={pipelineId ?? 'all'}
          onValueChange={(value) => {
            setParam('pipelineId', value === 'all' ? null : value);
          }}
        >
          <SelectTrigger className="w-52" aria-label="Pipeline">
            <SelectValue placeholder="Every pipeline" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every pipeline</SelectItem>
            {(pipelines.data ?? []).map((pipeline) => (
              <SelectItem key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={months}
          onValueChange={(value) => {
            setParam('months', value);
          }}
        >
          <SelectTrigger className="w-36" aria-label="Period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                Last {choice} months
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isError ? (
        <QueryErrorAlert
          error={error}
          onRetry={() => {
            void refetch();
          }}
        />
      ) : isPending ? (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((slot) => (
              <Skeleton key={slot} className="h-12" />
            ))}
          </div>
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      ) : (
        <DashboardBody data={data} animate={animate} />
      )}
    </div>
  );
}

function DashboardBody({
  data,
  animate,
}: {
  readonly data: NonNullable<ReturnType<typeof useCrmAnalytics>['data']>;
  readonly animate: boolean;
}) {
  const funnel = funnelSeries(data.stages);
  const outcomes = outcomeSeries(data.outcomes);
  const owners = ownerSeries(data.owners);
  const insights = crmInsights(data);
  const winRate = readableWinRate(data.totals);
  const nothingAtAll = data.totals.openCount === 0 && data.totals.wonCount === 0 && data.totals.lostCount === 0;

  if (nothingAtAll) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HandshakeIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing to report yet</EmptyTitle>
          <EmptyDescription>
            Once there are deals in this pipeline, their value, stages and outcomes appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Open pipeline" value={money(data.totals.openValue)} />
        <Stat label="Open deals" value={String(data.totals.openCount)} />
        <Stat
          label="Win rate"
          // Null is "not enough has closed to say", which is neither 0% nor a
          // number worth printing. The insight below uses the same rule.
          value={winRate === null ? EMPTY_VALUE : `${String(winRate)}%`}
        />
        <Stat
          label="Days to win"
          value={data.totals.avgDaysToWin === null ? EMPTY_VALUE : String(data.totals.avgDaysToWin)}
        />
      </div>

      {insights.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {insights.map((line) => (
            <p key={line} className="text-sm leading-relaxed">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading
          icon={<WarningCircleIcon />}
          title="Needs attention"
          note="Open deals only."
        />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Past close date"
            value={String(data.attention.overdue)}
            {...(data.attention.overdue > 0 ? { tone: 'warning' as const } : {})}
          />
          <Stat
            label="Follow-up due"
            value={String(data.attention.followUpDue)}
            {...(data.attention.followUpDue > 0 ? { tone: 'warning' as const } : {})}
          />
          <Stat label="Closing in 7 days" value={String(data.attention.closingSoon)} />
          <Stat label="Untouched 14 days" value={String(data.attention.stale)} />
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading icon={<ChartLineUpIcon />} title="Where deals are" note="Open deals by stage." />
        {funnel.length === 0 ? (
          <p className="text-muted-foreground text-sm">This pipeline has no open stages yet.</p>
        ) : (
          <StageFunnelChart points={funnel} animate={animate} />
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading icon={<ClockCountdownIcon />} title="Won and lost" note="By the month a deal closed." />
        <OutcomesChart points={outcomes} animate={animate} />
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading icon={<HandshakeIcon />} title="Who is carrying it" note="Open deals by owner." />
        {owners.length === 0 ? (
          <p className="text-muted-foreground text-sm">No open deals to attribute.</p>
        ) : (
          <OwnerLoadChart points={owners} animate={animate} />
        )}
      </section>
    </div>
  );
}
