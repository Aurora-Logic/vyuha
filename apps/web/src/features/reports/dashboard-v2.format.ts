/**
 * The two formatters the v2 dashboard's axes and labels need.
 *
 * Separate from the screen because a chart cannot be rendered in jsdom -- the
 * only way to prove an axis says "Jul" rather than "202" is to call the
 * function that produces it.
 */

/** Indian short scale, so a rupee figure fits on a bar cap rather than past it. */
export function short(value: number): string {
  const n = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const trim = (v: number): string => v.toFixed(1).replace(/\.0$/u, '');
  if (n >= 10_000_000) return `${sign}${trim(n / 10_000_000)}Cr`;
  if (n >= 100_000) return `${sign}${trim(n / 100_000)}L`;
  if (n >= 1_000) return `${sign}${trim(n / 1_000)}k`;
  return `${sign}${String(Math.round(n))}`;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * "2026-07" to "Jul", and January to "Jan 26" so a twelve-month axis says
 * where the year turns over. Anything that is not a month key is returned
 * unchanged rather than sliced into nonsense.
 */
export function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(key);
  if (match === null) return key;
  const [, year, month] = match;
  const name = MONTH_NAMES[Number(month) - 1];
  if (name === undefined) return key;
  return month === '01' ? `${name} ${year.slice(2)}` : name;
}
