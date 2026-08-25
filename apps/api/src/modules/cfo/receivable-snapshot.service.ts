import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { openBillsThrough, type BillEvent, type SettlementEvent } from '../../platform/receivables/bill-series.js';
import { bucketFor, daysOverdueOn, dueDateFor, type ReceivableBucket, type ReceivableSource } from './cfo-math.js';

/**
 * Writes one organisation's open receivable book for one snapshot date
 * (D-23). Two constructions, never both for one party on one day:
 *
 * - `billwise` where Tally sent bill_allocations rows for the party — a
 *   bill is its rows summed, exactly as the ageing report reads them.
 * - `voucher` for parties with no allocation rows — each Sales voucher a
 *   bill, receipts and credit notes settling oldest-first through the
 *   platform ledger, due = voucher date + the party's credit days.
 *
 * A party with allocation rows stays billwise even when every bill is
 * settled: its receipts carry marks the voucher walk would misread as FIFO,
 * so falling back would invent open bills the books do not show.
 */

/**
 * 500 rows of 11 parameters stays far inside the wire protocol's 65,535
 * bind limit while keeping one day's write to a handful of round trips.
 */
const INSERT_CHUNK = 500;

type BillwiseRow = {
  party_id: string;
  bill_name: string;
  bill_date: string | null;
  due_date: string | null;
  credit_days: number | null;
  raised: string | null;
  outstanding: string;
};

type VoucherRow = {
  party_id: string;
  voucher_date: string;
  voucher_type: string;
  voucher_number: string;
  amount: string;
  credit_days: number | null;
};

interface SnapshotRow {
  readonly partyId: string;
  readonly billRef: string;
  readonly billDate: string | null;
  readonly dueDate: string | null;
  readonly amount: number;
  readonly outstanding: number;
  readonly daysOverdue: number;
  readonly bucket: ReceivableBucket;
  readonly source: ReceivableSource;
}

@Injectable()
export class ReceivableSnapshotService {
  private readonly logger = new Logger(ReceivableSnapshotService.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  /** Replaces the org+date's rows as a unit: a rerun repairs, never duplicates. */
  async buildOrgDay(orgId: string, snapshotDate: string): Promise<number> {
    const { rows, billwiseParties } = await this.billwiseRows(orgId, snapshotDate);
    rows.push(...(await this.voucherGrainRows(orgId, snapshotDate, billwiseParties)));

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM fact_receivable_snapshot
         WHERE org_id = ${orgId} AND snapshot_date = ${snapshotDate}::date
      `);
      for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
        const chunk = rows.slice(start, start + INSERT_CHUNK);
        // Parameterised VALUES rather than the interest writer's text-array
        // trick: a Tally bill name may carry any character a literal cannot.
        const values = chunk.map(
          (row) => sql`(${orgId}, ${snapshotDate}::date, ${row.partyId}, ${row.billRef}, ${row.billDate}::date,
            ${row.dueDate}::date, ${row.amount.toFixed(2)}::numeric, ${row.outstanding.toFixed(2)}::numeric,
            ${row.daysOverdue}, ${row.bucket}, ${row.source})`,
        );
        await tx.execute(sql`
          INSERT INTO fact_receivable_snapshot
            (org_id, snapshot_date, party_id, bill_ref, bill_date, due_date, amount, outstanding, days_overdue, bucket, source)
          VALUES ${sql.join(values, sql`, `)}
        `);
      }
    });

    this.logger.log({ msg: 'Receivable snapshot written', orgId, snapshotDate, rows: rows.length });
    return rows.length;
  }

  /**
   * Tally's own bill-wise book: a bill is its `new` and `against` rows
   * summed, open when the sum is positive after rounding to the paisa — a
   * hundredth of a rupee left by a part payment is not an open bill.
   * `advance` and `on_account` rows are excluded for the reason the ageing
   * report excludes them: money with no bill attached has no date to age
   * from. Rows whose ledger name matched no projected party cannot land in
   * a table keyed by party and are left to the statement.
   */
  private async billwiseRows(
    orgId: string,
    snapshotDate: string,
  ): Promise<{ rows: SnapshotRow[]; billwiseParties: Set<string> }> {
    // The voucher join keeps the photograph honest for a replayed date —
    // only allocations from vouchers that existed by then — and drops
    // cancelled vouchers, whose allocation rows survive until a re-pull
    // rewrites them, the way the voucher-grain walk already drops them.
    const billwise = await this.db.execute<BillwiseRow>(sql`
      SELECT b.party_id,
             b.bill_name,
             min(b.bill_date)::text AS bill_date,
             max(b.due_date)::text AS due_date,
             p.credit_days,
             round(sum(b.amount) FILTER (WHERE b.ref_type = 'new'), 2)::text AS raised,
             round(sum(b.amount), 2)::text AS outstanding
        FROM bill_allocations b
        JOIN vouchers v ON v.id = b.voucher_id
        JOIN parties p ON p.id = b.party_id
       WHERE b.org_id = ${orgId}
         AND b.ref_type IN ('new', 'against')
         AND b.party_id IS NOT NULL
         AND p.parent_group = 'Sundry Debtors'
         AND NOT v.is_cancelled
         AND v.voucher_date <= ${snapshotDate}::date
       GROUP BY b.party_id, b.bill_name, p.credit_days
    `);

    const billwiseParties = new Set<string>();
    const rows: SnapshotRow[] = [];
    for (const bill of billwise.rows) {
      billwiseParties.add(bill.party_id);
      const outstanding = Number(bill.outstanding);
      if (outstanding <= 0) continue;
      // Tally's own due date where the company set one; else the party's
      // credit days over the bill's date — the voucher grain's rule, so the
      // two sources age alike. A bill with no date at all cannot age.
      const dueDate =
        bill.due_date ?? (bill.bill_date === null ? null : dueDateFor(bill.bill_date, bill.credit_days ?? 0));
      // A bill opened before the sync window has no `new` row in the
      // projection; what is outstanding is the only raise we can see.
      const raised = Number(bill.raised ?? '0');
      const daysOverdue = daysOverdueOn(snapshotDate, dueDate);
      rows.push({
        partyId: bill.party_id,
        billRef: bill.bill_name,
        billDate: bill.bill_date,
        dueDate,
        amount: raised > 0 ? raised : outstanding,
        outstanding,
        daysOverdue,
        bucket: bucketFor(daysOverdue),
        source: 'billwise',
      });
    }
    return { rows, billwiseParties };
  }

  /** The voucher-grain fallback, through the platform ledger. */
  private async voucherGrainRows(
    orgId: string,
    snapshotDate: string,
    billwiseParties: ReadonlySet<string>,
  ): Promise<SnapshotRow[]> {
    const vouchers = await this.db.execute<VoucherRow>(sql`
      SELECT v.party_id, v.voucher_date::text AS voucher_date, v.voucher_type, v.voucher_number,
             v.amount::text AS amount, p.credit_days
        FROM vouchers v
        JOIN parties p ON p.id = v.party_id
       WHERE v.org_id = ${orgId} AND NOT v.is_cancelled
         AND p.parent_group = 'Sundry Debtors'
         AND v.voucher_type IN ('Sales', 'Receipt', 'Credit Note')
         AND v.voucher_date <= ${snapshotDate}::date
       ORDER BY v.voucher_date, v.created_at
    `);

    const byParty = new Map<string, VoucherRow[]>();
    for (const voucher of vouchers.rows) {
      if (billwiseParties.has(voucher.party_id)) continue;
      const list = byParty.get(voucher.party_id) ?? [];
      list.push(voucher);
      byParty.set(voucher.party_id, list);
    }

    const rows: SnapshotRow[] = [];
    for (const [partyId, partyVouchers] of byParty) {
      const bills: BillEvent[] = [];
      const settlements: SettlementEvent[] = [];
      for (const voucher of partyVouchers) {
        const amount = Math.abs(Number(voucher.amount));
        if (amount === 0) continue;
        if (voucher.voucher_type === 'Sales') {
          bills.push({ date: voucher.voucher_date, amount, key: voucher.voucher_number });
        } else {
          settlements.push({ date: voucher.voucher_date, amount });
        }
      }

      const creditDays = partyVouchers[0]?.credit_days ?? 0;
      const usedRefs = new Set<string>();
      for (const open of openBillsThrough({ through: snapshotDate, bills, settlements })) {
        const outstanding = Math.round(open.outstanding * 100) / 100;
        if (outstanding <= 0) continue;
        const dueDate = dueDateFor(open.date, creditDays);
        const daysOverdue = daysOverdueOn(snapshotDate, dueDate);
        rows.push({
          partyId,
          billRef: uniqueRef(usedRefs, open.key ?? '', open.date),
          billDate: open.date,
          dueDate,
          amount: open.amount,
          outstanding,
          daysOverdue,
          bucket: bucketFor(daysOverdue),
          source: 'voucher',
        });
      }
    }
    return rows;
  }
}

/**
 * Tally restarts voucher numbers each financial year, so one party can hold
 * two open bills both named "1" — and a voucher can arrive unnumbered. The
 * unique key is (org, date, party, ref), so the later bill takes its own
 * date as a disambiguator rather than failing the whole day's write.
 */
function uniqueRef(used: Set<string>, ref: string, billDate: string): string {
  const base = ref === '' ? billDate : ref;
  let candidate = base;
  if (used.has(candidate)) candidate = `${base} (${billDate})`;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${base} (${billDate}) #${n}`;
  used.add(candidate);
  return candidate;
}
