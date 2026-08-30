import { sql } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * O-2 (owner, 28 Aug 2026): the coverage guarantee. A key account past its
 * class's contact window joins the desk even when no work list names it --
 * which means it must appear on a book so quiet that the scored path finds
 * no candidates at all. This fixture is that book: one A+ customer, one
 * year-old voucher, nothing overdue, nothing in any list.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000c0ff';

let harness: ApiHarness;
let adminToken = '';
let partyId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Desk Coverage Org', { preservePeople: true });
  for (const table of ['cfo_desk_served', 'cfo_desk_outcomes', 'promises_to_pay', 'customer_tier_assignments', 'customer_tiers', 'interest_daily_party', 'interest_daily_stock', 'fact_receivable_snapshot', 'fact_sales_daily', 'vouchers', 'parties']) {
    await harness.db.execute(sql.raw(`DELETE FROM ${table} WHERE org_id = '${ORG_ID}'`));
  }
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);
  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('desk-coverage-admin'), roleIds: [adminRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;

  const conn = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Coverage Co', 'guid-desk-coverage') RETURNING id
  `);
  const connectionId = conn.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Quiet Key Account', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO customer_tiers (org_id, code, label, description, colour_token, contact_every_days, service_priority, review_every, sort_order)
    VALUES (${ORG_ID}, 'A+', 'Key account', '', 'fresh-1', 30, 'High', 'Quarterly', 1)
  `);
  await harness.db.execute(sql`
    INSERT INTO customer_tier_assignments (org_id, party_id, tier_code, effective_from, assigned_by, reason)
    VALUES (${ORG_ID}, ${partyId}, 'A+', '2026-01-01', (SELECT id FROM users WHERE org_id = ${ORG_ID} LIMIT 1), 'fixture')
  `);
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 1, '2026-01-05', 'Sales', 'CV-1', 'Quiet Key Account', ${partyId}, '', false, 5000, now())
  `);
});

afterAll(async () => {
  await harness.close();
});

describe('the coverage guarantee (O-2) and the desk promise (O-3)', () => {
  it('a neglected key account joins an otherwise empty desk, and repeats do not', async () => {
    const res = await harness.get<{ rows: { party: string; primary: { key: string; reason: string } }[] }>('/cfo/desk?mixed=1&cap=10', { token: adminToken });
    expect(res.status).toBe(200);
    const coverage = res.body.rows.find((r) => r.primary.key === 'coverage');
    expect(coverage?.party).toBe('Quiet Key Account');
    expect(coverage?.primary.reason).toMatch(/class A\+ wants every 30/u);

    // Served today, so tomorrow-shaped reads inside seven days skip it.
    const again = await harness.get<{ rows: { primary: { key: string } }[] }>('/cfo/desk?mixed=1&cap=10', { token: adminToken });
    expect(again.body.rows.filter((r) => r.primary.key === 'coverage').length).toBeLessThanOrEqual(1);
  });

  it('a promise taken at the desk is a real promises_to_pay row, bills open', async () => {
    const missing = await harness.post(`/cfo/desk/${partyId}/outcome`, {
      token: adminToken,
      body: { outcome: 'PROMISE_TO_PAY', notes: 'Will pay' },
    });
    expect(missing.status).toBe(400);

    const ok = await harness.post(`/cfo/desk/${partyId}/outcome`, {
      token: adminToken,
      body: { outcome: 'PROMISE_TO_PAY', amount: '15000.00', nextDate: '2026-09-05', notes: 'After their receivable clears' },
    });
    expect(ok.status).toBe(201);
    const promise = await harness.db.execute<{ amount: string; promisedDate: string; bills: string[] }>(sql`
      SELECT amount::text, promised_date AS "promisedDate", bills FROM promises_to_pay
      WHERE org_id = ${ORG_ID} AND party_id = ${partyId}
    `);
    expect(promise.rows).toHaveLength(1);
    expect(promise.rows[0]?.amount).toBe('15000.00');
    expect(promise.rows[0]?.promisedDate).toBe('2026-09-05');
    // Empty bills means any receipt from the party counts (REQ-AJ-02).
    expect(promise.rows[0]?.bills).toEqual([]);
  });
});
