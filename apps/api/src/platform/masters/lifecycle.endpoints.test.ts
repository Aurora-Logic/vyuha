import { SYSTEM_ROLES, type ItemAnalytics, type ItemLifecycle, type PartyAnalytics, type PartyLifecycle } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Owner, 22 Aug 2026: the life of an item and of a party over real HTTP.
 * One confirmed order is enough to prove the joins: it shows up in both
 * lifecycles with its number and its door, the figures count it, and a
 * person without the masters key is refused.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0cc';

let harness: ApiHarness;
let adminToken = '';
let employeeToken = '';
let partyId = '';
let itemId = '';
let orderId = '';

interface SalesDocumentView {
  id: string;
  number: string;
  status: string;
  lines: { id: string }[];
}
interface ErrorBody {
  error: { code: string };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Lifecycle Org');
  // The projection tables are Tally's and the harness leaves them; this org's vouchers are this test's own.
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('lifecycle-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('lifecycle-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Lifecycle Co', 'guid-lifecycle-co') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate) VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00') RETURNING id
  `);
  itemId = item.rows[0]?.id ?? '';

  const created = await harness.post<SalesDocumentView>('/sales/orders', { token: adminToken, body: { partyId, lines: [{ stockItemId: itemId, quantity: '2', rate: '4000' }] } });
  expect(created.status).toBe(201);
  orderId = created.body.id;
  const confirmed = await harness.post<SalesDocumentView>(`/sales/orders/${orderId}/confirm`, { token: adminToken });
  expect([200, 201]).toContain(confirmed.status);
  const lineId = created.body.lines[0]?.id ?? '';

  // The period half needs what Tally and the door add: a Sales voucher
  // with an inventory line (billed_qty is Tally's text, "2 BOX"), a
  // Receipt, and one unit out of the door three days after the order.
  const invoice = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 1, '2026-08-10', 'Sales', 'INV-L1', 'Asha Traders', ${partyId}, '', false, 8000, now()) RETURNING id
  `);
  await harness.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, stock_item_id, billed_qty, rate, amount)
    VALUES (${ORG_ID}, ${invoice.rows[0]?.id ?? ''}, 1, 'inventory', 'Cat6 cable 305m', ${itemId}, '2 BOX', 4000, 8000)
  `);
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 2, '2026-08-15', 'Receipt', 'RCP-L1', 'Asha Traders', ${partyId}, '', false, 5000, now())
  `);
  await harness.db.execute(sql`UPDATE sales_document_lines SET picked_qty = 1, packed_qty = 1, invoiced_qty = 1, dispatched_qty = 1 WHERE id = ${lineId}`);
  const dispatch = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO dispatches (org_id, document_id, number, mode, dispatched_at)
    VALUES (${ORG_ID}, ${orderId}, 'DN-L1', 'local_auto', (SELECT date FROM sales_documents WHERE id = ${orderId})::timestamptz + interval '3 days') RETURNING id
  `);
  await harness.db.execute(sql`INSERT INTO dispatch_lines (org_id, dispatch_id, line_id, quantity) VALUES (${ORG_ID}, ${dispatch.rows[0]?.id ?? ''}, ${lineId}, 1)`);
});

afterAll(async () => {
  await harness.close();
});

describe('GET /masters/items/:id/lifecycle', () => {
  it('counts the confirmed order and lists it with a door', async () => {
    const res = await harness.get<ItemLifecycle>(`/masters/items/${itemId}/lifecycle`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.item.name).toBe('Cat6 cable 305m');
    expect(Number(res.body.figures.ordered)).toBe(2);
    expect(res.body.figures.openOrders).toBe(1);
    expect(res.body.customers[0]?.name).toBe('Asha Traders');
    const order = res.body.events.find((event) => event.kind === 'order');
    expect(order?.href).toBe(`/sales/orders/${orderId}`);
    expect(order?.quantity).not.toBeNull();
  });

  it('answers 404 for an item that is not there and 403 without the masters key', async () => {
    const missing = await harness.get<ErrorBody>('/masters/items/01900000-0000-7000-8000-0000000000ff/lifecycle', { token: adminToken });
    expect(missing.status).toBe(404);
    const refused = await harness.get<ErrorBody>(`/masters/items/${itemId}/lifecycle`, { token: employeeToken });
    expect(refused.status).toBe(403);
  });
});

describe('GET /masters/parties/:id/lifecycle', () => {
  it('reads the party as a customer with one open order', async () => {
    const res = await harness.get<PartyLifecycle>(`/masters/parties/${partyId}/lifecycle`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('customer');
    expect(res.body.figures.orders).toBe(1);
    expect(res.body.figures.openOrders).toBe(1);
    expect(res.body.figures.purchaseOrders).toBe(0);
    expect(res.body.events.some((event) => event.kind === 'order' && event.href === `/sales/orders/${orderId}`)).toBe(true);
  });

  it('counts nothing a cancelled document did', async () => {
    const before = await harness.get<PartyLifecycle>(`/masters/parties/${partyId}/lifecycle`, { token: adminToken });

    // A second order, confirmed and then cancelled, and an invoice cancelled
    // after it was raised. Neither happened.
    const cancelled = await harness.post<SalesDocumentView>('/sales/orders', {
      token: adminToken,
      body: { partyId, lines: [{ stockItemId: itemId, quantity: '9', rate: '5000' }] },
    });
    expect(cancelled.status).toBe(201);
    await harness.db.execute(sql`
      UPDATE sales_documents SET status = 'CANCELLED', date = CURRENT_DATE WHERE id = ${cancelled.body.id}
    `);
    await harness.db.execute(sql`
      INSERT INTO sales_documents (org_id, doc_type, number, status, date, party_id, customer_name, grand_total)
      VALUES (${ORG_ID}, 'INVOICE', 'INV-CANCELLED-1', 'CANCELLED', CURRENT_DATE, ${partyId}, 'Asha Traders', '45000.00'),
             (${ORG_ID}, 'INVOICE', 'INV-DRAFT-1', 'DRAFT', CURRENT_DATE, ${partyId}, 'Asha Traders', '31000.00')
    `);

    const after = await harness.get<PartyLifecycle>(`/masters/parties/${partyId}/lifecycle`, { token: adminToken });
    expect(after.body.figures.orders).toBe(before.body.figures.orders);
    // A cancelled order with nothing dispatched used to read as still open.
    expect(after.body.figures.openOrders).toBe(before.body.figures.openOrders);
    expect(after.body.figures.invoices).toBe(before.body.figures.invoices);
    expect(after.body.figures.orderedValue).toBe(before.body.figures.orderedValue);
    expect(after.body.figures.invoicedValue).toBe(before.body.figures.invoicedValue);
    // The last-order date carried no status condition at all, so a document
    // dated today that never happened made a quiet customer look current.
    expect(after.body.figures.lastOrderAt).toBe(before.body.figures.lastOrderAt);
  });
});

const PERIOD = 'from=2026-04-01&to=2027-03-31';
const COMPARE = 'compareFrom=2025-04-01&compareTo=2026-03-31';

describe('GET /masters/items/:id/analytics', () => {
  it('reads the period with its comparison: quantities, revenue from the voucher, rates, months, who, and the grid', async () => {
    const res = await harness.get<ItemAnalytics>(`/masters/items/${itemId}/analytics?${PERIOD}&${COMPARE}`, { token: adminToken });
    expect(res.status).toBe(200);
    const { kpis } = res.body;
    expect(res.body.comparison).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(kpis.ordered).toEqual({ value: 2, previous: 0 });
    expect(kpis.dispatched.value).toBe(1);
    expect(kpis.fulfilmentPct.value).toBe(50);
    expect(kpis.orders.value).toBe(1);
    expect(kpis.customers.value).toBe(1);
    expect(kpis.topCustomerSharePct.value).toBe(100);
    expect(kpis.revenue).toEqual({ value: 8000, previous: 0 });
    expect(kpis.billedQty.value).toBe(2);
    expect(kpis.realisedRate.value).toBe(4000);
    expect(kpis.openOrders).toBe(1);
    expect(kpis.lastSoldRate).toBe(4000);
    expect(res.body.monthly.some((m) => m.ordered === 2 && m.dispatched === 1)).toBe(true);
    expect(res.body.monthly.find((m) => m.month === '2026-08')?.revenue).toBe(8000);
    expect(res.body.monthlyComparison).not.toBeNull();
    expect(res.body.customers[0]).toMatchObject({ name: 'Asha Traders', quantity: 2, orders: 1, lastRate: 4000 });
    expect(res.body.heat.length).toBeGreaterThanOrEqual(1);
    expect(res.body.absent).toEqual([]);
  });

  it('answers without a comparison when none is asked, refuses a malformed date, and keeps the masters key', async () => {
    const plain = await harness.get<ItemAnalytics>(`/masters/items/${itemId}/analytics?${PERIOD}`, { token: adminToken });
    expect(plain.status).toBe(200);
    expect(plain.body.comparison).toBeNull();
    expect(plain.body.kpis.ordered.previous).toBeNull();
    const bad = await harness.get<ErrorBody>(`/masters/items/${itemId}/analytics?from=nope&to=2026-01-01`, { token: adminToken });
    expect(bad.status).toBe(400);
    const refused = await harness.get<ErrorBody>(`/masters/items/${itemId}/analytics?${PERIOD}`, { token: employeeToken });
    expect(refused.status).toBe(403);
  });
});

describe('GET /masters/parties/:id/analytics', () => {
  it('reads the customer: revenue, the receipt, the order, the door, and what bill-wise data alone could add', async () => {
    const res = await harness.get<PartyAnalytics>(`/masters/parties/${partyId}/analytics?${PERIOD}&${COMPARE}`, { token: adminToken });
    expect(res.status).toBe(200);
    const c = res.body.customer;
    expect(c).not.toBeNull();
    expect(c?.revenue).toEqual({ value: 8000, previous: 0 });
    expect(c?.invoices.value).toBe(1);
    expect(c?.averageInvoice.value).toBe(8000);
    expect(c?.collected.value).toBe(5000);
    expect(c?.orders.value).toBe(1);
    expect(c?.orderedQty.value).toBe(2);
    expect(c?.fulfilmentPct.value).toBe(50);
    expect(c?.leadTimeMedianDays.value).toBe(3);
    expect(c?.revenueSharePct.value).toBe(100);
    expect(c?.openOrders).toBe(1);
    expect(c?.dormant).toBe(false);
    expect(c?.medianOrderGapDays).toBeNull();
    expect(res.body.vendor?.purchaseOrders.value).toBe(0);
    expect(res.body.itemsBought[0]).toMatchObject({ name: 'Cat6 cable 305m', quantity: 2, documents: 1, lastRate: 4000 });
    expect(res.body.heat[0]?.row).toBe('Cat6 cable 305m');
    expect(res.body.monthly.find((m) => m.month === '2026-08')).toMatchObject({ revenue: 8000, collected: 5000 });
    expect(res.body.absent.map((a) => a.label)).toEqual(expect.arrayContaining(['Receivables ageing', 'Credit cycle (DSO)', 'Payment delay']));
  });
});

