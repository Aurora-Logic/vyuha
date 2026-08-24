import { SYSTEM_ROLES } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Owner, 23 Aug 2026: filters and sorting over the voucher register.
 *
 * The register is paged at twenty-five, so ordering has to happen in the
 * database -- a sort applied to the page in the browser would reorder
 * twenty-five rows out of a hundred and read as wrong. These tests are the
 * proof that the order and the narrowing are the server's.
 *
 * The amounts below are chosen to separate numeric ordering from text
 * ordering: as text, '10000' sorts before '900', and a register that put a
 * ten-thousand-rupee invoice below a nine-hundred-rupee one would be quietly
 * useless.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d9';

interface VoucherRow {
  readonly voucherNumber: string;
  readonly amount: string;
  readonly date: string;
  readonly voucherType: string;
}

interface VoucherPage {
  readonly data: readonly VoucherRow[];
  readonly meta: { readonly total: number };
}

interface TypeFacet {
  readonly voucherType: string;
  readonly count: number;
}

let harness: ApiHarness;
let adminToken = '';
let employeeToken = '';

const numbersOf = (page: VoucherPage): string[] => page.data.map((row) => row.voucherNumber);

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Voucher Register Org');
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);
  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('voucher-register-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('voucher-register-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Register Co', 'guid-voucher-register') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';

  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, narration, is_cancelled, amount, last_pulled_at) VALUES
      (${ORG_ID}, ${connectionId}, 1, '2026-01-05', 'Sales',    'S-1', 'Asha Traders',  'January',  false, 900,   now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-02-05', 'Sales',    'S-2', 'Bharat Cables', 'February', false, 10000, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-03-05', 'Sales',    'S-3', 'Chetan Power',  'March',    false, 2500,  now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-04-05', 'Receipt',  'R-1', 'Asha Traders',  'April',    false, 900,   now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-05-05', 'Purchase', 'P-1', 'Deva Supply',   'May',      false, 7300,  now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-06-05', 'Sales',    'S-4', 'Asha Traders',  'Cancelled', true, 4400,  now())
  `);
});

afterAll(async () => {
  await harness.close();
});

describe('GET /masters/vouchers ordering', () => {
  it('defaults to newest first, and leaves cancelled vouchers out', async () => {
    const res = await harness.get<VoucherPage>('/masters/vouchers', { token: adminToken });

    expect(res.status).toBe(200);
    expect(numbersOf(res.body)).toEqual(['P-1', 'R-1', 'S-3', 'S-2', 'S-1']);
    expect(res.body.meta.total).toBe(5);
  });

  it('orders by amount as a number, not as text', async () => {
    const ascending = await harness.get<VoucherPage>('/masters/vouchers?sort=amount', { token: adminToken });
    const descending = await harness.get<VoucherPage>('/masters/vouchers?sort=-amount', { token: adminToken });

    // 900 first and 10000 last is the numeric answer; the text answer would be
    // '10000', '2500', '7300', '900'.
    expect(ascending.body.data.map((row) => Number(row.amount))).toEqual([900, 900, 2500, 7300, 10000]);
    expect(descending.body.data.map((row) => Number(row.amount))).toEqual([10000, 7300, 2500, 900, 900]);
  });

  it('orders by party, type and number on request', async () => {
    const byParty = await harness.get<VoucherPage>('/masters/vouchers?sort=party', { token: adminToken });
    const byType = await harness.get<VoucherPage>('/masters/vouchers?sort=type', { token: adminToken });
    const byNumber = await harness.get<VoucherPage>('/masters/vouchers?sort=-number', { token: adminToken });

    // The parties are asserted, not the two rows inside the Asha Traders tie:
    // both arrived in one insert, so only the id tiebreak separates them, and
    // ids are minted fresh each run. That the tie resolves the *same way twice*
    // is what paging needs, and the test below is where that is proved.
    expect(byParty.body.data.map((row) => row.partyName)).toEqual([
      'Asha Traders',
      'Asha Traders',
      'Bharat Cables',
      'Chetan Power',
      'Deva Supply',
    ]);
    expect([...numbersOf(byParty.body).slice(0, 2)].sort()).toEqual(['R-1', 'S-1']);
    expect(byType.body.data.map((row) => row.voucherType)).toEqual(['Purchase', 'Receipt', 'Sales', 'Sales', 'Sales']);
    expect(numbersOf(byNumber.body)).toEqual(['S-3', 'S-2', 'S-1', 'R-1', 'P-1']);
  });

  it('ignores a sort term it does not know rather than refusing the page', async () => {
    // A stale bookmark must still show the register; an unknown column is a
    // client bug, not a reason to hand the reader an error instead of rows.
    const res = await harness.get<VoucherPage>('/masters/vouchers?sort=-narration', { token: adminToken });

    expect(res.status).toBe(200);
    expect(numbersOf(res.body)).toEqual(['P-1', 'R-1', 'S-3', 'S-2', 'S-1']);
  });

  it('keeps the order stable under a repeated same-day tie', async () => {
    // Every row here shares a sort key, so only the tiebreaks decide; two
    // identical requests must not disagree, or a row lands on two pages.
    const first = await harness.get<VoucherPage>('/masters/vouchers?sort=type', { token: adminToken });
    const second = await harness.get<VoucherPage>('/masters/vouchers?sort=type', { token: adminToken });

    expect(numbersOf(first.body)).toEqual(numbersOf(second.body));
  });
});

describe('GET /masters/vouchers filtering', () => {
  it('narrows to one voucher type', async () => {
    const res = await harness.get<VoucherPage>('/masters/vouchers?voucherType=Sales', { token: adminToken });

    expect(numbersOf(res.body)).toEqual(['S-3', 'S-2', 'S-1']);
    expect(res.body.meta.total).toBe(3);
  });

  it('narrows to a date window, inclusive at both ends', async () => {
    const res = await harness.get<VoucherPage>('/masters/vouchers?from=2026-02-05&to=2026-04-05', { token: adminToken });

    expect(numbersOf(res.body)).toEqual(['R-1', 'S-3', 'S-2']);
  });

  it('combines a type, a window and the cancelled switch', async () => {
    const res = await harness.get<VoucherPage>(
      '/masters/vouchers?voucherType=Sales&from=2026-03-01&to=2026-12-31&includeCancelled=true&sort=amount',
      { token: adminToken },
    );

    expect(numbersOf(res.body)).toEqual(['S-3', 'S-4']);
  });
});

describe('GET /masters/voucher-types', () => {
  it('lists the types this organisation has, commonest first', async () => {
    const res = await harness.get<TypeFacet[]>('/masters/voucher-types', { token: adminToken });

    expect(res.status).toBe(200);
    // Sales counts the cancelled one too: the filter must offer every type the
    // register can show, and the switch decides whether that row appears.
    expect(res.body).toEqual([
      { voucherType: 'Sales', count: 4 },
      { voucherType: 'Purchase', count: 1 },
      { voucherType: 'Receipt', count: 1 },
    ]);
  });

  it('refuses without the receivables key', async () => {
    const res = await harness.get('/masters/voucher-types', { token: employeeToken });

    expect(res.status).toBe(403);
  });
});
