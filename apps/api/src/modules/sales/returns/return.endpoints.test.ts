import { SYSTEM_ROLES, type Paginated, type ReturnReasonsPolicy, type SalesReturnSummary, type SalesReturnView, type UnlinkedCreditNote } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * Area AK's acceptance (docs/15), over real HTTP.
 *
 * The three rules the area rests on, each proved rather than asserted:
 * Vyuha raises no credit note and the receipt waits for Tally's
 * (REQ-AK-05/AK-06); a restock moves no stock here (REQ-AK-07); and a
 * replacement is an ordinary order whose lines are free or chargeable by a
 * decision recorded on the return (REQ-AK-08/AK-09, D-51).
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d2';

let harness: ApiHarness;
let adminToken = '';
let salesToken = '';
let employeeToken = '';
let connectionId = '';
let partyId = '';
let itemId = '';
let orderId = '';
let orderLineId = '';
let jpeg: Buffer;

interface ErrorBody {
  error: { code: string; message: string; details?: { fields?: { path: string; message: string }[] } };
}
interface OrderView {
  id: string;
  number: string;
  status: string;
  grandTotal: string;
  returnId?: string | null;
  lines: { id: string; description: string; quantity: string; rate: string; invoicedQty: string; dispatchedQty: string; freeOfCharge: boolean }[];
}

async function multipart<T>(path: string, token: string, payload: unknown, photos: readonly { field: string; bytes: Buffer }[] = []): Promise<{ status: number; body: T }> {
  const form = new FormData();
  for (const photo of photos) form.append(photo.field, new Blob([new Uint8Array(photo.bytes)], { type: 'image/jpeg' }), 'photo.jpg');
  form.append('payload', JSON.stringify(payload));
  const response = await fetch(`${harness.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : null) as T };
}

/** A Credit Note as the pull would leave it. */
async function creditNote(number: string, amount: number, narration: string, party = partyId): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, '2026-08-21', 'Credit Note', ${number}, 'Asha Traders', ${party}, ${narration}, false, ${amount}, now())
    RETURNING id
  `);
  return rows.rows[0]?.id ?? '';
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Returns Org');
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);
  jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#777' } }).jpeg({ quality: 80 }).toBuffer();

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const salesRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES_MANAGER, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const storeman = await harness.createEmployee({ code: 'ST-001', firstName: 'Ravi', lastName: 'Store' });
  const admin = await harness.createUser({ email: scopedEmail('ret-admin'), roleIds: [adminRoleId], employeeId: storeman });
  const sales = await harness.createUser({ email: scopedEmail('ret-sales'), roleIds: [salesRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('ret-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  salesToken = (await harness.login(sales.email, sales.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Returns Co', 'guid-returns-co') RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate) VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00') RETURNING id
  `);
  itemId = item.rows[0]?.id ?? '';

  // An order taken all the way out of the door, so a return has something to come back against.
  const created = await harness.post<OrderView>('/sales/orders', { token: adminToken, body: { partyId, lines: [{ stockItemId: itemId, quantity: '10', rate: '4000' }] } });
  orderId = created.body.id;
  orderLineId = created.body.lines[0]?.id ?? '';
  await harness.post(`/sales/orders/${orderId}/confirm`, { token: adminToken });
  await harness.post(`/sales/orders/${orderId}/picks`, { token: adminToken, body: { lines: [{ lineId: orderLineId, quantity: '10' }] } });
  await harness.post(`/sales/orders/${orderId}/packs`, { token: adminToken, body: { lines: [{ lineId: orderLineId, quantity: '10' }] } });
  await harness.db.execute(sql`UPDATE sales_document_lines SET invoiced_qty = 10, dispatched_qty = 10 WHERE id = ${orderLineId}`);
});

afterAll(async () => {
  await harness.close();
});

describe('Area AK: sales returns', () => {
  let returnId = '';
  let lineId = '';

  it('offers the six default reasons and refuses one that is not on the list (REQ-AK-02)', async () => {
    const reasons = await harness.get<ReturnReasonsPolicy>('/sales/returns/reasons', { token: adminToken });
    expect(reasons.status).toBe(200);
    expect(reasons.body.reasons).toContain('Damaged in transit');
    expect(reasons.body.reasons).toHaveLength(6);

    const refused = await multipart<ErrorBody>('/sales/returns', adminToken, {
      customerName: 'Asha Traders',
      partyId,
      lines: [{ description: 'Cat6 cable 305m', quantity: '1', reason: 'He said he did not want it', condition: 'sealed', disposition: 'restock' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('not one of this organisation');
  });

  it('refuses a quantity larger than the line ever sent (REQ-AK-01)', async () => {
    const refused = await multipart<ErrorBody>('/sales/returns', adminToken, {
      customerName: 'Asha Traders',
      partyId,
      sourceDocumentId: orderId,
      lines: [{ lineId: orderLineId, stockItemId: itemId, description: 'Cat6 cable 305m', quantity: '11', reason: 'Wrong item', condition: 'sealed', disposition: 'restock' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('cannot come back');
  });

  it('records the receipt with quantity, reason, condition, disposition and a photograph (REQ-AK-01…AK-04)', async () => {
    const created = await multipart<SalesReturnView>(
      '/sales/returns',
      adminToken,
      {
        customerName: 'Asha Traders',
        partyId,
        sourceDocumentId: orderId,
        receivedOn: '2026-08-21',
        notes: 'Two boxes came back on the same lorry.',
        lines: [
          { lineId: orderLineId, stockItemId: itemId, description: 'Cat6 cable 305m', unit: 'BOX', quantity: '2', reason: 'Damaged in transit', reasonNote: 'Crushed corner, cable exposed', condition: 'damaged', disposition: 'restock' },
        ],
      },
      [{ field: 'goods', bytes: jpeg }],
    );
    expect(created.status).toBe(201);
    returnId = created.body.id;
    lineId = created.body.lines[0]?.id ?? '';
    expect(created.body.number).toMatch(/^RET-\d{4}$/u);
    // REQ-AK-05: received means waiting on Tally, not credited.
    expect(created.body.state).toBe('awaiting_credit_note');
    expect(created.body.creditNote).toBeNull();
    expect(created.body.receivedByName).toContain('Ravi');
    expect(created.body.lines[0]?.condition).toBe('damaged');
    expect(created.body.lines[0]?.reasonNote).toContain('Crushed corner');
    expect(created.body.attachments).toHaveLength(1);

    const url = await harness.get<{ url: string }>(`/sales/returns/${returnId}/attachments/${created.body.attachments[0]?.fileId ?? ''}/url`, { token: adminToken });
    expect(url.status).toBe(200);
    expect(url.body.url).toContain('http');
  });

  it('moves no stock, in either direction (REQ-AK-07)', async () => {
    const item = await harness.db.execute<{ closing_qty: string | null }>(sql`SELECT closing_qty::text AS closing_qty FROM stock_items WHERE id = ${itemId}`);
    // The projection's quantity is Tally's to write; a restocked return never touches it.
    expect(item.rows[0]?.closing_qty ?? null).toBeNull();
    const order = await harness.get<OrderView>(`/sales/orders/${orderId}`, { token: adminToken });
    expect(order.body.lines[0]?.dispatchedQty).toBe('10.000');
  });

  it('refuses to record a line as scrap without the key that writes goods off (REQ-AK-03/AK-11)', async () => {
    const refused = await multipart<ErrorBody>('/sales/returns', salesToken, {
      customerName: 'Asha Traders',
      partyId,
      lines: [{ stockItemId: itemId, description: 'Cat6 cable 305m', quantity: '1', reason: 'Warranty', condition: 'damaged', disposition: 'scrap' }],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain('returns.disposition');

    // The same receipt, restocked, is theirs to record.
    const allowed = await multipart<SalesReturnView>('/sales/returns', salesToken, {
      customerName: 'Asha Traders',
      partyId,
      lines: [{ stockItemId: itemId, description: 'Cat6 cable 305m', quantity: '1', reason: 'Warranty', condition: 'damaged', disposition: 'restock' }],
    });
    expect(allowed.status).toBe(201);
    await harness.post(`/sales/returns/${allowed.body.id}/cancel`, { token: adminToken, body: { reason: 'Recorded for the permission check only' } });
  });

  it('keeps scrap behind its own key (REQ-AK-03/AK-11)', async () => {
    const refused = await harness.post<ErrorBody>(`/sales/returns/${returnId}/disposition`, {
      token: salesToken,
      body: { lineId, disposition: 'scrap', reason: 'Sheath cut through; unsellable' },
    });
    expect(refused.status).toBe(403);

    const changed = await harness.post<SalesReturnView>(`/sales/returns/${returnId}/disposition`, {
      token: adminToken,
      body: { lineId, disposition: 'scrap', reason: 'Sheath cut through; unsellable' },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.lines[0]?.disposition).toBe('scrap');
    expect(changed.body.lines[0]?.reasonNote).toContain('unsellable');
    // Waited for, and scoped to this receipt: the audit write does not hold
    // the response up, and the trail outlives the harness reset, so counting
    // the action alone would count every earlier run of this file.
    expect(await harness.waitForAuditEntityAction(returnId, 'sales.return.disposition_changed')).toBe(true);
  });

  it('shows the receipt on the accountant’s queue until a credit note arrives (REQ-AK-05)', async () => {
    const queue = await harness.get<Paginated<SalesReturnSummary>>('/sales/returns/awaiting-credit-note', { token: adminToken });
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((r) => r.id)).toContain(returnId);
    expect(queue.body.data.find((r) => r.id === returnId)?.scrapLines).toBe(1);
  });

  it('never guesses a credit note by party and date; it links by narration or by a person (REQ-AK-06)', async () => {
    const stranger = await creditNote('CN-STRAY', 8000, 'Rate difference on an old bill');
    const unlinked = await harness.get<UnlinkedCreditNote[]>('/sales/returns/unlinked-credit-notes', { token: adminToken });
    expect(unlinked.status).toBe(200);
    const stray = unlinked.body.find((v) => v.voucherId === stranger);
    expect(stray).toBeDefined();
    // The return is offered as a candidate; nothing has been decided for anyone.
    expect(stray?.candidateReturns.map((c) => c.returnId)).toContain(returnId);
    const stillWaiting = await harness.get<SalesReturnView>(`/sales/returns/${returnId}`, { token: adminToken });
    expect(stillWaiting.body.state).toBe('awaiting_credit_note');

    const linked = await harness.post<SalesReturnView>(`/sales/returns/${returnId}/credit-note`, { token: adminToken, body: { voucherId: stranger } });
    expect(linked.status).toBe(200);
    expect(linked.body.state).toBe('credited');
    expect(linked.body.creditNote?.voucherNumber).toBe('CN-STRAY');
    expect(linked.body.creditNote?.method).toBe('manual');

    const twice = await harness.post<ErrorBody>(`/sales/returns/${returnId}/credit-note`, { token: adminToken, body: { voucherId: stranger } });
    expect(twice.status).toBe(409);
  });

  it('links a credit note that names its return in the narration, by itself (REQ-AK-06)', async () => {
    const second = await multipart<SalesReturnView>('/sales/returns', adminToken, {
      customerName: 'Asha Traders',
      partyId,
      lines: [{ stockItemId: itemId, description: 'Cat6 cable 305m', quantity: '1', reason: 'Quality rejection', condition: 'opened', disposition: 'scrap' }],
    });
    expect(second.status).toBe(201);
    await creditNote('CN-NARR', 4000, `Against return ${second.body.number}`);

    // The queue read runs the narration pass; the named return is gone from it.
    const unlinked = await harness.get<UnlinkedCreditNote[]>('/sales/returns/unlinked-credit-notes', { token: adminToken });
    expect(unlinked.body.some((v) => v.voucherNumber === 'CN-NARR')).toBe(false);
    const view = await harness.get<SalesReturnView>(`/sales/returns/${second.body.id}`, { token: adminToken });
    expect(view.body.state).toBe('credited');
    expect(view.body.creditNote?.method).toBe('narration');
  });

  it('raises a free replacement that does not wait for an invoice (REQ-AK-08/AK-09, D-51)', async () => {
    const raised = await harness.post<SalesReturnView>(`/sales/returns/${returnId}/replacement`, { token: adminToken, body: { charge: 'free' } });
    expect(raised.status).toBe(201);
    expect(raised.body.replacementCharge).toBe('free');
    expect(raised.body.replacement).not.toBeNull();
    expect(raised.body.lines[0]?.replacedQty).toBe('2.000');

    const replacement = await harness.get<OrderView>(`/sales/orders/${raised.body.replacement?.documentId ?? ''}`, { token: adminToken });
    expect(replacement.status).toBe(200);
    expect(replacement.body.grandTotal).toBe('0.00');
    expect(replacement.body.lines[0]?.freeOfCharge).toBe(true);

    // The whole chain, with nothing invoiced: a free line has no invoice to wait for.
    const orderIdR = replacement.body.id;
    const lineIdR = replacement.body.lines[0]?.id ?? '';
    await harness.post(`/sales/orders/${orderIdR}/confirm`, { token: adminToken });
    await harness.post(`/sales/orders/${orderIdR}/picks`, { token: adminToken, body: { lines: [{ lineId: lineIdR, quantity: '2' }] } });
    await harness.post(`/sales/orders/${orderIdR}/packs`, { token: adminToken, body: { lines: [{ lineId: lineIdR, quantity: '2' }] } });
    const dispatched = await multipart<{ id: string; lines: { quantity: string }[] }>(`/sales/orders/${orderIdR}/dispatches`, adminToken, {
      mode: 'local_auto',
      lines: [{ lineId: lineIdR, quantity: '2' }],
    });
    expect(dispatched.status).toBe(201);
    const after = await harness.get<OrderView>(`/sales/orders/${orderIdR}`, { token: adminToken });
    expect(after.body.lines[0]?.invoicedQty).toBe('0.000');
    expect(after.body.lines[0]?.dispatchedQty).toBe('2.000');

    const again = await harness.post<ErrorBody>(`/sales/returns/${returnId}/replacement`, { token: adminToken, body: { charge: 'chargeable' } });
    expect(again.status).toBe(409);
  });

  it('keeps the free-of-charge mark through an edit of the replacement (audit 49)', async () => {
    const second = await multipart<SalesReturnView>('/sales/returns', adminToken, {
      customerName: 'Asha Traders',
      partyId,
      lines: [{ stockItemId: itemId, description: 'Cat6 cable 305m', quantity: '4', reason: 'Warranty', condition: 'opened', disposition: 'scrap' }],
    });
    const raised = await harness.post<SalesReturnView>(`/sales/returns/${second.body.id}/replacement`, { token: adminToken, body: { charge: 'free' } });
    const orderIdE = raised.body.replacement?.documentId ?? '';
    const before = await harness.get<OrderView>(`/sales/orders/${orderIdE}`, { token: adminToken });
    expect(before.body.lines[0]?.freeOfCharge).toBe(true);

    // There is deliberately no field for the mark on the line editor, so an
    // ordinary edit cannot carry it -- and used to clear it, putting a
    // replacement the company had given away back to waiting for an invoice
    // that was never coming.
    const edited = await harness.patch<OrderView>(`/sales/orders/${orderIdE}`, {
      token: adminToken,
      body: { lines: [{ stockItemId: itemId, description: 'Cat6 cable 305m', quantity: '5', rate: '0' }] },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.lines[0]?.quantity).toBe('5.000');
    expect(edited.body.lines[0]?.freeOfCharge).toBe(true);
    expect(edited.body.grandTotal).toBe('0.00');
  });

  it('holds a chargeable replacement to the invoice rule the rest of the product keeps (REQ-AK-09)', async () => {
    const third = await multipart<SalesReturnView>('/sales/returns', adminToken, {
      customerName: 'Asha Traders',
      partyId,
      lines: [{ stockItemId: itemId, description: 'Cat6 cable 305m', quantity: '3', reason: 'Warranty', condition: 'opened', disposition: 'scrap' }],
    });
    const raised = await harness.post<SalesReturnView>(`/sales/returns/${third.body.id}/replacement`, { token: adminToken, body: { charge: 'chargeable' } });
    expect(raised.status).toBe(201);
    const replacement = await harness.get<OrderView>(`/sales/orders/${raised.body.replacement?.documentId ?? ''}`, { token: adminToken });
    expect(replacement.body.lines[0]?.freeOfCharge).toBe(false);
    const orderIdC = replacement.body.id;
    const lineIdC = replacement.body.lines[0]?.id ?? '';
    await harness.post(`/sales/orders/${orderIdC}/confirm`, { token: adminToken });
    await harness.post(`/sales/orders/${orderIdC}/picks`, { token: adminToken, body: { lines: [{ lineId: lineIdC, quantity: '3' }] } });
    await harness.post(`/sales/orders/${orderIdC}/packs`, { token: adminToken, body: { lines: [{ lineId: lineIdC, quantity: '3' }] } });
    const refused = await multipart<ErrorBody>(`/sales/orders/${orderIdC}/dispatches`, adminToken, { mode: 'local_auto', lines: [{ lineId: lineIdC, quantity: '3' }] });
    expect([400, 409]).toContain(refused.status);
    expect(refused.body.error.message).toContain('invoiced');
  });

  it('keeps the whole area behind returns.view (REQ-AK-11)', async () => {
    const list = await harness.get<ErrorBody>('/sales/returns', { token: employeeToken });
    expect(list.status).toBe(403);
    const reports = await harness.get<{ data?: { key: string }[] }>('/reports', { token: employeeToken });
    // Either the catalogue is closed to them entirely, or it opens without
    // the return reports in it. Never with them.
    expect((reports.body.data ?? []).some((r) => r.key === 'return-rate-by-item')).toBe(false);
  });

  it('reports the return rate by item, by customer and by reason (REQ-AK-10)', async () => {
    const catalogue = await harness.get<{ data: { key: string }[] }>('/reports', { token: adminToken });
    for (const key of ['return-rate-by-item', 'return-rate-by-customer', 'returns-by-reason']) {
      expect(catalogue.body.data.some((r) => r.key === key)).toBe(true);
    }
    const byReason = await harness.get<Paginated<Record<string, unknown>>>('/reports/returns-by-reason/rows?page=1&pageSize=25', { token: adminToken });
    expect(byReason.status).toBe(200);
    // Three receipts stand, under three different reasons.
    expect(byReason.body.meta.total).toBeGreaterThanOrEqual(3);
    const byItem = await harness.get<Paginated<Record<string, unknown>>>('/reports/return-rate-by-item/rows?page=1&pageSize=25', { token: adminToken });
    expect(byItem.body.meta.total).toBe(1);
    const byCustomer = await harness.get<Paginated<Record<string, unknown>>>('/reports/return-rate-by-customer/rows?page=1&pageSize=25', { token: adminToken });
    expect(byCustomer.body.meta.total).toBe(1);
  });

  it('will not cancel a receipt Tally has already credited', async () => {
    const refused = await harness.post<ErrorBody>(`/sales/returns/${returnId}/cancel`, { token: adminToken, body: { reason: 'Raised on the wrong customer' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('credit note');
  });
});
