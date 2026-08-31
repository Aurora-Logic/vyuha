import { SYSTEM_ROLES, PERMISSIONS, type PickQueueEntry } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * P8-5 (owner, 28 Aug 2026): fulfilment answers to `sales.fulfil`, not to the
 * document keys. What this suite pins: the Warehouse seed works the floor —
 * reads the queue, reads the order behind a row, picks and packs — and cannot
 * raise a sales order; the Sales seed still does both; and a create key alone
 * no longer opens the floor, which was the point of splitting them.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f1ab';

interface SalesDocumentView {
  id: string;
  number: string;
  status: string;
  lines: { id: string; quantity: string; pickedQty: string; packedQty: string }[];
}
interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface PickRecordView {
  id: string;
  lines: { lineId: string; quantity: string }[];
}
interface PackRecordView {
  id: string;
  boxCount: number;
  lines: { lineId: string; quantity: string }[];
}

let harness: ApiHarness;
let salesToken = '';
let warehouseToken = '';
let deskToken = '';
let partyId = '';
let itemId = '';
let orderId = '';
let lineId = '';

async function raiseConfirmedOrder(token: string, quantity: string): Promise<{ id: string; lineId: string }> {
  const created = await harness.post<SalesDocumentView>('/sales/orders', {
    token,
    body: { partyId, lines: [{ stockItemId: itemId, quantity, rate: '4000' }] },
  });
  expect(created.status).toBe(201);
  const confirmed = await harness.post<SalesDocumentView>(`/sales/orders/${created.body.id}/confirm`, { token });
  expect([200, 201]).toContain(confirmed.status);
  const order = await harness.get<SalesDocumentView>(`/sales/orders/${created.body.id}`, { token });
  const line = order.body.lines[0]?.id ?? '';
  expect(line).not.toBe('');
  return { id: created.body.id, lineId: line };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Fulfilment RBAC Org');
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const salesRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES, { isSystem: true });
  const warehouseRoleId = await harness.createSystemRole(SYSTEM_ROLES.WAREHOUSE, { isSystem: true });
  // The pre-P8-5 shape of a desk: create plus a view key, no fulfil.
  const deskRoleId = await harness.createRole('Desk only', [
    PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    PERMISSIONS.SALES_DOCUMENT_CREATE,
  ]);

  const salesEmployee = await harness.createEmployee({ code: 'FR-001', firstName: 'Ravi', lastName: 'Kumar' });
  const warehouseHand = await harness.createEmployee({ code: 'FR-002', firstName: 'Bala', lastName: 'Murugan' });

  const sales = await harness.createUser({ email: scopedEmail('fr-sales'), roleIds: [salesRoleId], employeeId: salesEmployee });
  const warehouse = await harness.createUser({
    email: scopedEmail('fr-warehouse'),
    roleIds: [warehouseRoleId],
    employeeId: warehouseHand,
  });
  const desk = await harness.createUser({ email: scopedEmail('fr-desk'), roleIds: [deskRoleId] });
  salesToken = (await harness.login(sales.email, sales.password)).token;
  warehouseToken = (await harness.login(warehouse.email, warehouse.password)).token;
  deskToken = (await harness.login(desk.email, desk.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Fulfil Co', 'guid-fulfilment-rbac') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Floor Traders', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate) VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00') RETURNING id
  `);
  itemId = item.rows[0]?.id ?? '';

  const order = await raiseConfirmedOrder(salesToken, '6');
  orderId = order.id;
  lineId = order.lineId;
});

afterAll(async () => {
  await harness.close();
});

describe('the Warehouse seed (P8-5)', () => {
  it('reads the queue and the order behind a row, then picks and packs it', async () => {
    const queue = await harness.get<PickQueueEntry[]>('/sales/pick-queue', { token: warehouseToken });
    expect(queue.status).toBe(200);
    expect(queue.body.some((entry) => entry.documentId === orderId)).toBe(true);

    // The pack step reads the order itself — the view.all in the seed is what
    // makes a queue of other people's orders workable from the bench.
    const order = await harness.get<SalesDocumentView>(`/sales/orders/${orderId}`, { token: warehouseToken });
    expect(order.status).toBe(200);

    const picked = await harness.post<PickRecordView>(`/sales/orders/${orderId}/picks`, {
      token: warehouseToken,
      body: { lines: [{ lineId, quantity: '3' }] },
    });
    expect(picked.status).toBe(201);

    const packed = await harness.post<PackRecordView>(`/sales/orders/${orderId}/packs`, {
      token: warehouseToken,
      body: { boxCount: 1, lines: [{ lineId, quantity: '2' }] },
    });
    expect(packed.status).toBe(201);

    const packs = await harness.get<{ data: PackRecordView[] }>('/sales/packs?page=1&pageSize=10', { token: warehouseToken });
    expect(packs.status).toBe(200);
    expect(packs.body.data.some((pack) => pack.id === packed.body.id)).toBe(true);
  });

  it('cannot raise a sales order', async () => {
    const refused = await harness.post<ErrorBody>('/sales/orders', {
      token: warehouseToken,
      body: { partyId, lines: [{ stockItemId: itemId, quantity: '1', rate: '4000' }] },
    });
    expect(refused.status).toBe(403);
  });
});

describe('the Sales seed keeps both sides', () => {
  it('raises, confirms, picks and packs its own order', async () => {
    const order = await raiseConfirmedOrder(salesToken, '2');
    const picked = await harness.post<PickRecordView>(`/sales/orders/${order.id}/picks`, {
      token: salesToken,
      body: { lines: [{ lineId: order.lineId, quantity: '2' }] },
    });
    expect(picked.status).toBe(201);
    const packed = await harness.post<PackRecordView>(`/sales/orders/${order.id}/packs`, {
      token: salesToken,
      body: { boxCount: 1, lines: [{ lineId: order.lineId, quantity: '1' }] },
    });
    expect(packed.status).toBe(201);
  });
});

describe('a create key no longer opens the floor', () => {
  it('refuses the queue and the pick to a desk-shaped role', async () => {
    const queue = await harness.get<ErrorBody>('/sales/pick-queue', { token: deskToken });
    expect(queue.status).toBe(403);

    const pick = await harness.post<ErrorBody>(`/sales/orders/${orderId}/picks`, {
      token: deskToken,
      body: { lines: [{ lineId, quantity: '1' }] },
    });
    expect(pick.status).toBe(403);
  });
});
