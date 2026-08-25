import { PERMISSIONS, REPORT_DEFINITIONS, SYSTEM_ROLES, type InterestPartySettingView, type PartyInterestSource, type ReportFilters } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import type { Principal } from '../../platform/rbac/principal.js';

import { InterestBuildService } from './interest-build.service.js';
import { InterestReportSource } from './interest-report.source.js';

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
const JULY: ReportFilters = { from: '2026-07-01', to: '2026-07-31' };

let harness: ApiHarness;
let build: InterestBuildService;
let source: InterestReportSource;
let principal: Principal;
let adminToken = '';
let employeeToken = '';
let connectionId = '';
let debtorId = '';
let creditorId = '';
let itemId = '';

function principalFor(orgId: string, permissions: string[]): Principal {
  return {
    userId: '01900000-0000-7000-8000-0000000000aa',
    orgId,
    employeeId: null,
    email: 'interest@example.test',
    status: 'ACTIVE',
    sessionId: '01900000-0000-7000-8000-0000000000bb',
    roles: [],
    permissions: new Set(permissions),
  } as unknown as Principal;
}

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
  source = harness.resolve(InterestReportSource);
  principal = principalFor(ORG_ID, [PERMISSIONS.INTEREST_VIEW]);

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

describe('interest cost by customer', () => {
  it('prices within-credit and overdue rupee-days at the org rate', async () => {
    const page = await source.page(principal, 'party-interest-cost', JULY, 50, 0);
    expect(page.total).toBe(1);
    const row = page.rows[0] as PartyInterestSource;
    expect(row.partyName).toBe('Asha Traders');
    expect(row.effectiveRatePct).toBe(12);
    // Within credit: Jul 1-10 at 10,000 plus Jul 11 (age 10, receipt lands
    // that day) at 6,000 = 106,000 rupee-days -> x12%/365 = 34.85.
    expect(row.plannedCost).toBe('34.85');
    // Overdue: Jul 12-31, twenty days at 6,000 = 120,000 -> 39.45. Headline.
    expect(row.interestLoss).toBe('39.45');
    // 226,000 closing rupee-days over 10,000 of July sales.
    expect(row.avgDaysOutstanding).toBe(22.6);
    expect(row.avgOverdueDays).toBe(12);
    // 39.45 of loss against 10,000 of turnover.
    expect(row.lossPctOfTurnover).toBe(0.39);
    expect(row.creditTerms).toBe('TALLY');
    expect(row.settlementRule).toBe('FIFO oldest-first');
    expect(row.asOf).not.toBeNull();
  });
});

describe('interest cost of stock', () => {
  it('funds the shelf only after the vendor credit days pass, at purchase cost', async () => {
    const page = await source.page(principal, 'stock-interest-cost', JULY, 50, 0);
    expect(page.total).toBe(1);
    const row = page.rows[0] as Record<string, unknown>;
    expect(row.item).toBe('Cat6 cable 305m');
    // Funded: Jul 17-19 at 20,000 plus Jul 20-31 at 12,000 = 204,000
    // rupee-days -> x12%/365 = 67.07.
    expect(row.interest).toBe('67.07');
    expect(row.closingValue).toBe('12000.00');
    expect(row.fundedValue).toBe('12000.00');
    // Last outward Jul 20, series ends Jul 31.
    expect(row.daysSinceOutward).toBe(11);
    expect(row.nonMoving).toBe(false);
  });
});

describe('the cash cycle', () => {
  it('adds inventory and receivable days, subtracts payable days, and prices the month', async () => {
    const page = await source.page(principal, 'cash-cycle', JULY, 50, 0);
    expect(page.total).toBe(1);
    const row = page.rows[0] as Record<string, unknown>;
    expect(row.month).toBe('2026-07');
    // Stock: 19 days at 20,000 plus 12 at 12,000 = 524,000 over 20,000 purchases.
    expect(row.inventoryDays).toBe(26.2);
    // Receivables: 226,000 over 10,000 sales.
    expect(row.receivableDays).toBe(22.6);
    // Payables: Jul 1-15 at 20,000 = 300,000 over 20,000 purchases.
    expect(row.payableDays).toBe(15);
    expect(row.cashCycleDays).toBe(33.8);
    // AR overdue 120,000 plus stock funded 204,000 = 324,000 -> 106.52.
    expect(row.totalInterest).toBe('106.52');
  });
});

describe('access and honesty', () => {
  it('is refused without interest_cost.view, and absent from the catalogue', async () => {
    const outsider = principalFor(ORG_ID, []);
    await expect(source.page(outsider, 'party-interest-cost', JULY, 50, 0)).rejects.toThrow();
    expect(source.visibleDefinitions(outsider)).toEqual([]);
    expect(source.visibleDefinitions(principal).map((d) => d.key)).toEqual(['party-interest-cost', 'stock-interest-cost', 'cash-cycle']);
  });

  it('says plainly what the v1 grain and basis are', () => {
    expect(REPORT_DEFINITIONS['party-interest-cost'].description).toContain('Voucher-grain until Tally bill marks arrive');
    expect(REPORT_DEFINITIONS['stock-interest-cost'].description).toContain('purchase cost basis');
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

  it('a scoped rebuild reprices the party under the override', async () => {
    const outcome = await build.buildOrg(ORG_ID, { partyId: debtorId, today: '2026-07-31' });
    expect(outcome).toMatchObject({ partyRows: 31, stockRows: 0 });

    const page = await source.page(principal, 'party-interest-cost', JULY, 50, 0);
    const row = page.rows[0] as PartyInterestSource;
    expect(row.creditTerms).toBe('OVERRIDE');
    expect(row.effectiveRatePct).toBe(18);
    // Twenty credit days at the 18% override: within Jul 1-10 at 10,000 plus
    // Jul 11-21 at 6,000 = 166,000 -> x18%/365 = 81.86; overdue Jul 22-31 at
    // 6,000 = 60,000 -> 29.59. The snapshots held balances only, so the new
    // rate repriced history without touching them.
    expect(row.plannedCost).toBe('81.86');
    expect(row.interestLoss).toBe('29.59');
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
