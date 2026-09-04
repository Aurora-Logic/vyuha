import {
  SYSTEM_ROLES,
  type DealBoardView,
  type DealView,
  type Paginated,
  type PipelineView,
  type SalesDocumentView,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * REQ-U-12: a deal knows what paperwork stands behind it.
 *
 * The point of the whole arrangement is that the answer cannot drift. A
 * stage somebody drags a deal into can sit in "Invoiced" with no invoice, or
 * be invoiced and never moved; these two booleans are read from the
 * documents themselves on every request, so the only way to make a deal say
 * "Invoiced" is to raise an invoice against it.
 *
 * This also pins the module boundary from the outside: CRM never imports
 * sales, so if the registry were not wired the flags would silently stay
 * false and every assertion here would fail.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f1c7';

let harness: ApiHarness;
let token = '';
let partyId = '';
let itemId = '';
let pipeline: PipelineView;

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Deal Paperwork Fixture Org');
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeId = await harness.createEmployee({ code: 'DP-001', firstName: 'Ravi', lastName: 'Kumar' });
  const user = await harness.createUser({ email: scopedEmail('dp-admin'), roleIds: [adminRoleId], employeeId });
  token = (await harness.login(user.email, user.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Paperwork Co', 'guid-paperwork-co') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Acme Trading Co', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate)
    VALUES (${ORG_ID}, ${connectionId}, 'HDPE pipe 90mm', 'NOS', 'Pipes', '18.00') RETURNING id
  `);
  itemId = item.rows[0]?.id ?? '';

  const pipelines = await harness.get<PipelineView[]>('/crm/pipelines', { token });
  const first = pipelines.body[0];
  if (first === undefined) throw new Error('no pipeline');
  pipeline = first;
});

afterAll(async () => {
  await harness.close();
});

async function makeDeal(name: string): Promise<DealView> {
  const response = await harness.post<DealView>('/crm/deals', {
    token,
    body: { name, pipelineId: pipeline.id, value: '100000.00' },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function raiseOrder(dealId: string): Promise<SalesDocumentView> {
  const created = await harness.post<SalesDocumentView>('/sales/orders', {
    token,
    body: { partyId, dealId, lines: [{ stockItemId: itemId, quantity: '2', rate: '4000' }] },
  });
  expect(created.status).toBe(201);
  return created.body;
}

/**
 * The real road to an invoice: confirm, pick, pack, invoice. An invoice may
 * only be raised for what is packed and uninvoiced, which is the rule that
 * makes "Invoiced" mean something -- so this test walks it rather than
 * inserting a row that looks like an invoice.
 */
async function invoiceThrough(order: SalesDocumentView): Promise<void> {
  const lineId = order.lines[0]?.id ?? '';
  expect(lineId).not.toBe('');
  await harness.post(`/sales/orders/${order.id}/confirm`, { token });
  await harness.post(`/sales/orders/${order.id}/picks`, { token, body: { lines: [{ lineId, quantity: '2' }] } });
  await harness.post(`/sales/orders/${order.id}/packs`, { token, body: { lines: [{ lineId, quantity: '2' }] } });
  const invoice = await harness.post<SalesDocumentView>(`/sales/orders/${order.id}/invoices`, { token, body: {} });
  expect(invoice.status).toBe(201);
}

describe('a deal with nothing raised against it', () => {
  it('says so, rather than leaving the flags undefined', async () => {
    const deal = await makeDeal('Nothing raised yet');
    const read = await harness.get<DealView>(`/crm/deals/${deal.id}`, { token });
    expect(read.body.hasOrder).toBe(false);
    expect(read.body.hasInvoice).toBe(false);
  });
});

describe('an order raised against a deal', () => {
  it('shows on the deal, on the list and on the board', async () => {
    const deal = await makeDeal('Order raised');
    await raiseOrder(deal.id);

    const read = await harness.get<DealView>(`/crm/deals/${deal.id}`, { token });
    expect(read.body).toMatchObject({ hasOrder: true, hasInvoice: false });

    // The list and the board are decorated too, in one batched call each --
    // a badge that appeared only when a deal was opened would be a badge
    // nobody scanning a pipeline ever saw.
    const listed = await harness.get<Paginated<DealView>>('/crm/deals?page=1&pageSize=100', { token });
    expect(listed.body.data.find((row) => row.id === deal.id)).toMatchObject({ hasOrder: true });

    const board = await harness.get<DealBoardView>(`/crm/deals/board?pipelineId=${pipeline.id}`, { token });
    const onBoard = board.body.lanes.flatMap((lane) => lane.deals).find((row) => row.id === deal.id);
    expect(onBoard).toMatchObject({ hasOrder: true });
  });

  it('leaves every other deal alone', async () => {
    const withOrder = await makeDeal('Has an order');
    const without = await makeDeal('Has nothing');
    await raiseOrder(withOrder.id);

    const read = await harness.get<DealView>(`/crm/deals/${without.id}`, { token });
    expect(read.body.hasOrder).toBe(false);
  });
});

describe('an invoice raised against a deal', () => {
  it('is what makes the deal read as invoiced', async () => {
    const deal = await makeDeal('Through to invoice');
    const order = await raiseOrder(deal.id);
    await harness.post<SalesDocumentView>(`/sales/orders/${order.id}/confirm`, { token });

    const before = await harness.get<DealView>(`/crm/deals/${deal.id}`, { token });
    // Confirmed is not invoiced. This is the assertion that stops the flag
    // quietly meaning "the order got as far as confirmed".
    expect(before.body.hasInvoice).toBe(false);

    await invoiceThrough(order);

    const after = await harness.get<DealView>(`/crm/deals/${deal.id}`, { token });
    expect(after.body).toMatchObject({ hasOrder: true, hasInvoice: true });
  });

  it('is reachable from the deal by filtering invoices on it', async () => {
    // The query the deal's documents panel uses. Without `dealId` on the
    // invoice list it could show estimates and orders but never invoices.
    const deal = await makeDeal('Invoice by deal');
    const order = await raiseOrder(deal.id);
    await invoiceThrough(order);

    const invoices = await harness.get<Paginated<SalesDocumentView>>(`/sales/invoices?dealId=${deal.id}&page=1`, {
      token,
    });
    expect(invoices.status).toBe(200);
    expect(invoices.body.data.length).toBeGreaterThan(0);
    expect(invoices.body.data.every((row) => row.dealId === deal.id)).toBe(true);
  });

  it('refuses a deal id that is not a uuid', async () => {
    const response = await harness.get('/sales/invoices?dealId=nope&page=1', { token });
    expect(response.status).toBe(400);
  });
});
