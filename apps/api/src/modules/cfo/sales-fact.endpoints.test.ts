import { SYSTEM_ROLES } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { OwnerMapService } from './attribution/owner-map.service.js';
import { SalesFactService } from './sales-fact.service.js';

/**
 * Phase 1's fact and attribution, on hand-computed fixtures (brief 0.8).
 *
 * The day being built: two parties, 20 Aug 2026.
 * - Asha Traders (owner RS from 1 Aug): one Sales voucher, an inventory line
 *   of 2 BOX at 10,000.00 ex-GST, a Trade Discount ledger line of 500.00,
 *   and a tax line that must NOT land in the fact (B1: ex-GST throughout).
 * - Bharat Cables (split RS 60 / MP 40 from 1 Aug): a ledger-only Sales
 *   voucher of 4,130.50 and a Credit Note of 130.50.
 *
 * Hand-computed truth: gross 14,130.50 · discount 500.00 · returns 130.50 ·
 * net 13,500.00. Bharat's split: sales 2,478.30 / 1,652.20 and returns
 * 78.30 / 52.20 — the 60% cut lands on the even paisa both times, and the
 * remainder rule gives any odd paisa to the first owner.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0e4';
const DAY = '2026-08-20';

let harness: ApiHarness;
let facts: SalesFactService;
let owners: OwnerMapService;
let ashaId = '';
let bharatId = '';
let rsRef = '';
let mpRef = '';
let rsToken = '';
let mpId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'CFO Facts Org', { preservePeople: true });
  await harness.db.execute(sql`DELETE FROM fact_sales_daily WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM customer_owner_map WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const rs = await harness.createUser({ email: scopedEmail('cfo-rs'), roleIds: [adminRoleId] });
  const mp = await harness.createUser({ email: scopedEmail('cfo-mp'), roleIds: [adminRoleId] });
  rsRef = `user:${rs.id}`;
  mpRef = `user:${mp.id}`;
  mpId = mp.id;
  rsToken = (await harness.login(rs.email, rs.password)).token;

  facts = harness.resolve(SalesFactService);
  owners = harness.resolve(OwnerMapService);

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'CFO Co', 'guid-cfo-facts') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';

  const asha = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  ashaId = asha.rows[0]?.id ?? '';
  const bharat = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Bharat Cables', 'Sundry Debtors') RETURNING id
  `);
  bharatId = bharat.rows[0]?.id ?? '';

  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'MCB 6A', 'Nos', 'C&S Electric') RETURNING id
  `);
  const itemId = item.rows[0]?.id ?? '';

  await owners.assign(ORG_ID, null, ashaId, [{ ownerRef: rsRef, share: 100 }], '2026-08-01');
  await owners.assign(ORG_ID, null, bharatId, [{ ownerRef: rsRef, share: 60 }, { ownerRef: mpRef, share: 40 }], '2026-08-01');

  const ashaVoucher = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 1, ${DAY}, 'Sales', 'CF-1', 'Asha Traders', ${ashaId}, '', false, 11800.00, now()) RETURNING id
  `);
  const ashaVoucherId = ashaVoucher.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, stock_item_name, stock_item_id, billed_qty, amount) VALUES
      (${ORG_ID}, ${ashaVoucherId}, 1, 'inventory', NULL, NULL, 'MCB 6A', ${itemId}, '2 BOX', 10000.00),
      (${ORG_ID}, ${ashaVoucherId}, 2, 'ledger', 'Trade Discount', false, NULL, NULL, NULL, -500.00),
      (${ORG_ID}, ${ashaVoucherId}, 3, 'ledger', 'Output CGST', false, NULL, NULL, NULL, -2300.00)
  `);

  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at) VALUES
      (${ORG_ID}, ${connectionId}, 1, ${DAY}, 'Sales', 'CF-2', 'Bharat Cables', ${bharatId}, '', false, 4130.50, now()),
      (${ORG_ID}, ${connectionId}, 1, ${DAY}, 'Credit Note', 'CN-1', 'Bharat Cables', ${bharatId}, '', false, 130.50, now()),
      (${ORG_ID}, ${connectionId}, 1, ${DAY}, 'Sales', 'CF-X', 'Cancelled Co', NULL, '', true, 99999.00, now())
  `);
});

afterAll(async () => {
  await harness.close();
});

describe('fact_sales_daily build', () => {
  it('builds the day ex-GST, splits credit exactly, and keeps the cancelled voucher out', async () => {
    const written = await facts.buildOrgDay(ORG_ID, DAY);
    // Asha item row (RS) + Asha discount row (RS) + Bharat sales x2 owners
    // + Bharat credit note x2 owners.
    expect(written).toBe(6);

    const rows = await harness.db.execute<{
      partyName: string;
      salespersonRef: string;
      voucherType: string;
      gross: string;
      discount: string;
      returns: string;
      net: string;
      qty: string;
      brand: string;
    }>(sql`
      SELECT party_name AS "partyName", salesperson_ref AS "salespersonRef", voucher_type AS "voucherType",
             gross::text AS gross, discount::text AS discount, returns::text AS returns, net::text AS net,
             qty::text AS qty, brand
      FROM fact_sales_daily WHERE org_id = ${ORG_ID} AND date = ${DAY}
      ORDER BY party_name, voucher_type, salesperson_ref
    `);

    const asha = rows.rows.filter((r) => r.partyName === 'Asha Traders');
    // The tax line is nowhere: gross is the inventory line, not the voucher total.
    expect(asha.reduce((sum, r) => sum + Number(r.gross), 0)).toBe(10000);
    expect(asha.reduce((sum, r) => sum + Number(r.discount), 0)).toBe(500);
    expect(asha.every((r) => r.salespersonRef === rsRef)).toBe(true);
    expect(asha.find((r) => Number(r.qty) > 0)?.brand).toBe('C&S Electric');
    expect(asha.find((r) => Number(r.qty) > 0)?.qty).toBe('2.000');

    const bharatSales = rows.rows.filter((r) => r.partyName === 'Bharat Cables' && r.voucherType === 'Sales');
    expect(bharatSales.map((r) => [r.salespersonRef, r.gross])).toEqual([
      [mpRef, '1652.20'],
      [rsRef, '2478.30'],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

    const bharatCn = rows.rows.filter((r) => r.partyName === 'Bharat Cables' && r.voucherType === 'Credit Note');
    expect(bharatCn.reduce((sum, r) => sum + Number(r.returns), 0)).toBeCloseTo(130.5, 10);
    // The credit note row is negative net, by exactly its returns.
    expect(bharatCn.reduce((sum, r) => sum + Number(r.net), 0)).toBeCloseTo(-130.5, 10);
  });

  it('reconciles fact, source and every level to the paisa (B3)', async () => {
    const check = await facts.reconcile(ORG_ID, DAY, DAY);
    expect(check.factNet).toBe('13500.00');
    expect(check.sourceNet).toBe('13500.00');
    expect(check.byPersonNet).toBe('13500.00');
    expect(check.byBrandNet).toBe('13500.00');
    expect(check.unassignedNet).toBe('0.00');
    expect(check.ties).toBe(true);
  });

  it('rebuilding replaces the day rather than doubling it', async () => {
    await facts.buildOrgDay(ORG_ID, DAY);
    const check = await facts.reconcile(ORG_ID, DAY, DAY);
    expect(check.factNet).toBe('13500.00');
  });

  it('resolves the owner as of the voucher date: a later reassignment moves nothing old', async () => {
    // Bharat moves wholly to MP from 1 September; the 20 August day, rebuilt
    // after the reassignment, still credits RS 60 / MP 40 (B4's hard rule).
    await owners.assign(ORG_ID, null, bharatId, [{ ownerRef: mpRef, share: 100 }], '2026-09-01');
    await facts.buildOrgDay(ORG_ID, DAY);
    const rows = await harness.db.execute<{ salespersonRef: string; gross: string }>(sql`
      SELECT salesperson_ref AS "salespersonRef", gross::text AS gross
      FROM fact_sales_daily
      WHERE org_id = ${ORG_ID} AND date = ${DAY} AND party_id = ${bharatId} AND voucher_type = 'Sales'
      ORDER BY salesperson_ref
    `);
    expect(rows.rows.map((r) => Number(r.gross)).sort((a, b) => a - b)).toEqual([1652.2, 2478.3]);
  });

  it('a party nobody owns lands in the visible Unassigned bucket, never dropped', async () => {
    await harness.db.execute(sql`DELETE FROM customer_owner_map WHERE org_id = ${ORG_ID} AND party_id = ${ashaId}`);
    await facts.buildOrgDay(ORG_ID, DAY);
    const check = await facts.reconcile(ORG_ID, DAY, DAY);
    expect(Number(check.unassignedNet)).toBe(9500);
    expect(check.ties).toBe(true);
  });
});

describe('owner map rules', () => {
  it('refuses to rewrite history', async () => {
    await expect(
      owners.assign(ORG_ID, null, bharatId, [{ ownerRef: rsRef, share: 100 }], '2026-08-15'),
    ).rejects.toThrow('history is never rewritten');
  });

  it('refuses shares that do not sum to 100, more than two owners, and blank owners', async () => {
    await expect(
      owners.assign(ORG_ID, null, ashaId, [{ ownerRef: rsRef, share: 70 }], '2026-10-01'),
    ).rejects.toThrow('summing to exactly 100');
    await expect(
      owners.assign(
        ORG_ID,
        null,
        ashaId,
        [{ ownerRef: rsRef, share: 40 }, { ownerRef: mpRef, share: 40 }, { ownerRef: 'HOUSE', share: 20 }],
        '2026-10-01',
      ),
    ).rejects.toThrow('one or two owners');
    await expect(
      owners.assign(ORG_ID, null, ashaId, [{ ownerRef: '', share: 100 }], '2026-10-01'),
    ).rejects.toThrow('user:<id> or HOUSE');
  });

  it('the house book is explicit and resolvable', async () => {
    await owners.assign(ORG_ID, null, ashaId, [{ ownerRef: 'HOUSE', share: 100 }], '2026-10-01');
    const resolved = await owners.resolveOwners(ORG_ID, ashaId, '2026-10-05');
    expect(resolved).toEqual([{ ownerRef: 'HOUSE', share: 100 }]);
    // And the day before it starts, nothing is in force any more for Asha.
    expect(await owners.resolveOwners(ORG_ID, ashaId, '2026-09-30')).toEqual([]);
  });
});

describe('GET /cfo/sales-analysis (B3, level-aware)', () => {
  it('answers the company, then the same engine narrowed to a brand and to a person', async () => {
    await facts.buildOrgDay(ORG_ID, DAY);
    type Analysis = {
      summary: { net: string; customers: number; unassignedNet: string; unassignedPct: number };
      breakdowns: { level: string; rows: { key: string; label: string; net: string }[] }[];
      scope: { level: string; label: string }[];
    };
    const company = await harness.get<Analysis>(`/cfo/sales-analysis?from=${DAY}&to=${DAY}`, { token: rsToken });
    expect(company.status).toBe(200);
    // Asha 10,000 - 500 discount; Bharat 4,130.50 - 130.50 credit note. An
    // earlier test orphaned Asha, so her 9,500 is the visible Unassigned
    // bucket -- 70.4% of the company, the footer KPI B3 insists on.
    expect(company.body.summary.net).toBe('13500.00');
    expect(company.body.summary.customers).toBe(2);
    expect(company.body.summary.unassignedNet).toBe('9500.00');
    expect(company.body.summary.unassignedPct).toBe(70.4);
    const byBrand = company.body.breakdowns.find((b) => b.level === 'brand');
    expect(byBrand?.rows.map((r) => [r.key, r.net])).toEqual([
      ['C&S Electric', '10000.00'],
      ['Unbranded', '3500.00'],
    ]);
    const byPerson = company.body.breakdowns.find((b) => b.level === 'person');
    expect(byPerson?.rows.map((r) => [r.key, r.net])).toEqual([
      ['UNASSIGNED', '9500.00'],
      [rsRef, '2400.00'],
      [mpRef, '1600.00'],
    ]);
    // Persons wear names, not refs.
    expect(byPerson?.rows[0]?.label).toBe('Unassigned');
    expect(byPerson?.rows[1]?.label).toContain('cfo-rs');

    const brand = await harness.get<Analysis>(`/cfo/sales-analysis?from=${DAY}&to=${DAY}&brand=${encodeURIComponent('C&S Electric')}`, { token: rsToken });
    expect(brand.body.summary.net).toBe('10000.00');
    expect(brand.body.scope).toEqual([{ level: 'brand', key: 'C&S Electric', label: 'C&S Electric' }]);
    // The brand's breakdowns no longer offer "by brand".
    expect(brand.body.breakdowns.map((b) => b.level)).toEqual(['person', 'party', 'item']);

    const person = await harness.get<Analysis>(`/cfo/sales-analysis?from=${DAY}&to=${DAY}&person=${mpRef}`, { token: rsToken });
    expect(person.body.summary.net).toBe('1600.00');
    expect(person.body.scope[0]?.level).toBe('person');
  });

  it('a person scope other than your own needs cfo.team.view; a malformed scope is refused', async () => {
    const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES, { isSystem: true });
    const sales = await harness.createUser({ email: scopedEmail('cfo-sales-only'), roleIds: [employeeRoleId] });
    const salesToken = (await harness.login(sales.email, sales.password)).token;

    const other = await harness.get(`/cfo/sales-analysis?from=${DAY}&to=${DAY}&person=user:${mpId}`, { token: salesToken });
    expect(other.status).toBe(403);
    const own = await harness.get(`/cfo/sales-analysis?from=${DAY}&to=${DAY}&person=user:${sales.id}`, { token: salesToken });
    expect(own.status).toBe(200);
    const company = await harness.get(`/cfo/sales-analysis?from=${DAY}&to=${DAY}`, { token: salesToken });
    expect(company.status).toBe(200);

    const bad = await harness.get(`/cfo/sales-analysis?from=${DAY}&to=${DAY}&party=not-a-uuid`, { token: rsToken });
    expect(bad.status).toBe(400);
  });
});

describe('GET /cfo/penetration (Q2.10)', () => {
  it('fills the cell they buy and leaves the whitespace empty', async () => {
    const res = await harness.get<{
      categories: string[];
      customers: { party: string; filled: number; total: string }[];
      cells: { partyId: string; category: string; count: number; amount: string }[];
      columnTotals: Record<string, { count: number; amount: string }>;
    }>(`/cfo/penetration?from=${DAY}&to=${DAY}`, { token: rsToken });
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(['MCB', 'MCCB', 'ACB', 'RCCB', 'PQ', 'Other']);
    // Asha bought MCB 6A: one filled cell, 10,000 on the inventory line.
    // Bharat's vouchers carried no inventory lines, so he has no row.
    expect(res.body.customers.map((c) => [c.party, c.filled])).toEqual([['Asha Traders', 1]]);
    expect(res.body.cells).toEqual([{ partyId: ashaId, category: 'MCB', count: 1, amount: '10000.00' }]);
    expect(res.body.columnTotals.MCB).toEqual({ count: 1, amount: '10000.00' });
    expect(res.body.columnTotals.RCCB).toEqual({ count: 0, amount: '0.00' });
  });
});
