import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  PERMISSIONS,
  type AreaInsights,
  type InsightArea,
  type InsightsQuery,
  type MetricPoint,
  type MetricView,
} from '@vyuha/shared';

import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { type Principal } from '../rbac/principal.js';

/**
 * The four prebuilt report areas (owner, 26 Aug 2026): metric cards over a
 * date range, in the observability shape -- headline, day-bucketed series,
 * sometimes a breakdown table.
 *
 * Aggregation happens here, in SQL, and lands as text for money (D-01: the
 * browser never does arithmetic on Tally's figures -- Postgres numeric sums
 * exactly and ::text carries it whole). Day gaps are filled server-side so a
 * chart never has to guess whether a missing day meant zero or meant no row.
 *
 * Every route into this service already passed report.view; each area then
 * has its own gate, because a reports module must not become a side door --
 * the attendance page shows what attendance.view.all holders may see, and
 * nobody else (the same rule the old reports module enforced, and the same
 * rule custom-report widgets inherit by calling these endpoints).
 */

const MAX_RANGE_DAYS = 400;

// A type alias, not an interface: db.execute's generic wants an implicit
// index signature, which object-literal types carry and interfaces do not.
type DayRow = { day: string; key: string; value: string | number };

/** from..to inclusive as YYYY-MM-DD, computed without ever leaving UTC. */
function dayBuckets(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** Grouped rows -> one point per day with every series key present (0 when absent). */
function bucketise(
  rows: readonly DayRow[],
  days: readonly string[],
  seriesKeys: readonly string[],
): MetricPoint[] {
  const byDay = new Map<string, Map<string, string | number>>();
  for (const row of rows) {
    const bucket = byDay.get(row.day) ?? new Map<string, string | number>();
    bucket.set(row.key, row.value);
    byDay.set(row.day, bucket);
  }
  return days.map((day) => {
    const bucket = byDay.get(day);
    const point: MetricPoint = { t: day };
    for (const key of seriesKeys) point[key] = bucket?.get(key) ?? 0;
    return point;
  });
}

function label(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase().replaceAll('_', ' ');
}

@Injectable()
export class InsightsService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  async area(principal: Principal, area: InsightArea, query: InsightsQuery): Promise<AreaInsights> {
    const days = dayBuckets(query.from, query.to);
    if (days.length === 0) throw AppError.validation('The period ends before it starts.');
    if (days.length > MAX_RANGE_DAYS) {
      throw AppError.validation(`A report covers at most ${String(MAX_RANGE_DAYS)} days at once.`);
    }

    switch (area) {
      case 'attendance':
        this.gate(principal, PERMISSIONS.ATTENDANCE_VIEW_ALL);
        return { area, from: query.from, to: query.to, metrics: await this.attendance(principal, query, days) };
      case 'receivables':
        this.gate(principal, PERMISSIONS.RECEIVABLES_VIEW);
        return { area, from: query.from, to: query.to, metrics: await this.receivables(principal, query, days) };
      case 'sales':
        this.gate(principal, PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
        return { area, from: query.from, to: query.to, metrics: await this.sales(principal, query, days) };
      case 'sync':
        this.gate(principal, PERMISSIONS.INTEGRATION_MANAGE);
        return { area, from: query.from, to: query.to, metrics: await this.sync(principal, query, days) };
    }
  }

  private gate(principal: Principal, key: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]): void {
    if (!principal.permissions.has(key)) {
      throw AppError.forbidden('This report area needs a permission you do not hold.');
    }
  }

  /* ------------------------------- attendance ------------------------------- */

  private async attendance(principal: Principal, q: InsightsQuery, days: string[]): Promise<MetricView[]> {
    const mix = await this.db.execute<DayRow>(sql`
      SELECT date::text AS day, status AS key, count(*)::int AS value
      FROM attendance_days
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${q.from} AND ${q.to}
        AND status IN ('PRESENT', 'HALF_DAY', 'ON_DUTY', 'ON_LEAVE', 'ABSENT')
      GROUP BY 1, 2
    `);
    const late = await this.db.execute<DayRow>(sql`
      SELECT date::text AS day, 'late' AS key, count(*)::int AS value
      FROM attendance_days
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${q.from} AND ${q.to} AND late_minutes > 0
      GROUP BY 1
    `);
    const overtime = await this.db.execute<DayRow>(sql`
      SELECT date::text AS day, 'ot' AS key, sum(ot_minutes)::int AS value
      FROM attendance_days
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${q.from} AND ${q.to}
      GROUP BY 1
    `);

    const mixKeys = ['PRESENT', 'HALF_DAY', 'ON_DUTY', 'ON_LEAVE', 'ABSENT'];
    const mixPoints = bucketise(mix.rows, days, mixKeys);
    // The latest day that has any row is "today" as the engine last wrote it.
    const latest = [...mixPoints].reverse().find((p) => mixKeys.some((k) => Number(p[k]) > 0));
    const present = latest
      ? Number(latest.PRESENT) + Number(latest.HALF_DAY) + Number(latest.ON_DUTY)
      : 0;
    const lateTotal = late.rows.reduce((sum, r) => sum + Number(r.value), 0);
    const otTotal = overtime.rows.reduce((sum, r) => sum + Number(r.value), 0);

    return [
      {
        key: 'attendance-mix',
        label: 'Attendance each day',
        hint: 'Every employee-day the engine computed, by its status. Holidays and weekly offs are left out so the bars are people, not calendar.',
        unit: 'count',
        headline: String(present),
        series: mixKeys.map((k) => ({ key: k, label: label(k) })),
        points: mixPoints,
      },
      {
        key: 'late-arrivals',
        label: 'Late arrivals',
        hint: 'Days on which someone clocked in after their shift began, counted per day. The headline is the whole period.',
        unit: 'count',
        headline: String(lateTotal),
        series: [{ key: 'late', label: 'Late arrivals' }],
        points: bucketise(late.rows, days, ['late']),
      },
      {
        key: 'overtime',
        label: 'Overtime',
        hint: 'Overtime minutes the day engine credited, summed per day. Payroll is not computed here; this is the input it will be handed.',
        unit: 'minutes',
        headline: String(otTotal),
        series: [{ key: 'ot', label: 'Overtime' }],
        points: bucketise(overtime.rows, days, ['ot']),
      },
    ];
  }

  /* ------------------------------ receivables ------------------------------- */

  private async receivables(principal: Principal, q: InsightsQuery, days: string[]): Promise<MetricView[]> {
    const invoiced = await this.db.execute<DayRow>(sql`
      SELECT voucher_date::text AS day, 'invoiced' AS key, sum(amount)::text AS value
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND voucher_date BETWEEN ${q.from} AND ${q.to}
        AND voucher_type = 'Sales' AND is_cancelled = false
      GROUP BY 1
    `);
    const receipts = await this.db.execute<DayRow>(sql`
      SELECT voucher_date::text AS day, 'received' AS key, sum(amount)::text AS value
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND voucher_date BETWEEN ${q.from} AND ${q.to}
        AND voucher_type = 'Receipt' AND is_cancelled = false
      GROUP BY 1
    `);
    // Tally's voucher types are per-company configuration, so the mix's series
    // are whatever arrived: the commonest four by count, the rest folded.
    const mix = await this.db.execute<DayRow>(sql`
      WITH ranked AS (
        SELECT voucher_type, row_number() OVER (ORDER BY count(*) DESC, voucher_type) AS rank
        FROM vouchers
        WHERE org_id = ${principal.orgId} AND voucher_date BETWEEN ${q.from} AND ${q.to} AND is_cancelled = false
        GROUP BY 1
      )
      SELECT v.voucher_date::text AS day,
             CASE WHEN r.rank <= 4 THEN v.voucher_type ELSE 'Other' END AS key,
             count(*)::int AS value
      FROM vouchers v JOIN ranked r ON r.voucher_type = v.voucher_type
      WHERE v.org_id = ${principal.orgId} AND v.voucher_date BETWEEN ${q.from} AND ${q.to} AND v.is_cancelled = false
      GROUP BY 1, 2
    `);
    const parties = await this.db.execute<{ party: string; vouchers: number; amount: string }>(sql`
      SELECT coalesce(nullif(party_name, ''), 'No party') AS party, count(*)::int AS vouchers, sum(amount)::text AS amount
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND voucher_date BETWEEN ${q.from} AND ${q.to}
        AND voucher_type = 'Sales' AND is_cancelled = false
      GROUP BY 1 ORDER BY sum(amount) DESC LIMIT 8
    `);

    const sumText = (rows: readonly DayRow[]): string => {
      // Exactness note: these are two-decimal rupee figures; summing paise in
      // BigInt keeps the total exact where a float would drift on the tail.
      let paise = 0n;
      for (const row of rows) {
        const [whole = '0', fraction = ''] = String(row.value).replace('-', '').split('.');
        const sign = String(row.value).startsWith('-') ? -1n : 1n;
        paise += sign * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2)));
      }
      const sign = paise < 0n ? '-' : '';
      const abs = paise < 0n ? -paise : paise;
      return `${sign}${String(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
    };

    const mixKeys = [...new Set(mix.rows.map((r) => r.key))].sort((a, b) =>
      a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b),
    );

    return [
      {
        key: 'invoiced',
        label: 'Invoiced',
        hint: 'Sales vouchers from Tally, summed per day. Cancelled vouchers are out; the figure is Tally’s, summed, never recomputed.',
        unit: 'money',
        headline: sumText(invoiced.rows),
        series: [{ key: 'invoiced', label: 'Invoiced' }],
        points: bucketise(invoiced.rows, days, ['invoiced']),
        breakdown: {
          columns: [
            { key: 'party', label: 'Party' },
            { key: 'vouchers', label: 'Vouchers', numeric: true },
            { key: 'amount', label: 'Amount', numeric: true, unit: 'money' },
          ],
          rows: parties.rows,
        },
      },
      {
        key: 'received',
        label: 'Received',
        hint: 'Receipt vouchers from Tally, summed per day — the money that actually arrived against the invoicing above.',
        unit: 'money',
        headline: sumText(receipts.rows),
        series: [{ key: 'received', label: 'Received' }],
        points: bucketise(receipts.rows, days, ['received']),
      },
      {
        key: 'voucher-mix',
        label: 'Vouchers by type',
        hint: 'Every voucher the sync delivered, per day, by its Tally voucher type. The four commonest types are named; the rest fold into Other.',
        unit: 'count',
        headline: String(mix.rows.reduce((sum, r) => sum + Number(r.value), 0)),
        series: mixKeys.map((k) => ({ key: k, label: k })),
        points: bucketise(mix.rows, days, mixKeys),
      },
    ];
  }

  /* --------------------------------- sales ---------------------------------- */

  private async sales(principal: Principal, q: InsightsQuery, days: string[]): Promise<MetricView[]> {
    const orders = await this.db.execute<DayRow>(sql`
      SELECT date::text AS day, 'orders' AS key, sum(grand_total)::text AS value
      FROM sales_documents
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${q.from} AND ${q.to}
        AND doc_type = 'SALES_ORDER' AND status <> 'CANCELLED'
      GROUP BY 1
    `);
    const funnel = await this.db.execute<DayRow>(sql`
      SELECT date::text AS day, status AS key, count(*)::int AS value
      FROM sales_documents
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${q.from} AND ${q.to} AND doc_type = 'ESTIMATE'
      GROUP BY 1, 2
    `);
    const invoices = await this.db.execute<DayRow>(sql`
      SELECT date::text AS day, 'invoices' AS key, sum(grand_total)::text AS value
      FROM sales_documents
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${q.from} AND ${q.to}
        AND doc_type = 'INVOICE' AND status <> 'CANCELLED'
      GROUP BY 1
    `);

    const moneyTotal = (rows: readonly DayRow[]): string => {
      let paise = 0n;
      for (const row of rows) {
        const [whole = '0', fraction = ''] = String(row.value).split('.');
        paise += BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
      }
      return `${String(paise / 100n)}.${String(paise % 100n).padStart(2, '0')}`;
    };

    const funnelKeys = ['DRAFT', 'PENDING_APPROVAL', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'].filter((k) =>
      funnel.rows.some((r) => r.key === k),
    );

    const metrics: MetricView[] = [
      {
        key: 'orders-value',
        label: 'Sales orders',
        hint: 'Value of sales orders raised per day, cancelled ones excluded.',
        unit: 'money',
        headline: moneyTotal(orders.rows),
        series: [{ key: 'orders', label: 'Order value' }],
        points: bucketise(orders.rows, days, ['orders']),
      },
      {
        key: 'estimate-funnel',
        label: 'Estimates by state',
        hint: 'Estimates raised per day, coloured by where each stands now — the same document moves state, so an old day can change colour.',
        unit: 'count',
        headline: String(funnel.rows.reduce((sum, r) => sum + Number(r.value), 0)),
        series: funnelKeys.map((k) => ({ key: k, label: label(k) })),
        points: bucketise(funnel.rows, days, funnelKeys),
      },
      {
        key: 'invoices-value',
        label: 'Invoices',
        hint: 'Value of invoices issued per day, cancelled ones excluded.',
        unit: 'money',
        headline: moneyTotal(invoices.rows),
        series: [{ key: 'invoices', label: 'Invoice value' }],
        points: bucketise(invoices.rows, days, ['invoices']),
      },
    ];

    // Purchase rides on the sales page but behind its own key: a viewer who
    // may see sales and not purchases gets the page minus this card.
    if (principal.permissions.has(PERMISSIONS.PURCHASE_DOCUMENT_VIEW)) {
      const purchase = await this.db.execute<DayRow>(sql`
        SELECT date::text AS day, status AS key, count(*)::int AS value
        FROM purchase_orders
        WHERE org_id = ${principal.orgId} AND date BETWEEN ${q.from} AND ${q.to}
        GROUP BY 1, 2
      `);
      const poKeys = ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'CANCELLED'].filter((k) =>
        purchase.rows.some((r) => r.key === k),
      );
      metrics.push({
        key: 'purchase-orders',
        label: 'Purchase orders',
        hint: 'Purchase orders raised per day, by their current state.',
        unit: 'count',
        headline: String(purchase.rows.reduce((sum, r) => sum + Number(r.value), 0)),
        series: poKeys.map((k) => ({ key: k, label: label(k) })),
        points: bucketise(purchase.rows, days, poKeys),
      });
    }

    return metrics;
  }

  /* ---------------------------------- sync ---------------------------------- */

  private async sync(principal: Principal, q: InsightsQuery, days: string[]): Promise<MetricView[]> {
    const jobs = await this.db.execute<DayRow>(sql`
      SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, state AS key, count(*)::int AS value
      FROM sync_jobs
      WHERE org_id = ${principal.orgId}
        AND (created_at AT TIME ZONE 'UTC')::date BETWEEN ${q.from} AND ${q.to}
        AND state IN ('DONE', 'FAILED')
      GROUP BY 1, 2
    `);
    const exceptions = await this.db.execute<DayRow>(sql`
      SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, 'raised' AS key, count(*)::int AS value
      FROM sync_exceptions
      WHERE org_id = ${principal.orgId}
        AND (created_at AT TIME ZONE 'UTC')::date BETWEEN ${q.from} AND ${q.to}
      GROUP BY 1
    `);
    const openNow = await this.db.execute<{ value: number }>(sql`
      SELECT count(*)::int AS value FROM sync_exceptions
      WHERE org_id = ${principal.orgId} AND state = 'OPEN'
    `);
    const lastPull = await this.db.execute<{ minutes: number | null }>(sql`
      SELECT floor(extract(epoch FROM (now() - max(created_at))) / 60)::int AS minutes
      FROM sync_jobs
      WHERE org_id = ${principal.orgId} AND direction = 'PULL' AND state = 'DONE'
    `);
    const failures = await this.db.execute<{ entity: string; attempts: number; day: string }>(sql`
      SELECT coalesce(entity_type, 'unknown') AS entity, attempts, (created_at AT TIME ZONE 'UTC')::date::text AS day
      FROM sync_jobs
      WHERE org_id = ${principal.orgId} AND state = 'FAILED'
        AND (created_at AT TIME ZONE 'UTC')::date BETWEEN ${q.from} AND ${q.to}
      ORDER BY created_at DESC LIMIT 8
    `);

    const failed = jobs.rows.filter((r) => r.key === 'FAILED').reduce((sum, r) => sum + Number(r.value), 0);
    const minutes = lastPull.rows[0]?.minutes;

    return [
      {
        key: 'job-outcomes',
        label: 'Sync jobs',
        hint: 'Jobs that finished per day — done against failed. Queued and claimed jobs are in flight and not counted yet.',
        unit: 'count',
        headline: String(failed),
        series: [
          { key: 'DONE', label: 'Done' },
          { key: 'FAILED', label: 'Failed' },
        ],
        points: bucketise(jobs.rows, days, ['DONE', 'FAILED']),
        breakdown: {
          columns: [
            { key: 'entity', label: 'Entity' },
            { key: 'attempts', label: 'Attempts', numeric: true },
            { key: 'day', label: 'Day' },
          ],
          rows: failures.rows,
        },
      },
      {
        key: 'exceptions',
        label: 'Sync exceptions',
        hint: 'Exceptions raised per day. The headline is how many stand open right now, whatever day raised them.',
        unit: 'count',
        headline: String(openNow.rows[0]?.value ?? 0),
        series: [{ key: 'raised', label: 'Raised' }],
        points: bucketise(exceptions.rows, days, ['raised']),
      },
      {
        key: 'pull-freshness',
        label: 'Minutes since last pull',
        hint: 'Age of the newest completed pull from Tally. Rises between syncs and falls to near zero when one lands; blank means no pull has ever completed.',
        unit: 'minutes',
        headline: minutes === null || minutes === undefined ? '' : String(minutes),
        series: [{ key: 'DONE', label: 'Pulls completed' }],
        points: bucketise(
          jobs.rows.filter((r) => r.key === 'DONE'),
          days,
          ['DONE'],
        ),
      },
    ];
  }
}
