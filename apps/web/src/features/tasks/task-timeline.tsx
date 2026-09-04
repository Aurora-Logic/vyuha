import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { toDateParam } from '@/features/attendance/format';
import { cn } from '@/lib/utils';

import { PILL, PRIORITY_HUES } from './task-pills';
import { daysBetween, timelineBars, timelineMonths, timelineWindow } from './timeline-series';
import type { Task } from './types';

/**
 * REQ-V-16: what is running, and what overlaps.
 *
 * A bar per task from the day it was raised to the day it is due, which makes
 * two things visible that no list does: how long something has been waiting,
 * and how much lands in the same week. The board says what state a task is
 * in; this says when.
 *
 * Percentages rather than pixels, so the chart is the width of whatever it is
 * given and needs no measuring: at 360px it is a narrow chart, not a broken
 * one. The task titles sit above their bars rather than in a frozen left
 * column, because a 120px name column on a phone leaves nothing for the bar.
 */

/** Colour is by priority, matching every other task surface. */
const BAR_HUES = {
  HIGH: 'bg-destructive/70',
  MEDIUM: 'bg-warning/70',
  LOW: 'bg-info/70',
} as const;

export function TaskTimeline({
  tasks,
  onOpen,
  /** Injected so the "today" marker is the caller's, and a test's is fixed. */
  today = toDateParam(new Date()),
}: {
  readonly tasks: readonly Task[];
  readonly onOpen: (task: Task) => void;
  readonly today?: string;
}) {
  const window = useMemo(() => timelineWindow(tasks, today), [tasks, today]);
  const bars = useMemo(() => (window === null ? [] : timelineBars(tasks, window)), [tasks, window]);
  const months = useMemo(() => (window === null ? [] : timelineMonths(window)), [window]);
  const undatedCount = tasks.filter((task) => task.dueDate === null).length;

  if (window === null) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing here has a due date, so there is no span to draw.
      </p>
    );
  }

  const pct = (days: number) => (days / window.days) * 100;
  const todayOffset = daysBetween(window.start, today);
  const todayInside = todayOffset >= 0 && todayOffset <= window.days;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex flex-col gap-2 border p-3">
        {/* The month axis, and a line for today. Absolute inside the same
            relative box as the bars so the line runs the full height. */}
        <div className="text-muted-foreground relative h-4 text-[0.625rem]">
          {months.map((month) => (
            <span
              key={month.label}
              className="absolute top-0 whitespace-nowrap"
              style={{ left: `${String(pct(month.offsetDays))}%` }}
            >
              {month.label}
            </span>
          ))}
        </div>

        <div className="relative flex flex-col gap-2">
          {todayInside ? (
            <span
              aria-hidden
              className="bg-foreground/30 pointer-events-none absolute inset-y-0 w-px"
              style={{ left: `${String(pct(todayOffset))}%` }}
            />
          ) : null}

          {bars.map(({ task, offsetDays, lengthDays }) => (
            <Button
              key={task.id}
              variant="ghost"
              className="h-auto w-full flex-col items-stretch justify-start gap-1 rounded-none p-1 text-left font-normal"
              onClick={() => {
                onOpen(task);
              }}
              // The bar is thin and the title is above it, so the accessible
              // name has to carry the dates the eye reads off the chart.
              aria-label={`${task.title}, due ${task.dueDate ?? 'no date'}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={cn('min-w-0 truncate text-xs', task.isClosed && 'text-muted-foreground line-through')}>
                  {task.title}
                </span>
                <span className={cn(PILL, PRIORITY_HUES[task.priority], 'shrink-0')}>
                  {task.priority.charAt(0) + task.priority.slice(1).toLowerCase()}
                </span>
              </span>
              <span className="bg-muted relative h-2 w-full">
                <span
                  className={cn(
                    'absolute inset-y-0 rounded-none',
                    task.isClosed ? 'bg-success/60' : BAR_HUES[task.priority],
                  )}
                  style={{
                    left: `${String(pct(offsetDays))}%`,
                    // Never thinner than a hairline: a one-day task on a
                    // six-month window rounds to nothing otherwise.
                    width: `max(2px, ${String(pct(lengthDays))}%)`,
                  }}
                />
              </span>
            </Button>
          ))}
        </div>
      </div>

      {undatedCount > 0 ? (
        <p className="text-muted-foreground text-xs">
          {undatedCount === 1
            ? '1 task has no due date and is not on this chart.'
            : `${String(undatedCount)} tasks have no due date and are not on this chart.`}
        </p>
      ) : null}
    </div>
  );
}
