import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness } from '../../test-support/api-harness.js';

import { ReceivableSnapshotService } from './receivable-snapshot.service.js';

/**
 * D-23 end to end: the projection into the daily photograph. One org, one
 * snapshot date, both constructions side by side —
 *
 * Billwise Traders (bill-wise, due dates from Tally):
 *   B-100 raised 10,000 on Aug 1 due Aug 15, 4,000 received Aug 10
 *     -> open 6,000, five days overdue on Aug 20.
 *   B-099 raised 2,000 on Jul 1 due Jul 10, settled in full Jul 20
 *     -> absent: a snapshot is the open book.
 *
 * Cash Grain Stores (no allocation rows, 10 credit days):
 *   V-1 Sales 5,000 on Jul 1 (due Jul 11), Receipt 2,000 on Jul 20 FIFO
 *     -> open 3,000, forty days overdue on Aug 20.
 *   V-2 Sales 1,000 on Aug 18 (due Aug 28) -> current.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0e0';
const SNAPSHOT_DATE = '2026-08-20';

let harness: ApiHarness;
let builder: ReceivableSnapshotService;
let connectionId = '';
let billwisePartyId = '';
let voucherPartyId = '';

async function voucher(opts: { number: string; type: string; on: string; amount: number; partyId: string }): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, ${opts.on}::date, ${opts.type}, ${opts.number}, '', ${opts.partyId}, '', false, ${opts.amount}, now())
    RETURNING id
  `);
  return rows.rows[0]?.id ?? '';
}

async function allocation(opts: {
  voucherId: string;
  billName: string;
  refType: 'new' | 'against';
  amount: number;
  billDate?: string;
  dueDate?: string;
}): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO bill_allocations (org_id, connection_id, voucher_id, party_id, party_name, bill_name, ref_type, bill_date, due_date, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${opts.voucherId}, ${billwisePartyId}, 'Billwise Traders', ${opts.billName}, ${opts.refType}, ${opts.billDate ?? null}::date, ${opts.dueDate ?? null}::date, ${opts.amount}, now())
  `);
}

type SnapshotRow = {
  bill_ref: string;
  party_id: string;
  bill_date: string | null;
  due_date: string | null;
  amount: string;
  outstanding: string;
  days_overdue: number;
  bucket: string;
  source: string;
};

async function snapshotRows(): Promise<SnapshotRow[]> {
  const rows = await harness.db.execute<SnapshotRow>(sql`
    SELECT bill_ref, party_id, bill_date::text AS bill_date, due_date::text AS due_date,
           amount::text AS amount, outstanding::text AS outstanding, days_overdue, bucket, source
      FROM fact_receivable_snapshot
     WHERE org_id = ${ORG_ID} AND snapshot_date = ${SNAPSHOT_DATE}::date
     ORDER BY bill_ref
  `);
  return rows.rows;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'CFO Snapshot Org');
  builder = harness.resolve(ReceivableSnapshotService);

  await harness.db.execute(sql`DELETE FROM fact_receivable_snapshot WHERE org_id = ${ORG_ID}`);
  // Allocations cascade with their vouchers.
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'CFO Co', ${`guid-cfo-${ORG_ID}`}) RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';

  const billwise = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days) VALUES (${ORG_ID}, ${connectionId}, 'Billwise Traders', 'Sundry Debtors', 15) RETURNING id
  `);
  billwisePartyId = billwise.rows[0]?.id ?? '';
  const voucherGrain = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days) VALUES (${ORG_ID}, ${connectionId}, 'Cash Grain Stores', 'Sundry Debtors', 10) RETURNING id
  `);
  voucherPartyId = voucherGrain.rows[0]?.id ?? '';

  // The billwise party: an open bill, part-settled, and a fully settled one.
  const s100 = await voucher({ number: 'S-100', type: 'Sales', on: '2026-08-01', amount: 10_000, partyId: billwisePartyId });
  await allocation({ voucherId: s100, billName: 'B-100', refType: 'new', amount: 10_000, billDate: '2026-08-01', dueDate: '2026-08-15' });
  const r200 = await voucher({ number: 'R-200', type: 'Receipt', on: '2026-08-10', amount: 4_000, partyId: billwisePartyId });
  await allocation({ voucherId: r200, billName: 'B-100', refType: 'against', amount: -4_000 });
  const s099 = await voucher({ number: 'S-099', type: 'Sales', on: '2026-07-01', amount: 2_000, partyId: billwisePartyId });
  await allocation({ voucherId: s099, billName: 'B-099', refType: 'new', amount: 2_000, billDate: '2026-07-01', dueDate: '2026-07-10' });
  const r199 = await voucher({ number: 'R-199', type: 'Receipt', on: '2026-07-20', amount: 2_000, partyId: billwisePartyId });
  await allocation({ voucherId: r199, billName: 'B-099', refType: 'against', amount: -2_000 });

  // The voucher-grain party: no allocation rows anywhere.
  await voucher({ number: 'V-1', type: 'Sales', on: '2026-07-01', amount: 5_000, partyId: voucherPartyId });
  await voucher({ number: 'REC-1', type: 'Receipt', on: '2026-07-20', amount: 2_000, partyId: voucherPartyId });
  await voucher({ number: 'V-2', type: 'Sales', on: '2026-08-18', amount: 1_000, partyId: voucherPartyId });

  await builder.buildOrgDay(ORG_ID, SNAPSHOT_DATE);
});

afterAll(async () => {
  await harness.close();
});

describe('the receivable snapshot, one day of the open book', () => {
  it('writes the open bills and only the open bills', async () => {
    const rows = await snapshotRows();
    expect(rows.map((row) => row.bill_ref)).toEqual(['B-100', 'V-1', 'V-2']);
    // B-099 was settled in full: a snapshot is the open book.
    expect(rows.some((row) => row.bill_ref === 'B-099')).toBe(false);
  });

  it('reads the billwise party at bill grain, with Tally dates and summed outstanding', async () => {
    const rows = await snapshotRows();
    const b100 = rows.find((row) => row.bill_ref === 'B-100');
    expect(b100).toMatchObject({
      party_id: billwisePartyId,
      bill_date: '2026-08-01',
      due_date: '2026-08-15',
      amount: '10000.00',
      outstanding: '6000.00',
      days_overdue: 5,
      bucket: '0-30',
      source: 'billwise',
    });
  });

  it('reads the allocation-less party at voucher grain, FIFO against the oldest bill', async () => {
    const rows = await snapshotRows();
    const v1 = rows.find((row) => row.bill_ref === 'V-1');
    // The 2,000 receipt settled part of V-1; due Jul 11 puts Aug 20 forty days out.
    expect(v1).toMatchObject({
      party_id: voucherPartyId,
      bill_date: '2026-07-01',
      due_date: '2026-07-11',
      amount: '5000.00',
      outstanding: '3000.00',
      days_overdue: 40,
      bucket: '31-60',
      source: 'voucher',
    });
    const v2 = rows.find((row) => row.bill_ref === 'V-2');
    expect(v2).toMatchObject({
      party_id: voucherPartyId,
      due_date: '2026-08-28',
      outstanding: '1000.00',
      days_overdue: 0,
      bucket: 'current',
      source: 'voucher',
    });
  });

  it('never mixes the constructions for one party on one day', async () => {
    const rows = await snapshotRows();
    const sources = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = sources.get(row.party_id) ?? new Set<string>();
      set.add(row.source);
      sources.set(row.party_id, set);
    }
    for (const set of sources.values()) expect(set.size).toBe(1);
    // The billwise party's Sales vouchers must not double as voucher-grain bills.
    expect(rows.filter((row) => row.party_id === billwisePartyId)).toHaveLength(1);
  });

  it('repairs on rerun rather than duplicating', async () => {
    const before = await snapshotRows();
    await builder.buildOrgDay(ORG_ID, SNAPSHOT_DATE);
    const after = await snapshotRows();
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.bill_ref)).toEqual(before.map((row) => row.bill_ref));
  });
});
