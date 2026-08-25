import { Injectable, Logger } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import {
  buildPartyDailySeries,
  epochDay,
  isoOfEpochDay,
  type BillEvent,
  type PartyDay,
  type SettlementEvent,
} from '../../platform/receivables/bill-series.js';
import type { InterestPolicy } from '../../platform/settings/settings.catalogue.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { buildStockDailySeries, type StockDay, type StockEvent } from './interest-math.js';
import { readInterestPolicy } from './interest-policy.js';

/**
 * Materialises the daily closing balance series (D-22) into the snapshot
 * tables the report sources read. The walk always replays the voucher
 * projection from the series start — voucher-grain FIFO is linear and the
 * projection is the only truth — but only the recompute window is written,
 * so a backdated entry inside the window corrects itself nightly and one
 * outside it is what the recompute endpoint exists for.
 *
 * History is full backfill (D-22 rule 6): the first run walks from the
 * earliest voucher the projection holds, and the series says so by simply
 * starting there.
 */

/** How each voucher type moves a party's balance, per side of the ledger. */
const DEBTOR_BILLS: ReadonlySet<string> = new Set(['Sales']);
const DEBTOR_SETTLEMENTS: ReadonlySet<string> = new Set(['Receipt', 'Credit Note']);
const CREDITOR_BILLS: ReadonlySet<string> = new Set(['Purchase']);
const CREDITOR_SETTLEMENTS: ReadonlySet<string> = new Set(['Payment', 'Debit Note']);

const INSERT_CHUNK = 5_000;

type PartyRow = {
  id: string;
  parent_group: string;
  credit_days: number | null;
  opening_balance: string | null;
  credit_days_override: number | null;
};
type VoucherRow = { id: string; party_id: string; voucher_date: string; voucher_type: string; amount: string };
type AllocationRow = { voucher_id: string; bill_name: string; ref_type: string; amount: string };
type LineRow = {
  stock_item_id: string;
  voucher_date: string;
  voucher_type: string;
  party_id: string | null;
  qty: string;
  rate: string | null;
  amount: string;
  gst_rate: string | null;
};

export interface BuildScope {
  readonly from?: string;
  readonly partyId?: string;
  readonly stockItemId?: string;
  /** The build's "today"; tests pin it, the nightly run leaves it to the clock. */
  readonly today?: string;
}

export interface BuildOutcome {
  readonly partyRows: number;
  readonly stockRows: number;
  readonly builtThrough: string;
}

@Injectable()
export class InterestBuildService {
  private readonly logger = new Logger(InterestBuildService.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  /** Null when the projection holds no voucher yet — there is nothing to build a series from. */
  async buildOrg(orgId: string, scope: BuildScope = {}): Promise<BuildOutcome | null> {
    const policy = await readInterestPolicy(this.db, orgId);
    const earliest = await this.db.execute<{ d: string | null }>(sql`
      SELECT min(voucher_date)::text AS d FROM vouchers WHERE org_id = ${orgId} AND NOT is_cancelled
    `);
    const seriesStart = earliest.rows[0]?.d ?? null;
    if (seriesStart === null) return null;

    const today = scope.today ?? istDateOf(new Date().toISOString());
    const state = await this.db.execute<{ built_through: string }>(sql`
      SELECT built_through::text AS built_through FROM interest_build_state WHERE org_id = ${orgId}
    `);
    const stateRow = state.rows[0];
    const resumeFrom =
      stateRow === undefined
        ? seriesStart
        : isoOfEpochDay(epochDay(stateRow.built_through) - policy.recomputeWindowDays);
    let writeFrom = scope.from ?? resumeFrom;
    if (epochDay(writeFrom) < epochDay(seriesStart)) writeFrom = seriesStart;
    if (epochDay(writeFrom) > epochDay(today)) writeFrom = today;

    const partyRows =
      scope.stockItemId === undefined
        ? await this.buildParties(orgId, seriesStart, writeFrom, today, scope.partyId)
        : 0;
    const stockRows =
      scope.partyId === undefined
        ? await this.buildStock(orgId, policy, seriesStart, writeFrom, today, scope.stockItemId)
        : 0;

    // A scoped rebuild leaves the watermark alone: it corrected one entity,
    // not the org's frontier, and moving the mark would shrink the next
    // night's window for everybody else.
    if (scope.partyId === undefined && scope.stockItemId === undefined) {
      await this.db.execute(sql`
        INSERT INTO interest_build_state (org_id, built_through, built_at)
        VALUES (${orgId}, ${today}::date, now())
        ON CONFLICT (org_id) DO UPDATE SET built_through = ${today}::date, built_at = now()
      `);
    }

    this.logger.log({ msg: 'Interest snapshots built', orgId, writeFrom, today, partyRows, stockRows });
    return { partyRows, stockRows, builtThrough: today };
  }

  // ------------------------------------------------------------ receivables

  private async buildParties(
    orgId: string,
    seriesStart: string,
    writeFrom: string,
    to: string,
    partyId: string | undefined,
  ): Promise<number> {
    const partyFilter: SQL = partyId === undefined ? sql`` : sql`AND p.id = ${partyId}`;
    const parties = await this.db.execute<PartyRow>(sql`
      SELECT p.id, p.parent_group, p.credit_days, p.opening_balance::text AS opening_balance, s.credit_days_override
        FROM parties p
        LEFT JOIN interest_party_settings s
          ON s.org_id = p.org_id AND s.party_id = p.id AND s.deleted_at IS NULL
       WHERE p.org_id = ${orgId} AND p.parent_group IN ('Sundry Debtors', 'Sundry Creditors') ${partyFilter}
    `);

    const voucherFilter: SQL = partyId === undefined ? sql`` : sql`AND v.party_id = ${partyId}`;
    const vouchers = await this.db.execute<VoucherRow>(sql`
      SELECT v.id, v.party_id, v.voucher_date::text AS voucher_date, v.voucher_type, v.amount::text AS amount
        FROM vouchers v
       WHERE v.org_id = ${orgId} AND NOT v.is_cancelled AND v.party_id IS NOT NULL
         AND v.voucher_type IN ('Sales', 'Receipt', 'Credit Note', 'Purchase', 'Payment', 'Debit Note')
         ${voucherFilter}
       ORDER BY v.voucher_date, v.created_at
    `);
    const byParty = new Map<string, VoucherRow[]>();
    for (const voucher of vouchers.rows) {
      const list = byParty.get(voucher.party_id) ?? [];
      list.push(voucher);
      byParty.set(voucher.party_id, list);
    }

    // D-22 rule 5: Tally's bill-wise marks apply where present; everything
    // else falls to FIFO oldest-first. Read wholesale — the table has readers
    // and no production writer yet, so this is usually empty and always cheap.
    const allocations = await this.db.execute<AllocationRow>(sql`
      SELECT b.voucher_id, b.bill_name, b.ref_type, b.amount::text AS amount
        FROM bill_allocations b
       WHERE b.org_id = ${orgId} AND b.ref_type IN ('new', 'against')
    `);
    const allocationsByVoucher = new Map<string, AllocationRow[]>();
    for (const allocation of allocations.rows) {
      const list = allocationsByVoucher.get(allocation.voucher_id) ?? [];
      list.push(allocation);
      allocationsByVoucher.set(allocation.voucher_id, list);
    }

    await this.db.execute(sql`
      DELETE FROM interest_daily_party
       WHERE org_id = ${orgId} AND date >= ${writeFrom}::date AND date <= ${to}::date
       ${partyId === undefined ? sql`` : sql`AND party_id = ${partyId}`}
    `);

    let written = 0;
    for (const party of parties.rows) {
      const isDebtor = party.parent_group === 'Sundry Debtors';
      const billTypes = isDebtor ? DEBTOR_BILLS : CREDITOR_BILLS;
      const settleTypes = isDebtor ? DEBTOR_SETTLEMENTS : CREDITOR_SETTLEMENTS;
      const bills: BillEvent[] = [];
      const settlements: SettlementEvent[] = [];

      for (const voucher of byParty.get(party.id) ?? []) {
        const amount = Math.abs(Number(voucher.amount));
        if (amount === 0) continue;
        const marks = allocationsByVoucher.get(voucher.id) ?? [];
        if (billTypes.has(voucher.voucher_type)) {
          const raised = marks.find((mark) => mark.ref_type === 'new');
          bills.push({ date: voucher.voucher_date, amount, ...(raised === undefined ? {} : { key: raised.bill_name }) });
        } else if (settleTypes.has(voucher.voucher_type)) {
          const against = marks.filter((mark) => mark.ref_type === 'against');
          if (against.length === 0) {
            settlements.push({ date: voucher.voucher_date, amount });
          } else {
            let marked = 0;
            for (const mark of against) {
              const share = Math.abs(Number(mark.amount));
              if (share === 0) continue;
              marked += share;
              settlements.push({ date: voucher.voucher_date, amount: share, billKey: mark.bill_name });
            }
            // The half of a receipt Tally did not mark is on-account: FIFO.
            if (amount - marked > 0.005) settlements.push({ date: voucher.voucher_date, amount: amount - marked });
          }
        }
      }

      const opening = Number(party.opening_balance ?? 0);
      if (bills.length === 0 && settlements.length === 0 && opening === 0) continue;

      const creditDays = party.credit_days_override ?? party.credit_days ?? 0;
      const series = buildPartyDailySeries({
        seriesStart,
        to,
        openingBalance: opening,
        creditDays,
        bills,
        settlements,
      });
      written += await this.writePartyDays(orgId, party.id, trimLeadingZeroes(series, isZeroPartyDay), writeFrom);
    }
    return written;
  }

  private async writePartyDays(
    orgId: string,
    partyId: string,
    series: readonly PartyDay[],
    writeFrom: string,
  ): Promise<number> {
    const days = series.filter((day) => day.date >= writeFrom);
    for (let start = 0; start < days.length; start += INSERT_CHUNK) {
      const chunk = days.slice(start, start + INSERT_CHUNK);
      await this.db.execute(sql`
        INSERT INTO interest_daily_party (org_id, party_id, date, closing, within_credit, overdue)
        SELECT ${orgId}, ${partyId}, t.d::date, t.c::numeric, t.w::numeric, t.o::numeric
          FROM unnest(
            ${pgTextArray(chunk.map((day) => day.date))}::text[],
            ${pgTextArray(chunk.map((day) => day.closing.toFixed(2)))}::text[],
            ${pgTextArray(chunk.map((day) => day.withinCredit.toFixed(2)))}::text[],
            ${pgTextArray(chunk.map((day) => day.overdue.toFixed(2)))}::text[]
          ) AS t(d, c, w, o)
      `);
    }
    return days.length;
  }

  // ------------------------------------------------------------------ stock

  private async buildStock(
    orgId: string,
    policy: InterestPolicy,
    seriesStart: string,
    writeFrom: string,
    to: string,
    stockItemId: string | undefined,
  ): Promise<number> {
    const itemFilter: SQL = stockItemId === undefined ? sql`` : sql`AND vl.stock_item_id = ${stockItemId}`;
    const lines = await this.db.execute<LineRow>(sql`
      SELECT vl.stock_item_id, v.voucher_date::text AS voucher_date, v.voucher_type, v.party_id,
             abs(coalesce(substring(coalesce(vl.billed_qty, vl.actual_qty) FROM '^\\s*-?[0-9]+\\.?[0-9]*')::numeric, 0))::text AS qty,
             vl.rate::text AS rate, vl.amount::text AS amount, si.gst_rate::text AS gst_rate
        FROM voucher_lines vl
        JOIN vouchers v ON v.id = vl.voucher_id
        JOIN stock_items si ON si.id = vl.stock_item_id
       WHERE v.org_id = ${orgId} AND NOT v.is_cancelled AND vl.kind = 'inventory' AND vl.stock_item_id IS NOT NULL
         AND v.voucher_type IN ('Purchase', 'Sales', 'Debit Note')
         ${itemFilter}
       ORDER BY v.voucher_date, v.created_at, vl.line_no
    `);

    // The vendor's credit days fund each inward layer (D-22): the override
    // beats Tally's figure, and a vendor with neither accrues from day zero.
    const vendorTerms = await this.db.execute<{ id: string; credit_days: number | null; credit_days_override: number | null }>(sql`
      SELECT p.id, p.credit_days, s.credit_days_override
        FROM parties p
        LEFT JOIN interest_party_settings s
          ON s.org_id = p.org_id AND s.party_id = p.id AND s.deleted_at IS NULL
       WHERE p.org_id = ${orgId}
    `);
    const creditDaysByParty = new Map<string, number>();
    for (const vendor of vendorTerms.rows) {
      creditDaysByParty.set(vendor.id, vendor.credit_days_override ?? vendor.credit_days ?? 0);
    }

    const byItem = new Map<string, StockEvent[]>();
    for (const line of lines.rows) {
      const quantity = Number(line.qty);
      if (quantity === 0) continue;
      const events = byItem.get(line.stock_item_id) ?? [];
      if (line.voucher_type === 'Purchase') {
        const baseRate = line.rate !== null ? Math.abs(Number(line.rate)) : Math.abs(Number(line.amount)) / quantity;
        const gstFactor =
          policy.includeGstInStock && line.gst_rate !== null ? 1 + Number(line.gst_rate) / 100 : 1;
        const creditDays =
          policy.stockClockStart === 'INWARD'
            ? 0
            : (line.party_id === null ? 0 : (creditDaysByParty.get(line.party_id) ?? 0));
        events.push({ date: line.voucher_date, kind: 'inward', quantity, rate: baseRate * gstFactor, creditDays });
      } else {
        // Sales dispatch and Debit Note alike: the goods leave, and a return
        // to the vendor reduces the series from the return's own date.
        events.push({ date: line.voucher_date, kind: 'outward', quantity });
      }
      byItem.set(line.stock_item_id, events);
    }

    await this.db.execute(sql`
      DELETE FROM interest_daily_stock
       WHERE org_id = ${orgId} AND date >= ${writeFrom}::date AND date <= ${to}::date
       ${stockItemId === undefined ? sql`` : sql`AND stock_item_id = ${stockItemId}`}
    `);

    let written = 0;
    for (const [itemId, events] of byItem) {
      const series = buildStockDailySeries({ seriesStart, to, events });
      written += await this.writeStockDays(orgId, itemId, trimLeadingZeroes(series, isZeroStockDay), writeFrom);
    }
    return written;
  }

  private async writeStockDays(
    orgId: string,
    stockItemId: string,
    series: readonly StockDay[],
    writeFrom: string,
  ): Promise<number> {
    const days = series.filter((day) => day.date >= writeFrom);
    for (let start = 0; start < days.length; start += INSERT_CHUNK) {
      const chunk = days.slice(start, start + INSERT_CHUNK);
      await this.db.execute(sql`
        INSERT INTO interest_daily_stock (org_id, stock_item_id, date, quantity, closing_value, funded_value)
        SELECT ${orgId}, ${stockItemId}, t.d::date, t.q::numeric, t.c::numeric, t.f::numeric
          FROM unnest(
            ${pgTextArray(chunk.map((day) => day.date))}::text[],
            ${pgTextArray(chunk.map((day) => day.quantity.toFixed(3)))}::text[],
            ${pgTextArray(chunk.map((day) => day.closingValue.toFixed(2)))}::text[],
            ${pgTextArray(chunk.map((day) => day.fundedValue.toFixed(2)))}::text[]
          ) AS t(d, q, c, f)
      `);
    }
    return days.length;
  }
}

/**
 * A Postgres array literal as one parameter. Interpolating a JS array into
 * drizzle's template expands it to a value list, which cannot be cast to
 * text[]; the dates and fixed-point figures here contain no character that
 * needs quoting inside a literal.
 */
function pgTextArray(values: readonly string[]): string {
  return `{${values.join(',')}}`;
}

function isZeroPartyDay(day: PartyDay): boolean {
  return day.closing === 0 && day.withinCredit === 0 && day.overdue === 0;
}

function isZeroStockDay(day: StockDay): boolean {
  return day.quantity === 0 && day.closingValue === 0 && day.fundedValue === 0;
}

/**
 * Days before the entity's first movement are not part of its story and
 * would swell the tables with zeroes; days after it are kept, because a
 * balance that fell back to zero is a fact the last-outward detection and
 * the closing-value read both lean on.
 */
function trimLeadingZeroes<T>(series: readonly T[], isZero: (day: T) => boolean): readonly T[] {
  const first = series.findIndex((day) => !isZero(day));
  return first === -1 ? [] : series.slice(first);
}
