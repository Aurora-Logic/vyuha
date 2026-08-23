import { SYSTEM_ROLES, type EstimateSummary, type EstimateView, type ItemHistoryView, type Paginated } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * Estimates (REQ-W-01, REQ-W-02). Pins: numbering is per organisation and
 * gap-tolerant, arithmetic happens once in SQL and comes back as exact
 * text, a draft is editable and anything later is not, transitions follow
 * the table, and the item history reads the party's vouchers and earlier
 * estimates together. Nothing here touches Tally (D-04).
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000e5';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken: string;
let salesToken: string;
let otherSalesToken: string;
let salesEmployeeId = '';
let partyId = '';
let cableId = '';
let voucherId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Estimates Fixture Org');
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const salesRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES, { isSystem: true });
  salesEmployeeId = await harness.createEmployee({ code: 'EST-001', firstName: 'Ravi', lastName: 'Kumar' });
  const otherId = await harness.createEmployee({ code: 'EST-002', firstName: 'Meera', lastName: 'Iyer' });
  const admin = await harness.createUser({ email: scopedEmail('est-admin'), roleIds: [adminRoleId] });
  const sales = await harness.createUser({ email: scopedEmail('est-sales'), roleIds: [salesRoleId], employeeId: salesEmployeeId });
  const other = await harness.createUser({ email: scopedEmail('est-other'), roleIds: [salesRoleId], employeeId: otherId });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  salesToken = (await harness.login(sales.email, sales.password)).token;
  otherSalesToken = (await harness.login(other.email, other.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Estimates Co', 'guid-estimates-co') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  const cable = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate, sale_price)
    VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00', '4200.00') RETURNING id
  `);
  cableId = cable.rows[0]?.id ?? '';
  const voucher = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, master_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, amount)
    VALUES (${ORG_ID}, ${connectionId}, 'v-1', 1, '2026-06-12', 'Sales', 'INV-0042', 'Asha Traders', ${partyId}, '8000.00') RETURNING id
  `);
  voucherId = voucher.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, stock_item_id, actual_qty, billed_qty, rate, amount)
    VALUES (${ORG_ID}, ${voucherId}, 1, 'inventory', 'Cat6 cable 305m', ${cableId}, '2 BOX', '2 BOX', '4000.00', '8000.00')
  `);
});

afterAll(async () => {
  await harness.close();
});

let estimateId = '';

describe('raising an estimate (REQ-W-01)', () => {
  it('numbers it EST-0001, computes each line and the totals in SQL, and defaults tax from the item', async () => {
    const created = await harness.post<EstimateView>('/sales/estimates', {
      token: salesToken,
      body: {
        partyId,
        validUntil: '2026-09-30',
        lines: [
          { stockItemId: cableId, description: '', quantity: '3', rate: '4100', discountPct: '5' },
          { description: 'Installation', quantity: '1', unit: 'JOB', rate: '2500.50', taxPct: '18' },
        ],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.number).toBe('EST-0001');
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.customerName).toBe('Asha Traders');
    expect(created.body.ownerId).toBe(salesEmployeeId);
    expect(created.body.lines.map((l) => [l.description, l.unit, l.taxPct, l.amount, l.taxAmount])).toEqual([
      // 3 × 4100 = 12300, less 5% = 11685.00; tax 18% = 2103.30
      ['Cat6 cable 305m', 'BOX', '18.00', '11685.00', '2103.30'],
      ['Installation', 'JOB', '18.00', '2500.50', '450.09'],
    ]);
    expect(created.body.subtotal).toBe('14800.50');
    expect(created.body.discountTotal).toBe('615.00');
    expect(created.body.taxTotal).toBe('2553.39');
    expect(created.body.grandTotal).toBe('16738.89');
    estimateId = created.body.id;
    expect(await harness.waitForAuditAction('sales.estimate.created')).toBe(true);
  });

  it('numbers the next one EST-0002 even for another user, and refuses a nameless customer', async () => {
    const second = await harness.post<EstimateView>('/sales/estimates', {
      token: otherSalesToken,
      body: { customerName: 'Walk-in prospect', lines: [] },
    });
    expect(second.status).toBe(201);
    expect(second.body.number).toBe('EST-0002');
    expect(second.body.grandTotal).toBe('0.00');

    const nameless = await harness.post<ErrorBody>('/sales/estimates', { token: salesToken, body: { lines: [] } });
    expect(nameless.status).toBe(400);

    const badItem = await harness.post<ErrorBody>('/sales/estimates', {
      token: salesToken,
      body: { customerName: 'X', lines: [{ stockItemId: '01900000-0000-7000-8000-00000000dead', description: 'x', quantity: '1', rate: '1' }] },
    });
    expect(badItem.status).toBe(400);
  });

  it('view.self sees only its own; the list carries totals without lines', async () => {
    const mine = await harness.get<Paginated<EstimateSummary>>('/sales/estimates', { token: salesToken });
    expect(mine.body.data.map((e) => e.number)).toEqual(['EST-0001']);
    expect(mine.body.data[0]?.grandTotal).toBe('16738.89');
    expect((mine.body.data[0] as { lines?: unknown }).lines).toBeUndefined();

    const hidden = await harness.get<ErrorBody>(`/sales/estimates/${estimateId}`, { token: otherSalesToken });
    expect(hidden.status).toBe(404);

    const all = await harness.get<Paginated<EstimateSummary>>('/sales/estimates?sort=number', { token: adminToken });
    expect(all.body.data.map((e) => e.number)).toEqual(['EST-0001', 'EST-0002']);
  });
});

describe('editing and status (REQ-W-01)', () => {
  it('a draft takes new lines wholesale and recomputes; the trail records it', async () => {
    const updated = await harness.patch<EstimateView>(`/sales/estimates/${estimateId}`, {
      token: salesToken,
      body: { lines: [{ stockItemId: cableId, description: 'Cat6 cable 305m', quantity: '10', rate: '4000', discountPct: '10', taxPct: '18' }] },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.lines).toHaveLength(1);
    expect(updated.body.subtotal).toBe('40000.00');
    expect(updated.body.discountTotal).toBe('4000.00');
    expect(updated.body.grandTotal).toBe('42480.00');
    expect(await harness.waitForAuditAction('sales.estimate.updated')).toBe(true);
  });

  it('follows the transition table: draft → sent → accepted, and accepted is final and read-only', async () => {
    const sent = await harness.post<EstimateView>(`/sales/estimates/${estimateId}/status`, { token: salesToken, body: { status: 'SENT' } });
    expect(sent.body.status).toBe('SENT');
    expect(await harness.waitForAuditAction('sales.estimate.sent')).toBe(true);

    const edit = await harness.patch<ErrorBody>(`/sales/estimates/${estimateId}`, { token: salesToken, body: { notes: 'late edit' } });
    expect(edit.status).toBe(409);

    const accepted = await harness.post<EstimateView>(`/sales/estimates/${estimateId}/status`, { token: salesToken, body: { status: 'ACCEPTED' } });
    expect(accepted.body.status).toBe('ACCEPTED');

    const back = await harness.post<ErrorBody>(`/sales/estimates/${estimateId}/status`, { token: salesToken, body: { status: 'DRAFT' } });
    expect(back.status).toBe(409);
    expect(back.body.error.details?.allowed).toEqual([]);

    const del = await harness.del<ErrorBody>(`/sales/estimates/${estimateId}`, { token: salesToken });
    expect(del.status).toBe(409);
  });

  it('an empty draft cannot be sent; a draft can be deleted', async () => {
    const empty = await harness.get<Paginated<EstimateSummary>>('/sales/estimates?q=EST-0002', { token: adminToken });
    const id = empty.body.data[0]?.id ?? '';
    const refused = await harness.post<ErrorBody>(`/sales/estimates/${id}/status`, { token: adminToken, body: { status: 'SENT' } });
    expect(refused.status).toBe(409);
    const gone = await harness.del(`/sales/estimates/${id}`, { token: adminToken });
    expect(gone.status).toBe(204);
    // The number is not reused: a gap is a fact, a duplicate is a dispute.
    const third = await harness.post<EstimateView>('/sales/estimates', { token: adminToken, body: { customerName: 'Third', lines: [] } });
    expect(third.body.number).toBe('EST-0003');
  });
});

describe('item history (REQ-W-02)', () => {
  it('reads what the party was invoiced and quoted for the item, newest first, and says how fresh the vouchers are', async () => {
    const history = await harness.get<ItemHistoryView>(`/sales/item-history?stockItemId=${cableId}&partyId=${partyId}`, { token: salesToken });
    expect(history.status).toBe(200);
    expect(history.body.stockItemName).toBe('Cat6 cable 305m');
    expect(history.body.currentSalePrice).toBe('4200.00');
    expect(history.body.entries.map((e) => [e.source, e.reference, e.quantity, e.rate, e.discountPct])).toEqual([
      ['estimate', 'Estimate EST-0001', '10.000', '4000.00', '10.00'],
      ['voucher', 'Sales INV-0042', '2 BOX', '4000.00', null],
    ]);
    expect(history.body.entries[0]?.status).toBe('accepted');
    expect(history.body.vouchersAsOf).not.toBeNull();

    const unknown = await harness.get<ErrorBody>('/sales/item-history?stockItemId=01900000-0000-7000-8000-00000000dead', { token: salesToken });
    expect(unknown.status).toBe(404);
  });
});

describe('the printed page (documents settings, Excel)', () => {
  it('document settings read as defaults, are written under settings.manage, and an estimate exports as a workbook', async () => {
    // The fixture org outlives a run; a previous run's write must not pose as this org's default.
    await harness.db.execute(sql`DELETE FROM settings WHERE org_id = ${ORG_ID} AND key = 'documents.settings'`);
    const defaults = await harness.get<{ profile: { legalName: string }; designs: { ESTIMATE: { templateId: string } } }>('/documents/settings', { token: salesToken });
    expect(defaults.status).toBe(200);
    expect(defaults.body.designs.ESTIMATE.templateId).toBe('tally');
    const forbidden = await harness.put('/documents/settings', { token: salesToken, body: defaults.body });
    expect(forbidden.status).toBe(403);
    const written = await harness.put<{ profile: { legalName: string }; designs: { ESTIMATE: { templateId: string; accent: string } } }>('/documents/settings', {
      token: adminToken,
      body: { ...defaults.body, profile: { ...defaults.body.profile, legalName: 'Estimates Fixture Pvt Ltd', gstin: '27AAAAA0000A1Z5' }, designs: { ...defaults.body.designs, ESTIMATE: { ...defaults.body.designs.ESTIMATE, templateId: 'minimal', accent: 'teal' } } },
    });
    expect(written.status).toBe(200);
    expect(written.body.profile.legalName).toBe('Estimates Fixture Pvt Ltd');
    expect(written.body.designs.ESTIMATE.templateId).toBe('minimal');
    expect(await harness.waitForAuditAction('documents.settings.updated')).toBe(true);

    const list = await harness.get<{ data: { id: string; number: string }[] }>('/sales/estimates?page=1&pageSize=1', { token: salesToken });
    const first = list.body.data[0];
    expect(first).toBeDefined();
    const xlsx = await harness.getRaw(`/sales/estimates/${first?.id ?? ''}/export.xlsx`, { token: salesToken });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
    expect(xlsx.headers.get('content-disposition')).toContain(`Estimate-${first?.number ?? ''}.xlsx`);
    // A workbook is a zip: PK at the start.
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK');
  });
});
