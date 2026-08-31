import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CreditControlService } from './credit-control.service.js';
import { readDelta, type DeltaReading } from './robustness.js';

/**
 * The purchase side (commissioned by the owner, 28 Aug 2026). The voucher
 * projection has carried Purchase, Payment and Debit Note vouchers all
 * along -- the sync is type-agnostic -- so this reads what is already
 * there and says plainly what each figure is made of:
 *
 * - Payables are a running book: the vendor's opening balance plus
 *   purchases, less payments and debit notes. Tally's bill-wise payable
 *   detail is not in the projection, so there is no payables ageing --
 *   only the balance, and it says so.
 * - DPO is payables against a year of purchases per day; DIO is closing
 *   stock at the confirmed item cost (M1) against the trailing quarter's
 *   cost of goods sold; DSO is the countback the credit screen shows.
 *   The cash cycle is their sum only when all three exist -- a cycle
 *   with an invented leg is worse than none.
 */

export interface VendorRow {
  readonly partyId: string;
  readonly vendor: string;
  readonly net: string;
  readonly lastYear: string;
  readonly sharePct: number;
}

export interface PayableRow {
  readonly partyId: string;
  readonly vendor: string;
  readonly payable: string;
}

export interface PurchaseRead {
  readonly from: string;
  readonly to: string;
  readonly purchases: {
    readonly net: string;
    readonly lastYear: string;
    readonly delta: DeltaReading;
    readonly vouchers: number;
    readonly vendors: number;
  };
  readonly byVendor: readonly VendorRow[];
  readonly trend: readonly { month: string; net: string }[];
  readonly payables: {
    readonly total: string;
    readonly rows: readonly PayableRow[];
    readonly basis: string;
  };
  readonly cycle: {
    readonly dsoDays: number | null;
    readonly dioDays: number | null;
    readonly dpoDays: number | null;
    readonly cccDays: number | null;
    readonly notes: readonly string[];
  };
}

@Injectable()
export class PurchasesService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly credit: CreditControlService,
  ) {}

  async read(principal: Principal, from: string, to: string): Promise<PurchaseRead> {
    const today = istDateOf(new Date().toISOString());
    const window = await this.db.execute<{ net: string | null; lastYear: string | null; vouchers: number; vendors: number }>(sql`
      SELECT
        sum(CASE WHEN voucher_type = 'Purchase' THEN amount ELSE -amount END)
          FILTER (WHERE voucher_date BETWEEN ${from} AND ${to})::text AS net,
        sum(CASE WHEN voucher_type = 'Purchase' THEN amount ELSE -amount END)
          FILTER (WHERE voucher_date BETWEEN (${from}::date - 365) AND (${to}::date - 365))::text AS "lastYear",
        count(*) FILTER (WHERE voucher_type = 'Purchase' AND voucher_date BETWEEN ${from} AND ${to})::int AS vouchers,
        count(DISTINCT party_id) FILTER (WHERE voucher_type = 'Purchase' AND voucher_date BETWEEN ${from} AND ${to})::int AS vendors
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND is_cancelled = false AND voucher_type IN ('Purchase', 'Debit Note')
    `);
    const w = window.rows[0];
    const net = Number(w?.net ?? 0);
    const lastYear = Number(w?.lastYear ?? 0);

    const byVendor = await this.db.execute<{ partyId: string; vendor: string; net: string; lastYear: string }>(sql`
      SELECT v.party_id AS "partyId", coalesce(p.name, nullif(v.party_name, ''), 'Unnamed vendor') AS vendor,
        coalesce(sum(CASE WHEN v.voucher_type = 'Purchase' THEN v.amount ELSE -v.amount END)
          FILTER (WHERE v.voucher_date BETWEEN ${from} AND ${to}), 0)::text AS net,
        coalesce(sum(CASE WHEN v.voucher_type = 'Purchase' THEN v.amount ELSE -v.amount END)
          FILTER (WHERE v.voucher_date BETWEEN (${from}::date - 365) AND (${to}::date - 365)), 0)::text AS "lastYear"
      FROM vouchers v LEFT JOIN parties p ON p.id = v.party_id
      WHERE v.org_id = ${principal.orgId} AND v.is_cancelled = false AND v.voucher_type IN ('Purchase', 'Debit Note')
        AND v.party_id IS NOT NULL
      GROUP BY 1, 2
      HAVING sum(v.amount) FILTER (WHERE v.voucher_date BETWEEN ${from} AND ${to}) IS NOT NULL
      ORDER BY 3 DESC
      LIMIT 15
    `);

    const trend = await this.db.execute<{ month: string; net: string }>(sql`
      SELECT to_char(date_trunc('month', voucher_date), 'YYYY-MM') AS month,
             sum(CASE WHEN voucher_type = 'Purchase' THEN amount ELSE -amount END)::text AS net
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND is_cancelled = false AND voucher_type IN ('Purchase', 'Debit Note')
        AND voucher_date > (${to}::date - 365)
      GROUP BY 1 ORDER BY 1
    `);

    // The payable book: opening plus everything that ever happened, per
    // vendor. Not an ageing -- bill-wise dates are not in the projection.
    const payables = await this.db.execute<{ partyId: string; vendor: string; payable: string }>(sql`
      SELECT p.id AS "partyId", p.name AS vendor,
        (coalesce(p.opening_balance, 0) + coalesce(sum(
          CASE WHEN v.voucher_type = 'Purchase' THEN v.amount
               WHEN v.voucher_type IN ('Payment', 'Debit Note') THEN -v.amount
               ELSE 0 END), 0))::numeric(16,2)::text AS payable
      FROM parties p
      LEFT JOIN vouchers v ON v.party_id = p.id AND v.is_cancelled = false
        AND v.voucher_type IN ('Purchase', 'Payment', 'Debit Note')
      WHERE p.org_id = ${principal.orgId} AND lower(p.parent_group) LIKE 'sundry creditors%'
      GROUP BY 1, 2
      HAVING (coalesce(p.opening_balance, 0) + coalesce(sum(
        CASE WHEN v.voucher_type = 'Purchase' THEN v.amount
             WHEN v.voucher_type IN ('Payment', 'Debit Note') THEN -v.amount
             ELSE 0 END), 0)) <> 0
      ORDER BY 3 DESC
      LIMIT 25
    `);
    const payablesTotal = payables.rows.reduce((sum, r) => sum + Number(r.payable), 0);

    // DPO: today's payable book over a year of purchases per day.
    const year = await this.db.execute<{ net: string | null }>(sql`
      SELECT sum(CASE WHEN voucher_type = 'Purchase' THEN amount ELSE -amount END)::text AS net
      FROM vouchers
      WHERE org_id = ${principal.orgId} AND is_cancelled = false AND voucher_type IN ('Purchase', 'Debit Note')
        AND voucher_date > (${today}::date - 365)
    `);
    const purchasesYear = Number(year.rows[0]?.net ?? 0);
    const notes: string[] = [];
    let dpoDays: number | null = null;
    if (purchasesYear > 0) {
      dpoDays = Math.round(payablesTotal / (purchasesYear / 365));
    } else {
      notes.push('DPO needs a year of purchase vouchers; none have arrived yet.');
    }

    // DIO: closing stock at the confirmed item cost (M1) over the trailing
    // quarter's cost of goods sold from the sales fact.
    const stock = await this.db.execute<{ value: string | null }>(sql`
      SELECT sum(closing_qty * cost_price)::text AS value
      FROM stock_items
      WHERE org_id = ${principal.orgId} AND closing_qty IS NOT NULL AND cost_price IS NOT NULL AND closing_qty > 0
    `);
    const cogs = await this.db.execute<{ landed: string | null }>(sql`
      SELECT sum(landed_cost)::text AS landed FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND date > (${today}::date - 90)
    `);
    const stockValue = Number(stock.rows[0]?.value ?? 0);
    const cogs90 = Number(cogs.rows[0]?.landed ?? 0);
    let dioDays: number | null = null;
    if (stockValue > 0 && cogs90 > 0) {
      dioDays = Math.round(stockValue / (cogs90 / 90));
    } else {
      notes.push(stockValue <= 0
        ? 'DIO needs closing stock quantities from Tally; the item master carries none yet.'
        : 'DIO needs costed sales in the trailing quarter.');
    }

    const receivables = await this.credit.receivables(principal, from, to);
    const dsoDays = receivables.dsoCountback === null ? null : Math.round(receivables.dsoCountback);
    if (dsoDays === null) notes.push('DSO needs receivable snapshots in the window.');

    const cccDays = dsoDays !== null && dioDays !== null && dpoDays !== null ? dsoDays + dioDays - dpoDays : null;
    if (cccDays === null && notes.length === 0) notes.push('The cash cycle waits for all three legs.');

    return {
      from,
      to,
      purchases: {
        net: net.toFixed(2),
        lastYear: lastYear.toFixed(2),
        delta: readDelta(net, lastYear, 25_000),
        vouchers: w?.vouchers ?? 0,
        vendors: w?.vendors ?? 0,
      },
      byVendor: byVendor.rows.map((r) => ({
        partyId: r.partyId,
        vendor: r.vendor,
        net: Number(r.net).toFixed(2),
        lastYear: Number(r.lastYear).toFixed(2),
        sharePct: net > 0 ? Math.round((Number(r.net) / net) * 1000) / 10 : 0,
      })),
      trend: trend.rows.map((r) => ({ month: r.month, net: Number(r.net).toFixed(2) })),
      payables: {
        total: payablesTotal.toFixed(2),
        rows: payables.rows,
        basis: 'Opening balance plus purchases, less payments and debit notes, per Sundry Creditors ledger. Bill-wise ageing is not in the projection.',
      },
      cycle: { dsoDays, dioDays, dpoDays, cccDays, notes },
    };
  }
}
