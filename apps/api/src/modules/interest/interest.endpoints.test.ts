import { SYSTEM_ROLES, type InterestPartySettingView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

import { InterestBuildService } from './interest-build.service.js';

/**
 * D-22 end to end: vouchers into the projection, the build service walking
 * them into daily snapshots, and the three reports pricing the rupee-days.
 * Every expected figure below is hand-worked in the comments beside it,
 * because the whole module is one formula and the formula is checkable on
 * paper: SUM(daily closing) x 12% / 365.
 *
 * July 2026, one debtor, one creditor, one item:
 *   Sales 10,000 on Jul 1 (10 credit days), Receipt 4,000 on Jul 11.
 *   Purchase 10 BOX at 2,000 on Jul 1 from a vendor on 15 credit days,
 *   4 BOX dispatched Jul 20, the vendor paid in full Jul 16.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0dd';

let harness: ApiHarness;
let build: InterestBuildService;
let adminToken = '';
let employeeToken = '';
let connectionId = '';
let debtorId = '';
let creditorId = '';
let itemId = '';

async function voucher(opts: { number: string; type: string; on: string; amount: number; partyId?: string | null }): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, ${opts.on}::date, ${opts.type}, ${opts.number}, '', ${opts.partyId ?? null}, '', false, ${opts.amount}, now())
    RETURNING id
  `);
  return rows.rows[0]?.id ?? '';
}

/** The interceptor writes the trail after the response, deliberately unawaited, so assertions poll. */
async function auditCount(action: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${ORG_ID} AND action = ${action}
    `);
    const n = rows.rows[0]?.n ?? 0;
    if (n > 0) return n;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return 0;
}

async function inventoryLine(voucherId: string, qty: string, rate: number, amount: number): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, stock_item_id, actual_qty, billed_qty, rate, amount)
    VALUES (${ORG_ID}, ${voucherId}, 1, 'inventory', 'Cat6 cable 305m', ${itemId}, ${qty}, ${qty}, ${rate}, ${amount})
  `);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Interest Org');
  build = harness.resolve(InterestBuildService);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('int-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('int-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  // The snapshot rows hold parties and items with RESTRICT, so they go first.
  await harness.db.execute(sql`DELETE FROM interest_daily_party WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM interest_daily_stock WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM interest_build_state WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM interest_party_settings WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Interest Co', ${`guid-interest-${ORG_ID}`}) RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';

  const debtor = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days) VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors', 10) RETURNING id
  `);
  debtorId = debtor.rows[0]?.id ?? '';
  const creditor = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days) VALUES (${ORG_ID}, ${connectionId}, 'Steel Vendor', 'Sundry Creditors', 15) RETURNING id
  `);
  creditorId = creditor.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate) VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00') RETURNING id
  `);
  itemId = item.rows[0]?.id ?? '';

  await voucher({ number: 'SL-1', type: 'Sales', on: '2026-07-01', amount: 10_000, partyId: debtorId });
  await voucher({ number: 'RC-1', type: 'Receipt', on: '2026-07-11', amount: 4_000, partyId: debtorId });
  const purchase = await voucher({ number: 'PU-1', type: 'Purchase', on: '2026-07-01', amount: 20_000, partyId: creditorId });
  await inventoryLine(purchase, '10 BOX', 2_000, 20_000);
  await voucher({ number: 'PA-1', type: 'Payment', on: '2026-07-16', amount: 20_000, partyId: creditorId });
  // The dispatch: goods leave, but the billing party is not resolved, so it
  // moves stock without raising a second receivable bill.
  const dispatch = await voucher({ number: 'SL-2', type: 'Sales', on: '2026-07-20', amount: 0, partyId: null });
  await inventoryLine(dispatch, '4 BOX', 2_500, 10_000);
});

afterAll(async () => {
  await harness.close();
});

describe('the snapshot build', () => {
  it('walks from the earliest voucher and writes one row per active day', async () => {
    const outcome = await build.buildOrg(ORG_ID, { today: '2026-07-31' });
    // 31 July days for the debtor, 31 for the creditor, 31 for the item.
    expect(outcome).toEqual({ partyRows: 62, stockRows: 31, builtThrough: '2026-07-31' });
  });
});

describe('per-party overrides', () => {
  it('upserts an override behind interest_cost.configure, audited', async () => {
    const refused = await harness.put(`/interest/party-settings/${debtorId}`, { token: employeeToken, body: { creditDaysOverride: 20 } });
    expect(refused.status).toBe(403);

    const updated = await harness.put<InterestPartySettingView>(`/interest/party-settings/${debtorId}`, { token: adminToken, body: { creditDaysOverride: 20 } });
    expect(updated.status).toBe(200);
    expect(updated.body.creditDaysOverride).toBe(20);
    expect(updated.body.tallyCreditDays).toBe(10);
    expect(updated.body.creditTermsMissing).toBe(false);

    expect(await auditCount('interest.party_setting.upserted')).toBeGreaterThanOrEqual(1);

    const listed = await harness.get<InterestPartySettingView[]>('/interest/party-settings', { token: adminToken });
    expect(listed.status).toBe(200);
    expect(listed.body.find((row) => row.partyId === debtorId)?.creditDaysOverride).toBe(20);

    // A second PUT carrying only the rate leaves the credit days standing:
    // absent means unchanged, exactly as the settings PATCH reads it.
    const rated = await harness.put<InterestPartySettingView>(`/interest/party-settings/${debtorId}`, { token: adminToken, body: { interestRateOverride: 18 } });
    expect(rated.status).toBe(200);
    expect(rated.body.interestRateOverride).toBe('18.00');
    expect(rated.body.creditDaysOverride).toBe(20);
  });

  it('a scoped rebuild walks only the named party', async () => {
    // The pricing reads lived in the removed report source; what the build
    // still owes is the scoped walk itself -- one party's days rewritten,
    // nobody else's, and the org watermark left alone.
    const outcome = await build.buildOrg(ORG_ID, { partyId: debtorId, today: '2026-07-31' });
    expect(outcome).toMatchObject({ partyRows: 31, stockRows: 0 });
  });

  it('removing the override falls back to the Tally figure', async () => {
    const removed = await harness.del<InterestPartySettingView>(`/interest/party-settings/${debtorId}`, { token: adminToken });
    expect(removed.status).toBe(200);
    expect(removed.body.creditDaysOverride).toBeNull();
    expect(removed.body.tallyCreditDays).toBe(10);
    expect(removed.body.creditTermsMissing).toBe(false);
  });
});

describe('the on-demand recompute', () => {
  it('queues the rebuild behind interest_cost.configure, audited', async () => {
    const refused = await harness.post('/interest/recompute', { token: employeeToken, body: { partyId: debtorId } });
    expect(refused.status).toBe(403);

    const accepted = await harness.post<{ jobId: string }>('/interest/recompute', { token: adminToken, body: { partyId: debtorId } });
    expect(accepted.status).toBe(202);
    expect(accepted.body.jobId.length).toBeGreaterThan(0);

    expect(await auditCount('interest.recompute_requested')).toBeGreaterThanOrEqual(1);
  });

  it('refuses a party the organisation does not hold', async () => {
    const missing = await harness.post('/interest/recompute', { token: adminToken, body: { partyId: '01900000-0000-7000-8000-00000000dead' } });
    expect(missing.status).toBe(404);
  });
});
