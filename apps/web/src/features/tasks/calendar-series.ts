import type { Task } from './types';

/**
 * The task calendar's arithmetic, as pure functions.
 *
 * The question the calendar answers: *what is landing on me this month, and
 * which day is already full?* Everything here is about grouping tasks onto
 * days; nothing fetches and nothing renders.
 */

export interface DayLoad {
  /** Open tasks due that day. */
  readonly open: number;
  /** Of those, past their due date. Always a subset of `open`. */
  readonly overdue: number;
  /** Closed tasks due that day, counted separately: they are not a load. */
  readonly closed: number;
  /** Titles for the tooltip, in the order the day will list them. */
  readonly titles: readonly string[];
}

/**
 * Tasks grouped by the day they are due, keyed by the `yyyy-MM-dd` the API
 * already speaks. A task with no due date belongs to no day and is dropped —
 * `undated` below is how those are reached.
 */
export function tasksByDueDate(tasks: readonly Task[]): Map<string, Task[]> {
  const byDate = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.dueDate === null) continue;
    // The API sends a date-only string; anything with a time on it is keyed by
    // its day so a task never lands on no day at all.
    const day = task.dueDate.slice(0, 10);
    const existing = byDate.get(day);
    if (existing === undefined) byDate.set(day, [task]);
    else existing.push(task);
  }
  return byDate;
}

/**
 * What each day carries, for the grid.
 *
 * `today` decides overdue rather than the clock, so the caller controls the
 * boundary and the test does not depend on when it runs.
 */
export function dayLoads(tasks: readonly Task[], today: string): Map<string, DayLoad> {
  const loads = new Map<string, DayLoad>();
  for (const [day, group] of tasksByDueDate(tasks)) {
    const open = group.filter((task) => !task.isClosed);
    loads.set(day, {
      open: open.length,
      // Due strictly before today. A task due today is not late yet, which is
      // the distinction the whole screen turns on.
      overdue: day < today ? open.length : 0,
      closed: group.length - open.length,
      titles: group.map((task) => task.title),
    });
  }
  return loads;
}

/** Tasks with no due date, which a calendar cannot place and must not hide. */
export function undated(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.dueDate === null);
}
