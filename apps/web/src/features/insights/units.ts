import type { MetricUnit } from '@vyuha/shared';

import { formatDuration } from '@/features/attendance/format';
import { EMPTY_VALUE, formatCount, formatMoney, formatMoneyShort } from '@/lib/format';

/**
 * One place a metric's unit turns into text, so a headline, an axis tick and
 * a breakdown cell can never disagree about what 90 minutes looks like.
 * Durations ride the attendance module's own formatter, where zero is the em
 * dash -- "no overtime" is a fact, not a calculation that produced nothing.
 */

/** The big figure at the top of a card. Money keeps its exact text form. */
export function formatHeadline(unit: MetricUnit, headline: string): string {
  if (headline === '') return EMPTY_VALUE;
  switch (unit) {
    case 'money':
      return formatMoney(headline);
    case 'minutes':
      return formatDuration(Number(headline));
    case 'percent':
      return `${headline}%`;
    case 'count':
      return formatCount(Number(headline));
  }
}

/** An axis tick or an in-chart label: the short scale, never a paragraph. */
export function formatTick(unit: MetricUnit, value: number): string {
  switch (unit) {
    case 'money':
      return formatMoneyShort(value);
    case 'minutes':
      return formatDuration(value);
    case 'percent':
      return `${String(value)}%`;
    case 'count':
      return formatCount(value);
  }
}

/** A breakdown cell, by its column's declared unit. */
export function formatCell(unit: MetricUnit | undefined, value: string | number): string {
  if (unit === 'money') return formatMoney(typeof value === 'number' ? value : String(value));
  if (unit === 'minutes') return formatDuration(Number(value));
  if (typeof value === 'number') return formatCount(value);
  return value === '' ? EMPTY_VALUE : value;
}
