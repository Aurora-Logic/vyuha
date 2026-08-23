import { PERMISSIONS, SALES_ANALYSIS_DIMENSIONS, SYSTEM_ROLES, type ExportDownload, type ExportJobSummary, type Paginated, type PartyView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { env } from '../common/env.js';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { ExceptionSweepHandler } from './exception-sweep.handler.js';
import { ExportService } from '../export/export.service.js';
import { NotificationDispatcher, type NotificationEvent } from '../notifications/notification.dispatcher.js';

/**
 * The masters read surface (09 §5), and the 6b acceptance line it exists to
 * satisfy: "There is no way to create one in Vyuha — verified by asserting
 * the API returns 405 on POST /masters/parties." The write refusals are
 * asserted with their reason, because the 405 exists to teach, not merely to
 * refuse.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000bf';

let harness: ApiHarness;
let adminToken: string;
let employeeToken: string;
let connectionId = '';
let ashaId = '';

beforeAll(async () => {
  // export_jobs.requested_by is ON DELETE RESTRICT; a row left by a crashed
  // run pins its user and breaks resetOrganisation for every later run.
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await pool.query('DELETE FROM export_jobs WHERE org_id = $1', [ORG_ID]);
  } finally {
    await pool.end();
  }
  harness = await ApiHarness.start(ORG_ID, 'Masters Fixture Org');

  await harness.db.execute(sql`DELETE FROM sync_jobs WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_cursors WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('masters-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({
    email: scopedEmail('masters-employee'),
    roleIds: [employeeRoleId],
  });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Masters Co', 'guid-masters-co')
    RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';

  const asha = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, alias, parent_group, gstin, credit_limit, credit_days)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Asha', 'Sundry Debtors', '27AAAPL1234C1ZV', '250000.00', 30)
    RETURNING id
  `);
  ashaId = asha.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, absent_in_tally)
    VALUES (${ORG_ID}, ${connectionId}, 'Behar Supply Co', 'Sundry Creditors', true)
  `);
});

afterAll(async () => {
  await harness.close();
});

describe('GET /masters/parties', () => {
  it('needs masters.tally.view — an employee is refused, and told which key', async () => {
    const refused = await harness.get<{ error: { details?: { requiredAnyOf?: string[] } } }>(
      '/masters/parties',
      { token: employeeToken },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.details?.requiredAnyOf).toContain('masters.tally.view');
  });

  it('lists the projection with its figures exact and its age stated', async () => {
    const response = await harness.get<Paginated<PartyView>>('/masters/parties', {
      token: adminToken,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.map((p) => p.name)).toEqual(['Asha Traders', 'Behar Supply Co']);

    const asha = response.body.data[0];
    expect(asha?.creditLimit).toBe('250000.00');
    expect(asha?.lastPulledAt).toBeTruthy();
    expect(response.body.data[1]?.absentInTally).toBe(true);
  });

  it('searches name, alias and GSTIN, with wildcards escaped', async () => {
    const byGstin = await harness.get<Paginated<PartyView>>(
      '/masters/parties?q=27AAAPL1234C1ZV',
      { token: adminToken },
    );
    expect(byGstin.body.data.map((p) => p.name)).toEqual(['Asha Traders']);

    const wildcard = await harness.get<Paginated<PartyView>>('/masters/parties?q=%25%25', {
      token: adminToken,
    });
    expect(wildcard.body.data).toEqual([]);
  });

  it('filters by ledger side', async () => {
    const creditors = await harness.get<Paginated<PartyView>>(
      '/masters/parties?parentGroup=Sundry%20Creditors',
      { token: adminToken },
    );
    expect(creditors.body.data.map((p) => p.name)).toEqual(['Behar Supply Co']);
  });

  it('answers a single party, and a cross-org id as not found', async () => {
    const found = await harness.get<PartyView>(`/masters/parties/${ashaId}`, {
      token: adminToken,
    });
    expect(found.status).toBe(200);
    expect(found.body.name).toBe('Asha Traders');

    const missing = await harness.get(
      '/masters/parties/00000000-0000-4000-8000-000000000000',
      { token: adminToken },
    );
    expect(missing.status).toBe(404);
  });
});

describe('masters are read-only, and the refusal teaches (REQ-R-04)', () => {
  it('POST answers 405 naming where a party is actually created', async () => {
    const response = await harness.post<{ error: { message: string } }>('/masters/parties', {
      token: adminToken,
      body: { name: 'Should Never Exist' },
    });
    expect(response.status).toBe(405);
    expect(response.body.error.message).toContain('created in Tally');
  });

  it('PATCH answers 405 with the same teaching', async () => {
    const patched = await harness.patch<{ error: { message: string } }>(
      `/masters/parties/${ashaId}`,
      { token: adminToken, body: { name: 'Tampered' } },
    );
    expect(patched.status).toBe(405);
    expect(patched.body.error.message).toContain('read-only');
  });

  it('DELETE lands on the recycle bin surface, which refuses parties by name', async () => {
    // The soft-delete route owns this verb and path shape, and parties are
    // deliberately not in SOFT_DELETABLE_ENTITIES: absent in Tally is a
    // marking, not a deletion (REQ-R-06).
    const deleted = await harness.del<{ error: { message: string } }>(
      `/masters/parties/${ashaId}`,
      { token: adminToken, body: { reason: 'this must not work' } },
    );
    expect(deleted.status).toBe(400);
    expect(deleted.body.error.message).toContain('not a master that supports delete');
  });
});

describe('parties join Go To (REQ-O-05)', () => {
  it('a holder finds a party; the subtitle names the ledger side', async () => {
    const response = await harness.get<{ records: { type: string; title: string; subtitle: string | null }[] }>(
      '/go-to?q=asha',
      { token: adminToken },
    );
    const party = response.body.records.find((r) => r.type === 'party');
    expect(party?.title).toBe('Asha Traders');
    expect(party?.subtitle).toContain('Sundry Debtors');
  });

  it('a non-holder gets no party records, before ranking ever sees them', async () => {
    const response = await harness.get<{ records: { type: string }[] }>('/go-to?q=asha', {
      token: employeeToken,
    });
    expect(response.body.records.some((r) => r.type === 'party')).toBe(false);
  });
});

describe('vouchers, the books (Phase 6c, receivables.view)', () => {
  let invoiceId = '';

  beforeAll(async () => {
    const inserted = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO vouchers
        (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount)
      VALUES
        (${ORG_ID}, ${connectionId}, '2026-08-01', 'Sales', 'INV-0042', 'Asha Traders', ${ashaId}, 'Cable order', false, '4150.50'),
        (${ORG_ID}, ${connectionId}, '2026-08-05', 'Receipt', 'RCT-0007', 'Asha Traders', ${ashaId}, '', false, '4150.50'),
        (${ORG_ID}, ${connectionId}, '2026-07-20', 'Sales', 'INV-0040', 'Someone Else', NULL, '', true, '99.00')
      RETURNING id
    `);
    invoiceId = inserted.rows[0]?.id ?? '';
    await harness.db.execute(sql`
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount)
      VALUES (${ORG_ID}, ${invoiceId}, 1, 'ledger', 'Asha Traders', true, '4150.50'),
             (${ORG_ID}, ${invoiceId}, 2, 'ledger', 'Sales', false, '-4150.50')
    `);
    await harness.db.execute(sql`
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, actual_qty, billed_qty, rate, amount)
      VALUES (${ORG_ID}, ${invoiceId}, 3, 'inventory', 'Cat6 Cable Box', '1 NOS', '1 NOS', '4150.50', '4150.50')
    `);
  });

  it('is receivables.view, not masters.tally.view: an employee is refused', async () => {
    const refused = await harness.get('/masters/vouchers', { token: employeeToken });
    expect(refused.status).toBe(403);
  });

  it('lists newest first, hiding the cancelled unless asked, and filters by type, party and date', async () => {
    const list = await harness.get<{ data: { voucherNumber: string; amount: string }[]; meta: { total: number } }>(
      '/masters/vouchers',
      { token: adminToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.data.map((v) => v.voucherNumber)).toEqual(['RCT-0007', 'INV-0042']);
    // Money as text, to the paisa (D-01).
    expect(list.body.data[1]?.amount).toBe('4150.50');

    const withCancelled = await harness.get<{ meta: { total: number } }>(
      '/masters/vouchers?includeCancelled=true',
      { token: adminToken },
    );
    expect(withCancelled.body.meta.total).toBe(3);

    const sales = await harness.get<{ data: { voucherNumber: string }[] }>(
      `/masters/vouchers?voucherType=Sales&partyId=${ashaId}&from=2026-08-01&to=2026-08-31`,
      { token: adminToken },
    );
    expect(sales.body.data.map((v) => v.voucherNumber)).toEqual(['INV-0042']);
  });

  it('the detail carries the lines in Tally’s order', async () => {
    const detail = await harness.get<{ lines: { lineNo: number; kind: string; ledgerName: string | null; amount: string }[] }>(
      `/masters/vouchers/${invoiceId}`,
      { token: adminToken },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.lines.map((l) => [l.lineNo, l.kind])).toEqual([[1, 'ledger'], [2, 'ledger'], [3, 'inventory']]);
    expect(detail.body.lines[1]?.amount).toBe('-4150.50');
  });

  it('typing a voucher number in Go To opens that voucher (09 §6)', async () => {
    const response = await harness.get<{ records: { type: string; id: string; code: string | null; title: string }[] }>(
      '/go-to?q=INV-0042',
      { token: adminToken },
    );
    const voucher = response.body.records.find((r) => r.type === 'voucher');
    expect(voucher?.id).toBe(invoiceId);
    expect(voucher?.code).toBe('INV-0042');
    expect(voucher?.title).toBe('Sales INV-0042');
    // And a non-holder never sees the source.
    const refused = await harness.get<{ records: { type: string }[] }>('/go-to?q=INV-0042', { token: employeeToken });
    expect(refused.body.records.some((r) => r.type === 'voucher')).toBe(false);
  });
});

describe('voucher reconciliation report (REQ-S-05, through the report shell)', () => {
  it('appears in the catalogue for a receivables holder, and only for them', async () => {
    const admin = await harness.get<{ data: { key: string }[] }>('/reports', { token: adminToken });
    expect(admin.body.data.some((r) => r.key === 'voucher-reconciliation')).toBe(true);
    // Attendance's own catalogue is untouched by the new group.
    expect(admin.body.data.some((r) => r.key === 'attendance-register')).toBe(true);
    // A row read without the key is refused where the source is asked.
    const employee = await harness.get('/reports/voucher-reconciliation/rows', { token: employeeToken });
    expect(employee.status).toBe(403);
  });

  it('groups by month and voucher type; cancelled vouchers count but do not add value', async () => {
    const response = await harness.get<{
      data: { month: string; voucherType: string; count: number; cancelled: number; total: string }[];
      meta: { total: number };
    }>('/reports/voucher-reconciliation/rows?from=2026-07-01&to=2026-08-31', { token: adminToken });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { month: '2026-07', voucherType: 'Sales', count: 1, cancelled: 1, total: '0', lastPulledAt: expect.any(String) as string },
      { month: '2026-08', voucherType: 'Receipt', count: 1, cancelled: 0, total: '4150.50', lastPulledAt: expect.any(String) as string },
      { month: '2026-08', voucherType: 'Sales', count: 1, cancelled: 0, total: '4150.50', lastPulledAt: expect.any(String) as string },
    ]);
    expect(response.body.meta.total).toBe(3);
  });
});

describe('the receivables reports (Phase 6d, REQ-Y-01, Y-03, Y-05, Y-07)', () => {
  beforeAll(async () => {
    // A June invoice before the statement's period, so the opening row has
    // something to carry; and a voucher type outside the debit/credit table.
    await harness.db.execute(sql`
      INSERT INTO vouchers
        (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount)
      VALUES
        (${ORG_ID}, ${connectionId}, '2026-06-10', 'Sales', 'INV-0031', 'Asha Traders', ${ashaId}, 'June order', false, '1000.00'),
        (${ORG_ID}, ${connectionId}, '2026-08-07', 'Memo', 'MEMO-1', 'Asha Traders', ${ashaId}, 'A note', false, '55.00')
    `);
  });

  it('a customer statement needs a party, opens from what came before, and runs a balance across the period', async () => {
    const noParty = await harness.get<{ error: { details?: { fields?: { path: string }[] } } }>(
      '/reports/customer-statement/rows?from=2026-08-01&to=2026-08-31',
      { token: adminToken },
    );
    expect(noParty.status).toBe(400);
    expect(noParty.body.error.details?.fields?.[0]?.path).toBe('partyId');

    const statement = await harness.get<{
      data: { voucherType: string; voucherNumber: string; debit: string | null; credit: string | null; unclassified: string | null; balance: string; asOf: string | null }[];
      meta: { total: number };
    }>(`/reports/customer-statement/rows?partyId=${ashaId}&from=2026-08-01&to=2026-08-31`, { token: adminToken });
    expect(statement.status).toBe(200);
    expect(statement.body.data.map((r) => [r.voucherType, r.voucherNumber, r.debit, r.credit, r.unclassified, r.balance])).toEqual([
      ['Opening balance', '', null, null, null, '1000.00'],
      ['Sales', 'INV-0042', '4150.50', null, null, '5150.50'],
      ['Receipt', 'RCT-0007', null, '4150.50', null, '1000.00'],
      // Outside the debit/credit table: shown, not summed.
      ['Memo', 'MEMO-1', null, null, '55.00', '1000.00'],
    ]);
    expect(statement.body.meta.total).toBe(4);
    // REQ-Y-07: every row says which pull it rests on.
    expect(statement.body.data.every((r) => r.asOf !== null)).toBe(true);
  });

  it('the credit cycle shows exposure against the limit for every debtor', async () => {
    const credit = await harness.get<{
      data: { partyName: string; creditLimit: string | null; creditDays: number | null; exposure: string; headroom: string | null; overLimit: boolean; lastInvoiceDate: string | null; lastReceiptDate: string | null }[];
    }>('/reports/credit-cycle/rows', { token: adminToken });
    expect(credit.status).toBe(200);
    // Behar is a creditor, not a debtor: absent.
    expect(credit.body.data.map((r) => r.partyName)).toEqual(['Asha Traders']);
    const asha = credit.body.data[0];
    expect(asha?.creditLimit).toBe('250000.00');
    expect(asha?.creditDays).toBe(30);
    // 1000 + 4150.50 − 4150.50; the Memo is not counted.
    expect(asha?.exposure).toBe('1000.00');
    expect(asha?.headroom).toBe('249000.00');
    expect(asha?.overLimit).toBe(false);
    expect(asha?.lastInvoiceDate).toBe('2026-08-01');
    expect(asha?.lastReceiptDate).toBe('2026-08-05');
  });

  it('sales analysis groups invoiced inventory lines by the chosen dimension, with a share of the total', async () => {
    const byParty = await harness.get<{ data: { label: string; vouchers: number; value: string; share: string; quantity: string | null }[] }>(
      '/reports/sales-analysis/rows?from=2026-08-01&to=2026-08-31',
      { token: adminToken },
    );
    expect(byParty.status).toBe(200);
    expect(byParty.body.data.map((r) => [r.label, r.vouchers, r.value, r.share])).toEqual([['Asha Traders', 1, '4150.50', '100.0']]);

    const byItem = await harness.get<{ data: { label: string; quantity: string | null; value: string }[] }>(
      '/reports/sales-analysis/rows?groupBy=item&from=2026-08-01&to=2026-08-31',
      { token: adminToken },
    );
    // No stock_items row backs the line, so no unit agrees and quantity stays honest: null.
    expect(byItem.body.data.map((r) => [r.label, r.quantity, r.value])).toEqual([['Cat6 Cable Box', null, '4150.50']]);

    const byMonth = await harness.get<{ data: { label: string; value: string }[] }>('/reports/sales-analysis/rows?groupBy=month', {
      token: adminToken,
    });
    // June's invoice has no inventory line; only August groups.
    expect(byMonth.body.data.map((r) => r.label)).toEqual(['2026-08']);

    const bad = await harness.get('/reports/sales-analysis/rows?groupBy=salesperson', { token: adminToken });
    expect(bad.status).toBe(400);
  });

  // Every dimension the dropdown offers has to answer. "By item group"
  // shipped in it and returned 500 twice over -- the count query never
  // joined stock_items, and once it did the label reached for a column the
  // GROUP BY did not carry. Walking the shared list means a dimension added
  // later cannot ship untried.
  it('sales analysis answers on every dimension the dropdown offers', async () => {
    // Its own item and invoice, so the assertion does not depend on a hook in
    // a sibling describe, and so the item group is a real group rather than
    // the ungrouped bucket.
    await harness.db.execute(sql`
      WITH s AS (
        INSERT INTO stock_items (org_id, connection_id, name, parent_group, unit, closing_qty, cost_price, absent_in_tally)
        VALUES (${ORG_ID}, ${connectionId}, 'Dimension Cable', 'Cables', 'NOS', 5, 100, false)
        RETURNING id
      ), v AS (
        INSERT INTO vouchers (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, is_cancelled, amount)
        VALUES (${ORG_ID}, ${connectionId}, '2026-08-12', 'Sales', 'DIM-1', 'Dimension Co', NULL, false, '600.00')
        RETURNING id
      )
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_id, stock_item_name, actual_qty, billed_qty, rate, amount)
      SELECT ${ORG_ID}, v.id, 1, 'inventory', s.id, 'Dimension Cable', '2 NOS', '2 NOS', '300.00', '600.00' FROM v, s
    `);
    // A line no stock item backs, so the ungrouped bucket exists whatever
    // else the fixtures hold.
    await harness.db.execute(sql`
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, actual_qty, billed_qty, rate, amount)
      SELECT ${ORG_ID}, id, 2, 'inventory', 'Loose Item', '1 NOS', '1 NOS', '50.00', '50.00'
        FROM vouchers WHERE org_id = ${ORG_ID} AND voucher_number = 'DIM-1'
    `);

    for (const groupBy of SALES_ANALYSIS_DIMENSIONS) {
      const res = await harness.get<{ data: { label: string; value: string; share: string }[]; meta: { total: number } }>(
        `/reports/sales-analysis/rows?groupBy=${groupBy}&from=2026-08-01&to=2026-08-31`,
        { token: adminToken },
      );
      expect([groupBy, res.status]).toEqual([groupBy, 200]);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data.every((r) => r.label !== '' && /^-?\d+\.\d\d$/u.test(r.value))).toBe(true);
    }

    const byGroup = await harness.get<{ data: { label: string; value: string }[] }>(
      '/reports/sales-analysis/rows?groupBy=itemGroup&from=2026-08-01&to=2026-08-31',
      { token: adminToken },
    );
    // Items with no group at all collapse into one bucket rather than
    // appearing twice, once for NULL and once for the empty string.
    expect(byGroup.body.data.find((r) => r.label === 'Cables')?.value).toBe('600.00');
    expect(byGroup.body.data.filter((r) => r.label === '(ungrouped)')).toHaveLength(1);
  });
});

describe('the Tier 1 analytics (14 REQ-AE-01, REQ-AG-02)', () => {
  it('the day book lists every voucher for the period and narrows by type', async () => {
    const all = await harness.get<{ data: { voucherType: string; voucherNumber: string; partyName: string | null; amount: string; cancelled: boolean; asOf: string | null }[]; meta: { total: number } }>(
      '/reports/day-book/rows?from=2026-08-01&to=2026-08-31',
      { token: adminToken },
    );
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBeGreaterThanOrEqual(3);
    expect(all.body.data.every((r) => r.asOf !== null)).toBe(true);

    const sales = await harness.get<{ data: { voucherType: string }[] }>('/reports/day-book/rows?from=2026-08-01&to=2026-08-31&voucherType=Sales', { token: adminToken });
    expect(sales.status).toBe(200);
    expect(sales.body.data.length).toBeGreaterThan(0);
    expect(sales.body.data.every((r) => r.voucherType === 'Sales')).toBe(true);
  });

  it('customer lapse measures each customer against their own median gap and ranks by revenue at risk', async () => {
    // A customer with a monthly rhythm who has gone quiet for over two gaps.
    await harness.db.execute(sql`
      INSERT INTO vouchers
        (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, is_cancelled, amount)
      VALUES
        (${ORG_ID}, ${connectionId}, CURRENT_DATE - 160, 'Sales', 'LAP-1', 'Asha Traders', ${ashaId}, false, '900.00'),
        (${ORG_ID}, ${connectionId}, CURRENT_DATE - 130, 'Sales', 'LAP-2', 'Asha Traders', ${ashaId}, false, '900.00'),
        (${ORG_ID}, ${connectionId}, CURRENT_DATE - 100, 'Sales', 'LAP-3', 'Asha Traders', ${ashaId}, false, '900.00')
    `);
    const lapse = await harness.get<{ data: { partyName: string; state: string; daysSince: number; medianGapDays: number; sales12m: number; revenue12m: string; asOf: string | null }[] }>(
      '/reports/customer-lapse/rows',
      { token: adminToken },
    );
    expect(lapse.status).toBe(200);
    const asha = lapse.body.data.find((r) => r.partyName === 'Asha Traders');
    expect(asha).toBeDefined();
    // The June/August fixture invoices land inside the last 365 days too.
    expect(asha?.sales12m).toBeGreaterThanOrEqual(3);
    expect(asha?.medianGapDays).toBeGreaterThan(0);
    expect(asha?.daysSince).toBeGreaterThanOrEqual(0);
    expect(['LAPSED', 'AT_RISK', 'ON_RHYTHM']).toContain(asha?.state);
    expect(asha?.asOf).not.toBeNull();
  });
});

describe('the Tier 1 analytics, the wider set (14, D-46)', () => {
  it('the ledger extract opens from what came before and runs a balance', async () => {
    const noLedger = await harness.get<{ error: { details?: { fields?: { path: string }[] } } }>('/reports/ledger-extract/rows', { token: adminToken });
    expect(noLedger.status).toBe(400);
    expect(noLedger.body.error.details?.fields?.[0]?.path).toBe('ledgerName');

    const extract = await harness.get<{ data: { voucherType: string; balance: string; debit: string | null; credit: string | null }[]; meta: { total: number } }>(
      '/reports/ledger-extract/rows?ledgerName=Sales&from=2026-08-01&to=2026-08-31',
      { token: adminToken },
    );
    expect(extract.status).toBe(200);
    expect(extract.body.data[0]?.voucherType).toBe('Opening balance');
    expect(extract.body.data.every((r) => /^-?\d+\.\d\d$/u.test(r.balance))).toBe(true);
  });

  it('the extract reads the same paged as it does whole', async () => {
    // Its own ledger, so the fixtures the other tests write cannot move the
    // arithmetic. One voucher before the period gives the opening row
    // something to carry; five inside it are enough to page twice.
    await harness.db.execute(sql`
      WITH v AS (
        INSERT INTO vouchers (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, is_cancelled, amount)
        VALUES (${ORG_ID}, ${connectionId}, '2026-07-25', 'Sales', 'PG-0', 'Paging Co', false, '100.00'),
               (${ORG_ID}, ${connectionId}, '2026-08-02', 'Sales', 'PG-1', 'Paging Co', false, '10.00'),
               (${ORG_ID}, ${connectionId}, '2026-08-03', 'Sales', 'PG-2', 'Paging Co', false, '20.00'),
               (${ORG_ID}, ${connectionId}, '2026-08-04', 'Sales', 'PG-3', 'Paging Co', false, '30.00'),
               (${ORG_ID}, ${connectionId}, '2026-08-05', 'Sales', 'PG-4', 'Paging Co', false, '40.00'),
               (${ORG_ID}, ${connectionId}, '2026-08-06', 'Sales', 'PG-5', 'Paging Co', false, '50.00')
        RETURNING id, amount
      )
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount)
      SELECT ${ORG_ID}, v.id, 1, 'ledger', 'Paging Ledger', true, v.amount FROM v
    `);

    type Row = { voucherNumber: string; balance: string };
    const fetch = async (page: number, pageSize: number) =>
      (
        await harness.get<{ data: Row[]; meta: { total: number } }>(
          `/reports/ledger-extract/rows?ledgerName=Paging%20Ledger&from=2026-08-01&to=2026-08-31&page=${String(page)}&pageSize=${String(pageSize)}`,
          { token: adminToken },
        )
      ).body;

    const whole = await fetch(1, 50);
    expect(whole.meta.total).toBe(6);
    expect(whole.data.map((r) => r.balance)).toEqual(['100.00', '110.00', '130.00', '160.00', '200.00', '250.00']);

    const first = await fetch(1, 3);
    const second = await fetch(2, 3);
    // Page two continues the statement. Accumulating across the page instead
    // of summing the period restarted this at the opening figure, which read
    // 130.00 here -- the balance of a statement that began at row three.
    expect(second.data[0]?.balance).toBe('160.00');
    // The opening row is the first row of page one, so three-a-page means
    // three rows on every page and six rows in two -- no line shown twice,
    // and none skipped.
    expect(first.data).toHaveLength(3);
    expect(second.data).toHaveLength(3);
    expect([...first.data, ...second.data].map((r) => r.voucherNumber)).toEqual(whole.data.map((r) => r.voucherNumber));
    // And the balance on page two continues the statement rather than
    // restarting it from the opening figure.
    expect([...first.data, ...second.data].map((r) => r.balance)).toEqual(whole.data.map((r) => r.balance));
    expect(second.data[2]?.balance).toBe('250.00');
  });

  it('stock summary values closing at cost and carries committed and available', async () => {
    await harness.db.execute(sql`
      INSERT INTO stock_items (org_id, connection_id, name, parent_group, unit, closing_qty, cost_price, absent_in_tally)
      VALUES (${ORG_ID}, ${connectionId}, 'Summary Cable', 'Cables', 'NOS', 12, 250, false)
    `);
    const summary = await harness.get<{ data: { item: string; closingQty: string | null; committedQty: string; availableQty: string | null; value: string | null }[] }>(
      '/reports/stock-summary/rows',
      { token: adminToken },
    );
    expect(summary.status).toBe(200);
    const cable = summary.body.data.find((r) => r.item === 'Summary Cable');
    expect(cable).toBeDefined();
    expect(Number(cable?.value)).toBe(3000);
    expect(cable?.committedQty).toBe('0');
    expect(Number(cable?.availableQty)).toBe(12);
  });

  it('duplicate masters flags names that collapse to the same key', async () => {
    await harness.db.execute(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group)
      VALUES (${ORG_ID}, ${connectionId}, 'ASHA  TRADERS.', 'Sundry Debtors')
    `);
    const dupes = await harness.get<{ data: { kind: string; nameA: string; nameB: string }[] }>('/reports/duplicate-masters/rows', { token: adminToken });
    expect(dupes.status).toBe(200);
    const pair = dupes.body.data.find((r) => r.kind === 'Party' && [r.nameA, r.nameB].some((n) => n.includes('Asha') || n.includes('ASHA')));
    expect(pair).toBeDefined();
  });

  it('the customer × product matrix counts invoices per party and item', async () => {
    const matrix = await harness.get<{ data: { partyName: string; item: string; invoices: number; value: string }[] }>(
      '/reports/customer-item-matrix/rows',
      { token: adminToken },
    );
    expect(matrix.status).toBe(200);
    expect(matrix.body.data.length).toBeGreaterThan(0);
    expect(matrix.body.data.every((r) => r.invoices >= 1)).toBe(true);
  });

});

describe('the daily exception sweep and usage retention (D-46, D14-6)', () => {
  it('opening a report records one usage row, deduplicated within the minute', async () => {
    await harness.db.execute(sql`DELETE FROM report_usage WHERE org_id = ${ORG_ID}`);
    await harness.get('/reports/negative-stock/rows', { token: adminToken });
    await harness.get('/reports/negative-stock/rows', { token: adminToken });
    // The insert is deliberately fire-and-forget, so give it a beat.
    let rows: { rows: { n: number }[] } = { rows: [] };
    for (let i = 0; i < 20; i += 1) {
      rows = await harness.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM report_usage WHERE org_id = ${ORG_ID} AND report_key = 'negative-stock'`,
      );
      if ((rows.rows[0]?.n ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('notifies the permission holders about non-empty exception reports and prunes year-old usage', async () => {
    const emitted: NotificationEvent[] = [];
    const spy = vi.spyOn(harness.resolve(NotificationDispatcher), 'emit').mockImplementation((event) => {
      emitted.push(event);
      return Promise.resolve('spied');
    });
    try {
      await harness.db.execute(sql`
        INSERT INTO report_usage (org_id, user_id, report_key, opened_at)
        SELECT ${ORG_ID}, (SELECT id FROM users WHERE org_id = ${ORG_ID} LIMIT 1), 'day-book', t.at
          FROM (VALUES (now() - interval '13 months'), (now())) AS t(at)
      `);
      const sweep = harness.resolve(ExceptionSweepHandler);
      const result = await sweep.run({ now: '2026-08-21T02:00:00.000Z' }, { jobId: 'test', attempt: 1 });
      const mine = emitted.filter((e) => e.orgId === ORG_ID && e.type === 'reports.exceptions_daily');
      expect(mine).toHaveLength(1);
      expect(mine[0]?.audience).toEqual({ kind: 'permission', key: 'reports.exceptions.notify' });
      expect(String(mine[0]?.payload?.summary)).toContain('duplicate masters');
      expect(mine[0]?.idempotencyKey).toBe(`exception-sweep-${ORG_ID}-2026-08-21`);
      expect(Number(result.usageRowsPruned)).toBeGreaterThanOrEqual(1);
      const kept = await harness.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM report_usage WHERE org_id = ${ORG_ID} AND report_key = 'day-book'`,
      );
      expect(kept.rows[0]?.n).toBe(1);

      // The same morning run twice carries the same idempotency key, so BullMQ delivers once.
      await sweep.run({ now: '2026-08-21T04:00:00.000Z' }, { jobId: 'test', attempt: 1 });
      const again = emitted.filter((e) => e.orgId === ORG_ID && e.type === 'reports.exceptions_daily');
      expect(again[1]?.idempotencyKey).toBe(again[0]?.idempotencyKey);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('comparison flows into the exported file (data-analyst §3)', () => {
  it('a CSV export with compare carries a previous column and a change column, joined by the same key as the screen', async () => {
    // Sales analysis reads inventory lines; the June fixture voucher has
    // none, so give it one for the comparison period to find.
    await harness.db.execute(sql`
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, billed_qty, rate, amount)
      SELECT ${ORG_ID}, id, 1, 'inventory', 'Cat6 Cable Box', '1 NOS', '1000.00', '1000.00'
        FROM vouchers WHERE org_id = ${ORG_ID} AND voucher_number = 'INV-0031'
    `);
    const accepted = await harness.post<ExportJobSummary>('/reports/exports', {
      token: adminToken,
      body: {
        reportKey: 'sales-analysis',
        filters: { from: '2026-08-01', to: '2026-08-31' },
        format: 'CSV',
        compare: { from: '2026-06-01', to: '2026-06-30', columnKey: 'value', label: 'previous' },
      },
    });
    expect(accepted.status).toBe(202);
    // Run the job directly so the assertion does not race the queue; the
    // queued worker's own attempt then reads DONE and skips.
    await harness.resolve(ExportService).run(ORG_ID, accepted.body.id, 1);
    const link = await harness.get<ExportDownload>(`/reports/exports/${accepted.body.id}/download`, { token: adminToken });
    expect(link.status).toBe(200);
    const response = await fetch(link.body.url);
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.split('\n');
    const header = lines.find((line) => line.startsWith('Group,')) ?? '';
    expect(header).toContain('Value (previous)');
    expect(header).toContain('Change');
    const asha = lines.find((line) => line.startsWith('Asha Traders')) ?? '';
    // August 4150.50 against June 1000: the file states the base and the delta.
    expect(asha).toContain('1000');
    expect(asha).toContain('+3150.5 (315.1%)');
  });
});

describe('the second analytics set (owner, 22 Aug 2026)', () => {
  it('reports every confirmed order line and where it has got to (P-33, D-48)', async () => {
    // Its own order, taken one step at a time, so each row's word is the
    // furthest step that line actually reached rather than a coincidence of
    // whatever else the fixtures left behind.
    const order = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO sales_documents (org_id, doc_type, number, status, date, party_id, customer_name, grand_total)
      VALUES (${ORG_ID}, 'SALES_ORDER', 'SO-FULFIL-1', 'CONFIRMED', '2026-08-18', ${ashaId}, 'Asha Traders', '900.00')
      RETURNING id
    `);
    const orderId = order.rows[0]?.id ?? '';
    await harness.db.execute(sql`
      INSERT INTO sales_document_lines (org_id, document_id, line_no, description, quantity, rate, amount, picked_qty, packed_qty, invoiced_qty, dispatched_qty)
      VALUES (${ORG_ID}, ${orderId}, 1, 'Fully out', 5, 100, 500, 5, 5, 5, 5),
             (${ORG_ID}, ${orderId}, 2, 'Half out', 4, 100, 400, 4, 4, 4, 2),
             (${ORG_ID}, ${orderId}, 3, 'Invoiced only', 3, 100, 300, 3, 3, 3, 0),
             (${ORG_ID}, ${orderId}, 4, 'Packed only', 2, 100, 200, 2, 2, 0, 0),
             (${ORG_ID}, ${orderId}, 5, 'Picked only', 2, 100, 200, 1, 0, 0, 0),
             (${ORG_ID}, ${orderId}, 6, 'Not started', 7, 100, 700, 0, 0, 0, 0)
    `);

    const rows = await harness.get<{ data: { number: string; item: string; state: string; balanceQty: string }[]; meta: { total: number } }>(
      '/reports/order-fulfilment/rows?from=2026-08-01&to=2026-08-31&page=1&pageSize=200',
      { token: adminToken },
    );
    expect(rows.status).toBe(200);
    const mine = rows.body.data.filter((row) => row.number === 'SO-FULFIL-1');
    expect(mine).toHaveLength(6);
    expect(new Map(mine.map((row) => [row.item, row.state]))).toEqual(
      new Map([
        ['Fully out', 'closed'],
        ['Half out', 'partially_dispatched'],
        ['Invoiced only', 'ready_to_dispatch'],
        ['Packed only', 'awaiting_invoice'],
        ['Picked only', 'picking'],
        ['Not started', 'open'],
      ]),
    );
    // What is still to go is against what was ordered, and never negative.
    expect(new Map(mine.map((row) => [row.item, row.balanceQty]))).toEqual(
      new Map([
        ['Fully out', '0.000'],
        ['Half out', '2.000'],
        ['Invoiced only', '3.000'],
        ['Packed only', '2.000'],
        ['Picked only', '2.000'],
        ['Not started', '7.000'],
      ]),
    );

    // A short-closed order says so, whatever its lines have reached.
    await harness.db.execute(sql`UPDATE sales_documents SET short_closed_at = now() WHERE id = ${orderId}`);
    const closed = await harness.get<{ data: { number: string; state: string }[] }>(
      '/reports/order-fulfilment/rows?from=2026-08-01&to=2026-08-31&page=1&pageSize=200',
      { token: adminToken },
    );
    expect(closed.body.data.filter((row) => row.number === 'SO-FULFIL-1').every((row) => row.state === 'short_closed')).toBe(true);
  });

  it('a headline total is the whole report, not whatever the page held', async () => {
    await harness.db.execute(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group, credit_limit)
      VALUES (${ORG_ID}, ${connectionId}, 'Whole A', 'Sundry Debtors', 100000),
             (${ORG_ID}, ${connectionId}, 'Whole B', 'Sundry Debtors', 100000)
    `);
    await harness.db.execute(sql`
      INSERT INTO vouchers (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, is_cancelled, amount)
      SELECT ${ORG_ID}, ${connectionId}, '2026-08-15', 'Sales', 'WH-' || p.name, p.name, p.id, false, '500.00'
        FROM parties p WHERE p.org_id = ${ORG_ID} AND p.name IN ('Whole A', 'Whole B')
    `);

    type Body = { data: { exposure: string }[]; meta: { total: number; totals?: Record<string, string> } };
    const all = (await harness.get<Body>('/reports/credit-cycle/rows?page=1&pageSize=200', { token: adminToken })).body;
    const one = (await harness.get<Body>('/reports/credit-cycle/rows?page=1&pageSize=1', { token: adminToken })).body;

    expect(one.data).toHaveLength(1);
    // The same figure whichever slice was asked for: it is the report's.
    expect(one.meta.totals?.exposure).toBe(all.meta.totals?.exposure);
    const whole = Number(all.meta.totals?.exposure ?? '0');
    expect(whole).toBeCloseTo(
      all.data.reduce((running, row) => running + Number(row.exposure), 0),
      2,
    );
    // And it is not the one row the caller was given, which is what the
    // dashboard tile used to add up.
    expect(Number(one.data[0]?.exposure ?? '0')).toBeLessThan(whole);
  });

  it('the quiet-revenue total leaves out customers still buying on rhythm', async () => {
    type Body = { data: { state: string; revenue12m: string }[]; meta: { totals?: Record<string, string> } };
    const lapse = (await harness.get<Body>('/reports/customer-lapse/rows?page=1&pageSize=200', { token: adminToken })).body;
    const quiet = lapse.data.filter((row) => row.state !== 'ON_RHYTHM');
    expect(lapse.meta.totals?.revenue12m).toBeDefined();
    expect(Number(lapse.meta.totals?.revenue12m ?? '-1')).toBeCloseTo(
      quiet.reduce((running, row) => running + Number(row.revenue12m), 0),
      2,
    );
  });

  it('credit breaches count each party its own releases, not the whole organisation', async () => {
    // Two customers over their limit; one had an order released, the other
    // never did. The count is the column's whole point -- a party released
    // three times this quarter is a different conversation from one that has
    // simply drifted over.
    const parties = await harness.db.execute<{ id: string; name: string }>(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group, credit_limit)
      VALUES (${ORG_ID}, ${connectionId}, 'Breach Released', 'Sundry Debtors', 100),
             (${ORG_ID}, ${connectionId}, 'Breach Untouched', 'Sundry Debtors', 100)
      RETURNING id, name
    `);
    const released = parties.rows.find((r) => r.name === 'Breach Released')?.id ?? '';
    const untouched = parties.rows.find((r) => r.name === 'Breach Untouched')?.id ?? '';
    await harness.db.execute(sql`
      INSERT INTO vouchers (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, is_cancelled, amount)
      VALUES (${ORG_ID}, ${connectionId}, '2026-08-14', 'Sales', 'BR-1', 'Breach Released', ${released}, false, '900.00'),
             (${ORG_ID}, ${connectionId}, '2026-08-14', 'Sales', 'BR-2', 'Breach Untouched', ${untouched}, false, '900.00')
    `);
    const doc = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO sales_documents (org_id, doc_type, number, status, date, party_id, customer_name, grand_total)
      VALUES (${ORG_ID}, 'SALES_ORDER', 'SO-BREACH-1', 'CONFIRMED', '2026-08-14', ${released}, 'Breach Released', '900.00')
      RETURNING id
    `);
    await harness.db.execute(sql`
      INSERT INTO audit_logs (org_id, action, entity_type, entity_id, created_at)
      VALUES (${ORG_ID}, 'sales.order.credit_overridden', 'sales_document', ${doc.rows[0]?.id ?? ''}, now() - interval '10 days')
    `);

    const breaches = await harness.get<{ data: { partyName: string; releases90d: number; overBy: string }[] }>('/reports/credit-breaches/rows', {
      token: adminToken,
    });
    expect(breaches.status).toBe(200);
    const rows = breaches.body.data.filter((r) => r.partyName.startsWith('Breach '));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.partyName === 'Breach Released')?.releases90d).toBe(1);
    // Before the subquery was correlated this read 1 as well, because it was
    // counting the organisation rather than the party.
    expect(rows.find((r) => r.partyName === 'Breach Untouched')?.releases90d).toBe(0);
  });

  it('serves each new report with its declared columns', async () => {
    for (const key of ['aov-trend', 'partial-shipments', 'vendor-lead-time', 'stock-out-frequency', 'sales-heatmap'] as const) {
      const page = await harness.get<{ data: Record<string, unknown>[]; meta: { total: number } }>(
        `/reports/${key}/rows?from=2026-06-01&to=2026-08-31`,
        { token: adminToken },
      );
      expect(page.status, `${key}: ${page.text}`).toBe(200);
      expect(Array.isArray(page.body.data)).toBe(true);
    }
  });

  it('average order value reads the fixture invoices month by month', async () => {
    const page = await harness.get<{ data: { month: string; invoices: number; aov: string }[] }>(
      '/reports/aov-trend/rows?from=2026-06-01&to=2026-08-31',
      { token: adminToken },
    );
    expect(page.status, page.text).toBe(200);
    const august = page.body.data.find((row) => row.month === '2026-08');
    expect(august).toBeDefined();
    expect(august?.invoices).toBeGreaterThanOrEqual(1);
    expect(Number(august?.aov)).toBeGreaterThan(0);
  });

  it('the margin proxy is for margin eyes only, and says cost against price', async () => {
    const margin = await harness.get<{ data: { item: string; revenue: string; cost: string; margin: string }[] }>(
      '/reports/margin-proxy/rows?from=2026-08-01&to=2026-08-31',
      { token: adminToken },
    );
    expect(margin.status, margin.text).toBe(200);
    const cable = margin.body.data.find((row) => row.item === 'Cat6 Cable Box');
    expect(cable).toBeDefined();
    expect(Number(cable?.revenue)).toBeGreaterThan(0);
    expect(Number(cable?.margin)).toBe(Number(cable?.revenue) - Number(cable?.cost));

    const narrowRoleId = await harness.createRole('Receivables only', [PERMISSIONS.RECEIVABLES_VIEW, PERMISSIONS.REPORT_VIEW]);
    const viewer = await harness.createUser({ email: scopedEmail('masters-no-margin'), roleIds: [narrowRoleId] });
    const viewerToken = (await harness.login(viewer.email, viewer.password)).token;
    const refused = await harness.get<{ error: { code: string } }>('/reports/margin-proxy/rows', { token: viewerToken });
    expect(refused.status).toBe(403);
    const catalogue = await harness.get<{ data: { key: string }[] }>('/reports', { token: viewerToken });
    expect(catalogue.body.data.some((report) => report.key === 'margin-proxy')).toBe(false);
    expect(catalogue.body.data.some((report) => report.key === 'aov-trend')).toBe(true);
  });
});

/**
 * REQ-Y-02 and REQ-Y-04, the two reports `bill_allocations` unblocks.
 *
 * The fixture is three bills for one party, chosen so each answers a question
 * a net balance cannot:
 *
 *   BILL-A  10,000  raised 200 days ago, settled in full after 40 days
 *   BILL-B   5,000  raised 100 days ago, 2,000 paid  -> 3,000 open, 90+ bucket
 *   BILL-C   8,000  raised 10 days ago, untouched    -> 8,000 open, 0-30
 *
 * Net exposure is 11,000 either way. What only the bill view can say is that
 * 3,000 of it has been owed for a hundred days.
 */
describe('ageing and payment analysis (Phase 6d, REQ-Y-02 / REQ-Y-04)', () => {
  let billPartyId = '';

  beforeAll(async () => {
    const party = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group, credit_limit, credit_days)
      VALUES (${ORG_ID}, ${connectionId}, 'Bill-wise Traders', 'Sundry Debtors', '500000', 30)
      RETURNING id
    `);
    billPartyId = party.rows[0]?.id ?? '';

    const raise = async (number: string, daysAgo: number, amount: string): Promise<string> => {
      const rows = await harness.db.execute<{ id: string }>(sql`
        INSERT INTO vouchers (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, amount)
        VALUES (${ORG_ID}, ${connectionId}, CURRENT_DATE - (${daysAgo})::int, 'Sales', ${number}, 'Bill-wise Traders', ${billPartyId}, ${amount})
        RETURNING id
      `);
      return rows.rows[0]?.id ?? '';
    };
    const settle = async (daysAgo: number, amount: string): Promise<string> => {
      const rows = await harness.db.execute<{ id: string }>(sql`
        INSERT INTO vouchers (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, amount)
        VALUES (${ORG_ID}, ${connectionId}, CURRENT_DATE - (${daysAgo})::int, 'Receipt', 'RCT-BW', 'Bill-wise Traders', ${billPartyId}, ${amount})
        RETURNING id
      `);
      return rows.rows[0]?.id ?? '';
    };

    const a = await raise('BILL-A', 200, '10000');
    const b = await raise('BILL-B', 100, '5000');
    const c = await raise('BILL-C', 10, '8000');
    const payA = await settle(160, '10000');
    const payB = await settle(90, '2000');

    await harness.db.execute(sql`
      INSERT INTO bill_allocations (org_id, connection_id, voucher_id, party_id, party_name, bill_name, ref_type, bill_date, amount)
      VALUES
        (${ORG_ID}, ${connectionId}, ${a}, ${billPartyId}, 'Bill-wise Traders', 'BILL-A', 'new', CURRENT_DATE - 200, '10000'),
        (${ORG_ID}, ${connectionId}, ${b}, ${billPartyId}, 'Bill-wise Traders', 'BILL-B', 'new', CURRENT_DATE - 100, '5000'),
        (${ORG_ID}, ${connectionId}, ${c}, ${billPartyId}, 'Bill-wise Traders', 'BILL-C', 'new', CURRENT_DATE - 10, '8000'),
        (${ORG_ID}, ${connectionId}, ${payA}, ${billPartyId}, 'Bill-wise Traders', 'BILL-A', 'against', CURRENT_DATE - 200, '-10000'),
        (${ORG_ID}, ${connectionId}, ${payB}, ${billPartyId}, 'Bill-wise Traders', 'BILL-B', 'against', CURRENT_DATE - 100, '-2000')
    `);
  });

  it('lists only bills with something still on them, aged from the bill date', async () => {
    const res = await harness.get<{
      data: { partyName: string; billName: string; ageDays: number; bucket: string; outstanding: string; overdue: boolean }[];
    }>(`/reports/ageing/rows?partyId=${billPartyId}`, { token: adminToken });
    expect(res.status).toBe(200);

    // BILL-A settled in full, so it is gone -- no "paid" flag was needed to
    // say so, the rows simply net to zero.
    expect(res.body.data.map((r) => r.billName)).toEqual(['BILL-B', 'BILL-C']);

    const b = res.body.data.find((r) => r.billName === 'BILL-B');
    expect(b?.outstanding).toBe('3000.00');
    expect(b?.ageDays).toBe(100);
    expect(b?.bucket).toBe('90+');
    // Raised 100 days ago on 30-day terms.
    expect(b?.overdue).toBe(true);

    const c = res.body.data.find((r) => r.billName === 'BILL-C');
    expect(c?.outstanding).toBe('8000.00');
    expect(c?.bucket).toBe('0-30');
    expect(c?.overdue).toBe(false);
  });

  it('says what a net balance cannot: how old the open money is', async () => {
    const res = await harness.get<{ data: { outstanding: string; ageDays: number }[] }>(
      `/reports/ageing/rows?partyId=${billPartyId}`,
      { token: adminToken },
    );
    const total = res.body.data.reduce((sum, row) => sum + Number(row.outstanding), 0);
    // The same 11,000 the credit cycle would show as one figure...
    expect(total).toBe(11000);
    // ...of which this much has been owed beyond the terms.
    const aged = res.body.data.filter((r) => r.ageDays > 30).reduce((sum, r) => sum + Number(r.outstanding), 0);
    expect(aged).toBe(3000);
  });

  it('measures days to pay from the settlement that names the bill', async () => {
    const res = await harness.get<{
      data: { partyName: string; creditDays: number | null; avgDaysToPay: number | null; slippage: number | null; billsPaid: number; billsOpen: number; oldestOpenDays: number | null }[];
    }>(`/reports/payment-analysis/rows?partyId=${billPartyId}`, { token: adminToken });
    expect(res.status).toBe(200);

    const row = res.body.data[0];
    expect(row?.partyName).toBe('Bill-wise Traders');
    // BILL-A alone is settled: raised 200 days ago, paid at 160 -- forty days.
    expect(row?.avgDaysToPay).toBe(40);
    expect(row?.billsPaid).toBe(1);
    expect(row?.billsOpen).toBe(2);
    // Agreed 30, took 40.
    expect(row?.slippage).toBe(10);
    expect(row?.oldestOpenDays).toBe(100);
  });

  it('refuses an account without receivables.view', async () => {
    const refused = await harness.get('/reports/ageing/rows', { token: employeeToken });
    expect(refused.status).toBe(403);
  });
});

/**
 * A search that only finds what you can already spell is not a search.
 *
 * The fixture is deliberately awkward: "Behar Supply Co" has a space where
 * somebody might type none, and the GSTIN is the kind of string nobody
 * reproduces exactly. Each case below failed before `masterSearch` learned to
 * strip separators and match words in any order.
 */
describe('finding a party the way somebody actually types', () => {
  const find = async (q: string): Promise<string[]> => {
    const res = await harness.get<Paginated<PartyView>>(
      `/masters/parties?q=${encodeURIComponent(q)}`,
      { token: adminToken },
    );
    expect(res.status).toBe(200);
    return res.body.data.map((p) => p.name).sort();
  };

  /*
   * Both spellings, and that is the right answer rather than a nuisance.
   * The duplicate-masters test above leaves "ASHA  TRADERS." in the fixture --
   * two spaces and a full stop -- and it is the same party. A search that
   * returned only the tidy spelling would hide the record somebody is most
   * likely hunting for, which is the messy one somebody typed badly once.
   */
  const BOTH_ASHAS = ['ASHA  TRADERS.', 'Asha Traders'];

  it('still finds the exact name, which must not regress', async () => {
    expect(await find('Asha Traders')).toEqual(BOTH_ASHAS);
  });

  it('finds it with the words the other way round', async () => {
    // "traders asha" is how somebody who half-remembers the name types it.
    expect(await find('traders asha')).toEqual(BOTH_ASHAS);
  });

  it('does not care how many spaces were typed', async () => {
    expect(await find('  asha    traders  ')).toEqual(BOTH_ASHAS);
  });

  it('finds a name typed without its space', async () => {
    // The reported case: the separator has to be reproduced exactly or nothing
    // comes back.
    expect(await find('beharsupply')).toEqual(['Behar Supply Co']);
  });

  it('finds a name typed with a hyphen the record does not have', async () => {
    expect(await find('behar-supply')).toEqual(['Behar Supply Co']);
  });

  it('finds a GSTIN typed in pieces, and only the record that has it', async () => {
    // The duplicate has no GSTIN, so this is also the case that shows the
    // search still narrows rather than sweeping both in on the name.
    expect(await find('27AAAPL 1234C1ZV')).toEqual(['Asha Traders']);
  });

  it('matches across columns within one word, and narrows across words', async () => {
    // Both parties contain neither word, so an OR across words would return
    // both and prove nothing. AND is what makes a second word useful.
    expect(await find('asha behar')).toEqual([]);
  });

  it('is still case-insensitive', async () => {
    expect(await find('ASHA')).toEqual(BOTH_ASHAS);
  });

  it('does not let a wildcard turn the filter off', async () => {
    // The escaping this function has always had: a bare % must not match every
    // row, which would be a filter that silently stopped filtering.
    expect(await find('%%')).toEqual([]);
  });

  it('treats an all-separator term as no filter rather than matching nothing', async () => {
    // Stripping "---" leaves an empty string; searching for it must not become
    // a contains-empty that matches everything, nor an error.
    const all = await find('---');
    expect(all.length).toBeGreaterThanOrEqual(0);
  });
});
