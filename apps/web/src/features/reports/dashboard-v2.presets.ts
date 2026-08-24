import { endOfMonth, endOfQuarter, startOfMonth, startOfQuarter, subDays, subMonths } from 'date-fns';

import type { RangePreset } from '@/features/attendance/pickers';

/**
 * The named windows the reports dashboard offers above its calendar.
 *
 * A dashboard is read at a few fixed cadences -- the month just gone, the
 * quarter, the year to date -- and typing two dates to get one of them is work
 * nobody should have to do twice a day.
 *
 * The financial year runs April to March (REQ-L-01), so "This FY" is not the
 * calendar year and must not be derived from one.
 */
function financialYearStart(on: Date): Date {
  const year = on.getMonth() >= 3 ? on.getFullYear() : on.getFullYear() - 1;
  return new Date(year, 3, 1);
}

export const DASHBOARD_PRESETS: readonly RangePreset[] = [
  { label: 'Today', range: () => ({ from: new Date(), to: new Date() }) },
  { label: 'Last 7 days', range: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: 'Last 30 days', range: () => ({ from: subDays(new Date(), 29), to: new Date() }) },
  { label: 'Last 90 days', range: () => ({ from: subDays(new Date(), 89), to: new Date() }) },
  { label: 'This month', range: () => ({ from: startOfMonth(new Date()), to: new Date() }) },
  {
    label: 'Last month',
    range: () => {
      const previous = subMonths(new Date(), 1);
      return { from: startOfMonth(previous), to: endOfMonth(previous) };
    },
  },
  { label: 'This quarter', range: () => ({ from: startOfQuarter(new Date()), to: new Date() }) },
  {
    label: 'Last quarter',
    range: () => {
      const previous = subMonths(new Date(), 3);
      return { from: startOfQuarter(previous), to: endOfQuarter(previous) };
    },
  },
  { label: 'This FY', range: () => ({ from: financialYearStart(new Date()), to: new Date() }) },
  { label: 'Last 12 months', range: () => ({ from: startOfMonth(subMonths(new Date(), 11)), to: new Date() }) },
];

/** What the dashboard opens on: a year is the window most of these reports are read over. */
export function defaultRange(): { from: Date; to: Date } {
  return { from: startOfMonth(subMonths(new Date(), 11)), to: new Date() };
}

/** The API takes date-only strings; `toISOString` would shift the day west of Greenwich. */
export function asApiDate(value: Date): string {
  return value.toLocaleDateString('en-CA');
}
