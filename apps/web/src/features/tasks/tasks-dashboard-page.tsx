import { CheckSquareIcon, ClockCountdownIcon, KanbanIcon, UsersThreeIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { useChartIntro } from '@/components/shared/use-chart-motion';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE } from '@/lib/format';

import { AssigneeLoadChart, ChartSkeleton, ColumnLoadChart, FlowChart } from './analytics-charts';
import { columnSeries, flowSeries, loadSeries, prioritySeries, readableDaysToClose, taskInsights } from './analytics-series';
import { useTaskAnalytics } from './use-tasks';

/**
 * REQ-V-11: the task dashboard.
 *
 * Five questions in the order somebody asks them: how much is open, what
 * needs me today, where is it sitting, who is carrying it, and are we
 * closing as fast as work arrives.
 *
 * No card inside a card (CLAUDE.md §3 rule 3): header, toolbar, then
 * sections separated by headings and rules on the page's own surface. The
 * stat row is typography, not five little boxes.
 */

const WEEK_CHOICES = ['4', '8', '12'] as const;
const DEFAULT_WEEKS = '8';

function Stat({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: 'warning' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={tone === 'warning' ? 'text-warning text-xl font-semibold tabular-nums' : 'text-xl font-semibold tabular-nums'}>
        {value}
      </span>
    </div>
  );
}

export function TasksDashboardPage() {
  const [params, setParams] = useSearchParams();
  const weeks = params.get('weeks') ?? DEFAULT_WEEKS;
  const { data, isPending, isError, error, refetch } = useTaskAnalytics({ weeks: Number(weeks) });
  // Once, on the first paint after the data lands; never again, so changing
  // the period is not a wait.
  const animate = useChartIntro(data !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Tasks" title="Dashboard" description="What is open, what is late, and who is carrying it." />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={weeks}
          onValueChange={(value) => {
            const next = new URLSearchParams(params);
            next.set('weeks', value);
            setParams(next, { replace: true });
          }}
        >
          <SelectTrigger className="w-36" aria-label="Period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WEEK_CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                Last {choice} weeks
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
  readonly data: NonNullable<ReturnType<typeof useTaskAnalytics>['data']>;
  readonly animate: boolean;
}) {
  const columns = columnSeries(data.columns);
  const flow = flowSeries(data.flow);
  const load = loadSeries(data.assignees);
  const priorities = prioritySeries(data.priorities);
  const insights = taskInsights(data);
  const daysToClose = readableDaysToClose(data.totals);

  if (data.totals.open === 0 && data.totals.closedInPeriod === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CheckSquareIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing to report yet</EmptyTitle>
          <EmptyDescription>
            Once there are tasks, what is open, what is late and who is carrying it appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Open" value={String(data.totals.open)} />
        <Stat
          label="Overdue"
          value={String(data.totals.overdue)}
          {...(data.totals.overdue > 0 ? { tone: 'warning' as const } : {})}
        />
        <Stat label="Closed in period" value={String(data.totals.closedInPeriod)} />
        <Stat
          label="Days to close"
          // Null is "not enough has closed to say", which is not zero days.
          value={daysToClose === null ? EMPTY_VALUE : String(daysToClose)}
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
        <SectionHeading icon={<WarningCircleIcon />} title="Needs attention" note="Open tasks only." />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Due today"
            value={String(data.totals.dueToday)}
            {...(data.totals.dueToday > 0 ? { tone: 'warning' as const } : {})}
          />
          <Stat label="Due in 7 days" value={String(data.totals.dueThisWeek)} />
          <Stat
            label="Nobody assigned"
            value={String(data.totals.unassigned)}
            {...(data.totals.unassigned > 0 ? { tone: 'warning' as const } : {})}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-muted-foreground text-xs">By priority</span>
            {/* Three small numbers, not a fourth chart: a split of three is
                read faster as text than as a shape. */}
            <span className="flex flex-wrap items-center gap-1.5">
              {priorities.map((entry) => (
                <Badge key={entry.priority} variant="outline" className="font-normal tabular-nums">
                  {entry.label} {entry.count}
                </Badge>
              ))}
            </span>
          </div>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading icon={<KanbanIcon />} title="Where work is sitting" note="Open tasks by board column." />
        {columns.length === 0 ? (
          <p className="text-muted-foreground text-sm">This board has no open columns yet.</p>
        ) : (
          <ColumnLoadChart points={columns} animate={animate} />
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading icon={<ClockCountdownIcon />} title="Raised and closed" note="By the week work arrived or was finished." />
        <FlowChart points={flow} animate={animate} />
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <SectionHeading icon={<UsersThreeIcon />} title="Who is carrying it" note="Open tasks by assignee, with the overdue part shown inside the bar." />
        {load.length === 0 ? (
          <p className="text-muted-foreground text-sm">No open tasks to attribute.</p>
        ) : (
          <AssigneeLoadChart points={load} animate={animate} />
        )}
      </section>
    </div>
  );
}
