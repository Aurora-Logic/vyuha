import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';

import type { AttendanceDay, AttendanceStatus } from '@/features/attendance/types';

/**
 * Attendance day rows, turned into the arrays the charts plot (REQ-K-01).
 *
 * All of it is here rather than in the components for the reason CLAUDE.md §6
 * gives: a component renders, it does not decide what a number means. Deciding
 * that a HALF_DAY counts as someone who came to work, or that a day the server
 * returned no row for is a zero rather than a gap, is domain logic, and domain
 * logic that lives in a chart is domain logic nothing can test.
 *
 * Two rules everything below keeps:
 *
 * 1. A date the caller asked for always produces a point, even when no row
 *    came back for it. Recharts will happily skip a missing date and silently
 *    compress the axis, which turns "nobody was recorded on the 14th" into
 *    "the 14th did not happen".
 * 2. A row for a date the caller did not ask for is dropped rather than
 *    appended. The range is the question; a row outside it is a server or
 *    clock problem and must not become a phantom column at the end of a chart.
 */

/**
 * The four bands the trend stacks, and why eight statuses collapse into them.
 *
 * A stacked bar can carry about four series before the eye gives up, and the
 * palette has to survive colour blindness — measured, not guessed: the four
 * below clear ΔE 12.3 under deuteranopia in light mode at the order they are
 * stacked, where the theme's eight status tones do not (red beside amber
 * measures 5.6, which is a fail).
 *
 * `other` is the honest name for what is left. A holiday and a day the engine
 * has not finalised are both "not a working day anybody missed", and folding
 * them into `absent` would report a public holiday as mass absenteeism.
 */
export type StatusGroup = 'work' | 'leave' | 'absent' | 'other';

const STATUS_GROUP: Record<AttendanceStatus, StatusGroup> = {
  PRESENT: 'work',
  HALF_DAY: 'work',
  ON_DUTY: 'work',
  ON_LEAVE: 'leave',
  ABSENT: 'absent',
  PENDING: 'other',
  HOLIDAY: 'other',
  WEEKLY_OFF: 'other',
};

export function statusGroup(status: AttendanceStatus): StatusGroup {
  return STATUS_GROUP[status];
}

/** A year of daily points is already more than a chart can show; refuse more. */
const MAX_RANGE_DAYS = 366;

/**
 * Every date from `from` to `to` inclusive, as `YYYY-MM-DD`.
 *
 * Returns `[]` rather than throwing for a reversed or unparseable range: this
 * feeds a chart, and the empty state is a better answer than a crash inside a
 * renderer.
 */
export function dateRange(from: string, to: string): string[] {
  const start = parseISO(from);
  const end = parseISO(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const span = differenceInCalendarDays(end, start);
  if (span < 0) return [];
  const count = Math.min(span, MAX_RANGE_DAYS - 1);
  return Array.from({ length: count + 1 }, (_, index) => format(addDays(start, index), 'yyyy-MM-dd'));
}

export interface TrendPoint {
  date: string;
  work: number;
  leave: number;
  absent: number;
  other: number;
}

/** One stacked column per date: how many people were in each band that day. */
export function attendanceTrend(days: readonly AttendanceDay[], dates: readonly string[]): TrendPoint[] {
  const points: TrendPoint[] = dates.map((date) => ({
    date,
    work: 0,
    leave: 0,
    absent: 0,
    other: 0,
  }));
  const index = new Map(points.map((point) => [point.date, point]));

  for (const day of days) {
    const point = index.get(day.date);
    if (!point) continue;
    point[STATUS_GROUP[day.status]] += 1;
  }

  return points;
}

export interface LatePoint {
  date: string;
  /** People who arrived late that day, not minutes: one late hour by one
   *  person and one late minute by sixty are not the same problem. */
  late: number;
  minutes: number;
}

export function lateArrivals(days: readonly AttendanceDay[], dates: readonly string[]): LatePoint[] {
  const points: LatePoint[] = dates.map((date) => ({ date, late: 0, minutes: 0 }));
  const index = new Map(points.map((point) => [point.date, point]));

  for (const day of days) {
    const point = index.get(day.date);
    // A negative lateMinutes would mean "early", which the contract has no
    // word for. Treating it as not-late beats plotting a bar below the axis.
    if (!point || day.lateMinutes <= 0) continue;
    point.late += 1;
    point.minutes += day.lateMinutes;
  }

  return points;
}

export interface HoursPoint {
  date: string;
  /** Hours to two places. The tooltip prints the minutes it came from. */
  hours: number;
  workedMinutes: number;
  otMinutes: number;
  lateMinutes: number;
  status: AttendanceStatus | null;
}

/**
 * One person's worked hours per day.
 *
 * Overtime is carried alongside rather than stacked on top. The contract does
 * not say whether `workedMinutes` already contains `otMinutes` (REQ-E-05 only
 * says overtime is a number), and a stacked bar would be asserting an answer:
 * if it does contain it, the stack double-counts. So the bar is worked minutes
 * and nothing else, and overtime is reported as its own figure in the tooltip.
 */
export function ownHours(days: readonly AttendanceDay[], dates: readonly string[]): HoursPoint[] {
  const points: HoursPoint[] = dates.map((date) => ({
    date,
    hours: 0,
    workedMinutes: 0,
    otMinutes: 0,
    lateMinutes: 0,
    status: null,
  }));
  const index = new Map(points.map((point) => [point.date, point]));

  for (const day of days) {
    const point = index.get(day.date);
    if (!point) continue;
    point.workedMinutes += Math.max(0, day.workedMinutes);
    point.otMinutes += Math.max(0, day.otMinutes);
    point.lateMinutes += Math.max(0, day.lateMinutes);
    point.status ??= day.status;
    point.hours = Math.round((point.workedMinutes / 60) * 100) / 100;
  }

  return points;
}

export interface TeamHoursPoint {
  date: string;
  /** Everyone's worked hours added up, to two places. */
  hours: number;
  /** How many people contributed any worked time that day. */
  people: number;
  /** Hours divided by the people who worked -- the figure that survives a
   *  headcount change, which the total does not. */
  averageHours: number;
  workedMinutes: number;
}

/**
 * The team's worked hours per day.
 *
 * The total and the average are both carried because they answer different
 * questions and one of them lies on its own: a total that halves when six
 * people are on leave is not a productivity story, and an average that holds
 * steady while three people carry the week is not a staffing one.
 *
 * Overtime is deliberately absent. The contract does not say whether
 * `workedMinutes` already contains `otMinutes`, so adding them would be
 * asserting an answer -- the same reason `ownHours` keeps them apart.
 */
export function teamHours(days: readonly AttendanceDay[], dates: readonly string[]): TeamHoursPoint[] {
  const points: TeamHoursPoint[] = dates.map((date) => ({
    date,
    hours: 0,
    people: 0,
    averageHours: 0,
    workedMinutes: 0,
  }));
  const index = new Map(points.map((point) => [point.date, point]));

  for (const day of days) {
    const point = index.get(day.date);
    if (!point) continue;
    const worked = Math.max(0, day.workedMinutes);
    if (worked === 0) continue;
    point.workedMinutes += worked;
    point.people += 1;
  }

  for (const point of points) {
    point.hours = Math.round((point.workedMinutes / 60) * 100) / 100;
    point.averageHours =
      point.people === 0 ? 0 : Math.round((point.workedMinutes / point.people / 60) * 100) / 100;
  }

  return points;
}

export interface Totals {
  present: number;
  halfDay: number;
  onDuty: number;
  absent: number;
  leave: number;
  pending: number;
  offDay: number;
  otMinutes: number;
  lateDays: number;
  flagged: number;
  rows: number;
}

export function summarise(days: readonly AttendanceDay[]): Totals {
  return days.reduce<Totals>(
    (totals, day) => ({
      present: totals.present + (day.status === 'PRESENT' ? 1 : 0),
      halfDay: totals.halfDay + (day.status === 'HALF_DAY' ? 1 : 0),
      onDuty: totals.onDuty + (day.status === 'ON_DUTY' ? 1 : 0),
      absent: totals.absent + (day.status === 'ABSENT' ? 1 : 0),
      leave: totals.leave + (day.status === 'ON_LEAVE' ? 1 : 0),
      pending: totals.pending + (day.status === 'PENDING' ? 1 : 0),
      offDay: totals.offDay + (day.status === 'HOLIDAY' || day.status === 'WEEKLY_OFF' ? 1 : 0),
      otMinutes: totals.otMinutes + Math.max(0, day.otMinutes),
      lateDays: totals.lateDays + (day.lateMinutes > 0 ? 1 : 0),
      flagged: totals.flagged + (day.flags.length > 0 ? 1 : 0),
      rows: totals.rows + 1,
    }),
    {
      present: 0,
      halfDay: 0,
      onDuty: 0,
      absent: 0,
      leave: 0,
      pending: 0,
      offDay: 0,
      otMinutes: 0,
      lateDays: 0,
      flagged: 0,
      rows: 0,
    },
  );
}

/** True when at least one point carries a value; the charts' empty test. */
export function hasValues<T>(points: readonly T[], keys: readonly (keyof T)[]): boolean {
  return points.some((point) => keys.some((key) => Number(point[key]) > 0));
}

/**
 * Which dates get a label on the axis.
 *
 * Recharts' own thinning takes a step count from the first category and lets
 * the last one fall wherever it lands, which on a thirty-day range labelled
 * every sixth day stops at the 8th and leaves the reader guessing where today
 * is. Choosing the ticks outright puts the first and last date on the axis
 * whatever the range, and is deterministic enough to test.
 */
export function axisTicks(dates: readonly string[], maxTicks: number): string[] {
  if (dates.length === 0) return [];
  if (maxTicks < 2) return dates.slice(0, 1);
  if (dates.length <= maxTicks) return [...dates];

  const step = (dates.length - 1) / (maxTicks - 1);
  const picked = new Set<string>();
  for (let index = 0; index < maxTicks; index += 1) {
    const date = dates[Math.round(index * step)];
    if (date !== undefined) picked.add(date);
  }
  return [...picked];
}

/**
 * A y axis for durations that lands on whole hours.
 *
 * Recharts picks its own ticks from the data, which for a month topping out at
 * nine hours produced an axis reading 0h, 3h, 7h, 10h - three uneven steps
 * that look like a rounding bug because they are one. Fixing the domain to a
 * multiple of the step puts every gridline on an hour a reader recognises.
 */
export function hourTicks(maxMinutes: number): { domainMax: number; ticks: number[] } {
  const step = maxMinutes > 720 ? 180 : 120;
  const domainMax = Math.max(step, Math.ceil(Math.max(0, maxMinutes) / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= domainMax; value += step) ticks.push(value);
  return { domainMax, ticks };
}

/** `2026-08-13` as `13 Aug`, for an axis with no room for a full date. */
export function shortDate(date: string): string {
  const parsed = parseISO(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return format(parsed, 'd MMM');
}

// -------------------------------------------------------------- insights

/** Below this share of the team at work, a day is worth naming. */
export const THIN_DAY_PCT = 70;
/** Fewer finished days than this and a period has no shape to read. */
export const DAYS_FOR_A_READING = 5;

/** The sentence under the attendance-by-day chart. */
export function attendanceInsight(points: readonly TrendPoint[]): string | null {
  const counted = points.filter((p) => p.work + p.leave + p.absent + p.other > 0);
  if (counted.length === 0) return null;
  if (counted.length < DAYS_FOR_A_READING) {
    return 'Not enough days recorded in this period to read a pattern.';
  }
  const thin = counted.filter((p) => {
    const due = p.work + p.leave + p.absent;
    return due > 0 && (p.work / due) * 100 < THIN_DAY_PCT;
  });
  return thin.length === 0
    ? `At least ${String(THIN_DAY_PCT)}% of those due in were at work on every one of these ${String(counted.length)} days.`
    : `${String(thin.length)} of ${String(counted.length)} days had under ${String(THIN_DAY_PCT)}% of those due in at work.`;
}

/** The sentence under the late-arrivals chart. */
export function lateInsight(points: readonly LatePoint[]): string | null {
  const total = points.reduce((sum, p) => sum + p.late, 0);
  if (points.length === 0) return null;
  if (total === 0) return 'Nobody arrived late in this period.';
  const worst = points.reduce((most, p) => (p.late > most.late ? p : most));
  const minutes = points.reduce((sum, p) => sum + p.minutes, 0);
  const average = Math.round(minutes / total);
  return `${String(total)} late arrivals, ${String(average)} minutes each on average; the worst day was ${shortDate(worst.date)}.`;
}

/** The sentence under the team's worked hours. */
export function teamHoursInsight(points: readonly TeamHoursPoint[]): string | null {
  const worked = points.filter((p) => p.people > 0);
  if (worked.length === 0) return null;
  const averaged = worked.reduce((sum, p) => sum + p.averageHours, 0) / worked.length;
  const busiest = worked.reduce((most, p) => (p.hours > most.hours ? p : most));
  return `The team averaged ${String(Math.round(averaged * 10) / 10)} hours a person on the ${String(worked.length)} days anyone worked; the longest was ${shortDate(busiest.date)}.`;
}
