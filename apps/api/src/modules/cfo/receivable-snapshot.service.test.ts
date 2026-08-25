import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness } from '../../test-support/api-harness.js';

import { ReceivableSnapshotService } from './receivable-snapshot.service.js';

/**
 * D-23 end to end: projected vouchers and bill allocations into one day's
 * photograph of the open book. Every expected figure is hand-worked beside
 * its fixture, because the whole service is bookkeeping and bookkeeping is
 * checkable on paper.
 *
 * July 2026, snapshot taken for the 31st. Three debtors and one creditor:
 *
 *   Asha (voucher grain, 10 credit days, opening balance 5,000):
 *     Sales V-1 2,000 on Jul 10, Receipt 4,000 on Jul 15. The receipt
 *     settles the opening bill first (FIFO), leaving 1,000 on it and the
 *     whole of V-1 open. A cancelled Sales on Jul 2 must leave no trace.
 *   Bina (billwise, Tally dates): two Sales both named BILL-7 — 3,000 due
 *     Jul 6 and 1,000 due Jul 25 — and a receipt of 1,000 against the name.
 *     The projection cannot split a shared name, so one merged row, aged by
 *     the OLDEST due date.
 *   Chand (voucher grain, 0 credit days, opening balance -1,500):
 *     Sales V-9 2,000 on Jul 5; the advance is consumed before it ages,
 *     leaving 500 open on a bill raised for 2,000.
 *   Steel Vendor (creditor): a Purchase that must never enter a
 *     receivables photograph.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000cf0d';
const SNAPSHOT_DATE = '2026-07-31';

let harness: ApiHarness;
let service: ReceivableSnapshotService;
let connectionId = '';
let ashaId = '';
let binaId = '';
let chandId = '';
let vendorId = '';

async function party(opts: { name: string; group: string; creditDays: number; opening?: number }): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days, opening_balance)
    VALUES (${ORG_ID}, ${connectionId}, ${opts.name}, ${opts.group}, ${opts.creditDays}, ${opts.opening ?? null})
    RETURNING id
  `);
  return rows.rows[0]?.id ?? '';
}

async function voucher(opts: {
  number: string;
  type: string;
  on: string;
  amount: number;
  partyId: string;
  cancelled?: boolean;
}): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, ${opts.on}::date, ${opts.type}, ${opts.number}, '', ${opts.partyId}, '', ${opts.cancelled ?? false}, ${opts.amount}, now())
    RETURNING id
  `);
  return rows.rows[0]?.id ?? '';
}

async function allocation(opts: {
  voucherId: string;
  partyId: string;
  billName: string;
  refType: 'new' | 'against';
  billDate: string;
  dueDate: string | null;
  amount: number;
}): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO bill_allocations (org_id, connection_id, voucher_id, party_id, party_name, bill_name, ref_type, bill_date, due_date, amount)
    VALUES (${ORG_ID}, ${connectionId}, ${opts.voucherId}, ${opts.partyId}, '', ${opts.billName}, ${opts.refType}, ${opts.billDate}::date, ${opts.dueDate}::date, ${opts.amount})
  `);
}

type WrittenRow = {
  party_id: string;
  bill_ref: string;
  bill_date: string | null;
  due_date: string | null;
  amount: string;
  outstanding: string;
  days_overdue: number;
  bucket: string;
  source: string;
};

async function writtenRows(): Promise<WrittenRow[]> {
  const rows = await harness.db.execute<WrittenRow>(sql`
    SELECT party_id, bill_ref, bill_date::text AS bill_date, due_date::text AS due_date,
           amount::text AS amount, outstanding::text AS outstanding, days_overdue, bucket, source
      FROM fact_receivable_snapshot
     WHERE org_id = ${ORG_ID} AND snapshot_date = ${SNAPSHOT_DATE}::date
     ORDER BY bill_date, bill_ref
  `);
  return rows.rows;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'CFO Org');
  service = harness.resolve(ReceivableSnapshotService);

  // The snapshot holds parties RESTRICT, and allocations cascade off their
  // vouchers, so the photograph goes first and the vouchers carry the rest.
  await harness.db.execute(sql`DELETE FROM fact_receivable_snapshot WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'CFO Co', ${`guid-cfo-${ORG_ID}`}) RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';

  ashaId = await party({ name: 'Asha Traders', group: 'Sundry Debtors', creditDays: 10, opening: 5_000 });
  binaId = await party({ name: 'Bina Textiles', group: 'Sundry Debtors', creditDays: 5 });
  chandId = await party({ name: 'Chand Stores', group: 'Sundry Debtors', creditDays: 0, opening: -1_500 });
  vendorId = await party({ name: 'Steel Vendor', group: 'Sundry Creditors', creditDays: 15 });

  // The org's earliest voucher is Jul 1, so that is where the books begin
  // and where every opening balance seeds.
  const binaSale1 = await voucher({ number: 'B-SL-1', type: 'Sales', on: '2026-07-01', amount: 3_000, partyId: binaId });
  await allocation({ voucherId: binaSale1, partyId: binaId, billName: 'BILL-7', refType: 'new', billDate: '2026-07-01', dueDate: '2026-07-06', amount: 3_000 });
  const binaSale2 = await voucher({ number: 'B-SL-2', type: 'Sales', on: '2026-07-20', amount: 1_000, partyId: binaId });
  await allocation({ voucherId: binaSale2, partyId: binaId, billName: 'BILL-7', refType: 'new', billDate: '2026-07-20', dueDate: '2026-07-25', amount: 1_000 });
  const binaReceipt = await voucher({ number: 'B-RC-1', type: 'Receipt', on: '2026-07-10', amount: 1_000, partyId: binaId });
  await allocation({ voucherId: binaReceipt, partyId: binaId, billName: 'BILL-7', refType: 'against', billDate: '2026-07-01', dueDate: null, amount: -1_000 });

  await voucher({ number: 'V-1', type: 'Sales', on: '2026-07-10', amount: 2_000, partyId: ashaId });
  await voucher({ number: 'A-RC-1', type: 'Receipt', on: '2026-07-15', amount: 4_000, partyId: ashaId });
  await voucher({ number: 'V-X', type: 'Sales', on: '2026-07-02', amount: 999, partyId: ashaId, cancelled: true });

  await voucher({ number: 'V-9', type: 'Sales', on: '2026-07-05', amount: 2_000, partyId: chandId });

  await voucher({ number: 'PU-1', type: 'Purchase', on: '2026-07-03', amount: 20_000, partyId: vendorId });
});

afterAll(async () => {
  await harness.close();
});

describe('one day of the receivable photograph', () => {
  it('writes the open book: opening balances seeded, billwise and voucher grain apart, nothing else', async () => {
    const written = await service.buildOrgDay(ORG_ID, SNAPSHOT_DATE);
    expect(written).toBe(4);

    const rows = await writtenRows();
    expect(rows).toEqual([
      // Asha's opening balance: a keyless bill of the books' first day,
      // named by its date, 4,000 of it taken by the receipt. Due Jul 11
      // (10 credit days), so 20 days overdue on the 31st.
      {
        party_id: ashaId,
        bill_ref: '2026-07-01',
        bill_date: '2026-07-01',
        due_date: '2026-07-11',
        amount: '5000.00',
        outstanding: '1000.00',
        days_overdue: 20,
        bucket: '0-30',
        source: 'voucher',
      },
      // Bina's merged name: 3,000 + 1,000 raised, 1,000 received, aged by
      // the OLDEST due date — Jul 6, 25 days before the snapshot.
      {
        party_id: binaId,
        bill_ref: 'BILL-7',
        bill_date: '2026-07-01',
        due_date: '2026-07-06',
        amount: '4000.00',
        outstanding: '3000.00',
        days_overdue: 25,
        bucket: '0-30',
        source: 'billwise',
      },
      // Chand's advance is consumed before the bill ages: raised 2,000,
      // 500 still open, due on its own date (0 credit days).
      {
        party_id: chandId,
        bill_ref: 'V-9',
        bill_date: '2026-07-05',
        due_date: '2026-07-05',
        amount: '2000.00',
        outstanding: '500.00',
        days_overdue: 26,
        bucket: '0-30',
        source: 'voucher',
      },
      // Asha's V-1, untouched: the receipt went to the older opening bill.
      {
        party_id: ashaId,
        bill_ref: 'V-1',
        bill_date: '2026-07-10',
        due_date: '2026-07-20',
        amount: '2000.00',
        outstanding: '2000.00',
        days_overdue: 11,
        bucket: '0-30',
        source: 'voucher',
      },
    ]);
  });

  it('a rerun replaces the day as a unit, never doubles it', async () => {
    const written = await service.buildOrgDay(ORG_ID, SNAPSHOT_DATE);
    expect(written).toBe(4);
    expect((await writtenRows()).length).toBe(4);
  });

  it('a replayed earlier date reads only what existed by then', async () => {
    // On Jul 4 the books hold Bina's first bill (due Jul 6, not yet due),
    // Asha's opening bill (due Jul 11), and Chand's advance — no open bill
    // for Chand yet, and no receipts anywhere.
    const written = await service.buildOrgDay(ORG_ID, '2026-07-04');
    expect(written).toBe(2);
    const rows = await harness.db.execute<{ bill_ref: string; outstanding: string; bucket: string }>(sql`
      SELECT bill_ref, outstanding::text AS outstanding, bucket
        FROM fact_receivable_snapshot
       WHERE org_id = ${ORG_ID} AND snapshot_date = '2026-07-04'::date
       ORDER BY bill_ref
    `);
    expect(rows.rows).toEqual([
      { bill_ref: '2026-07-01', outstanding: '5000.00', bucket: 'current' },
      { bill_ref: 'BILL-7', outstanding: '3000.00', bucket: 'current' },
    ]);
  });
});
