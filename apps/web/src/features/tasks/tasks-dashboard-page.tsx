import {
  BroadcastIcon,
  CheckSquareIcon,
  ClockCountdownIcon,
  BuildingsIcon,
  HourglassIcon,
  KanbanIcon,
  SlidersHorizontalIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { Fragment, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '@/components/shared/page-header';
import { useChartIntro } from '@/components/shared/use-chart-motion';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE } from '@/lib/format';

import { AgeingChart, AssigneeLoadChart, ColumnLoadChart, CustomerLoadChart, FlowChart } from './analytics-charts';
import {
  ageingSeries,
  columnSeries,
  customerSeries,
  flowSeries,
  hasAgeing,
  loadSeries,
  prioritySeries,
  readableDaysToClose,
  taskInsights,
} from './analytics-series';
import { BlockFigures, BlockNumber, DashboardBlock } from './dashboard-block';
import { useTaskDashboardBlocks, type TaskDashboardBlock } from './dashboard-blocks';
import { DashboardBlocksMenu } from './dashboard-blocks-menu';
import { useTaskAnalytics } from './use-tasks';
import { useWorkingNowCount } from './working-now-count';
import { WorkingNow } from './working-now';

/**
 * REQ-V-11 and REQ-V-14: the task dashboard, as a grid of blocks.
 *
 * The shape is Notion's, taken from the real screen rather than from memory
 * (owner, 31 Aug 2026): small bordered blocks in a two-column grid, each with
 * a quiet labelled strip and one thing inside it. What that buys over the
 * full-width sections this screen had before is scanning — five questions
 * side by side rather than five screens of scrolling, and a block can be read
 * without reading its neighbours.
 *
 * Nothing on this page polls. Every figure is invalidated by the live stream
 * under the `['tasks']` prefix, so a colleague closing a task moves these
 * numbers within a second; the Working now block is the roster itself.
 *
 * One level deep: a block holds a chart, a list or a number, never another
 * block (CLAUDE.md §3).
 */

const WEEK_CHOICES = ['4', '8', '12'] as const;
const DEFAULT_WEEKS = '8';

export function TasksDashboardPage() {
  const [params, setParams] = useSearchParams();
  const weeks = params.get('weeks') ?? DEFAULT_WEEKS;
  const { data, isPending, isError, error, refetch } = useTaskAnalytics({ weeks: Number(weeks) });
  // Once, on the first paint after the data lands; never again, so changing
  // the period is not a wait.
  const animate = useChartIntro(data !== undefined);

  const period = (
    <Select
      value={weeks}
      onValueChange={(value) => {
        const next = new URLSearchParams(params);
        next.set('weeks', value ?? DEFAULT_WEEKS);
        setParams(next, { replace: true });
      }}
    >
      <SelectTrigger size="sm" className="w-32" aria-label="Period">
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
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Tasks"
        title="Dashboard"
        description="What is open, what is late, and who is on it now."
        action={<DashboardBlocksMenu />}
      />

      {isError ? (
        <QueryErrorAlert
          error={error}
          subject="the dashboard"
          onRetry={() => {
            void refetch();
          }}
        />
      ) : isPending ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((slot) => (
            <Skeleton key={slot} className="h-44" />
          ))}
        </div>
      ) : (
        <DashboardGrid data={data} animate={animate} period={period} />
      )}
    </div>
  );
}

function DashboardGrid({
  data,
  animate,
  period,
}: {
  readonly data: NonNullable<ReturnType<typeof useTaskAnalytics>['data']>;
  readonly animate: boolean;
  readonly period: React.ReactNode;
}) {
  const columns = columnSeries(data.columns);
  const flow = flowSeries(data.flow);
  const load = loadSeries(data.assignees);
  const ageing = ageingSeries(data.ageing);
  const customers = customerSeries(data.customers);
  const priorities = prioritySeries(data.priorities);
  const insights = taskInsights(data);
  const daysToClose = readableDaysToClose(data.totals);
  const workingNow = useWorkingNowCount();
  const { shown, order } = useTaskDashboardBlocks();

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

  // Each block built once, then rendered in the order this reader chose and
  // filtered to what they kept. Keeping them in a lookup rather than inline
  // is what lets the order be data instead of the shape of the JSX.
  const blocks: Record<TaskDashboardBlock, ReactNode> = {
    open: (
      <DashboardBlock icon={<CheckSquareIcon />} label="Open" note="right now">
        <BlockNumber
          value={String(data.totals.open)}
          caption={
            data.totals.overdue > 0
              ? `${String(data.totals.overdue)} of them past their due date`
              : 'None of them overdue'
          }
          {...(data.totals.overdue > 0 ? { captionTone: 'warning' as const } : {})}
        />
      </DashboardBlock>
    ),

    // REQ-V-14. "Who is on it now" is the question a dashboard is opened to
    // answer and the one no other screen answers whole.
    workingNow: (
      <DashboardBlock
        icon={<BroadcastIcon />}
        label="Working now"
        note={workingNow === 0 ? undefined : `${String(workingNow)} open`}
      >
        <WorkingNow />
      </DashboardBlock>
    ),

    attention: (
      <DashboardBlock icon={<WarningCircleIcon />} label="Needs attention" note="open tasks">
        <BlockFigures
          figures={[
            {
              label: 'Due today',
              value: String(data.totals.dueToday),
              ...(data.totals.dueToday > 0 ? { tone: 'warning' as const } : {}),
            },
            { label: 'Due in 7 days', value: String(data.totals.dueThisWeek) },
            {
              label: 'Nobody assigned',
              value: String(data.totals.unassigned),
              ...(data.totals.unassigned > 0 ? { tone: 'warning' as const } : {}),
            },
            { label: 'Days to close', value: daysToClose === null ? EMPTY_VALUE : String(daysToClose) },
          ]}
        />
      </DashboardBlock>
    ),

    priority: (
      <DashboardBlock icon={<KanbanIcon />} label="By priority" note="open tasks">
        <span className="flex flex-wrap items-center gap-1.5">
          {priorities.map((entry) => (
            <Badge key={entry.priority} variant="outline" className="font-normal tabular-nums">
              {entry.label} {entry.count}
            </Badge>
          ))}
        </span>
      </DashboardBlock>
    ),

    insights:
      insights.length === 0 ? null : (
        <DashboardBlock icon={<CheckSquareIcon />} label="What the numbers say" span="wide">
          <ul className="flex flex-col gap-1.5 text-sm leading-relaxed">
            {insights.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </DashboardBlock>
      ),

    columns: (
      <DashboardBlock icon={<KanbanIcon />} label="Where work is sitting" note="by board column">
        {columns.length === 0 ? (
          <p className="text-muted-foreground text-sm">This board has no open columns yet.</p>
        ) : (
          <ColumnLoadChart points={columns} animate={animate} />
        )}
      </DashboardBlock>
    ),

    load: (
      <DashboardBlock icon={<UsersThreeIcon />} label="Who is carrying it" note="overdue shown inside the bar">
        {load.length === 0 ? (
          <p className="text-muted-foreground text-sm">No open tasks to attribute.</p>
        ) : (
          <AssigneeLoadChart points={load} animate={animate} />
        )}
      </DashboardBlock>
    ),

    ageing: (
      <DashboardBlock icon={<HourglassIcon />} label="How old the backlog is" note="open tasks by age">
        {!hasAgeing(data.ageing) ? (
          <p className="text-muted-foreground text-sm">Nothing is open, so there is no backlog to age.</p>
        ) : (
          <AgeingChart points={ageing} animate={animate} />
        )}
      </DashboardBlock>
    ),

    customers: (
      <DashboardBlock icon={<BuildingsIcon />} label="Which customer it is for" note="open tasks, busiest first">
        {customers.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No open task names a customer yet. Set one on a task and it appears here.
          </p>
        ) : (
          <CustomerLoadChart points={customers} animate={animate} />
        )}
      </DashboardBlock>
    ),

    // The period control belongs to this block and nothing else: it is the
    // only figure on the page that has a window.
    flow: (
      <DashboardBlock
        icon={<ClockCountdownIcon />}
        label="Raised and closed"
        note="by week"
        span="wide"
        action={period}
      >
        <FlowChart points={flow} animate={animate} />
      </DashboardBlock>
    ),
  };

  const visible = order.filter((key) => shown[key] && blocks[key] !== null);

  if (visible.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SlidersHorizontalIcon />
          </EmptyMedia>
          <EmptyTitle>Every block is hidden</EmptyTitle>
          <EmptyDescription>Turn one back on from Blocks, above.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {visible.map((key) => (
        <Fragment key={key}>{blocks[key]}</Fragment>
      ))}
    </div>
  );
}
