import { SYSTEM_ROLES, type PartyStatementView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Report 48 (doc 18): a customer statement for sending. Hand-worked: Asha
 * opens at 10,000 Dr (Tally sends a debit balance as -10000); a July sale of
 * 1,000 sits before the period and moves the opening to 11,000 Dr; in August
 * a sale of 9,440 whose party line says Dr takes it to 20,440 Dr, a receipt
 * of 5,000 with no lines is credited by its type to 15,440 Dr, a cancelled
 * sale is not there at all, and a journal with no side is shown, counted,
 * and moves nothing.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d8';

let harness: ApiHarness;
let adminToken = '';
let employeeToken = '';
let partyId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Statement Org');
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);
  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('statement-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('statement-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Statement Co', 'guid-statement') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, gstin, address, opening_balance, closing_balance)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors', '27AAAPL1234C1ZV', 'MIDC, Nashik', -10000, -15440) RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  const voucher = (date: string, type: string, number: string, amount: number, cancelled = false) => sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 1, ${date}, ${type}, ${number}, 'Asha Traders', ${partyId}, ${`${type} ${number}`}, ${cancelled}, ${amount}, now()) RETURNING id
  `;
  await harness.db.execute(voucher('2026-07-05', 'Sales', 'INV-J1', 1000));
  const sale = await harness.db.execute<{ id: string }>(voucher('2026-08-10', 'Sales', 'INV-A1', 9440));
  await harness.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount)
    VALUES (${ORG_ID}, ${sale.rows[0]?.id ?? ''}, 1, 'ledger', 'Asha Traders', true, 9440)
  `);
  await harness.db.execute(voucher('2026-08-20', 'Receipt', 'RCP-7', 5000));
  await harness.db.execute(voucher('2026-08-25', 'Sales', 'INV-X', 777, true));
  await harness.db.execute(voucher('2026-08-28', 'Journal', 'JV-3', 100));
});

afterAll(async () => {
  await harness.close();
});

describe('GET /masters/parties/:id/statement', () => {
  it('walks the ledger from the pulled opening through the period, in Tally\'s sides', async () => {
    const res = await harness.get<PartyStatementView>(`/masters/parties/${partyId}/statement?from=2026-08-01&to=2026-08-31`, { token: adminToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.opening).toEqual({ amount: '11000.00', side: 'Dr' });
    expect(res.body.entries.map((e) => [e.voucherNumber, e.side, e.sideSource, e.amount, e.balance, e.balanceSide])).toEqual([
      ['INV-A1', 'Dr', 'line', '9440.00', '20440.00', 'Dr'],
      ['RCP-7', 'Cr', 'type', '5000.00', '15440.00', 'Dr'],
      ['JV-3', null, 'none', '100.00', '15440.00', 'Dr'],
    ]);
    expect(res.body.closing).toEqual({ amount: '15440.00', side: 'Dr' });
    expect(res.body.totals).toEqual({ debit: '9440.00', credit: '5000.00' });
    expect(res.body.unplaced).toBe(1);
    expect(res.body.tallyClosing).toBe('-15440.00');
    expect(res.body.earliestVoucherDate).toBe('2026-07-05');
    expect(res.body.party.name).toBe('Asha Traders');
  });

  it('crosses the sign when receipts overtake the debt', async () => {
    // Only the receipt in the window: 11,000 Dr + 9,440 Dr = 20,440 Dr before it, 15,440 Dr after. A window past it all
    // still lands on the closing, and an empty window carries the closing as both its opening and its closing.
    const later = await harness.get<PartyStatementView>(`/masters/parties/${partyId}/statement?from=2026-09-01&to=2026-09-30`, { token: adminToken });
    expect(later.status).toBe(200);
    expect(later.body.entries).toEqual([]);
    expect(later.body.opening).toEqual({ amount: '15440.00', side: 'Dr' });
    expect(later.body.closing).toEqual({ amount: '15440.00', side: 'Dr' });
  });

  it('answers a workbook, refuses without the key, names a party that is not there, and refuses a backwards period', async () => {
    const sheet = await harness.getRaw(`/masters/parties/${partyId}/statement.xlsx?from=2026-08-01&to=2026-08-31`, { token: adminToken });
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get('content-type') ?? '').toContain('spreadsheet');
    expect(sheet.headers.get('content-disposition') ?? '').toContain('Statement-Asha-Traders-2026-08-01-to-2026-08-31.xlsx');
    expect(sheet.body.subarray(0, 2).toString()).toBe('PK');
    // The workbook itself, not its magic bytes: the ledger rows land with the amount on the side the API placed it.
    const workbook = new ExcelJS.Workbook();
    // ExcelJS types its own Buffer; Node's Buffer<ArrayBufferLike> is the same bytes.
    await workbook.xlsx.load(sheet.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const rows: unknown[][] = [];
    workbook.worksheets[0]?.eachRow((row) => { rows.push((row.values as unknown[]).slice(1)); });
    expect(rows).toContainEqual(['Date', 'Voucher', 'Number', 'Particulars', 'Debit', 'Credit', 'Balance']);
    const byNumber = (n: string) => rows.find((r) => r[2] === n);
    expect(byNumber('INV-A1')?.[4]).toBe(9440);
    expect(byNumber('INV-A1')?.[6]).toBe('20440.00 Dr');
    expect(byNumber('RCP-7')?.[5]).toBe(5000);
    // ExcelJS reads a blank written cell back as '' -- neither money column holds the unplaced journal.
    expect([byNumber('JV-3')?.[4], byNumber('JV-3')?.[5]]).toEqual(['', '']);
    expect(byNumber('JV-3')?.[3]).toBe('Journal JV-3 -- Side not known -- not counted');
    expect(rows.some((r) => r[0] === 'Note' && String(r[1]).startsWith('1 voucher(s) carried no side'))).toBe(true);
    const closing = rows.find((r) => r[3] === 'Closing balance');
    expect(closing?.[6]).toBe('15440.00 Dr');
    const total = rows.find((r) => r[3] === 'Total');
    expect([total?.[4], total?.[5]]).toEqual([9440, 5000]);

    const refused = await harness.get(`/masters/parties/${partyId}/statement?from=2026-08-01&to=2026-08-31`, { token: employeeToken });
    expect(refused.status).toBe(403);
    const missing = await harness.get('/masters/parties/01900000-0000-7000-8000-0000000000ff/statement?from=2026-08-01&to=2026-08-31', { token: adminToken });
    expect(missing.status).toBe(404);
    const backwards = await harness.get(`/masters/parties/${partyId}/statement?from=2026-08-31&to=2026-08-01`, { token: adminToken });
    expect(backwards.status).toBe(400);
  });
});
