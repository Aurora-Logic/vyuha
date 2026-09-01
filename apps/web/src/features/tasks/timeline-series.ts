import type { Task } from './types';

/**
 * The timeline's arithmetic, as pure functions.
 *
 * The question it answers: *what is running between now and then, and what
 * overlaps?* A task here has two dates — the day it was raised and the day it
 * is due — and the bar between them is how long it has been waiting.
 *
 * A task with no due date has no length and cannot be drawn; a task due before
 * it was raised is somebody's typo, and is drawn as a single day rather than a
 * bar running backwards.
 */

export interface TimelineBar {
  readonly task: Task;
  /** Days from the window start, 0-based. Never negative: the window clips. */
  readonly offsetDays: number;
  /** At least 1, so a same-day task is still a visible mark. */
  readonly lengthDays: number;
}

export interface TimelineWindow {
  readonly start: string;
  readonly end: string;
  readonly days: number;
}

const MS_PER_DAY = 86_400_000;

/** Whole days between two `yyyy-MM-dd` strings, positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

/** `yyyy-MM-dd`, `n` days after the given one. */
export function addDays(day: string, n: number): string {
  const at = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(at)) return day;
  return new Date(at + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The span the bars are drawn across: the earliest start to the latest due,
 * with today always inside it so "now" is never off the edge of its own chart.
 */
export function timelineWindow(tasks: readonly Task[], today: string): TimelineWindow | null {
  const dated = tasks.filter((task) => task.dueDate !== null);
  if (dated.length === 0) return null;

  let start = today;
  let end = today;
  for (const task of dated) {
    const raised = task.createdAt.slice(0, 10);
    const due = (task.dueDate ?? today).slice(0, 10);
    if (raised < start) start = raised;
    if (due < start) start = due;
    if (due > end) end = due;
    if (raised > end) end = raised;
  }
  return { start, end, days: Math.max(1, daysBetween(start, end) + 1) };
}

export function timelineBars(tasks: readonly Task[], window: TimelineWindow): TimelineBar[] {
  return tasks
    .filter((task): task is Task & { dueDate: string } => task.dueDate !== null)
    .map((task) => {
      const raised = task.createdAt.slice(0, 10);
      const due = task.dueDate.slice(0, 10);
      // Raised after it is due is a typo, not a negative-length task: it is
      // drawn as the single day it is due on.
      const from = raised <= due ? raised : due;
      const offsetDays = Math.max(0, daysBetween(window.start, from));
      return {
        task,
        offsetDays,
        lengthDays: Math.max(1, daysBetween(from, due) + 1),
      };
    })
    .sort((a, b) => {
      // By where the bar starts, then by the title, so the chart is stable
      // between renders and reads top-left to bottom-right.
      if (a.offsetDays !== b.offsetDays) return a.offsetDays - b.offsetDays;
      return a.task.title.localeCompare(b.task.title);
    });
}

/** Month labels across the window, for the axis. */
export function timelineMonths(window: TimelineWindow): { label: string; offsetDays: number }[] {
  const months: { label: string; offsetDays: number }[] = [];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let cursor = `${window.start.slice(0, 7)}-01`;
  // Guarded rather than while(true): a bad window must not spin the tab.
  for (let guard = 0; guard < 120; guard += 1) {
    if (cursor > window.end) break;
    const offsetDays = daysBetween(window.start, cursor);
    const month = MONTHS[Number(cursor.slice(5, 7)) - 1] ?? '';
    months.push({ label: `${month} ${cursor.slice(2, 4)}`, offsetDays: Math.max(0, offsetDays) });
    const year = Number(cursor.slice(0, 4));
    const next = Number(cursor.slice(5, 7)) + 1;
    cursor = next > 12 ? `${String(year + 1)}-01-01` : `${String(year)}-${String(next).padStart(2, '0')}-01`;
  }
  return months;
}
