import { endOfMonth, startOfMonth, subDays, subMonths } from 'date-fns';
import type { DateRange } from 'react-day-picker';

import type { RangePreset } from '@/features/attendance/pickers';

/**
 * The windows a report is read over. Business data moves daily, so the chips
 * are day-ranged (the reference's "Last 60 minutes" belongs to servers); the
 * financial year runs April to March (REQ-L-01), so "This FY" is not the
 * calendar year and must not be derived from one.
 */
export const INSIGHT_PRESETS: readonly RangePreset[] = [
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
  {
    label: 'This FY',
    range: () => {
      const now = new Date();
      const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      return { from: new Date(year, 3, 1), to: now };
    },
  },
];

export function toApiDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export function fromApiDate(value: string | null): Date | undefined {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** What a page opens on when the URL names no window. */
export function defaultRange(): { from: string; to: string } {
  return { from: toApiDate(subDays(new Date(), 29)), to: toApiDate(new Date()) };
}

/** URL params -> the range the API is asked for, falling back to the default. */
export function rangeFromParams(params: URLSearchParams): { from: string; to: string } {
  const from = params.get('from');
  const to = params.get('to');
  if (from !== null && to !== null && fromApiDate(from) && fromApiDate(to) && from <= to) {
    return { from, to };
  }
  return defaultRange();
}

export function rangeAsPickerValue(range: { from: string; to: string }): DateRange {
  return { from: fromApiDate(range.from), to: fromApiDate(range.to) };
}
