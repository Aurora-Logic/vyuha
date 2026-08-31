import type { TaskAnalyticsView, TaskColumnLoad } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import {
  MIN_OPEN_FOR_LOAD_INSIGHT,
  columnSeries,
  flowSeries,
  loadSeries,
  prioritySeries,
  readableDaysToClose,
  taskInsights,
} from './analytics-series';

function column(name: string, count: number, isDone = false): TaskColumnLoad {
  return { columnId: name, columnName: name, sortOrder: 0, isDone, count };
}

function view(overrides: Partial<TaskAnalyticsView> = {}): TaskAnalyticsView {
  return {
    totals: {
      open: 0,
      overdue: 0,
      dueToday: 0,
      dueThisWeek: 0,
      unassigned: 0,
      closedInPeriod: 0,
      avgDaysToClose: null,
    },
    columns: [],
    assignees: [],
    priorities: [],
    flow: [],
    ...overrides,
  };
}

describe('columnSeries', () => {
  it('drops done columns, which by definition hold no open work', () => {
    const points = columnSeries([column('To do', 4), column('Done', 0, true)]);
    expect(points.map((point) => point.column)).toEqual(['To do']);
  });

  it('keeps a column nobody has reached', () => {
    // An empty "In progress" says nothing has been started, which is
    // information; dropping it makes the board look shorter than it is.
    expect(columnSeries([column('To do', 4), column('In progress', 0)])).toHaveLength(2);
  });

  it('has nothing to draw for a board with no columns', () => {
    expect(columnSeries([])).toEqual([]);
  });
});

describe('flowSeries', () => {
  it('labels a week by its Monday and keeps the sortable key', () => {
    const points = flowSeries([{ weekStart: '2026-08-17', raised: 3, closed: 1 }]);
    expect(points[0]).toMatchObject({ weekStart: '2026-08-17', label: '17 Aug', raised: 3, closed: 1 });
  });

  it('keeps a week in which nothing happened', () => {
    expect(flowSeries([{ weekStart: '2026-08-24', raised: 0, closed: 0 }])).toHaveLength(1);
  });
});

describe('loadSeries', () => {
  it('names work with nobody on it rather than dropping it', () => {
    const points = loadSeries([{ assigneeId: null, assigneeName: null, openCount: 3, overdueCount: 1 }]);
    expect(points[0]).toEqual({ person: 'Unassigned', onTime: 2, overdue: 1 });
  });

  it('splits so the two parts sum to the open count, never past it', () => {
    // The bar is stacked: if these did not sum to `openCount` the chart would
    // draw a length that is not the person's workload.
    const points = loadSeries([{ assigneeId: 'a', assigneeName: 'Meera Iyer', openCount: 17, overdueCount: 6 }]);
    expect(points[0]?.onTime).toBe(11);
    expect((points[0]?.onTime ?? 0) + (points[0]?.overdue ?? 0)).toBe(17);
  });

  it('never draws a negative bar, however the counts disagree', () => {
    const points = loadSeries([{ assigneeId: 'a', assigneeName: 'Odd', openCount: 2, overdueCount: 5 }]);
    expect(points[0]?.onTime).toBe(0);
  });

  it('has nothing to draw when nothing is open', () => {
    expect(loadSeries([])).toEqual([]);
  });
});

describe('prioritySeries', () => {
  it('lists all three in the product order, including the empty ones', () => {
    const points = prioritySeries([{ priority: 'HIGH', openCount: 2 }]);
    expect(points.map((point) => point.priority)).toEqual(['HIGH', 'MEDIUM', 'LOW']);
    expect(points.map((point) => point.count)).toEqual([2, 0, 0]);
  });
});

describe('readableDaysToClose', () => {
  it('withholds an average built from too few closed tasks', () => {
    // One slow task wearing a statistic's clothes.
    expect(readableDaysToClose({ ...view().totals, closedInPeriod: 2, avgDaysToClose: 31 })).toBeNull();
  });

  it('gives it once enough has closed', () => {
    expect(readableDaysToClose({ ...view().totals, closedInPeriod: 9, avgDaysToClose: 3.4 })).toBe(3.4);
  });
});

describe('taskInsights', () => {
  it('says an empty backlog is empty rather than inventing a claim', () => {
    expect(taskInsights(view())).toEqual(['Nothing is open. There is no backlog to read.']);
  });

  it('counts overdue and unassigned work, in singular and plural', () => {
    const one = taskInsights(view({ totals: { ...view().totals, open: 4, overdue: 1, unassigned: 1 } }));
    expect(one.some((line) => line.includes('1 of 4 open task is past their due date'))).toBe(true);
    expect(one.some((line) => line.includes('1 open task has nobody on them'))).toBe(true);

    const many = taskInsights(view({ totals: { ...view().totals, open: 9, overdue: 3, unassigned: 2 } }));
    expect(many.some((line) => line.includes('3 of 9 open tasks are past'))).toBe(true);
    expect(many.some((line) => line.includes('2 open tasks have nobody'))).toBe(true);
  });

  it('names somebody drowning, but not somebody with two tasks', () => {
    const drowning = taskInsights(
      view({
        totals: { ...view().totals, open: 10 },
        assignees: [{ assigneeId: 'a', assigneeName: 'Meera Iyer', openCount: MIN_OPEN_FOR_LOAD_INSIGHT, overdueCount: MIN_OPEN_FOR_LOAD_INSIGHT }],
      }),
    );
    expect(drowning.some((line) => line.includes('Meera Iyer has'))).toBe(true);

    // Two tasks, both late, is not a workload problem — it is two tasks.
    const trivial = taskInsights(
      view({
        totals: { ...view().totals, open: 10 },
        assignees: [{ assigneeId: 'a', assigneeName: 'Ravi Kumar', openCount: 2, overdueCount: 2 }],
      }),
    );
    expect(trivial.some((line) => line.includes('Ravi Kumar has'))).toBe(false);
  });

  it('says which way the backlog moved, including when it held steady', () => {
    const grew = taskInsights(view({ totals: { ...view().totals, open: 5 }, flow: [{ weekStart: '2026-08-17', raised: 9, closed: 2 }] }));
    expect(grew.some((line) => line.includes('the backlog grew'))).toBe(true);

    const shrank = taskInsights(view({ totals: { ...view().totals, open: 5 }, flow: [{ weekStart: '2026-08-17', raised: 2, closed: 9 }] }));
    expect(shrank.some((line) => line.includes('the backlog shrank'))).toBe(true);

    const steady = taskInsights(view({ totals: { ...view().totals, open: 5 }, flow: [{ weekStart: '2026-08-17', raised: 4, closed: 4 }] }));
    expect(steady.some((line) => line.includes('held steady'))).toBe(true);
  });

  it('says nothing about flow when the period is empty', () => {
    const insights = taskInsights(view({ totals: { ...view().totals, open: 3 }, flow: [{ weekStart: '2026-08-17', raised: 0, closed: 0 }] }));
    expect(insights.some((line) => line.includes('backlog'))).toBe(false);
  });
});
