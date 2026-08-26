import { SYSTEM_ROLES, type AreaInsights, type CustomReportView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * The reports module's API (owner, 26 Aug 2026): four gated areas of
 * day-bucketed metrics, and custom reports with author-only writes.
 *
 * The fixtures are small and exact so every figure below is checkable by
 * hand: two attendance days, three vouchers, two sales documents, two sync
 * jobs. What these tests hold is the shape (every day in the range present,
 * zeros filled), the arithmetic (money summed exactly, as text), and the
 * gates (module key, area key, author-only writes, unshared invisibility).
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0e3';

let harness: ApiHarness;
let adminToken = '';
let employeeToken = '';
let secondAdminToken = '';

const metric = (body: AreaInsights, key: string) => {
  const found = body.metrics.find((m) => m.key === key);
  if (found === undefined) throw new Error(`metric ${key} missing: ${body.metrics.map((m) => m.key).join(', ')}`);
  return found;
};

beforeAll(async () => {
  // preservePeople, like the attendance suites: attendance_days holds a
  // restrict FK onto employees, so the harness must not try to delete people
  // before this file has cleared its own day rows.
  harness = await ApiHarness.start(ORG_ID, 'Insights Org', { preservePeople: true });
  await harness.db.execute(sql`DELETE FROM custom_reports WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM fact_receivable_snapshot WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM interest_daily_party WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM attendance_days WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sales_documents WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_jobs WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_exceptions WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('insights-admin'), roleIds: [adminRoleId] });
  const second = await harness.createUser({ email: scopedEmail('insights-admin-2'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('insights-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  secondAdminToken = (await harness.login(second.email, second.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  await harness.db.execute(sql`DELETE FROM employees WHERE org_id = ${ORG_ID} AND employee_code = 'INS-1'`);
  const person = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO employees (org_id, employee_code, first_name, last_name, date_of_joining)
    VALUES (${ORG_ID}, 'INS-1', 'Meera', 'Shah', '2025-01-01') RETURNING id
  `);
  const employeeId = person.rows[0]?.id ?? '';

  // Two days: the 1st fully present and late, the 2nd absent with overtime 0.
  await harness.db.execute(sql`
    INSERT INTO attendance_days (org_id, employee_id, date, status, worked_minutes, ot_minutes, late_minutes) VALUES
      (${ORG_ID}, ${employeeId}, '2026-08-01', 'PRESENT', 480, 60, 12),
      (${ORG_ID}, ${employeeId}, '2026-08-02', 'ABSENT', 0, 0, 0)
  `);

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Insights Co', 'guid-insights') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';

  // 1000.50 + 200.25 invoiced on two days; one 300.00 receipt; a cancelled
  // voucher that must count nowhere.
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, narration, is_cancelled, amount, last_pulled_at) VALUES
      (${ORG_ID}, ${connectionId}, 1, '2026-08-01', 'Sales',   'INS-S1', 'Asha Traders', '', false, 1000.50, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-08-02', 'Sales',   'INS-S2', 'Bharat Cables', '', false, 200.25, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-08-02', 'Receipt', 'INS-R1', 'Asha Traders', '', false, 300.00, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-08-02', 'Sales',   'INS-X1', 'Asha Traders', '', true,  999.99, now())
  `);

  await harness.db.execute(sql`
    INSERT INTO sales_documents (org_id, doc_type, number, status, date, customer_name, subtotal, grand_total) VALUES
      (${ORG_ID}, 'SALES_ORDER', 'SO-1', 'CONFIRMED', '2026-08-01', 'Asha Traders', 500, 590.00),
      (${ORG_ID}, 'ESTIMATE',    'EST-1', 'SENT',     '2026-08-02', 'Bharat Cables', 100, 118.00)
  `);

  await harness.db.execute(sql`
    INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, state, attempts, created_at) VALUES
      (${ORG_ID}, ${connectionId}, 'PULL', 'voucher', 'DONE',   1, '2026-08-01T05:00:00Z'),
      (${ORG_ID}, ${connectionId}, 'PULL', 'party',   'FAILED', 3, '2026-08-02T05:00:00Z')
  `);

  // The receivable snapshot: two bills for one party, one fresh, one 45 days
  // overdue -- so the ageing has two buckets to fill.
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  const partyId = party.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO fact_receivable_snapshot (org_id, snapshot_date, party_id, bill_ref, amount, outstanding, days_overdue, bucket, source) VALUES
      (${ORG_ID}, '2026-08-02', ${partyId}, 'B-1', 500, 400.00, 45, '31-60', 'test'),
      (${ORG_ID}, '2026-08-02', ${partyId}, 'B-2', 300, 100.00, 0,  'current', 'test')
  `);
  await harness.db.execute(sql`
    INSERT INTO interest_daily_party (org_id, party_id, date, closing, within_credit, overdue) VALUES
      (${ORG_ID}, ${partyId}, '2026-08-01', 500, 350, 150),
      (${ORG_ID}, ${partyId}, '2026-08-02', 500, 300, 200.50)
  `);
  await harness.db.execute(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables')
  `);
});

afterAll(async () => {
  await harness.close();
});

describe('GET /insights/:area', () => {
  it('fills every day of the range, zeros where nothing happened', async () => {
    const res = await harness.get<AreaInsights>('/insights/attendance?from=2026-08-01&to=2026-08-04', { token: adminToken });

    expect(res.status).toBe(200);
    const mix = metric(res.body, 'attendance-mix');
    expect(mix.points.map((p) => p.t)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
    expect(mix.points[0]?.PRESENT).toBe(1);
    expect(mix.points[1]?.ABSENT).toBe(1);
    expect(mix.points[2]?.PRESENT).toBe(0);
    expect(metric(res.body, 'late-arrivals').headline).toBe('1');
    expect(metric(res.body, 'overtime').headline).toBe('60');
  });

  it('sums money exactly and as text, leaving the cancelled voucher out', async () => {
    const res = await harness.get<AreaInsights>('/insights/receivables?from=2026-08-01&to=2026-08-03', { token: adminToken });

    const invoiced = metric(res.body, 'invoiced');
    expect(invoiced.headline).toBe('1200.75');
    expect(invoiced.points[0]?.invoiced).toBe('1000.50');
    expect(invoiced.breakdown?.rows[0]?.party).toBe('Asha Traders');
    expect(metric(res.body, 'received').headline).toBe('300.00');
    // The mix counts three vouchers: the cancelled one is not a fourth.
    expect(metric(res.body, 'voucher-mix').headline).toBe('3');
  });

  it('buckets the latest receivable snapshot into ageing, on a category axis', async () => {
    const res = await harness.get<AreaInsights>('/insights/receivables?from=2026-08-01&to=2026-08-02', { token: adminToken });

    const ageing = metric(res.body, 'customer-ageing');
    expect(ageing.xKind).toBe('category');
    expect(ageing.headline).toBe('500.00');
    const byBucket = Object.fromEntries(ageing.points.map((p) => [p.t, p.outstanding]));
    expect(byBucket['Not due']).toBe('100.00');
    expect(byBucket['31-60']).toBe('400.00');
    expect(ageing.breakdown?.rows[0]?.party).toBe('Asha Traders');
    expect(ageing.breakdown?.rows[0]?.worst).toBe(45);
  });

  it('carries the interest module’s daily balances for its key holders', async () => {
    const res = await harness.get<AreaInsights>('/insights/receivables?from=2026-08-01&to=2026-08-02', { token: adminToken });

    const exposure = metric(res.body, 'interest-exposure');
    // The latest day's overdue balance, exact.
    expect(exposure.headline).toBe('200.50');
    expect(exposure.points[0]?.withinCredit).toBe('350.00');
    expect(exposure.points[1]?.overdue).toBe('200.50');
  });

  it('reads sales documents by type and buckets sync outcomes', async () => {
    const sales = await harness.get<AreaInsights>('/insights/sales?from=2026-08-01&to=2026-08-02', { token: adminToken });
    expect(metric(sales.body, 'orders-value').headline).toBe('590.00');
    expect(metric(sales.body, 'estimate-funnel').series.map((s) => s.key)).toEqual(['SENT']);

    const stock = metric(sales.body, 'stock-ageing');
    expect(stock.xKind).toBe('category');
    // The one item moved on 21 Aug 2026 (INS-S1 has no inventory line, so its
    // age runs from the projection row's own birth) -- under thirty days at
    // the time these fixtures were written is not assertable against now(),
    // so what is held instead is the shape: four buckets, one item in total.
    expect(stock.points.map((p) => p.t)).toEqual(['Under 30', '31-60', '61-90', 'Over 90']);
    expect(stock.points.reduce((sum, p) => sum + Number(p.items), 0)).toBe(1);
    expect(stock.breakdown?.rows[0]?.item).toBe('Cat6 cable 305m');

    const sync = await harness.get<AreaInsights>('/insights/sync?from=2026-08-01&to=2026-08-02', { token: adminToken });
    const jobs = metric(sync.body, 'job-outcomes');
    expect(jobs.headline).toBe('1');
    expect(jobs.points[0]?.DONE).toBe(1);
    expect(jobs.points[1]?.FAILED).toBe(1);
    expect(jobs.breakdown?.rows[0]?.entity).toBe('party');
  });

  it('refuses an area to a caller without its gate, and the module to one without report.view', async () => {
    // The employee role holds neither report.view nor any area key.
    const module_ = await harness.get('/insights/attendance?from=2026-08-01&to=2026-08-02', { token: employeeToken });
    expect(module_.status).toBe(403);

    const unknown = await harness.get('/insights/payroll?from=2026-08-01&to=2026-08-02', { token: adminToken });
    expect(unknown.status).toBe(404);

    const inverted = await harness.get('/insights/attendance?from=2026-08-05&to=2026-08-01', { token: adminToken });
    expect(inverted.status).toBe(400);
  });
});

describe('custom reports', () => {
  const widget = {
    id: 'w1',
    title: 'Invoiced',
    kind: 'bar',
    size: '2x1',
    area: 'receivables',
    metric: 'invoiced',
    options: { legend: true, dataLabels: false, showTotal: true },
  };

  it('creates, lists, updates and deletes for its author', async () => {
    const created = await harness.post<CustomReportView>('/insights/custom-reports', {
      token: adminToken,
      body: { name: 'Money week', shared: false, widgets: [widget] },
    });
    expect(created.status).toBe(201);
    expect(created.body.editable).toBe(true);
    const id = created.body.id;

    const listed = await harness.get<CustomReportView[]>('/insights/custom-reports', { token: adminToken });
    expect(listed.body.map((r) => r.name)).toContain('Money week');

    const updated = await harness.put<CustomReportView>(`/insights/custom-reports/${id}`, {
      token: adminToken,
      body: { name: 'Money week', shared: true, widgets: [widget, { ...widget, id: 'w2', title: 'Received', metric: 'received' }] },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.widgets).toHaveLength(2);

    const removed = await harness.del(`/insights/custom-reports/${id}`, { token: adminToken });
    expect(removed.status).toBe(204);
  });

  it('keeps an unshared report invisible to others, and shared ones read-only to them', async () => {
    const mine = await harness.post<CustomReportView>('/insights/custom-reports', {
      token: adminToken,
      body: { name: 'Private view', shared: false, widgets: [widget] },
    });
    const shared = await harness.post<CustomReportView>('/insights/custom-reports', {
      token: adminToken,
      body: { name: 'Team view', shared: true, widgets: [widget] },
    });

    const theirList = await harness.get<CustomReportView[]>('/insights/custom-reports', { token: secondAdminToken });
    const names = theirList.body.map((r) => r.name);
    expect(names).toContain('Team view');
    expect(names).not.toContain('Private view');

    const peek = await harness.get(`/insights/custom-reports/${mine.body.id}`, { token: secondAdminToken });
    expect(peek.status).toBe(404);

    const rewrite = await harness.put(`/insights/custom-reports/${shared.body.id}`, {
      token: secondAdminToken,
      body: { name: 'Hijacked', shared: true, widgets: [] },
    });
    expect(rewrite.status).toBe(403);

    const sharedView = await harness.get<CustomReportView>(`/insights/custom-reports/${shared.body.id}`, { token: secondAdminToken });
    expect(sharedView.status).toBe(200);
    expect(sharedView.body.editable).toBe(false);
  });

  it('refuses a second report under the same name for one author', async () => {
    await harness.post('/insights/custom-reports', { token: adminToken, body: { name: 'Twice', shared: false, widgets: [] } });
    const again = await harness.post('/insights/custom-reports', { token: adminToken, body: { name: 'Twice', shared: false, widgets: [] } });
    expect(again.status).toBe(409);
  });

  it('rejects a widget pointing nowhere', async () => {
    const res = await harness.post('/insights/custom-reports', {
      token: adminToken,
      body: { name: 'Broken', shared: false, widgets: [{ id: 'w', title: 'X', kind: 'sparkle', area: 'payroll', metric: '' }] },
    });
    expect(res.status).toBe(400);
  });
});
