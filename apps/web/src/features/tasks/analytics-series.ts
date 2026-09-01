import {
  MIN_CLOSED_FOR_AVERAGE,
  TASK_AGE_BUCKETS,
  TASK_AGE_BUCKET_LABELS,
  TASK_PRIORITY_LABELS,
  type TaskAgeLoad,
  type TaskAnalyticsView,
  type TaskAssigneeLoad,
  type TaskCustomerLoad,
  type TaskColumnLoad,
  type TaskFlowWeek,
} from '@vyuha/shared';

/**
 * The task dashboard's arithmetic, as pure functions.
 *
 * The questions each chart answers, written down before the chart was drawn:
 *
 * - Columns: *where is the work sitting?* Open tasks per board column, in
 *   board order, because the board's order is the order of the work.
 * - Flow: *are we closing as fast as work arrives?* Raised against closed per
 *   week, both counts on one axis — a second axis would make any two lines
 *   look related and this comparison is the whole point of the chart.
 * - Load: *who is carrying it, and how much of theirs is late?*
 *
 * Nothing here fetches and nothing renders. Every threshold an insight turns
 * on is a named constant, so it can be argued with and tested.
 */

/** A person carrying at least this share of their open work late needs help, not a nudge. */
export const OVERDUE_SHARE_WORTH_SAYING = 0.5;

/** Below this, "who has the most" is noise: two tasks against one is not a workload. */
export const MIN_OPEN_FOR_LOAD_INSIGHT = 5;

export interface ColumnPoint {
  readonly column: string;
  readonly count: number;
}

export interface FlowPoint {
  readonly weekStart: string;
  /** "18 Aug" — the axis label; the tooltip carries the rest. */
  readonly label: string;
  readonly raised: number;
  readonly closed: number;
}

export interface LoadPoint {
  readonly person: string;
  /**
   * Split so the two parts sum to the person's open count.
   *
   * Drawn as `overdue` beside `open` they were two bars of different lengths
   * with no stated relationship, under a caption claiming one was inside the
   * other -- and 17 open beside 6 overdue reads as 23 pieces of work. On time
   * and overdue stack to exactly the open total, which is the true shape:
   * overdue is part of open, not another number next to it.
   */
  readonly onTime: number;
  readonly overdue: number;
}

/** Open columns only: a done column holds no open work, so its bar is always zero. */
export function columnSeries(columns: readonly TaskColumnLoad[]): ColumnPoint[] {
  return columns
    .filter((column) => !column.isDone)
    .map((column) => ({ column: column.columnName, count: column.count }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function flowSeries(weeks: readonly TaskFlowWeek[]): FlowPoint[] {
  return weeks.map((week) => {
    const day = Number(week.weekStart.slice(8, 10));
    const month = MONTHS[Number(week.weekStart.slice(5, 7)) - 1] ?? '';
    return {
      weekStart: week.weekStart,
      label: `${String(day)} ${month}`,
      raised: week.raised,
      closed: week.closed,
    };
  });
}

export function loadSeries(assignees: readonly TaskAssigneeLoad[]): LoadPoint[] {
  return assignees.map((row) => ({
    // Work with nobody on it is a real state and the most actionable row on
    // the chart, so it is named rather than dropped.
    person: row.assigneeName ?? 'Unassigned',
    // Clamped at zero: the two counts come from one query and cannot disagree,
    // but a bar of negative length would be the loudest possible way to find
    // out if they ever did.
    onTime: Math.max(0, row.openCount - row.overdueCount),
    overdue: row.overdueCount,
  }));
}

/**
 * The mean days-to-close, or nothing.
 *
 * Below a handful of closed tasks the mean is one slow task wearing a
 * statistic's clothes, and the stat tile must not disagree with the sentence
 * beside it.
 */
export function readableDaysToClose(totals: TaskAnalyticsView['totals']): number | null {
  return totals.closedInPeriod < MIN_CLOSED_FOR_AVERAGE ? null : totals.avgDaysToClose;
}

/**
 * The sentences printed beside the charts.
 *
 * Each is a claim the numbers prove and the reader can act on. Where the
 * data cannot support a claim, it says so rather than drawing a trend
 * through two points.
 */
export function taskInsights(view: TaskAnalyticsView): string[] {
  const insights: string[] = [];
  const { totals } = view;

  if (totals.open === 0) {
    insights.push('Nothing is open. There is no backlog to read.');
    return insights;
  }

  if (totals.overdue > 0) {
    insights.push(
      `${String(totals.overdue)} of ${String(totals.open)} open ${totals.overdue === 1 ? 'task is' : 'tasks are'} past their due date.`,
    );
  }
  if (totals.unassigned > 0) {
    insights.push(
      `${String(totals.unassigned)} open ${totals.unassigned === 1 ? 'task has' : 'tasks have'} nobody on them.`,
    );
  }

  // Whoever is worst off, and only when their share of late work is high
  // enough that it is a problem rather than a coincidence.
  const struggling = [...view.assignees]
    .filter((row) => row.openCount >= MIN_OPEN_FOR_LOAD_INSIGHT)
    .map((row) => ({ row, share: row.overdueCount / row.openCount }))
    .filter((entry) => entry.share >= OVERDUE_SHARE_WORTH_SAYING)
    .sort((a, b) => b.share - a.share)[0];
  if (struggling !== undefined) {
    insights.push(
      `${struggling.row.assigneeName ?? 'Unassigned work'} has ${String(struggling.row.overdueCount)} of ${String(struggling.row.openCount)} open tasks overdue.`,
    );
  }

  // Raised against closed over the whole window, which is the question the
  // flow chart is drawn to answer.
  const raised = view.flow.reduce((sum, week) => sum + week.raised, 0);
  const closed = view.flow.reduce((sum, week) => sum + week.closed, 0);
  if (raised > 0 || closed > 0) {
    insights.push(
      raised > closed
        ? `${String(raised)} raised and ${String(closed)} closed in this period — the backlog grew.`
        : raised < closed
          ? `${String(closed)} closed against ${String(raised)} raised — the backlog shrank.`
          : `${String(raised)} raised and ${String(closed)} closed — the backlog held steady.`,
    );
  }

  return insights;
}

/** The priority split, in the order the product lists priorities, including the empty ones. */
export function prioritySeries(
  priorities: TaskAnalyticsView['priorities'],
): { priority: string; label: string; count: number }[] {
  const byPriority = new Map(priorities.map((row) => [row.priority, row.openCount]));
  return (['HIGH', 'MEDIUM', 'LOW'] as const).map((priority) => ({
    priority,
    label: TASK_PRIORITY_LABELS[priority],
    count: byPriority.get(priority) ?? 0,
  }));
}

/**
 * How old the open work is (REQ-V-11, owner 1 Sep 2026: "add more charts").
 *
 * The question: *is the backlog turning over, or silting up?* A count of
 * seventeen open says nothing about that; seventeen of which nine are over a
 * month old says all of it.
 *
 * Every bucket is returned, including the empty ones, and in age order. An
 * absent "over a month" bar and a zero-height one mean opposite things, and
 * only one of them is good news.
 */
export function ageingSeries(ageing: readonly TaskAgeLoad[]): LoadPoint[] {
  const byBucket = new Map(ageing.map((row) => [row.bucket, row]));
  return TASK_AGE_BUCKETS.map((bucket) => {
    const row = byBucket.get(bucket);
    const open = row?.openCount ?? 0;
    const overdue = row?.overdueCount ?? 0;
    return {
      person: TASK_AGE_BUCKET_LABELS[bucket],
      // Stacked to the open total, the same shape the assignee chart uses:
      // overdue is part of open, never a second number beside it.
      onTime: Math.max(0, open - overdue),
      overdue,
    };
  });
}

/**
 * Which customer the open work belongs to.
 *
 * "Who is carrying it" answers which colleague; this answers which account.
 * The server returns only tasks that name a customer and only the busiest
 * few, so this shapes rather than filters.
 */
export function customerSeries(customers: readonly TaskCustomerLoad[]): LoadPoint[] {
  return customers.map((row) => ({
    person: row.partyName,
    onTime: Math.max(0, row.openCount - row.overdueCount),
    overdue: row.overdueCount,
  }));
}

/** Whether the ageing chart has anything to say, or the backlog is empty. */
export function hasAgeing(ageing: readonly TaskAgeLoad[]): boolean {
  return ageing.some((row) => row.openCount > 0);
}
