import { PERMISSIONS, type ReportFilters, type ReturnRateCustomerSource, type ReturnRateItemSource, type ReturnsByReasonSource } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Principal } from '../../../platform/rbac/principal.js';
import { ApiHarness } from '../../../test-support/api-harness.js';

import { ReturnsReportSource } from './returns-report.source.js';

/**
 * Every figure on a returns report row is computed inside that row's filters
 * -- including "Commonest item" and "Commonest reason".
 *
 * Those two used to come from sub-selects that reopened
 * `sales_return_lines`, repeated the org, state and deleted_at guards by
 * hand, and left out the period and the party. A row narrowed to August could
 * therefore name a reason last given in March, or an item another customer
 * returned, beside an August quantity: the kind of wrong that reads as a data
 * problem rather than a report bug, and sends somebody to chase an item
 * nobody here has returned this quarter.
 *
 * The fixture is arranged so the out-of-scope value is always the *larger*
 * one. The old sub-select therefore prefers it, and no assertion below can
 * pass by accident.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d8';
const MARCH = '2026-03-10';
const AUGUST = '2026-08-10';
const AUG_ONLY = { from: '2026-08-01', to: '2026-08-31' } as const;

let harness: ApiHarness;
let source: ReturnsReportSource;
let principal: Principal;
let asha = '';
let bharat = '';
let cable = '';

/** The report source reads `orgId` and `permissions`; the rest is shape. */
function principalFor(orgId: string): Principal {
  return {
    userId: '01900000-0000-7000-8000-0000000000aa',
    orgId,
    employeeId: null,
    email: 'reports@example.test',
    status: 'ACTIVE',
    sessionId: '01900000-0000-7000-8000-0000000000bb',
    roles: [],
    permissions: new Set([PERMISSIONS.RETURNS_VIEW]),
  };
}

/** One receipt of one line, as the service leaves it. */
async function receipt(opts: {
  number: string;
  on: string;
  partyId: string;
  customerName: string;
  reason: string;
  description: string;
  quantity: string;
  stockItemId?: string;
}): Promise<void> {
  const created = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO sales_returns (org_id, number, state, party_id, customer_name, received_on)
    VALUES (${ORG_ID}, ${opts.number}, 'awaiting_credit_note', ${opts.partyId}, ${opts.customerName}, ${opts.on}::date)
    RETURNING id
  `);
  const returnId = created.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO sales_return_lines (org_id, return_id, line_no, stock_item_id, description, quantity, reason, condition, disposition)
    VALUES (${ORG_ID}, ${returnId}, 1, ${opts.stockItemId ?? null}, ${opts.description}, ${opts.quantity}, ${opts.reason}, 'sealed', 'restock')
  `);
}

async function byReason(filters: ReportFilters): Promise<readonly ReturnsByReasonSource[]> {
  const page = await source.page(principal, 'returns-by-reason', filters, 50, 0);
  return page.rows as readonly ReturnsByReasonSource[];
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Returns Filters Org');
  source = harness.resolve(ReturnsReportSource);
  principal = principalFor(ORG_ID);

  await harness.db.execute(sql`DELETE FROM sales_return_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sales_returns WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Filters Co', ${`guid-filters-${ORG_ID}`}) RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const parties = await harness.db.execute<{ id: string; name: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors'),
           (${ORG_ID}, ${connectionId}, 'Bharat Supply', 'Sundry Debtors')
    RETURNING id, name
  `);
  asha = parties.rows.find((p) => p.name === 'Asha Traders')?.id ?? '';
  bharat = parties.rows.find((p) => p.name === 'Bharat Supply')?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate) VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00') RETURNING id
  `);
  cable = item.rows[0]?.id ?? '';

  // Asha's March is five hundred units of one reason; her August is five of
  // another. Any figure that reaches outside August lands on March.
  await receipt({ number: 'RF-0001', on: MARCH, partyId: asha, customerName: 'Asha Traders', reason: 'Damaged in transit', description: 'March damaged carton', quantity: '500', stockItemId: cable });
  await receipt({ number: 'RF-0002', on: AUGUST, partyId: asha, customerName: 'Asha Traders', reason: 'Wrong item sent', description: 'August carton', quantity: '5', stockItemId: cable });
  await receipt({ number: 'RF-0004', on: MARCH, partyId: asha, customerName: 'Asha Traders', reason: 'Wrong item sent', description: 'March carton', quantity: '100' });
  // Bharat returns in August too, in bulk. Any figure that reaches outside the
  // party lands here.
  await receipt({ number: 'RF-0003', on: AUGUST, partyId: bharat, customerName: 'Bharat Supply', reason: 'Short shipped', description: 'Bharat short carton', quantity: '80', stockItemId: cable });
  await receipt({ number: 'RF-0005', on: AUGUST, partyId: bharat, customerName: 'Bharat Supply', reason: 'Wrong item sent', description: 'Bharat carton', quantity: '500' });
});

afterAll(async () => {
  await harness.close();
});

describe('a returns report row is computed entirely inside its own filters', () => {
  it('names the commonest item of the period and the party, not of all history', async () => {
    const rows = await byReason({ ...AUG_ONLY, partyId: asha });
    const wrongItem = rows.find((r) => r.reason === 'Wrong item sent');
    expect(wrongItem).toBeDefined();
    // The quantity was always right; the item beside it was not. Reaching
    // outside the period gives 'March carton'; outside the party,
    // 'Bharat carton' -- both larger, both wrong.
    expect(wrongItem?.quantity).toBe('5.000');
    expect(wrongItem?.topItem).toBe('August carton');
  });

  it('still names the larger March carton once March is inside the period', async () => {
    const rows = await byReason({ from: '2026-01-01', to: '2026-12-31', partyId: asha });
    expect(rows.find((r) => r.reason === 'Wrong item sent')?.topItem).toBe('March carton');
  });

  it('keeps another party out of this party’s commonest item when no period is set', async () => {
    const rows = await byReason({ partyId: asha });
    expect(rows.map((r) => r.reason).sort()).toEqual(['Damaged in transit', 'Wrong item sent']);
    expect(rows.find((r) => r.reason === 'Wrong item sent')?.topItem).toBe('March carton');
  });

  it('names the commonest reason of the period on the item report', async () => {
    const page = await source.page(principal, 'return-rate-by-item', { ...AUG_ONLY, partyId: asha }, 50, 0);
    const rows = page.rows as readonly ReturnRateItemSource[];
    const row = rows.find((r) => r.itemName === 'Cat6 cable 305m');
    expect(row).toBeDefined();
    expect(row?.returnedQty).toBe('5.000');
    // March's 500 damaged are the same item and the same party, and out of
    // period; Bharat's 80 are in period and another party's.
    expect(row?.topReason).toBe('Wrong item sent');
  });

  it('names the commonest reason of the period on the customer report', async () => {
    const page = await source.page(principal, 'return-rate-by-customer', AUG_ONLY, 50, 0);
    const rows = page.rows as readonly ReturnRateCustomerSource[];
    const row = rows.find((r) => r.partyName === 'Asha Traders');
    expect(row).toBeDefined();
    expect(row?.returnedQty).toBe('5.000');
    expect(row?.topReason).toBe('Wrong item sent');
  });
});
