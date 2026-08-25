import { format, formatDistanceToNow, parseISO } from 'date-fns';

import { DEFAULT_LOCALE, groupDigits, type WorkspaceLocale } from '@vyuha/shared';

/**
 * How dates are written on screen.
 *
 * REQ-L-01 makes dd-MM-yyyy the organisation default; the stored setting
 * overrides it through `setWorkspaceDateFormat` below. Putting it here rather
 * than inlining the pattern means the change is
 * one edit, and — more usefully — it means no screen can render a raw
 * `2026-04-01` by forgetting to format at all, because there is an obvious
 * thing to call instead.
 */
export const DATE_FORMAT = 'dd-MM-yyyy';

/** What a column shows when a nullable date is not set. Not the empty string:
 *  a blank cell reads as a rendering failure, an em dash reads as "none". */
export const EMPTY_VALUE = '—';

/**
 * The workspace's number format and currency symbol, set once by the shell
 * from the branding read (appearance-effect.tsx) and read by every
 * formatter below. A module-level value rather than context, because the
 * formatters are called from table cells, chart labels and toasts, none of
 * which should need a hook to write a number.
 */
let locale: WorkspaceLocale = DEFAULT_LOCALE;

export function setWorkspaceLocale(next: WorkspaceLocale): void {
  locale = next;
}

/**
 * The workspace's date pattern, delivered the same way. The setting existed
 * -- stored, validated and audited since REQ-L-01 -- but nothing on screen
 * ever read it back, so every date rendered as the default no matter what
 * Settings said. Delivery rides the branding payload because that is the one
 * read every signed-in client already mounts.
 */
let workspaceDateFormat = DATE_FORMAT;

export function setWorkspaceDateFormat(next: string): void {
  workspaceDateFormat = next;
}

export function currencySymbol(): string {
  return locale.currencySymbol;
}

/**
 * A decimal string as the API sends it, grouped the way the workspace writes
 * figures; two decimals.
 *
 * The third decimal is rounded, not chopped. It used to be sliced off, so
 * every figure the API sends with more than two decimals -- and the
 * projection keeps three on purpose (D-01), so quantities, rates and any
 * derived amount do -- was shown a paisa short: 1234.567 read as 1234.56, and
 * a column of them drifted further the longer it got.
 *
 * Scaled to paise once with BigInt rather than through a float: `Number` on a
 * long rupee figure is not exact, and this runs on totals. Only the fraction
 * needs the big arithmetic, so the carry is a single add.
 */
export function formatAmount(value: string | null): string {
  if (value === null) return EMPTY_VALUE;
  const negative = value.startsWith('-');
  const magnitude = value.replace(/^-/u, '');
  const [whole = '0', fraction] = magnitude.split('.');
  let rupees = whole === '' ? '0' : whole;
  let decimals = '00';
  if (fraction !== undefined && fraction !== '') {
    // Half-up on the third decimal, carried into the rupees when it overflows.
    const paise = BigInt(fraction.padEnd(3, '0').slice(0, 3));
    const rounded = (paise + 5n) / 10n;
    if (rounded >= 100n) {
      rupees = (BigInt(rupees) + 1n).toString();
      decimals = '00';
    } else {
      decimals = rounded.toString().padStart(2, '0');
    }
  }
  return `${negative ? '−' : ''}${groupDigits(rupees, locale.numberFormat)}.${decimals}`;
}

/**
 * A figure that is money, with the workspace's currency symbol in front of it.
 *
 * Separate from `formatAmount` because not every grouped decimal is money -- a
 * quantity, a rate percentage and a day count all go through the same grouping
 * and none of them wants a rupee sign. Anything the reader should understand as
 * an amount of money calls this one, so the symbol is never a string a screen
 * pastes in front of a number itself.
 */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY_VALUE;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(2) : null) : value;
  if (text === null) return EMPTY_VALUE;
  const amount = formatAmount(text);
  if (amount === EMPTY_VALUE) return EMPTY_VALUE;
  // The minus goes outside the symbol -- "−₹1,200.00" is what a ledger writes,
  // not "₹−1,200.00".
  return amount.startsWith('−')
    ? `−${locale.currencySymbol}${amount.slice(1)}`
    : `${locale.currencySymbol}${amount}`;
}

/**
 * Money short enough for a bar cap or an axis tick: the Indian short scale,
 * with the symbol. A chart label has no room for "₹9,33,103.00".
 */
export function formatMoneyShort(value: number): string {
  if (!Number.isFinite(value)) return EMPTY_VALUE;
  const n = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const trim = (v: number): string => v.toFixed(1).replace(/\.0$/u, '');
  const symbol = locale.currencySymbol;
  if (n >= 10_000_000) return `${sign}${symbol}${trim(n / 10_000_000)}Cr`;
  if (n >= 100_000) return `${sign}${symbol}${trim(n / 100_000)}L`;
  if (n >= 1_000) return `${sign}${symbol}${trim(n / 1_000)}k`;
  return `${sign}${symbol}${groupDigits(String(Math.round(n)), locale.numberFormat)}`;
}

/** A whole number for a headline: grouped, no decimals. */
export function formatCount(value: number): string {
  const rounded = Math.round(Math.abs(value));
  return `${value < 0 ? '−' : ''}${groupDigits(String(rounded), locale.numberFormat)}`;
}

/**
 * Formats an API date.
 *
 * The input is a date-only `YYYY-MM-DD` string (NFR-05: a joining date is not
 * an instant), so it is parsed with `parseISO`, which reads a date-only string
 * as local midnight. `new Date(value)` would read the same string as UTC
 * midnight and print the previous day for every user west of Greenwich — a
 * silent off-by-one that only shows up in some timezones.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const parsed = parseISO(value);
  // A malformed date from the API is a data problem, not a reason to render
  // "Invalid Date" into a table cell.
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return format(parsed, workspaceDateFormat);
}

/** `ON_NOTICE` -> `On notice`. Sentence case, per PRD §6.6. */
export function humaniseEnum(value: string): string {
  const words = value.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}


/**
 * "3 minutes ago", or the empty-value dash for an unparseable instant. One
 * owner for relative ages, so Integrations and Parties cannot drift apart on
 * how the same timestamp reads.
 */
export function formatRelativeAge(iso: string): string {
  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return EMPTY_VALUE;
  return `${formatDistanceToNow(parsed)} ago`;
}
