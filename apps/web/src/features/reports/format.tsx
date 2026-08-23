import { format, parseISO } from 'date-fns';

import { Badge } from '@/components/ui/badge';
import { EMPTY_VALUE, formatDate, formatMoney, humaniseEnum } from '@/lib/format';
import type { ReportCellValue, ReportColumnType } from '@vyuha/shared';

/**
 * How a report cell is written on screen.
 *
 * The value itself comes from the same extractor the exporter uses
 * (`attendanceRegisterCell` / `punchAuditCell` in `@vyuha/shared`), so the
 * screen and the file cannot disagree about *what* is in a column. They render
 * it differently on purpose -- a table says `8h 12m` and a spreadsheet says
 * `08:12` -- and that difference lives here, in one switch, rather than being
 * decided per column by whoever added it.
 */

/** Minutes as `8h 12m`. Zero is a dash: a weekly off did not work zero hours. */
export function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return EMPTY_VALUE;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${String(rest)}m`;
  if (rest === 0) return `${String(hours)}h`;
  return `${String(hours)}h ${String(rest)}m`;
}

/**
 * An ISO instant on the reader's clock.
 *
 * The browser's timezone, not the organisation's: the exported file states the
 * organisation timezone in its header because it will be read elsewhere, but a
 * reader looking at a screen is standing where they are standing. NFR-05 puts
 * the org timezone on the file; matching it here would print a time that
 * disagrees with the clock in the corner of the same screen.
 */
function formatInstant(value: string, withSeconds: boolean): string {
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return format(parsed, withSeconds ? 'HH:mm:ss' : 'HH:mm');
}

export function isNumericColumn(type: ReportColumnType): boolean {
  return type === 'duration' || type === 'number' || type === 'time' || type === 'instant' || type === 'money';
}

export function renderCell(value: ReportCellValue, type: ReportColumnType): React.ReactNode {
  if (value === null || value === undefined) return EMPTY_VALUE;

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  // `Array.isArray` on a `readonly string[]` narrows to `any[]`, which would
  // make every element below untyped. Checked as an object first so the array
  // keeps the element type the contract gave it.
  if (typeof value === 'object') {
    const flags: readonly string[] = value;
    if (flags.length === 0) return EMPTY_VALUE;
    return (
      <span className="flex flex-wrap gap-1">
        {flags.map((flag) => (
          <Badge key={flag} variant="outline" className="font-normal">
            {humaniseEnum(flag)}
          </Badge>
        ))}
      </span>
    );
  }

  if (typeof value === 'number') {
    return type === 'duration' ? formatDurationMinutes(value) : String(value);
  }

  const text = String(value);
  if (text.length === 0) return EMPTY_VALUE;

  switch (type) {
    case 'date':
      return formatDate(text);
    case 'time':
      return formatInstant(text, false);
    case 'instant':
      return formatInstant(text, true);
    case 'status':
      return <Badge variant="secondary">{humaniseEnum(text)}</Badge>;
    case 'code':
      return <span className="tabular-nums">{text}</span>;
    case 'money':
      // The held amount, grouped Indian-style with the symbol -- 15,87,620.00
      // reads as money, 1587620.00 reads as a typo. The export keeps the raw
      // number so a spreadsheet can sum it.
      return <span className="tabular-nums">{formatMoney(text)}</span>;
    default:
      return text;
  }
}

/** `2026-08-13T09:30:00Z` as `13-08-2026 15:00`, for a tray row. */
export function formatTimestamp(value: string | null): string {
  if (value === null) return EMPTY_VALUE;
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return `${formatDate(format(parsed, 'yyyy-MM-dd'))} ${format(parsed, 'HH:mm')}`;
}

/** "in 6 days", "today", "expired" -- the tray's retention line (REQ-J-03). */
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
