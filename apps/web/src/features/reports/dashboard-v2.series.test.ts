import { describe, expect, it } from 'vitest';

import {
  ageingByBucket,
  averageOrderValue,
  concentration,
  creditHeadroom,
  fillRate,
  invoiceMix,
  monthlyInvoiced,
  newVsRepeat,
  paymentSlippage,
  pendingByAge,
  revenueAndBasket,
  quietRevenue,
  revenueAtRisk,
  seasonality,
  stockAgeing,
  sumColumn,
  topCustomers,
} from './dashboard-v2.series';
import type { ReportRowView } from './types';

/** A row shaped the way `toRowViews` produces one; only `cells` is read. */
function row(cells: Record<string, string | number | boolean | null>): ReportRowView {
  return { id: JSON.stringify(cells), primary: '', status: null, cells, punch: null };
}

describe('monthlyInvoiced', () => {
  const rows = [
    row({ label: '2026-07', value: '300' }),
    row({ label: '2026-05', value: '100' }),
    row({ label: '2026-08', value: '50' }),
    row({ label: '2026-06', value: '200' }),
  ];

  it('zero-fills a silent month instead of letting the line glide through it', () => {
    // June sold nothing and sent no row. It must exist as a zero: without
    // it the chart hides the collapse, and "on the month before" would
    // compare July to May.
    const series = monthlyInvoiced(
      [row({ label: '2026-05', value: '100' }), row({ label: '2026-07', value: '300' })],
      '2026-08',
    );
    expect(series.points).toEqual([
      { label: '2026-05', value: 100 },
      { label: '2026-06', value: 0 },
      { label: '2026-07', value: 300 },
    ]);
    // July against a zero June is a movement with no honest percentage, so
    // no claim is made rather than a made-up one.
    expect(series.insight).toBeNull();
  });

  it('fills across a December so the year boundary does not break the axis', () => {
    const series = monthlyInvoiced(
      [row({ label: '2026-11', value: '100' }), row({ label: '2027-01', value: '300' })],
      '2027-02',
    );
    expect(series.points.map((p) => p.label)).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('orders by month, not by the size the API sorted on', () => {
    expect(monthlyInvoiced(rows, '2026-08').points.map((p) => p.label)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
  });

  it('compares the last two finished months, never the part-month in progress', () => {
    const series = monthlyInvoiced(rows, '2026-08');
    expect([series.comparedFrom, series.comparedTo]).toEqual(['2026-06', '2026-07']);
    expect(series.movementPct).toBe(50);
    expect(series.insight).toBe('Up 50% on the month before.');
  });

  it('says so when there are too few finished months to read a direction', () => {
    const short = [row({ label: '2026-07', value: '10' }), row({ label: '2026-08', value: '4' })];
    expect(monthlyInvoiced(short, '2026-08').insight).toBe(
      'Not enough finished months in this period to read a direction.',
    );
  });

  it('calls a move under the threshold flat rather than inventing a trend', () => {
    const flat = [
      row({ label: '2026-05', value: '100' }),
      row({ label: '2026-06', value: '100' }),
      row({ label: '2026-07', value: '101' }),
    ];
    expect(monthlyInvoiced(flat, '2026-08').insight).toBe('Flat on the month before.');
  });

  it('totals the whole period, part-month included', () => {
    expect(monthlyInvoiced(rows, '2026-08').total).toBe(650);
  });

  it('holds on an empty period', () => {
    const empty = monthlyInvoiced([], '2026-08');
    expect(empty.points).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.movementPct).toBeNull();
  });
});

describe('topCustomers', () => {
  const rows = [
    row({ label: 'A', value: '500' }),
    row({ label: 'B', value: '300' }),
    row({ label: 'C', value: '100' }),
    row({ label: 'D', value: '100' }),
  ];

  it('keeps the top n and folds the rest into a tail', () => {
    const series = topCustomers(rows, 2);
    expect(series.points.map((p) => p.label)).toEqual(['A', 'B']);
    expect(series.tailValue).toBe(200);
    expect(series.tailCount).toBe(2);
  });

  it('names a concentration risk when one customer is a quarter of the book', () => {
    expect(topCustomers(rows).insight).toContain('losing them would be felt');
  });

  it('states the leader plainly when nobody dominates', () => {
    const spread = Array.from({ length: 10 }, (_, i) => row({ label: `P${String(i)}`, value: '100' }));
    expect(topCustomers(spread).insight).toBe('P0 leads at 10% of the period.');
  });

  it('claims only the rows shown when the page cap clipped the party list', () => {
    // 500 of 1000 would be a concentration alarm -- but the denominator is
    // four rows of a longer book, so the sentence must not say "of the
    // period", and must not raise the alarm it cannot prove.
    const series = topCustomers(rows, 2, true);
    expect(series.insight).toBe('A leads at 50% of the top 4 customers shown.');
  });

  it('has no insight with no rows', () => {
    expect(topCustomers([]).insight).toBeNull();
  });
});

describe('ageingByBucket', () => {
  const rows = [
    row({ bucket: '90+', outstanding: '300' }),
    row({ bucket: '0-30', outstanding: '100' }),
    row({ bucket: '90+', outstanding: '100' }),
  ];

  it('sums per bucket and keeps them in age order', () => {
    const series = ageingByBucket(rows);
    expect(series.points.map((p) => p.bucket)).toEqual(['0-30', '90+']);
    expect(series.points.map((p) => p.value)).toEqual([100, 400]);
  });

  it('assigns the ramp by the bucket’s identity, not its position among the non-empty', () => {
    // With 31-60 and 61-90 empty, 90+ still wears the deep end of the
    // ramp; a positional index would dress it in 31-60’s colour.
    expect(ageingByBucket(rows).points.map((p) => p.fill)).toEqual([
      'var(--chart-1)',
      'var(--chart-4)',
    ]);
  });

  it('surfaces a bucket it does not recognise instead of dropping the money', () => {
    // The UNDATED story (audit 34) as a class: a new bucket name from the
    // server rides as ‘Other’, keeps the total honest, and claims no
    // overdue-ness it cannot prove.
    const series = ageingByBucket([
      row({ bucket: '0-30', outstanding: '100' }),
      row({ bucket: '120+', outstanding: '900' }),
    ]);
    expect(series.points.map((p) => p.bucket)).toEqual(['0-30', 'Other']);
    expect(series.total).toBe(1000);
    expect(series.overdue).toBe(0);
  });

  it('counts everything past thirty days as overdue', () => {
    const series = ageingByBucket(rows);
    expect(series.overdue).toBe(400);
    expect(series.insight).toBe('80% of what is owed is already past thirty days.');
  });

  it('keeps bills the API could not age (audit 34)', () => {
    // Tally may send a bill with no date, and the API keeps those on purpose
    // rather than guessing an age. The bucket list did not have UNDATED, so
    // they were dropped: the donut and the figure beside it showed less money
    // outstanding than the table underneath, with nothing to say why.
    const withUndated = ageingByBucket([...rows, row({ bucket: 'UNDATED', outstanding: '250' })]);
    expect(withUndated.points.map((p) => p.bucket)).toEqual(['0-30', '90+', 'UNDATED']);
    expect(withUndated.total).toBe(750);
    // Undated is not overdue: nothing is known about when it was due.
    expect(withUndated.overdue).toBe(400);
  });

  it('says the good news too', () => {
    expect(ageingByBucket([row({ bucket: '0-30', outstanding: '100' })]).insight).toBe(
      'Everything owed is inside thirty days.',
    );
  });
});

describe('newVsRepeat', () => {
  it('shares the period between first-time and returning customers', () => {
    const series = newVsRepeat([
      row({ month: '2026-02', newRevenue: '0', repeatRevenue: '300' }),
      row({ month: '2026-01', newRevenue: '100', repeatRevenue: '600' }),
    ]);
    expect(series.points.map((p) => p.label)).toEqual(['2026-01', '2026-02']);
    expect(series.insight).toBe("10% of the period's revenue came from customers billed for the first time.");
  });

  it('has no insight with nothing to divide', () => {
    expect(newVsRepeat([]).insight).toBeNull();
  });
});

describe('averageOrderValue', () => {
  it('reads the direction across the whole period', () => {
    const series = averageOrderValue([
      row({ month: '2026-03', aov: '150' }),
      row({ month: '2026-01', aov: '100' }),
      row({ month: '2026-02', aov: '120' }),
    ]);
    expect(series.points.map((p) => p.value)).toEqual([100, 120, 150]);
    expect(series.insight).toBe('The average invoice is up 50% across the period.');
  });

  it('refuses a trend from two points', () => {
    expect(averageOrderValue([row({ month: '2026-01', aov: '100' })]).insight).toBe(
      'Not enough months here to read the basket.',
    );
  });
});

describe('concentration', () => {
  it('counts how few customers make up half the revenue', () => {
    const series = concentration([
      row({ partyName: 'A', sharePct: '30', cumulativePct: '30' }),
      row({ partyName: 'B', sharePct: '25', cumulativePct: '55' }),
      row({ partyName: 'C', sharePct: '45', cumulativePct: '100' }),
    ]);
    expect(series.insight).toBe('2 of 3 customers make up half the revenue.');
  });

  it('says when nobody reaches half', () => {
    expect(
      concentration([row({ partyName: 'A', sharePct: '10', cumulativePct: '10' })]).insight,
    ).toBe('No single group of customers reaches half the revenue in this period.');
  });

  it('has no insight with no rows', () => {
    expect(concentration([]).insight).toBeNull();
  });
});

describe('paymentSlippage', () => {
  it('puts the worst payers first and counts who is past terms', () => {
    const series = paymentSlippage([
      row({ partyName: 'Slow', slippage: '40', creditDays: '30' }),
      row({ partyName: 'Fine', slippage: '2', creditDays: '30' }),
      row({ partyName: 'Late', slippage: '20', creditDays: '15' }),
    ]);
    expect(series.points.map((p) => p.label)).toEqual(['Slow', 'Late', 'Fine']);
    expect(series.insight).toBe('2 of 3 customers run more than 15 days past terms.');
  });

  it('says so when everybody pays on time', () => {
    expect(paymentSlippage([row({ partyName: 'Good', slippage: '1', creditDays: '30' })]).insight).toBe(
      'Everyone is paying inside their agreed terms.',
    );
  });
});

describe('fillRate', () => {
  it('shows the worst-served customers first', () => {
    const series = fillRate([
      row({ partyName: 'Full', fillPct: '100' }),
      row({ partyName: 'Empty', fillPct: '0' }),
    ]);
    expect(series.points.map((p) => p.label)).toEqual(['Empty', 'Full']);
    expect(series.insight).toBe('1 of 2 customers have orders under 85% filled.');
  });

  it('says so when the order book is being served', () => {
    expect(fillRate([row({ partyName: 'Full', fillPct: '99' })]).insight).toBe(
      "Every customer's orders are at least 85% filled.",
    );
  });
});

describe('pendingByAge', () => {
  it('bands open lines by how long they have waited', () => {
    const series = pendingByAge([
      row({ ageDays: 5 }),
      row({ ageDays: 45 }),
      row({ ageDays: 200 }),
      row({ ageDays: 300 }),
    ]);
    expect(series.points).toEqual([
      { label: '0-30', value: 1 },
      { label: '31-60', value: 1 },
      { label: '90+', value: 2 },
    ]);
    expect(series.insight).toBe('2 of 4 waiting lines have been open more than ninety days.');
  });

  it('has a sentence for an empty order book', () => {
    expect(pendingByAge([]).insight).toBe('Nothing is waiting to go out.');
  });

  it('says so when nothing has gone stale', () => {
    expect(pendingByAge([row({ ageDays: 10 })]).insight).toBe(
      '1 lines waiting, none of them older than ninety days.',
    );
  });
});

describe('stockAgeing', () => {
  it('sums each bucket across every item and drops the empty ones', () => {
    const series = stockAgeing([
      row({ bucket0: '10', bucket31: '0', bucket61: '0', bucket90: '30' }),
      row({ bucket0: '10', bucket31: '0', bucket61: '0', bucket90: '50' }),
    ]);
    expect(series.points).toEqual([
      { label: '0-30', value: 20 },
      { label: '90+', value: 80 },
    ]);
    expect(series.insight).toBe('80% of the quantity on the shelf has been there over 90 days.');
  });

  it('has no insight with nothing on the shelf', () => {
    expect(stockAgeing([]).insight).toBeNull();
  });
});

describe('revenueAtRisk', () => {
  it('splits quiet revenue into lapsed and at risk', () => {
    const series = revenueAtRisk([
      row({ state: 'LAPSED', revenue12m: '100' }),
      row({ state: 'AT_RISK', revenue12m: '50' }),
      row({ state: 'LAPSED', revenue12m: '25' }),
    ]);
    expect(series.points).toEqual([
      { label: 'Lapsed', value: 125 },
      { label: 'At risk', value: 50 },
    ]);
    expect(series.insight).toBe('2 of 3 quiet customers have stopped buying altogether.');
  });

  it('has a sentence when nobody has gone quiet', () => {
    expect(revenueAtRisk([]).insight).toBe('No customer has gone quiet in this period.');
  });

  it('leaves customers buying on rhythm out of the at-risk slice', () => {
    const series = revenueAtRisk([
      row({ state: 'LAPSED', revenue12m: '100' }),
      row({ state: 'AT_RISK', revenue12m: '50' }),
      row({ state: 'ON_RHYTHM', revenue12m: '900' }),
    ]);
    // The healthy customer's 900 used to land in "At risk", which put the
    // best customer on the report of the ones being lost.
    expect(series.points).toEqual([
      { label: 'Lapsed', value: 100 },
      { label: 'At risk', value: 50 },
    ]);
    expect(series.insight).toBe('1 of 2 quiet customers have stopped buying altogether.');
  });

  it('a report of nothing but healthy customers has nobody quiet', () => {
    const series = revenueAtRisk([row({ state: 'ON_RHYTHM', revenue12m: '900' })]);
    expect(series.points).toEqual([]);
    expect(series.insight).toBe('No customer has gone quiet in this period.');
  });
});

describe('quietRevenue', () => {
  it('adds up only the customers who have gone quiet', () => {
    expect(
      quietRevenue([
        row({ state: 'LAPSED', revenue12m: '100' }),
        row({ state: 'AT_RISK', revenue12m: '50' }),
        row({ state: 'ON_RHYTHM', revenue12m: '900' }),
      ]),
    ).toBe(150);
  });

  it('is zero when every customer is on rhythm', () => {
    expect(quietRevenue([row({ state: 'ON_RHYTHM', revenue12m: '900' })])).toBe(0);
  });
});

describe('creditHeadroom', () => {
  it('ranks by how much of the line is used', () => {
    const series = creditHeadroom([
      row({ partyName: 'Light', creditLimit: '1000', exposure: '100', overLimit: 'false' }),
      row({ partyName: 'Heavy', creditLimit: '1000', exposure: '900', overLimit: 'false' }),
    ]);
    expect(series.points.map((p) => p.label)).toEqual(['Heavy', 'Light']);
    expect(series.points.map((p) => p.value)).toEqual([90, 10]);
    expect(series.insight).toBe('Every customer is inside their credit limit.');
  });

  it('counts a breach from the flag as well as from the arithmetic', () => {
    const series = creditHeadroom([
      row({ partyName: 'Over', creditLimit: '100', exposure: '150', overLimit: 'true' }),
      row({ partyName: 'Fine', creditLimit: '100', exposure: '10', overLimit: 'false' }),
    ]);
    expect(series.insight).toBe('1 of 2 customers are over their credit limit.');
  });

  it('does not divide by a missing credit limit', () => {
    const series = creditHeadroom([
      row({ partyName: 'None', creditLimit: null, exposure: '500', overLimit: 'false' }),
    ]);
    expect(series.points[0]?.value).toBe(0);
  });
});

describe('seasonality', () => {
  // No fixture month is in progress.
  const AFTER = '2026-12';

  it('folds the years together as a mean per calendar month, never a sum', () => {
    const series = seasonality(
      [
        row({ label: '2025-03', value: '100' }),
        row({ label: '2026-03', value: '50' }),
        row({ label: '2026-07', value: '400' }),
      ],
      AFTER,
    );
    expect(series.points).toHaveLength(12);
    // March appears in both years: (100 + 50) / 2, not 150 -- a month must
    // not be crowned for being counted twice.
    expect(series.points[2]).toEqual({ label: 'Mar', value: 75 });
    expect(series.points[6]).toEqual({ label: 'Jul', value: 400 });
    expect(series.insight).toBe('Jul is the strongest month of the year here; Mar the weakest.');
  });

  it('keeps the month in progress out of its calendar bucket', () => {
    // Three weeks of August must not argue with a full July.
    const series = seasonality(
      [
        row({ label: '2026-07', value: '400' }),
        row({ label: '2026-06', value: '300' }),
        row({ label: '2026-08', value: '90' }),
      ],
      '2026-08',
    );
    expect(series.points[7]).toEqual({ label: 'Aug', value: 0 });
    expect(series.insight).toBe('Jul is the strongest month of the year here; Jun the weakest.');
  });

  it('still returns twelve axes when a month is missing, so the shape holds', () => {
    const series = seasonality([row({ label: '2026-01', value: '10' })], AFTER);
    expect(series.points).toHaveLength(12);
    expect(series.points[5]).toEqual({ label: 'Jun', value: 0 });
  });

  it('ignores a label that is not a month key', () => {
    expect(seasonality([row({ label: 'Godavari Electricals', value: '900' })], AFTER).insight).toBeNull();
  });
});

describe('invoiceMix', () => {
  it('places each customer by how often they buy against what they spend', () => {
    const series = invoiceMix([
      row({ label: 'Frequent', vouchers: 10, value: '1000' }),
      row({ label: 'Rare but big', vouchers: 1, value: '900' }),
    ]);
    // Sorted by invoice count, because the trend line is drawn along that axis.
    expect(series.points.map((p) => p.label)).toEqual(['Rare but big', 'Frequent']);
    expect(series.insight).toContain('Rare but big writes the largest bills');
  });

  it('draws the trend from the period average bill, not from each customer', () => {
    const series = invoiceMix([
      row({ label: 'A', vouchers: 1, value: '100' }),
      row({ label: 'B', vouchers: 3, value: '300' }),
    ]);
    // 400 over 4 invoices is 100 a bill, so the line is 100 times the count.
    expect(series.averageBill).toBe(100);
    expect(series.points.map((p) => p.trend)).toEqual([100, 300]);
  });

  it('counts who sits above the line', () => {
    const series = invoiceMix([
      row({ label: 'Big', vouchers: 1, value: '900' }),
      row({ label: 'Small', vouchers: 9, value: '900' }),
    ]);
    expect(series.insight).toContain('1 of 2 customers sit above the line');
  });

  it('drops a customer with no invoices rather than dividing by zero', () => {
    const series = invoiceMix([
      row({ label: 'None', vouchers: 0, value: '0' }),
      row({ label: 'Real', vouchers: 2, value: '200' }),
    ]);
    expect(series.points.map((p) => p.label)).toEqual(['Real']);
  });

  it('has no insight with nothing to place', () => {
    const series = invoiceMix([]);
    expect(series.insight).toBeNull();
    expect(series.averageBill).toBe(0);
  });
});

describe('revenueAndBasket', () => {
  // Hand-worked: 100/50 = 2 invoices, 200/40 = 5, 300/30 = 10.
  const rows = [
    row({ month: '2026-03', revenue: '300', aov: '30', invoices: 10 }),
    row({ month: '2026-01', revenue: '100', aov: '50', invoices: 2 }),
    row({ month: '2026-02', revenue: '200', aov: '40', invoices: 5 }),
  ];
  // No month in the fixture is in progress.
  const AFTER = '2026-04';

  it('orders by month and totals the period', () => {
    const series = revenueAndBasket(rows, AFTER);
    expect(series.points.map((p) => p.label)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(series.totals.revenue).toBe(600);
    // The period's own average bill: all the money over all the invoices,
    // 600 / 17. Not the mean of the monthly averages (40), and NEVER
    // revenue over the number of months (200) -- a period's average
    // invoice cannot exceed its largest monthly average.
    expect(series.totals.aov).toBe(35.29);
  });

  it('names the case where the two measures disagree', () => {
    expect(revenueAndBasket(rows, AFTER).insight).toBe(
      'Revenue is up while the average bill is down: more customers, buying less each.',
    );
  });

  it('reads the direction across finished months only', () => {
    // With March still in progress, the read stops at February: revenue up
    // (100 -> 200) and basket down (50 -> 40) -- the same disagreement, but
    // proven without the part-month.
    expect(revenueAndBasket(rows, '2026-03').insight).toBe(
      'Revenue is up while the average bill is down: more customers, buying less each.',
    );
    // The part-month still counts toward the period totals; only the trend
    // sentence excludes it.
    expect(revenueAndBasket(rows, '2026-03').totals.revenue).toBe(600);
  });

  it('says so when they move together', () => {
    const together = [
      row({ month: '2026-01', revenue: '100', aov: '10', invoices: 10 }),
      row({ month: '2026-02', revenue: '200', aov: '20', invoices: 10 }),
      row({ month: '2026-03', revenue: '300', aov: '30', invoices: 10 }),
    ];
    expect(revenueAndBasket(together, AFTER).insight).toContain('moving the same way, both up');
  });

  it('refuses a reading from two adjacent months', () => {
    const twoMonths = [
      row({ month: '2026-01', revenue: '100', aov: '50', invoices: 2 }),
      row({ month: '2026-02', revenue: '200', aov: '40', invoices: 5 }),
    ];
    expect(revenueAndBasket(twoMonths, AFTER).insight).toBe(
      'Not enough months here to read the basket.',
    );
  });

  it('a gap month counts as a month: January and March span three, with a real zero between', () => {
    // Two rows, three calendar months -- the silent February is data, not
    // absence, so the window is wide enough to read.
    const gapped = [
      row({ month: '2026-01', revenue: '100', aov: '50', invoices: 2 }),
      row({ month: '2026-03', revenue: '300', aov: '30', invoices: 10 }),
    ];
    const series = revenueAndBasket(gapped, AFTER);
    expect(series.points.map((p) => p.label)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(series.points[1]).toEqual({ label: '2026-02', revenue: 0, aov: 0, invoices: 0 });
    expect(series.insight).not.toBeNull();
  });

  it('does not divide by zero on an empty period', () => {
    expect(revenueAndBasket([], AFTER).totals).toEqual({ revenue: 0, aov: 0 });
  });
});

describe('sumColumn', () => {
  it('adds a column across the page', () => {
    expect(sumColumn([row({ exposure: '100.5' }), row({ exposure: '9.5' })], 'exposure')).toBe(110);
  });

  it('treats a missing or unreadable cell as zero rather than NaN', () => {
    expect(sumColumn([row({ exposure: null }), row({ other: '5' })], 'exposure')).toBe(0);
  });

  it('is zero on an empty page', () => {
    expect(sumColumn([], 'exposure')).toBe(0);
  });
});

describe('fillRate shortfall', () => {
  it('carries what is still owed alongside what went out', () => {
    const series = fillRate([
      row({ partyName: 'Part', fillPct: '40' }),
      row({ partyName: 'Full', fillPct: '100' }),
    ]);
    expect(series.points).toEqual([
      { label: 'Part', value: 40, shortfall: 60 },
      { label: 'Full', value: 100, shortfall: 0 },
    ]);
  });

  it('never reports a negative shortfall when a line over-ships', () => {
    expect(fillRate([row({ partyName: 'Over', fillPct: '115' })]).points[0]?.shortfall).toBe(0);
  });
});
