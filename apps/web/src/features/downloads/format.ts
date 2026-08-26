import { format, parseISO } from 'date-fns';

import { EMPTY_VALUE, formatDate } from '@/lib/format';

/** The tray's timestamp: the org's date format, with the minute. */
export function formatTimestamp(value: string | null): string {
  if (value === null) return EMPTY_VALUE;
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return `${formatDate(format(parsed, 'yyyy-MM-dd'))} ${format(parsed, 'HH:mm')}`;
}

/** "in 6 days", "today", "expired" -- the tray's retention line. */
export function describeExpiry(expiresAt: string | null): string {
  if (expiresAt === null) return '';
  const parsed = parseISO(expiresAt);
  if (Number.isNaN(parsed.getTime())) return '';
  const days = Math.floor((parsed.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${String(days)} days`;
}
