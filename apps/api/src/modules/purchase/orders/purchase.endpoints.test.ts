import { PERMISSIONS, SYSTEM_ROLES, type ApprovalRequestSummary, type GrnView, type Paginated, type PurchaseOrderView, type PurchaseSettings, type RequirementView, type SalesDocumentView, type StockAvailability } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { NotificationDispatcher, type NotificationEvent } from '../../../platform/notifications/notification.dispatcher.js';
import { RequirementsService } from '../../../platform/procurement/requirements.service.js';
import { PushOutcomeRegistry } from '../../../platform/sync/push-outcome.registry.js';
import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * Procurement (13): the loop from shortage to GRN. Two orders short of one
 * item become two requirements and one PO; a partial receipt with a
 * rejection is allocated by a person; the released order's owner is told;
 * available = closing − committed throughout, without any sync running.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000ea';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken: string;
let salesToken: string;
let buyerToken: string;
let raviId = '';
let customerId = '';
let vendorId = '';
let cableId = '';
let connectionId = '';
const emitted: NotificationEvent[] = [];

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Procurement Fixture Org');
  vi.spyOn(harness.resolve(NotificationDispatcher), 'emit').mockImplementation((event) => {
    emitted.push(event);
    return Promise.resolve('spied');
  });
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const salesRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES, { isSystem: true });
  raviId = await harness.createEmployee({ code: 'PR-001', firstName: 'Ravi', lastName: 'Kumar' });
  const admin = await harness.createUser({ email: scopedEmail('pr-admin'), roleIds: [adminRoleId] });
  const sales = await harness.createUser({ email: scopedEmail('pr-sales'), roleIds: [salesRoleId], employeeId: raviId });
  // A buyer: raises purchase orders, cannot approve them (REQ-X-16).
  const buyerRoleId = await harness.createRole('Buyer', [PERMISSIONS.PURCHASE_DOCUMENT_VIEW, PERMISSIONS.PURCHASE_DOCUMENT_CREATE, PERMISSIONS.MASTERS_TALLY_VIEW]);
  const buyer = await harness.createUser({ email: scopedEmail('pr-buyer'), roleIds: [buyerRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  salesToken = (await harness.login(sales.email, sales.password)).token;
  buyerToken = (await harness.login(buyer.email, buyer.password)).token;

  /*
   * Start from a known approval threshold rather than whatever the last run
   * left behind.
   *
   * `purchase.approvalThreshold` is a settings row, and `resetOrganisation`
   * does not clear it -- the settings test below writes 10000 and it was
   * still 10000 at the top of the next run. Every order in this file then
   * crossed it, which mattered the moment confirm stopped letting the
   * requester's own approve key answer for the threshold (owner, 31 Aug
   * 2026): the first order sat in PENDING_APPROVAL and eight tests failed on
   * a fixture that had never said what it wanted. Zero is "no approval
   * needed", which is what a procurement-flow suite is actually about.
   */
  await harness.put('/purchase/settings', {
    token: adminToken,
    body: { approvalThreshold: null, invoiceWaitingHours: 24 },
  });

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Procurement Co', 'guid-procurement') RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';
  const customer = await harness.db.execute<{ id: string }>(sql`INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id`);
  customerId = customer.rows[0]?.id ?? '';
  const vendor = await harness.db.execute<{ id: string }>(sql`INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Behar Supply Co', 'Sundry Creditors') RETURNING id`);
  vendorId = vendor.rows[0]?.id ?? '';
  const cable = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate, closing_qty, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00', '12', now()) RETURNING id
  `);
  cableId = cable.rows[0]?.id ?? '';
});

afterAll(async () => {
  await harness.close();
});

let orderA = '';
let orderB = '';
let lineA = '';
let lineB = '';
let poId = '';

describe('availability (13 §2, REQ-AC-03/04)', () => {
  it('available is closing minus committed, and drops when an order is confirmed — with no sync running', async () => {
    const before = await harness.get<StockAvailability>(`/purchase/items/${cableId}/availability`, { token: adminToken });
    expect(before.body).toMatchObject({ closingQty: '12.000', committedQty: '0.000', availableQty: '12.000', openPoQty: '0.000' });
    expect(before.body.asOf).not.toBeNull();

    const a = await harness.post<SalesDocumentView>('/sales/orders', { token: salesToken, body: { partyId: customerId, lines: [{ stockItemId: cableId, quantity: '10', rate: '100' }] } });
    orderA = a.body.id;
    lineA = a.body.lines[0]?.id ?? '';
    await harness.post(`/sales/orders/${orderA}/confirm`, { token: salesToken });
    const b = await harness.post<SalesDocumentView>('/sales/orders', { token: salesToken, body: { partyId: customerId, lines: [{ stockItemId: cableId, quantity: '10', rate: '100' }] } });
    orderB = b.body.id;
    lineB = b.body.lines[0]?.id ?? '';
    await harness.post(`/sales/orders/${orderB}/confirm`, { token: salesToken });

    const after = await harness.get<StockAvailability>(`/purchase/items/${cableId}/availability`, { token: adminToken });
    expect(after.body).toMatchObject({ committedQty: '20.000', availableQty: '-8.000' });

    // 13 §6: no route writes a stock figure, under any permission including Admin — 405 on every plausible verb.
    const forbidden = await harness.del<ErrorBody>(`/purchase/items/${cableId}/stock`, { token: adminToken });
    expect(forbidden.status).toBe(405);
    const set = await harness.put<ErrorBody>(`/purchase/items/${cableId}/stock`, { token: adminToken, body: { closingQty: '999' } });
    expect(set.status).toBe(405);
    const entry = await harness.post<ErrorBody>(`/purchase/items/${cableId}/stock`, { token: adminToken, body: { quantity: '999' } });
    expect(entry.status).toBe(405);
    const items = await harness.post<ErrorBody>('/masters/items', { token: adminToken, body: { name: 'x' } });
    expect(items.status).toBe(405);
  });
});

describe('shortage → requirement → PO → GRN → allocation (13 §1)', () => {
  it('two short packs raise two requirements carrying their orders; the queue shows who waits', async () => {
    // D-48: the shelf first; the shortage is what was not there to pick.
    await harness.post(`/sales/orders/${orderA}/picks`, { token: salesToken, body: { lines: [{ lineId: lineA, quantity: '6' }] } });
    await harness.post(`/sales/orders/${orderA}/packs`, { token: salesToken, body: { lines: [{ lineId: lineA, quantity: '6' }] } });
    // D-48: the shelf first; the shortage is what was not there to pick.
    await harness.post(`/sales/orders/${orderB}/picks`, { token: salesToken, body: { lines: [{ lineId: lineB, quantity: '6' }] } });
    await harness.post(`/sales/orders/${orderB}/packs`, { token: salesToken, body: { lines: [{ lineId: lineB, quantity: '6' }] } });
    const queue = await harness.get<RequirementView[]>('/purchase/requirements?state=open', { token: adminToken });
    const mine = queue.body.filter((r) => r.stockItemId === cableId);
    expect(mine.map((r) => [r.source, r.quantity, r.salesOrderId])).toEqual([['shortage', '4.000', orderA], ['shortage', '4.000', orderB]]);
    expect(mine[0]?.customerName).toBe('Asha Traders');
  });

  it('the waiting order says why it waits and on what: the requirement, then the PO with its vendor and date (REQ-X-26)', async () => {
    const before = await harness.get<SalesDocumentView>(`/sales/orders/${orderA}`, { token: salesToken });
    expect(before.body.waitingOn.map((w) => [w.stockItemName, w.quantity, w.state, w.purchaseOrders])).toEqual([['Cat6 cable 305m', '4.000', 'open', []]]);
  });

  it('one PO from both requirements, one line of 8, linked to each; confirming pushes it and marks them ordered', async () => {
    const queue = await harness.get<RequirementView[]>('/purchase/requirements?state=open', { token: adminToken });
    const ids = queue.body.filter((r) => r.stockItemId === cableId).map((r) => r.id);
    const created = await harness.post<PurchaseOrderView>('/purchase/orders/from-requirements', { token: adminToken, body: { partyId: vendorId, requirementIds: ids } });
    expect(created.status).toBe(201);
    expect(created.body.number).toBe('PO-0001');
    expect(created.body.lines).toHaveLength(1);
    expect(created.body.lines[0]?.quantity).toBe('8.000');
    expect(created.body.lines[0]?.requirements.map((r) => r.quantity)).toEqual(['4.000', '4.000']);
    poId = created.body.id;

    // A rate, since the requirements carried none.
    const priced = await harness.patch<PurchaseOrderView>(`/purchase/orders/${poId}`, {
      token: adminToken,
      body: { lines: [{ stockItemId: cableId, description: 'Cat6 cable 305m', quantity: '8', rate: '3800', taxPct: '18', requirementIds: ids }] },
    });
    expect(priced.body.grandTotal).toBe('35872.00');

    const confirmed = await harness.post<PurchaseOrderView>(`/purchase/orders/${poId}/confirm`, { token: adminToken });
    expect(confirmed.body.status).toBe('CONFIRMED');
    // No agent connection with a token in this fixture: honest NOT_PUSHED, not a lie.
    expect(confirmed.body.syncState).toBe('NOT_PUSHED');
    const after = await harness.get<RequirementView[]>('/purchase/requirements?state=ordered', { token: adminToken });
    expect(after.body.filter((r) => r.stockItemId === cableId)).toHaveLength(2);
    const waiting = await harness.get<SalesDocumentView>(`/sales/orders/${orderA}`, { token: salesToken });
    expect(waiting.body.waitingOn[0]?.state).toBe('ordered');
    expect(waiting.body.waitingOn[0]?.purchaseOrders.map((p) => [p.number, p.vendorName, p.status, p.quantity])).toEqual([['PO-0001', 'Behar Supply Co', 'CONFIRMED', '4.000']]);
    const availability = await harness.get<StockAvailability>(`/purchase/items/${cableId}/availability`, { token: adminToken });
    expect(availability.body.openPoQty).toBe('8.000');
    // The nightly sweep raises nothing for an item an open PO already covers (with no reorder level set, nothing at all).
    await harness.db.execute(sql`INSERT INTO item_settings (org_id, stock_item_id, reorder_level) VALUES (${ORG_ID}, ${cableId}, '5')`);
  });

  it('a partial receipt with a rejection stays open, keeps the reason, and waits for a person to allocate between the two orders', async () => {
    const po = await harness.get<PurchaseOrderView>(`/purchase/orders/${poId}`, { token: adminToken });
    const poLine = po.body.lines[0]?.id ?? '';
    const noReason = await harness.post<ErrorBody>(`/purchase/orders/${poId}/grns`, { token: adminToken, body: { lines: [{ purchaseOrderLineId: poLine, receivedQty: '3', rejectedQty: '1' }] } });
    expect(noReason.status).toBe(400);

    const grn = await harness.post<GrnView>(`/purchase/orders/${poId}/grns`, {
      token: adminToken,
      body: { vendorInvoiceRef: 'BS/221', lines: [{ purchaseOrderLineId: poLine, receivedQty: '3', rejectedQty: '1', rejectionReason: 'Crushed box' }] },
    });
    expect(grn.status).toBe(201);
    expect(grn.body.number).toBe('GRN-0001');
    expect(grn.body.lines[0]).toMatchObject({ receivedQty: '3.000', rejectedQty: '1.000', rejectionReason: 'Crushed box' });
    // Two orders wait on one line: nobody was allocated automatically.
    expect(grn.body.pendingAllocations).toHaveLength(1);
    expect(grn.body.pendingAllocations[0]?.unallocatedQty).toBe('3.000');
    expect(grn.body.pendingAllocations[0]?.waiting).toHaveLength(2);
    expect(emitted.filter((e) => e.type === 'procurement.stock_arrived')).toHaveLength(0);

    const after = await harness.get<PurchaseOrderView>(`/purchase/orders/${poId}`, { token: adminToken });
    expect(after.body.fulfilment).toBe('partially_received');
    expect(after.body.lines[0]).toMatchObject({ receivedQty: '3.000', rejectedQty: '1.000' });

    const tooMuch = await harness.post<ErrorBody>(`/purchase/grns/${grn.body.id}/allocate`, {
      token: adminToken,
      body: { allocations: [{ requirementId: grn.body.pendingAllocations[0]?.waiting[0]?.requirementId, quantity: '5' }] },
    });
    expect(tooMuch.status).toBe(400);

    // The goods receipt note's workbook: quantities, no money.
    const xlsx = await harness.getRaw(`/purchase/grns/${grn.body.id}/export.xlsx`, { token: adminToken });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('content-disposition')).toContain(`Goods-Receipt-Note-${grn.body.number}.xlsx`);
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK');
    const decided = await harness.post<GrnView>(`/purchase/grns/${grn.body.id}/allocate`, {
      token: adminToken,
      body: { allocations: [{ requirementId: grn.body.pendingAllocations[0]?.waiting[0]?.requirementId, quantity: '3' }] },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.pendingAllocations).toHaveLength(0);
    // The chosen order's owner is told (REQ-X-28), once.
    const told = emitted.filter((e) => e.type === 'procurement.stock_arrived');
    expect(told).toHaveLength(1);
    expect(told[0]?.audience).toEqual({ kind: 'employees', employeeIds: [raviId] });
    expect(told[0]?.payload?.orderNumber).toBeTruthy();
    expect(await harness.waitForAuditAction('purchase.grn.allocated')).toBe(true);
  });

  it('receiving the rest while two still wait asks again; splitting 4 as 1 + 3 completes one requirement and leaves the other short', async () => {
    const po = await harness.get<PurchaseOrderView>(`/purchase/orders/${poId}`, { token: adminToken });
    const poLine = po.body.lines[0]?.id ?? '';
    const grn = await harness.post<GrnView>(`/purchase/orders/${poId}/grns`, { token: adminToken, body: { lines: [{ purchaseOrderLineId: poLine, receivedQty: '4' }] } });
    expect(grn.status).toBe(201);
    const pending = grn.body.pendingAllocations[0];
    expect(pending?.unallocatedQty).toBe('4.000');
    expect(pending?.waiting.map((w) => w.outstandingQty).sort()).toEqual(['1.000', '4.000']);
    const first = pending?.waiting.find((w) => w.outstandingQty === '1.000');
    const second = pending?.waiting.find((w) => w.outstandingQty === '4.000');
    const decided = await harness.post<GrnView>(`/purchase/grns/${grn.body.id}/allocate`, {
      token: adminToken,
      body: { allocations: [{ requirementId: first?.requirementId, quantity: '1' }, { requirementId: second?.requirementId, quantity: '3' }] },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.pendingAllocations).toHaveLength(0);
    const requirements = await harness.get<RequirementView[]>('/purchase/requirements', { token: adminToken });
    const states = requirements.body.filter((r) => r.stockItemId === cableId).map((r) => [r.state, r.receivedQty]).sort();
    expect(states).toEqual([['ordered', '3.000'], ['received', '4.000']]);
    const after = await harness.get<PurchaseOrderView>(`/purchase/orders/${poId}`, { token: adminToken });
    // 3 + 1 rejected + 4 = 8: everything ordered is accounted for.
    expect(after.body.fulfilment).toBe('received');
    expect(emitted.filter((e) => e.type === 'procurement.stock_arrived')).toHaveLength(3);
  });

  it('short-close needs the approve key; item vendors and settings are Vyuha’s (D-27, D-28)', async () => {
    const asSales = await harness.post<ErrorBody>(`/purchase/orders/${poId}/short-close`, { token: salesToken, body: { reason: 'x' } });
    expect([403, 404]).toContain(asSales.status);

    const vendors = await harness.put<{ partyName: string; isPreferred: boolean }[]>(`/purchase/items/${cableId}/vendors`, {
      token: adminToken,
      body: { vendors: [{ partyId: vendorId, isPreferred: true, leadTimeDays: 7 }] },
    });
    expect(vendors.body).toEqual([{ partyId: vendorId, partyName: 'Behar Supply Co', isPreferred: true, leadTimeDays: 7 }]);
    const settings = await harness.put<StockAvailability>(`/purchase/items/${cableId}/settings`, { token: adminToken, body: { reorderLevel: '20', minimumOrderQty: '5' } });
    expect(settings.body.reorderLevel).toBe('20.000');

    const history = await harness.get<{ source: string; reference: string; rate: string | null }[]>(`/purchase/item-history?stockItemId=${cableId}&partyId=${vendorId}`, { token: adminToken });
    expect(history.body.map((h) => [h.source, h.reference, h.rate])).toEqual([['purchase_order', 'PO-0001', '3800.00']]);
  });
});

describe('the nightly reorder sweep (13 REQ-X-09)', () => {
  it('raises one requirement per item at or below its reorder level, audits it, and raises nothing a second time while it stays open', async () => {
    const requirements = harness.resolve(RequirementsService);
    await harness.put(`/purchase/items/${cableId}/settings`, { token: adminToken, body: { reorderLevel: '1000', minimumOrderQty: '5' } });
    const first = await requirements.raiseReorderBreaches(ORG_ID);
    expect(first).toBe(1);
    const raised = await harness.get<RequirementView[]>('/purchase/requirements?state=open', { token: adminToken });
    const reorder = raised.body.find((r) => r.stockItemId === cableId && r.source === 'reorder');
    expect(reorder).toBeDefined();
    expect(Number(reorder?.quantity)).toBeGreaterThan(0);
    expect(await harness.waitForAuditAction('procurement.requirement.raised')).toBe(true);
    const second = await requirements.raiseReorderBreaches(ORG_ID);
    expect(second).toBe(0);
    await harness.post(`/purchase/requirements/${reorder?.id ?? ''}/close`, { token: adminToken, body: { reason: 'test: reorder level restored' } });
    await harness.put(`/purchase/items/${cableId}/settings`, { token: adminToken, body: { reorderLevel: '20', minimumOrderQty: '5' } });
  });

  it('refuses a minimum order quantity of nought (audit 5)', async () => {
    // Stored as zero it reaches the sweep, where it is the floor of a
    // GREATEST: an item sitting exactly on its reorder level then produced a
    // requirement to buy nought, which the buyer sees as a job to do and can
    // do nothing with. Empty is how "no minimum" is said.
    const refused = await harness.put<ErrorBody>(`/purchase/items/${cableId}/settings`, {
      token: adminToken,
      body: { reorderLevel: '20', minimumOrderQty: '0' },
    });
    expect(refused.status).toBe(400);
    const alsoRefused = await harness.put<ErrorBody>(`/purchase/items/${cableId}/settings`, {
      token: adminToken,
      body: { reorderLevel: '20', minimumOrderQty: '0.000' },
    });
    expect(alsoRefused.status).toBe(400);
    // Clearing it still means "no minimum".
    const cleared = await harness.put(`/purchase/items/${cableId}/settings`, {
      token: adminToken,
      body: { reorderLevel: '20', minimumOrderQty: null },
    });
    expect(cleared.status).toBe(200);
    await harness.put(`/purchase/items/${cableId}/settings`, { token: adminToken, body: { reorderLevel: '20', minimumOrderQty: '5' } });
  });

  it('does not reorder an item whose receipt has not come back from Tally (audit 6)', async () => {
    const requirements = harness.resolve(RequirementsService);
    await harness.put(`/purchase/items/${cableId}/settings`, { token: adminToken, body: { reorderLevel: '1000', minimumOrderQty: '5' } });
    const raised = await requirements.raiseReorderBreaches(ORG_ID);
    expect(raised).toBe(1);
    const open = await harness.get<RequirementView[]>('/purchase/requirements?state=open', { token: adminToken });
    const mine = open.body.find((r) => r.stockItemId === cableId && r.source === 'reorder');
    expect(mine).toBeDefined();

    // The goods arrive: the requirement is received, but closing_qty is
    // Tally's figure and Tally has not been pulled since. The guard only
    // looked at open and ordered, so the sweep raised the same reorder again
    // -- every night, until Tally caught up.
    await harness.db.execute(sql`
      UPDATE procurement_requirements SET state = 'received', received_qty = quantity, updated_at = now()
       WHERE id = ${mine?.id ?? ''}
    `);
    await harness.db.execute(sql`UPDATE stock_items SET last_pulled_at = now() - interval '1 hour' WHERE id = ${cableId}`);

    expect(await requirements.raiseReorderBreaches(ORG_ID)).toBe(0);

    // Once Tally has been pulled since, its closing quantity knows about the
    // receipt -- and if the item is still short, it is short for real.
    await harness.db.execute(sql`UPDATE stock_items SET last_pulled_at = now() WHERE id = ${cableId}`);
    expect(await requirements.raiseReorderBreaches(ORG_ID)).toBe(1);

    await harness.db.execute(sql`
      UPDATE procurement_requirements SET state = 'closed', closed_at = now()
       WHERE org_id = ${ORG_ID} AND stock_item_id = ${cableId} AND source = 'reorder' AND state <> 'closed'
    `);
    await harness.put(`/purchase/items/${cableId}/settings`, { token: adminToken, body: { reorderLevel: '20', minimumOrderQty: '5' } });
  });
});

describe('approval by value through the inbox (13 REQ-X-16)', () => {
  let bigPoId = '';

  /*
   * Put the threshold back. It is organisation-wide, so leaving it at 10000
   * hands every later describe an approval requirement it never asked for --
   * which is what left the double-order test confirming into
   * PENDING_APPROVAL instead of CONFIRMED.
   */
  afterAll(async () => {
    await harness.put('/purchase/settings', {
      token: adminToken,
      body: { approvalThreshold: null, invoiceWaitingHours: 24 },
    });
  });

  it('the threshold is a setting an approver writes; a PO over it waits in the approvals inbox, and its author cannot approve it', async () => {
    const asBuyer = await harness.put<ErrorBody>('/purchase/settings', { token: buyerToken, body: { approvalThreshold: '10000', invoiceWaitingHours: 24 } });
    expect(asBuyer.status).toBe(403);
    const written = await harness.put<PurchaseSettings>('/purchase/settings', { token: adminToken, body: { approvalThreshold: '10000', invoiceWaitingHours: 24 } });
    expect(written.body).toEqual({ approvalThreshold: '10000.00', invoiceWaitingHours: 24 });

    const created = await harness.post<PurchaseOrderView>('/purchase/orders', {
      token: buyerToken,
      body: { partyId: vendorId, lines: [{ stockItemId: cableId, quantity: '10', rate: '3800' }] },
    });
    expect(created.status).toBe(201);
    expect(created.body.approvalRequired).toBe(true);
    bigPoId = created.body.id;

    const confirmed = await harness.post<PurchaseOrderView>(`/purchase/orders/${bigPoId}/confirm`, { token: buyerToken });
    expect(confirmed.body.status).toBe('PENDING_APPROVAL');
    expect(confirmed.body.syncState).toBe('NOT_PUSHED');

    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals?view=all', { token: adminToken });
    const request = inbox.body.data.find((r) => r.type === 'PURCHASE_ORDER' && r.subject.startsWith(created.body.number));
    expect(request).toBeDefined();
    expect(request?.status).toBe('PENDING');

    const self = await harness.post<ErrorBody>(`/purchase/orders/${bigPoId}/approve`, { token: buyerToken });
    expect(self.status).toBe(403);
  });

  it('approving in the inbox confirms the PO and runs the push settlement; the two never disagree', async () => {
    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals?view=all', { token: adminToken });
    const request = inbox.body.data.find((r) => r.type === 'PURCHASE_ORDER' && r.status === 'PENDING');
    const decided = await harness.post(`/approvals/${request?.id ?? ''}/approve`, { token: adminToken, body: {} });
    expect(decided.status).toBe(201);
    const po = await harness.get<PurchaseOrderView>(`/purchase/orders/${bigPoId}`, { token: adminToken });
    expect(po.body.status).toBe('CONFIRMED');
    // Same fixture, same honesty: no agent token here, so the push settlement ran and found no carrier.
    expect(po.body.syncState).toBe('NOT_PUSHED');
    expect(await harness.waitForAuditAction('purchase.order.approved')).toBe(true);
  });

  it('a rejection sends the PO back to draft with the reason; the PO’s own Approve button decides the same request', async () => {
    const created = await harness.post<PurchaseOrderView>('/purchase/orders', {
      token: buyerToken,
      body: { partyId: vendorId, lines: [{ stockItemId: cableId, quantity: '20', rate: '3800' }] },
    });
    await harness.post(`/purchase/orders/${created.body.id}/confirm`, { token: buyerToken });
    let inbox = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals?view=all', { token: adminToken });
    let request = inbox.body.data.find((r) => r.type === 'PURCHASE_ORDER' && r.status === 'PENDING');
    const rejected = await harness.post(`/approvals/${request?.id ?? ''}/reject`, { token: adminToken, body: { reason: 'Too much cable for one month' } });
    expect(rejected.status).toBe(201);
    const back = await harness.get<PurchaseOrderView>(`/purchase/orders/${created.body.id}`, { token: buyerToken });
    expect(back.body.status).toBe('DRAFT');

    // Resubmitted, then approved from the PO itself: same ledger, same outcome.
    await harness.post(`/purchase/orders/${created.body.id}/confirm`, { token: buyerToken });
    const approved = await harness.post<PurchaseOrderView>(`/purchase/orders/${created.body.id}/approve`, { token: adminToken });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('CONFIRMED');
    inbox = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals?view=all', { token: adminToken });
    request = inbox.body.data.find((r) => r.type === 'PURCHASE_ORDER' && r.status === 'PENDING');
    expect(request).toBeUndefined();
  });

  it('a released PO carries the vendor’s copy per channel, pending until a person marks it sent (REQ-X-18, REQ-AA-26)', async () => {
    const created = await harness.post<PurchaseOrderView>('/purchase/orders', {
      token: buyerToken,
      body: { partyId: vendorId, vendorEmail: 'orders@behar.example', vendorWhatsapp: '+919800000000', lines: [{ stockItemId: cableId, quantity: '1', rate: '3800' }] },
    });
    expect(created.body.vendorEmail).toBe('orders@behar.example');
    expect(created.body.notifications).toEqual([]);
    const confirmed = await harness.post<PurchaseOrderView>(`/purchase/orders/${created.body.id}/confirm`, { token: buyerToken });
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.notifications.map((n) => [n.channel, n.recipient, n.status])).toEqual([
      ['email', 'orders@behar.example', 'pending'],
      ['whatsapp', '+919800000000', 'pending'],
    ]);
    expect(confirmed.body.notifications[0]?.composedText).toContain(created.body.number);
    expect(confirmed.body.notifications[0]?.composedText).toContain('Cat6 cable 305m: 1 BOX @ 3800.00');
    const marked = await harness.post<PurchaseOrderView>(`/purchase/orders/${created.body.id}/notifications/${confirmed.body.notifications[1]?.id ?? ''}`, { token: buyerToken, body: { status: 'sent' } });
    expect(marked.status).toBe(200);
    expect(marked.body.notifications.find((n) => n.channel === 'whatsapp')?.status).toBe('sent');
    expect(await harness.waitForAuditAction('purchase.order.notification_sent')).toBe(true);
  });

  it('a PO number opens from the palette (REQ-O-05)', async () => {
    const found = await harness.get<{ records: { type: string; code: string | null }[] }>('/go-to?q=PO-0001', { token: buyerToken });
    expect(found.body.records.some((r) => r.type === 'purchase_order' && r.code === 'PO-0001')).toBe(true);
  });

  it('cancelling a pending PO withdraws its request', async () => {
    const created = await harness.post<PurchaseOrderView>('/purchase/orders', {
      token: buyerToken,
      body: { partyId: vendorId, lines: [{ stockItemId: cableId, quantity: '30', rate: '3800' }] },
    });
    await harness.post(`/purchase/orders/${created.body.id}/confirm`, { token: buyerToken });
    const cancelled = await harness.post<PurchaseOrderView>(`/purchase/orders/${created.body.id}/cancel`, { token: buyerToken });
    expect(cancelled.body.status).toBe('CANCELLED');
    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals?view=all', { token: adminToken });
    expect(inbox.body.data.find((r) => r.type === 'PURCHASE_ORDER' && r.status === 'PENDING')).toBeUndefined();
  });
});

describe('item settings belong to the organisation that owns the item', () => {
  /**
   * `item_settings` is unique on `stock_item_id` alone, and the id arrived
   * from the path unchecked — so a settings write naming another
   * organisation's item did not collide with its row, it updated it.
   */
  it('refuses a stock item this organisation does not own, and leaves its settings alone', async () => {
    // An item belonging to nobody in this org: a different organisation's row.
    const otherOrg = '01900000-0000-7000-8000-0000000000eb';
    await harness.db.execute(sql`
      INSERT INTO organizations (id, name) VALUES (${otherOrg}, 'Other Co')
      ON CONFLICT (id) DO NOTHING
    `);
    // resetOrganisation clears this org, not the other one, so a second run
    // would collide on the connection's company guid. Clear the neighbour
    // first: it is this test's fixture and nobody else's.
    await harness.db.execute(sql`DELETE FROM item_settings WHERE org_id = ${otherOrg}`);
    await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${otherOrg}`);
    await harness.db.execute(sql`DELETE FROM integration_connections WHERE org_id = ${otherOrg}`);
    const conn = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO integration_connections (org_id, system, name, company_guid)
      VALUES (${otherOrg}, 'TALLY', 'Other Co', 'guid-other-co-settings') RETURNING id
    `);
    const theirItem = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate, last_pulled_at)
      VALUES (${otherOrg}, ${conn.rows[0]?.id ?? ''}, 'Their cable', 'NOS', 'Cables', '18.00', now()) RETURNING id
    `);
    const theirItemId = theirItem.rows[0]?.id ?? '';
    await harness.db.execute(sql`
      INSERT INTO item_settings (org_id, stock_item_id, reorder_level, minimum_order_qty)
      VALUES (${otherOrg}, ${theirItemId}, 500, 50)
    `);

    const refused = await harness.put(`/purchase/items/${theirItemId}/settings`, {
      token: adminToken,
      body: { reorderLevel: '1', minimumOrderQty: '1' },
    });
    expect(refused.status).toBe(404);

    // Their row is untouched — this is what the bug overwrote.
    const after = await harness.db.execute<{ reorder_level: string; org_id: string }>(sql`
      SELECT reorder_level::text, org_id::text FROM item_settings WHERE stock_item_id = ${theirItemId}
    `);
    expect(after.rows[0]?.reorder_level).toBe('500.000');
    expect(after.rows[0]?.org_id).toBe(otherOrg);

    await harness.db.execute(sql`DELETE FROM item_settings WHERE org_id = ${otherOrg}`);
    await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${otherOrg}`);
    await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${otherOrg}`);
  });

  it('accepts an item this organisation does own', async () => {
    const ok = await harness.put(`/purchase/items/${cableId}/settings`, {
      token: adminToken,
      body: { reorderLevel: '25', minimumOrderQty: '5' },
    });
    expect([200, 204]).toContain(ok.status);
  });
});

describe('the two ceilings on an allocation (audits 11, 12)', () => {
  /**
   * How much is left was read from the view the request was built against and
   * never moved while the request ran. Two allocators looking at the same
   * screen each saw the whole receipt free and both spent it; so did one
   * request naming the same requirement twice. And nothing capped an
   * allocation by what the order was actually waiting for, so a requirement
   * short by one could be allocated four and read as received, quietly taking
   * what belonged to whoever else was in the queue.
   */
  const lastGrn = async (): Promise<GrnView> => {
    const row = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM grns WHERE org_id = ${ORG_ID} AND purchase_order_id = ${poId} ORDER BY created_at DESC LIMIT 1
    `);
    return (await harness.get<GrnView>(`/purchase/grns/${row.rows[0]?.id ?? ''}`, { token: adminToken })).body;
  };

  it('refuses the second half of a request that spends the same receipt twice', async () => {
    // Everything allocated so far is given back, so this GRN's line has room
    // again and the two requirements are waiting on it.
    await harness.db.execute(sql`
      UPDATE po_line_requirements SET allocated_qty = 0
       WHERE purchase_order_line_id IN (SELECT id FROM purchase_order_lines WHERE purchase_order_id = ${poId})
    `);
    await harness.db.execute(sql`
      UPDATE procurement_requirements SET received_qty = 0, state = 'ordered'
       WHERE org_id = ${ORG_ID} AND id IN (SELECT requirement_id FROM po_line_requirements
         WHERE purchase_order_line_id IN (SELECT id FROM purchase_order_lines WHERE purchase_order_id = ${poId}))
    `);
    await harness.db.execute(sql`
      UPDATE purchase_order_lines SET received_qty = 4 WHERE purchase_order_id = ${poId}
    `);

    const grn = await lastGrn();
    const pending = grn.pendingAllocations[0];
    expect(pending?.unallocatedQty).toBe('4.000');
    const first = pending?.waiting[0]?.requirementId ?? '';

    // Four are free; three and three is six. The snapshot said four was free
    // for both halves, and both used to be written.
    const refused = await harness.post<ErrorBody>(`/purchase/grns/${grn.id}/allocate`, {
      token: adminToken,
      body: { allocations: [{ requirementId: first, quantity: '3' }, { requirementId: first, quantity: '3' }] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('left to allocate');

    // The transaction took neither half.
    const after = await lastGrn();
    expect(after.pendingAllocations[0]?.unallocatedQty).toBe('4.000');
  });

  it('refuses more than the order is waiting for, even when the receipt has it', async () => {
    // One requirement now waits for a single unit while four sit unallocated
    // on the line: the receipt has room, the order does not.
    await harness.db.execute(sql`
      UPDATE po_line_requirements SET quantity = 1, allocated_qty = 0
       WHERE purchase_order_line_id IN (SELECT id FROM purchase_order_lines WHERE purchase_order_id = ${poId})
    `);
    const grn = await lastGrn();
    const pending = grn.pendingAllocations[0];
    expect(Number(pending?.unallocatedQty)).toBeGreaterThan(1);
    const waiting = pending?.waiting[0];
    expect(waiting?.outstandingQty).toBe('1.000');

    const refused = await harness.post<ErrorBody>(`/purchase/grns/${grn.id}/allocate`, {
      token: adminToken,
      body: { allocations: [{ requirementId: waiting?.requirementId, quantity: '3' }] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('waiting for only');

    // One is taken, which is all it was waiting for.
    const allowed = await harness.post<GrnView>(`/purchase/grns/${grn.id}/allocate`, {
      token: adminToken,
      body: { allocations: [{ requirementId: waiting?.requirementId, quantity: '1' }] },
    });
    expect(allowed.status).toBe(200);
  });
});

describe('an order that stops being a promise of goods (audits 3, 4, 8, 12)', () => {
  /**
   * Short-closing and a Tally cancellation are the same fact arriving from
   * two directions: the vendor is not bringing the balance. Both have to give
   * the requirements back, and neither may give them back twice.
   *
   * Built from SQL rather than through the shortage flow so each test owns its
   * own order and requirement and the numbers are not a coincidence of what
   * the fixtures above left behind.
   */
  const buildOrder = async (number: string, quantity: number): Promise<{ poId: string; requirementId: string }> => {
    const req = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO procurement_requirements (org_id, stock_item_id, quantity, source, state, ordered_qty, received_qty)
      VALUES (${ORG_ID}, ${cableId}, ${quantity}, 'shortage', 'ordered', ${quantity}, 0)
      RETURNING id
    `);
    const requirementId = req.rows[0]?.id ?? '';
    const po = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO purchase_orders (org_id, number, status, date, party_id, vendor_name)
      VALUES (${ORG_ID}, ${number}, 'CONFIRMED', CURRENT_DATE, ${vendorId}, 'Behar Supply Co')
      RETURNING id
    `);
    const poId = po.rows[0]?.id ?? '';
    const line = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO purchase_order_lines (org_id, purchase_order_id, line_no, stock_item_id, description, quantity, rate, amount, tax_pct, tax_amount)
      VALUES (${ORG_ID}, ${poId}, 1, ${cableId}, 'Cat6 cable 305m', ${quantity}, 100, ${quantity * 100}, 18, ${quantity * 18})
      RETURNING id
    `);
    await harness.db.execute(sql`
      INSERT INTO po_line_requirements (org_id, purchase_order_line_id, requirement_id, quantity, allocated_qty)
      VALUES (${ORG_ID}, ${line.rows[0]?.id ?? ''}, ${requirementId}, ${quantity}, 0)
    `);
    return { poId, requirementId };
  };

  /** The registry's own mirror callback, bound so it can be called detached. */
  const mirrorHandler = () => {
    const handler = harness.resolve(PushOutcomeRegistry).find('PURCHASE_ORDER');
    return handler?.onMirror?.bind(handler);
  };

  const orderedQty = async (requirementId: string): Promise<string> =>
    (
      await harness.db.execute<{ ordered_qty: string }>(
        sql`SELECT ordered_qty::text FROM procurement_requirements WHERE id = ${requirementId}`,
      )
    ).rows[0]?.ordered_qty ?? '';

  it('short-closes once, however many times it is asked (audit 3)', async () => {
    const { poId, requirementId } = await buildOrder('PO-SHORT-1', 6);
    expect(await orderedQty(requirementId)).toBe('6.000');

    const first = await harness.post(`/purchase/orders/${poId}/short-close`, { token: adminToken, body: { reason: 'Vendor cannot supply' } });
    expect(first.status).toBe(200);
    expect(await orderedQty(requirementId)).toBe('0.000');

    // The second attempt subtracted the same six again, so the requirement
    // believed less was on order than really was and the sweep reordered
    // goods that were already coming.
    const again = await harness.post<ErrorBody>(`/purchase/orders/${poId}/short-close`, { token: adminToken, body: { reason: 'Pressed twice' } });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('already short-closed');
    expect(await orderedQty(requirementId)).toBe('0.000');
  });

  it('gives the requirements back when Tally cancels the order (audit 4)', async () => {
    const { poId, requirementId } = await buildOrder('PO-TALLY-1', 5);
    expect(await orderedQty(requirementId)).toBe('5.000');

    const onMirror = mirrorHandler();
    expect(onMirror).toBeDefined();
    await harness.db.transaction(async (tx) => {
      await onMirror?.(tx, ORG_ID, poId, {
      remoteGuid: 'guid-tally-cancel-1',
      remoteVoucherNumber: '4242',
      isCancelled: true,
      alterId: 2,
      });
    });

    const status = await harness.db.execute<{ status: string }>(sql`SELECT status FROM purchase_orders WHERE id = ${poId}`);
    expect(status.rows[0]?.status).toBe('CANCELLED');
    // The order is gone from Tally, so nothing is on the way any more. It used
    // to be marked cancelled and leave the requirement sitting in `ordered`,
    // so the buyer went on believing the goods were coming.
    expect(await orderedQty(requirementId)).toBe('0.000');

    // And a second pull of the same cancellation does not subtract again.
    await harness.db.transaction(async (tx) => {
      await onMirror?.(tx, ORG_ID, poId, {
      remoteGuid: 'guid-tally-cancel-1',
      remoteVoucherNumber: '4242',
      isCancelled: true,
      alterId: 3,
      });
    });
    expect(await orderedQty(requirementId)).toBe('0.000');
  });

  it('refuses the confirm that would double-order what another PO already took (P3 lead 7)', async () => {
    const req = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO procurement_requirements (org_id, stock_item_id, quantity, source, state)
      VALUES (${ORG_ID}, ${cableId}, 10, 'shortage', 'open')
      RETURNING id
    `);
    const requirementId = req.rows[0]?.id ?? '';

    // Two drafts, both born from the same shortage: nothing claims a
    // requirement until its order confirms, so both see the same ten open.
    const draftOf = async (): Promise<string> => {
      const created = await harness.post<PurchaseOrderView>('/purchase/orders/from-requirements', { token: adminToken, body: { partyId: vendorId, requirementIds: [requirementId] } });
      expect(created.status).toBe(201);
      await harness.patch<PurchaseOrderView>(`/purchase/orders/${created.body.id}`, {
        token: adminToken,
        body: { lines: [{ stockItemId: cableId, description: 'Cat6 cable 305m', quantity: '10', rate: '3800', taxPct: '18', requirementIds: [requirementId] }] },
      });
      return created.body.id;
    };
    const first = await draftOf();
    const second = await draftOf();

    const confirmed = await harness.post<PurchaseOrderView>(`/purchase/orders/${first}/confirm`, { token: adminToken });
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(await orderedQty(requirementId)).toBe('10.000');

    // The second confirm used to go through as well: ordered_qty reached
    // twenty on a ten-unit requirement and the vendor got two copies of one
    // shortage.
    const refused = await harness.post<ErrorBody>(`/purchase/orders/${second}/confirm`, { token: adminToken });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('still open');
    expect(await orderedQty(requirementId)).toBe('10.000');
    const held = await harness.get<PurchaseOrderView>(`/purchase/orders/${second}`, { token: adminToken });
    expect(held.body.status).toBe('DRAFT');

    // The refusal names the repair. Unlinked, the same draft confirms, and
    // the requirement still shows the first order's ten and nothing more.
    await harness.patch<PurchaseOrderView>(`/purchase/orders/${second}`, {
      token: adminToken,
      body: { lines: [{ stockItemId: cableId, description: 'Cat6 cable 305m', quantity: '10', rate: '3800', taxPct: '18', requirementIds: [] }] },
    });
    const secondConfirm = await harness.post<PurchaseOrderView>(`/purchase/orders/${second}/confirm`, { token: adminToken });
    expect(secondConfirm.body.status).toBe('CONFIRMED');
    expect(await orderedQty(requirementId)).toBe('10.000');
  });

  it('writes one audit entry when a receipt note is voided in Tally, and none on the repeat (P3 lead 9)', async () => {
    const { poId } = await buildOrder('PO-VOID-GRN', 3);
    const grn = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO grns (org_id, number, purchase_order_id) VALUES (${ORG_ID}, 'GRN-VOID-1', ${poId}) RETURNING id
    `);
    const grnId = grn.rows[0]?.id ?? '';
    const handler = harness.resolve(PushOutcomeRegistry).find('RECEIPT_NOTE');
    const onMirror = handler?.onMirror?.bind(handler);
    expect(onMirror).toBeDefined();
    const audit = harness.resolve(AuditContext);

    // The handler records through the request-scoped audit channel, so the
    // test provides one and reads back what landed in it.
    const mirrorOnce = (alterId: number) =>
      audit.run(async (store) => {
        await harness.db.transaction(async (tx) => {
          await onMirror?.(tx, ORG_ID, grnId, { remoteGuid: 'guid-grn-void', remoteVoucherNumber: '77', isCancelled: true, alterId });
        });
        return store.entries.filter((entry) => entry.action === 'purchase.grn.cancelled_in_tally');
      });

    const firstEntries = await mirrorOnce(2);
    expect(firstEntries).toHaveLength(1);
    expect(firstEntries[0]?.entityId).toBe(grnId);
    const noted = await harness.db.execute<{ last_error: string | null }>(sql`SELECT last_error FROM grns WHERE id = ${grnId}`);
    expect(noted.rows[0]?.last_error).toBe('Cancelled in Tally');

    // The mirror arrives on every pull; the audit row must not.
    expect(await mirrorOnce(3)).toHaveLength(0);
  });

  it('writes one audit entry when a delivery note is voided in Tally, and none on the repeat (P3 lead 9)', async () => {
    const doc = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO sales_documents (org_id, doc_type, number, status, date, customer_name)
      VALUES (${ORG_ID}, 'SALES_ORDER', 'SO-VOID-1', 'CONFIRMED', CURRENT_DATE, 'Asha Traders')
      RETURNING id
    `);
    const dispatch = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO dispatches (org_id, document_id, number, mode)
      VALUES (${ORG_ID}, ${doc.rows[0]?.id ?? ''}, 'DSP-VOID-1', 'outstation')
      RETURNING id
    `);
    const dispatchId = dispatch.rows[0]?.id ?? '';
    const handler = harness.resolve(PushOutcomeRegistry).find('DELIVERY_NOTE');
    const onMirror = handler?.onMirror?.bind(handler);
    expect(onMirror).toBeDefined();
    const audit = harness.resolve(AuditContext);

    const mirrorOnce = (alterId: number) =>
      audit.run(async (store) => {
        await harness.db.transaction(async (tx) => {
          await onMirror?.(tx, ORG_ID, dispatchId, { remoteGuid: 'guid-dsp-void', remoteVoucherNumber: '78', isCancelled: true, alterId });
        });
        return store.entries.filter((entry) => entry.action === 'sales.dispatch.cancelled_in_tally');
      });

    const firstEntries = await mirrorOnce(2);
    expect(firstEntries).toHaveLength(1);
    expect(firstEntries[0]?.entityId).toBe(dispatchId);
    expect(await mirrorOnce(3)).toHaveLength(0);
  });

  it('does not release twice when an order is short-closed and then cancelled in Tally (audits 3, 4)', async () => {
    const { poId, requirementId } = await buildOrder('PO-BOTH-1', 4);
    await harness.post(`/purchase/orders/${poId}/short-close`, { token: adminToken, body: { reason: 'Vendor cannot supply' } });
    expect(await orderedQty(requirementId)).toBe('0.000');

    // Short-closing leaves the status CONFIRMED, so the Tally cancellation
    // passes a status check and would have released a second time.
    const onMirror = mirrorHandler();
    await harness.db.transaction(async (tx) => {
      await onMirror?.(tx, ORG_ID, poId, {
      remoteGuid: 'guid-tally-cancel-2',
      remoteVoucherNumber: '4243',
      isCancelled: true,
      alterId: 2,
      });
    });
    expect(await orderedQty(requirementId)).toBe('0.000');
  });

  it('stores the subtotal gross, so subtotal less discount plus tax is the total (audit 12)', async () => {
    // Its own order with a real discount on it: without one, net and gross are
    // the same number and the assertion holds either way.
    const created = await harness.post<PurchaseOrderView>('/purchase/orders', {
      token: adminToken,
      body: {
        partyId: vendorId,
        lines: [{ stockItemId: cableId, description: 'Cat6 cable 305m', quantity: '10', rate: '100', discountPct: '10', taxPct: '18' }],
      },
    });
    expect(created.status, created.text).toBe(201);

    const po = await harness.get<PurchaseOrderView>(`/purchase/orders/${created.body.id}`, { token: adminToken });
    const gross = Number(po.body.subtotal);
    const discount = Number(po.body.discountTotal);
    const tax = Number(po.body.taxTotal);
    const total = Number(po.body.grandTotal);

    // Ten at a hundred, less a tenth, plus eighteen per cent of what is left.
    expect(gross).toBe(1000);
    expect(discount).toBe(100);
    expect(tax).toBe(162);
    expect(total).toBe(1062);
    // The four figures on the export reconcile. `subtotal` used to be the net,
    // with the discount already taken off, so a reader subtracting the
    // discount printed beside it took it off twice -- 962 against a total of
    // 1062.
    expect(gross - discount + tax).toBeCloseTo(total, 2);
  });

});
