import { z } from 'zod';

/**
 * Workspace-wide policy the owner asked for beside the colour picker
 * (22 Aug 2026): how figures are written, how long a sign-in lasts, and
 * how long what the system keeps is kept. Each is an organisation setting;
 * the first rides with the branding read so every client formats alike.
 */

export const NUMBER_FORMATS = ['indian', 'international'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];
export const NUMBER_FORMAT_LABELS: Record<NumberFormat, string> = {
  indian: '12,34,567.00 (lakh and crore)',
  international: '1,234,567.00',
};

export const CURRENCY_SYMBOLS = ['₹', 'INR', 'Rs'] as const;
export type CurrencySymbol = (typeof CURRENCY_SYMBOLS)[number];

/**
 * The date formats the clients can actually render -- not a free date-fns
 * pattern: `DD-MM-YYYY`, the Moment spelling, reads as day-of-year and era,
 * and nothing would report the mangling. The API DTO and the web contract
 * each kept a hand-synced copy and the two drifted a comment apart; the set
 * lives here once.
 */
export const DATE_FORMATS = ['dd-MM-yyyy', 'dd/MM/yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy', 'dd MMM yyyy'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const localeSchema = z.object({
  numberFormat: z.enum(NUMBER_FORMATS),
  currencySymbol: z.enum(CURRENCY_SYMBOLS),
});
export type WorkspaceLocale = z.infer<typeof localeSchema>;
export const DEFAULT_LOCALE: WorkspaceLocale = { numberFormat: 'indian', currencySymbol: '₹' };

/** Digits only, already split from the sign and the fraction. */
export function groupDigits(whole: string, format: NumberFormat): string {
  if (whole.length <= 3) return whole;
  if (format === 'international') return whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/gu, ',')},${last3}`;
}

/** Thirty days, the refresh window the product shipped with; one hour to ninety days. */
export const DEFAULT_SESSION_HOURS = 720;
export const SESSION_HOURS_MIN = 1;
export const SESSION_HOURS_MAX = 90 * 24;

/**
 * The audit trail is deliberately not here. It is append-only at the
 * database (the vyuha_forbid_mutation trigger refuses UPDATE and DELETE on
 * audit_logs), which is the product's tamper-evidence guarantee; a retention
 * that deleted from it would need that guarantee loosened, which is a
 * decision for the owner and counsel, not a setting (OPEN-QUESTIONS).
 */
export const retentionSchema = z.object({
  /** How long a download stays in the tray. */
  exportsDays: z.number().int().min(1).max(365),
});
export type RetentionPolicy = z.infer<typeof retentionSchema>;
export const DEFAULT_RETENTION: RetentionPolicy = { exportsDays: 7 };
