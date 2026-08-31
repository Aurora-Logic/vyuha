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
    case 'money': {
      const text = headline.startsWith('-') ? headline.slice(1) : headline;
      return formatMoney(text);
    }
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
      return formatMoneyShort(Math.abs(value));
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
  if (unit === 'money') {
    const text = typeof value === 'number' ? (Number.isFinite(value) ? Math.abs(value).toFixed(2) : '') : value;
    const absText = text.startsWith('-') ? text.slice(1) : text;
    return formatMoney(absText);
  }
  if (unit === 'minutes') return formatDuration(Number(value));
  if (typeof value === 'number') return formatCount(value);
  return value === '' ? EMPTY_VALUE : value;
}
