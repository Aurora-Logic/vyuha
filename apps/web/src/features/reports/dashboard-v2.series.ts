import type { ReportRowView } from './types';

/**
 * Every series the second reports dashboard draws, and the sentence that goes
 * under each one.
 *
 * Pure functions over report rows, in their own module because a Recharts chart
 * cannot be rendered in jsdom -- the only way to prove a bar is the right height
 * or an insight says the right thing is to call the function that produces it.
 * Every threshold an insight turns on is named here and covered by a test.
 *
 * The first version of this dashboard built its series inline and shipped three
 * faults nobody could have caught: months ordered by size on a time axis, an
 * axis label that read "202", and a part-month compared against a whole one.
 */

export interface Point {
  readonly label: string;
  readonly value: number;
}

/** What a card shows when the period has too little in it to say anything. */
export interface Series<T> {
  readonly points: readonly T[];
  /** One sentence, or null when the data does not support one. */
  readonly insight: string | null;
}

const text = (row: ReportRowView, key: string): string => {
  const cell = row.cells[key];
  return typeof cell === 'string' ? cell : typeof cell === 'number' ? String(cell) : '';
};

const num = (row: ReportRowView, key: string): number => {
  const cell = row.cells[key];
  const parsed = typeof cell === 'number' ? cell : typeof cell === 'string' ? Number(cell) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

// ---------------------------------------------------------------- thresholds

/** Below this many finished months a direction is noise, not a trend. */
export const MONTHS_FOR_A_TREND = 3;
/** A month-on-month move smaller than this is not worth a sentence. */
export const MOVEMENT_WORTH_SAYING_PCT = 2;
/** One customer above this share of revenue is a concentration risk. */
export const CONCENTRATION_WORRY_PCT = 25;
/** Paying this many days past agreed terms is worth naming. */
export const SLIPPAGE_WORRY_DAYS = 15;
/** Below this fill rate an order book is not being served. */
export const FILL_RATE_WORRY_PCT = 85;
/** Stock sitting longer than this is the tail worth reporting. */
export const STOCK_STALE_DAYS = 90;

// ------------------------------------------------------------ 1. by month

export interface MonthlySeries extends Series<Point> {
  readonly total: number;
  readonly movementPct: number | null;
  readonly comparedFrom: string | null;
  readonly comparedTo: string | null;
}

/**
 * Invoiced value per calendar month.
 *
 * Sorted by key, never left in the order the API sent: every report carries its
 * own default sort and this one is "-value", which on a time axis draws the
 * months in order of size.
 */
export function monthlyInvoiced(rows: readonly ReportRowView[], thisMonth: string): MonthlySeries {
  const points = rows
    .map((row) => ({ label: text(row, 'label'), value: Math.abs(num(row, 'value')) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const total = sum(points.map((p) => p.value));

  // The month in progress is a part-month and would read as a collapse against
  // a whole one, so the comparison is between the last two that finished.
  const finished = points.filter((p) => p.label !== thisMonth);
  const last = finished.at(-1);
  const previous = finished.at(-2);
  const movementPct =
    last !== undefined && previous !== undefined && previous.value > 0
      ? Math.round(((last.value - previous.value) / previous.value) * 1000) / 10
      : null;

  let insight: string | null = null;
  if (finished.length < MONTHS_FOR_A_TREND) {
    insight = 'Not enough finished months in this period to read a direction.';
  } else if (movementPct !== null && Math.abs(movementPct) >= MOVEMENT_WORTH_SAYING_PCT) {
    insight = `${movementPct >= 0 ? 'Up' : 'Down'} ${String(Math.abs(movementPct))}% on the month before.`;
  } else if (movementPct !== null) {
    insight = 'Flat on the month before.';
  }

  return {
    points,
    total,
    movementPct,
    comparedFrom: previous?.label ?? null,
    comparedTo: last?.label ?? null,
    insight,
  };
}

// --------------------------------------------------------- 2. top customers

export interface TopCustomers extends Series<Point> {
  readonly tailValue: number;
  readonly tailCount: number;
  readonly total: number;
}

/** The top `keep` by value, with everyone else folded into a tail figure. */
export function topCustomers(rows: readonly ReportRowView[], keep = 5): TopCustomers {
  const all = rows
    .map((row) => ({ label: text(row, 'label'), value: Math.abs(num(row, 'value')) }))
    .sort((a, b) => b.value - a.value);
  const points = all.slice(0, keep);
  const rest = all.slice(keep);
  const total = sum(all.map((p) => p.value));
  const leader = points[0];

  const share = leader === undefined ? 0 : pct(leader.value, total);
  const insight =
    leader === undefined
      ? null
      : share >= CONCENTRATION_WORRY_PCT
        ? `${leader.label} alone is ${String(share)}% of the period — losing them would be felt.`
        : `${leader.label} leads at ${String(share)}% of the period.`;

  return { points, tailValue: sum(rest.map((p) => p.value)), tailCount: rest.length, total, insight };
}

// ------------------------------------------------------------- 3. ageing

export interface AgeingSlice {
  readonly bucket: string;
  readonly value: number;
  readonly fill: string;
}
export interface AgeingSeries extends Series<AgeingSlice> {
  readonly overdue: number;
  readonly total: number;
}

/**
 * The buckets the ageing report emits, in the order they should be read.
 *
 * `UNDATED` is one of them. Tally may send a bill with no date -- the API
 * keeps those deliberately rather than guessing an age -- and this list did
 * not have it, so `ageingByBucket` dropped them: the donut and the figure
 * beside it quietly showed less money outstanding than the table underneath
 * did, with nothing to say why. Last, because it is not an age; it is the
 * absence of one.
 */
export const AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+', 'UNDATED'] as const;

/** Outstanding by age of bill. Buckets are ordered, so the ramp is a ramp. */
export function ageingByBucket(rows: readonly ReportRowView[]): AgeingSeries {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const bucket = text(row, 'bucket');
    if (bucket === '') continue;
    totals.set(bucket, (totals.get(bucket) ?? 0) + num(row, 'outstanding'));
  }
  const points = AGE_BUCKETS.filter((b) => totals.has(b)).map((bucket, index) => ({
    bucket,
    value: totals.get(bucket) ?? 0,
    fill: `var(--chart-${String(index + 1)})`,
  }));
  const total = sum(points.map((p) => p.value));
  // Undated is not overdue: nothing is known about when it was due.
  const overdue = sum(points.filter((p) => p.bucket !== '0-30' && p.bucket !== 'UNDATED').map((p) => p.value));
  const share = pct(overdue, total);

  return {
    points,
    overdue,
    total,
    insight:
      points.length === 0
        ? null
        : share === 0
          ? 'Everything owed is inside thirty days.'
          : `${String(share)}% of what is owed is already past thirty days.`,
  };
}

// -------------------------------------------------------- 4. new vs repeat

export interface NewVsRepeatPoint {
  readonly label: string;
  readonly newRevenue: number;
  readonly repeatRevenue: number;
}

/** Where the month's money came from: someone new, or someone who came back. */
export function newVsRepeat(rows: readonly ReportRowView[]): Series<NewVsRepeatPoint> {
  const points = rows
    .map((row) => ({
      label: text(row, 'month'),
      newRevenue: num(row, 'newRevenue'),
      repeatRevenue: num(row, 'repeatRevenue'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const fresh = sum(points.map((p) => p.newRevenue));
  const repeat = sum(points.map((p) => p.repeatRevenue));
  const share = pct(fresh, fresh + repeat);

  return {
    points,
    insight:
      points.length === 0
        ? null
        : `${String(share)}% of the period's revenue came from customers billed for the first time.`,
  };
}

// ------------------------------------------------------------- 5. AOV trend

/** Average invoice value per month — is the basket growing or splitting? */
export function averageOrderValue(rows: readonly ReportRowView[]): Series<Point> {
  const points = rows
    .map((row) => ({ label: text(row, 'month'), value: num(row, 'aov') }))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (points.length < MONTHS_FOR_A_TREND) {
    return { points, insight: 'Not enough months here to read the basket.' };
  }
  const first = points[0]?.value ?? 0;
  const last = points.at(-1)?.value ?? 0;
  const move = first === 0 ? null : Math.round(((last - first) / first) * 1000) / 10;

  return {
    points,
    insight:
      move === null
        ? null
        : `The average invoice is ${move >= 0 ? 'up' : 'down'} ${String(Math.abs(move))}% across the period.`,
  };
}

// --------------------------------------------------------- 6. concentration

export interface ConcentrationPoint extends Point {
  readonly cumulative: number;
}

/** How few customers make up the book. */
export function concentration(rows: readonly ReportRowView[]): Series<ConcentrationPoint> {
  const points = rows
    .map((row) => ({
      label: text(row, 'partyName'),
      value: num(row, 'sharePct'),
      cumulative: num(row, 'cumulativePct'),
    }))
    .sort((a, b) => a.cumulative - b.cumulative);

  // How many customers it takes to reach half the revenue -- the number people
  // actually repeat back to each other.
  const half = points.findIndex((p) => p.cumulative >= 50);
  return {
    points,
    insight:
      half === -1
        ? points.length === 0
          ? null
          : 'No single group of customers reaches half the revenue in this period.'
        : `${String(half + 1)} of ${String(points.length)} customers make up half the revenue.`,
  };
}

// ------------------------------------------------------ 7. payment behaviour

export interface SlippagePoint extends Point {
  readonly creditDays: number;
}

/** Days beyond agreed terms, worst first. */
export function paymentSlippage(rows: readonly ReportRowView[], keep = 6): Series<SlippagePoint> {
  const all = rows
    .map((row) => ({
      label: text(row, 'partyName'),
      value: num(row, 'slippage'),
      creditDays: num(row, 'creditDays'),
    }))
    .filter((p) => p.label !== '')
    .sort((a, b) => b.value - a.value);
  const points = all.slice(0, keep);
  const late = all.filter((p) => p.value >= SLIPPAGE_WORRY_DAYS);

  return {
    points,
    insight:
      all.length === 0
        ? null
        : late.length === 0
          ? 'Everyone is paying inside their agreed terms.'
          : `${String(late.length)} of ${String(all.length)} customers run more than ${String(SLIPPAGE_WORRY_DAYS)} days past terms.`,
  };
}

// ----------------------------------------------------------- 8. fill rate

export interface FillPoint extends Point {
  /** What is still owed to that customer, as a share of what they ordered. */
  readonly shortfall: number;
}

/**
 * How much of what was ordered actually went out, and how much did not.
 *
 * Both halves, because a bar that stops at 40% leaves the reader to work out
 * that the other 60% is the story.
 */
export function fillRate(rows: readonly ReportRowView[], keep = 6): Series<FillPoint> {
  const all = rows
    .map((row) => {
      const filled = num(row, 'fillPct');
      return {
        label: text(row, 'partyName'),
        value: filled,
        shortfall: Math.max(0, Math.round((100 - filled) * 10) / 10),
      };
    })
    .filter((p) => p.label !== '')
    .sort((a, b) => a.value - b.value);
  const points = all.slice(0, keep);
  const short = all.filter((p) => p.value < FILL_RATE_WORRY_PCT);

  return {
    points,
    insight:
      all.length === 0
        ? null
        : short.length === 0
          ? `Every customer's orders are at least ${String(FILL_RATE_WORRY_PCT)}% filled.`
          : `${String(short.length)} of ${String(all.length)} customers have orders under ${String(FILL_RATE_WORRY_PCT)}% filled.`,
  };
}

// ------------------------------------------------- 9. pending dispatch by age

/** Open order lines, grouped by how long they have been waiting. */
export function pendingByAge(rows: readonly ReportRowView[]): Series<Point> {
  const bands: { label: string; upto: number }[] = [
    { label: '0-30', upto: 30 },
    { label: '31-60', upto: 60 },
    { label: '61-90', upto: 90 },
    { label: '90+', upto: Number.POSITIVE_INFINITY },
  ];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const age = num(row, 'ageDays');
    const band = bands.find((b) => age <= b.upto);
    if (band === undefined) continue;
    counts.set(band.label, (counts.get(band.label) ?? 0) + 1);
  }
  const points = bands
    .filter((b) => counts.has(b.label))
    .map((b) => ({ label: b.label, value: counts.get(b.label) ?? 0 }));
  const stale = sum(points.filter((p) => p.label === '90+').map((p) => p.value));
  const total = sum(points.map((p) => p.value));

  return {
    points,
    insight:
      total === 0
        ? 'Nothing is waiting to go out.'
        : stale === 0
          ? `${String(total)} lines waiting, none of them older than ninety days.`
          : `${String(stale)} of ${String(total)} waiting lines have been open more than ninety days.`,
  };
}

// ----------------------------------------------------------- 10. stock ageing

/** Value locked in stock, by how long it has sat. */
export function stockAgeing(rows: readonly ReportRowView[]): Series<Point> {
  const buckets: { label: string; key: string }[] = [
    { label: '0-30', key: 'bucket0' },
    { label: '31-60', key: 'bucket31' },
    { label: '61-90', key: 'bucket61' },
    { label: '90+', key: 'bucket90' },
  ];
  const points = buckets.map((b) => ({
    label: b.label,
    value: sum(rows.map((row) => num(row, b.key))),
  }));
  const total = sum(points.map((p) => p.value));
  const stale = points.at(-1)?.value ?? 0;
  const share = pct(stale, total);

  return {
    points: points.filter((p) => p.value > 0),
    insight:
      total === 0
        ? null
        : `${String(share)}% of the quantity on the shelf has been there over ${String(STOCK_STALE_DAYS)} days.`,
  };
}

// -------------------------------------------------------- 11. revenue at risk

export interface LapseSplit {
  readonly label: string;
  readonly value: number;
}

/** Last year's revenue whose customer has gone quiet. */
export function revenueAtRisk(rows: readonly ReportRowView[]): Series<LapseSplit> {
  // The report carries three states and only two of them are quiet. Reading
  // "at risk" as everything that is not lapsed put every customer buying
  // exactly on rhythm into the at-risk slice, and made the sentence beneath
  // it count them as quiet too.
  const lapsed = rows.filter((row) => text(row, 'state') === 'LAPSED');
  const atRisk = rows.filter((row) => text(row, 'state') === 'AT_RISK');
  const quiet = lapsed.length + atRisk.length;
  const points = [
    { label: 'Lapsed', value: sum(lapsed.map((row) => num(row, 'revenue12m'))) },
    { label: 'At risk', value: sum(atRisk.map((row) => num(row, 'revenue12m'))) },
  ].filter((p) => p.value > 0);

  return {
    points,
    insight:
      quiet === 0
        ? 'No customer has gone quiet in this period.'
        : `${String(lapsed.length)} of ${String(quiet)} quiet customers have stopped buying altogether.`,
  };
}

/** The last twelve months' revenue of customers who have actually gone quiet. */
export function quietRevenue(rows: readonly ReportRowView[]): number {
  return sum(rows.filter((row) => text(row, 'state') !== 'ON_RHYTHM').map((row) => num(row, 'revenue12m')));
}

// ------------------------------------------------------- 12. credit headroom

export interface HeadroomPoint extends Point {
  readonly exposure: number;
  readonly overLimit: boolean;
}

/** How much of each customer's credit line is used. */
export function creditHeadroom(rows: readonly ReportRowView[], keep = 6): Series<HeadroomPoint> {
  const all = rows
    .map((row) => {
      const limit = num(row, 'creditLimit');
      const exposure = num(row, 'exposure');
      return {
        label: text(row, 'partyName'),
        value: limit === 0 ? 0 : Math.round((exposure / limit) * 1000) / 10,
        exposure,
        overLimit: text(row, 'overLimit') === 'true',
      };
    })
    .filter((p) => p.label !== '')
    .sort((a, b) => b.value - a.value);
  const points = all.slice(0, keep);
  const breached = all.filter((p) => p.overLimit || p.value > 100);

  return {
    points,
    insight:
      all.length === 0
        ? null
        : breached.length === 0
          ? 'Every customer is inside their credit limit.'
          : `${String(breached.length)} of ${String(all.length)} customers are over their credit limit.`,
  };
}

// ------------------------------------------------------- 13. seasonality

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * The trading year folded onto itself: every January together, every February
 * together, whatever year they fell in.
 *
 * A twelve-month bar chart shows what happened. This shows whether the same
 * thing happens every year -- the question behind "is March always quiet".
 */
export function seasonality(rows: readonly ReportRowView[]): Series<Point> {
  const totals = new Array<number>(12).fill(0);
  let matched = 0;
  for (const row of rows) {
    const key = text(row, 'label');
    const month = /^\d{4}-(\d{2})$/u.exec(key);
    if (month === null) continue;
    const index = Number(month[1]) - 1;
    if (index < 0 || index > 11) continue;
    totals[index] = (totals[index] ?? 0) + num(row, 'value');
    matched += 1;
  }

  const points = MONTH_NAMES.map((label, index) => ({ label, value: totals[index] ?? 0 }));
  const busiest = points.reduce((most, p) => (p.value > most.value ? p : most), points[0] ?? { label: '', value: 0 });
  const quietest = points
    .filter((p) => p.value > 0)
    .reduce<Point | null>((least, p) => (least === null || p.value < least.value ? p : least), null);

  return {
    points,
    insight:
      matched === 0
        ? null
        : quietest === null || busiest.value === 0
          ? 'Nothing invoiced in this period.'
          : `${busiest.label} is the strongest month of the year here; ${quietest.label} the weakest.`,
  };
}

// ---------------------------------------------------------- 14. invoice mix

export interface MixPoint {
  readonly label: string;
  /** How many invoices that customer took. */
  readonly invoices: number;
  /** What they were worth in total. */
  readonly value: number;
  /** What that many invoices would be worth at the period's average bill. */
  readonly trend: number;
}
export interface MixSeries extends Series<MixPoint> {
  /** The period's average bill, which the trend line is drawn from. */
  readonly averageBill: number;
}

/**
 * Every customer as one dot, against the line they would sit on if they
 * bought at the average.
 *
 * The four corners are four different customers -- frequent and large, rare
 * and large, frequent and small, rare and small -- and each wants a different
 * conversation. The line is what makes the dots mean something: above it is a
 * customer writing bigger bills than the book average, below it is one buying
 * often and small. A ranked bar chart cannot show either.
 */
export function invoiceMix(rows: readonly ReportRowView[]): MixSeries {
  const raw = rows
    .map((row) => ({
      label: text(row, 'label'),
      invoices: num(row, 'vouchers'),
      value: Math.abs(num(row, 'value')),
    }))
    .filter((p) => p.label !== '' && p.invoices > 0)
    .sort((a, b) => a.invoices - b.invoices);

  if (raw.length === 0) return { points: [], averageBill: 0, insight: null };

  const totalInvoices = sum(raw.map((p) => p.invoices));
  const averageBill = totalInvoices === 0 ? 0 : sum(raw.map((p) => p.value)) / totalInvoices;
  const points = raw.map((p) => ({ ...p, trend: Math.round(p.invoices * averageBill) }));
  const best = points.reduce((most, p) => (p.value / p.invoices > most.value / most.invoices ? p : most), points[0] as MixPoint);
  const above = points.filter((p) => p.value > p.trend).length;

  return {
    points,
    averageBill,
    insight: `${best.label} writes the largest bills, at about ${String(Math.round((best.value / best.invoices) / averageBill * 10) / 10)} times the average; ${String(above)} of ${String(points.length)} customers sit above the line.`,
  };
}

// ------------------------------------------------- 15. revenue and basket

export interface BasketPoint {
  readonly label: string;
  readonly revenue: number;
  readonly aov: number;
}
export interface BasketSeries extends Series<BasketPoint> {
  readonly totals: { readonly revenue: number; readonly aov: number };
}

/**
 * Revenue and average invoice on one set of months, so the chart can switch
 * between them without refetching.
 *
 * They belong together because they move apart: revenue up while the average
 * falls is more customers buying less each, which is a different week from
 * revenue up on a steady average.
 */
export function revenueAndBasket(rows: readonly ReportRowView[]): BasketSeries {
  const points = rows
    .map((row) => ({
      label: text(row, 'month'),
      revenue: num(row, 'revenue'),
      aov: num(row, 'aov'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const revenue = sum(points.map((p) => p.revenue));
  const invoices = points.length;
  const totals = {
    revenue,
    // The average of the averages would weight a quiet month the same as a
    // busy one; this is the period's own average bill.
    aov: invoices === 0 ? 0 : Math.round((revenue / invoices) * 100) / 100,
  };

  if (points.length < MONTHS_FOR_A_TREND) {
    return { points, totals, insight: 'Not enough months here to read the basket.' };
  }
  const first = points[0];
  const last = points.at(-1);
  const revenueUp = last !== undefined && first !== undefined && last.revenue >= first.revenue;
  const basketUp = last !== undefined && first !== undefined && last.aov >= first.aov;

  return {
    points,
    totals,
    insight:
      revenueUp === basketUp
        ? `Revenue and the average bill are moving the same way, both ${revenueUp ? 'up' : 'down'} across the period.`
        : revenueUp
          ? 'Revenue is up while the average bill is down: more customers, buying less each.'
          : 'Revenue is down while the average bill holds: fewer customers, spending the same.',
  };
}

// ------------------------------------------------------------- 16. totals

/**
 * One numeric column added up across a page of rows.
 *
 * The headline figures are sums and nothing else, but they were being written
 * inline at each tile, which is how "receivables exposure" and the credit
 * chart beneath it came to be computed two different ways on the same screen.
 */
export function sumColumn(rows: readonly ReportRowView[], key: string): number {
  return sum(rows.map((row) => num(row, key)));
}
