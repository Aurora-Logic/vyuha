import { SYSTEM_ROLES } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import type { CreditOverview, WorkLists } from './credit-control.service.js';
import type { MyCfo } from './my-cfo.service.js';
import { OwnerMapService } from './attribution/owner-map.service.js';

/**
 * Phase 2's credit endpoints on hand-computed fixtures.
 *
 * The book on 20 Aug 2026: Asha holds 40,000 current (due 30 Aug) and
 * 60,000 at 45 days overdue; Bharat holds 30,000 at 10 days overdue against
 * a 25,000 limit. August credit sales 100,000 (31 days), July 50,000.
 *
 * Hand-worked: outstanding 130,000 · overdue 90,000 · countback consumes
 * August whole (31d) and 30,000/50,000 of July (18.6d) = 49.6 · best DSO
 * on the 40,000 current book = 12.4 · ADD 37.2. D17 at the default 12%:
 * Asha's delay costs 7,200 a year, Bharat's 3,600.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0e5';
const TODAY = new Date().toISOString().slice(0, 10);

let harness: ApiHarness;
let adminToken = '';
let employeeToken = '';
let adminUserId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'CFO Credit Org', { preservePeople: true });
  for (const table of ['fact_receivable_snapshot', 'cfo_targets', 'customer_owner_map', 'voucher_lines', 'vouchers', 'parties']) {
    await harness.db.execute(sql.raw(`DELETE FROM ${table} WHERE org_id = '${ORG_ID}'`));
  }
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('cfo-credit-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('cfo-credit-emp'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;
  adminUserId = admin.id;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Credit Co', 'guid-cfo-credit') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const asha = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  const bharat = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_limit)
    VALUES (${ORG_ID}, ${connectionId}, 'Bharat Cables', 'Sundry Debtors', 25000) RETURNING id
  `);
  const chetan = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Chetan Power', 'Sundry Debtors') RETURNING id
  `);
  const deva = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connectionId}, 'Deva Supply', 'Sundry Debtors') RETURNING id
  `);
  const ashaId = asha.rows[0]?.id ?? '';
  const bharatId = bharat.rows[0]?.id ?? '';
  const chetanId = chetan.rows[0]?.id ?? '';
  const devaId = deva.rows[0]?.id ?? '';

  await harness.db.execute(sql`
    INSERT INTO fact_receivable_snapshot (org_id, snapshot_date, party_id, bill_ref, bill_date, due_date, amount, outstanding, days_overdue, bucket, source) VALUES
      (${ORG_ID}, '2026-08-20', ${ashaId},   'A-CUR', '2026-08-10', (${TODAY}::date + 5), 40000, 40000, 0,  'current', 'test'),
      (${ORG_ID}, '2026-08-20', ${ashaId},   'A-OLD', '2026-06-15', '2026-07-06',        60000, 60000, 45, '31-60',  'test'),
      (${ORG_ID}, '2026-08-20', ${bharatId}, 'B-1',   '2026-07-25', '2026-08-10',        30000, 30000, 10, '0-30',   'test'),
      (${ORG_ID}, '2026-08-19', ${ashaId},   'A-OLD', '2026-06-15', '2026-07-06',        60000, 62000, 44, '31-60',  'test')
  `);

  // Credit sales: August 100,000, July 50,000; a receipt for last-payment.
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at) VALUES
      (${ORG_ID}, ${connectionId}, 1, '2026-08-05', 'Sales',   'S-A1', 'Asha Traders',  ${ashaId},   '', false, 60000, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-08-12', 'Sales',   'S-B1', 'Bharat Cables', ${bharatId}, '', false, 40000, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-07-10', 'Sales',   'S-A0', 'Asha Traders',  ${ashaId},   '', false, 50000, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-08-15', 'Receipt', 'R-A1', 'Asha Traders',  ${ashaId},   '', false, 20000, now()),
      (${ORG_ID}, ${connectionId}, 1, '2025-08-10', 'Sales',   'S-C0', 'Chetan Power',  ${chetanId}, '', false, 30000, now()),
      (${ORG_ID}, ${connectionId}, 1, '2025-08-12', 'Sales',   'S-D0', 'Deva Supply',   ${devaId},   '', false, 20000, now()),
      (${ORG_ID}, ${connectionId}, 1, '2026-08-18', 'Sales',   'S-D1', 'Deva Supply',   ${devaId},   '', false, 15000, now())
  `);

  // My CFO's book: Asha is the admin's through the CFO owner map.
  await harness.resolve(OwnerMapService).assign(ORG_ID, null, ashaId, [{ ownerRef: `user:${adminUserId}`, share: 100 }], '2026-01-01');
});

afterAll(async () => {
  await harness.close();
});

describe('GET /cfo/receivables', () => {
  it('reads the book, counts back the DSO, and prices the delay', async () => {
    const res = await harness.get<CreditOverview>('/cfo/receivables?from=2026-08-01&to=2026-08-31', { token: adminToken });

    if (res.status !== 200) throw new Error(`500 body: ${res.text.slice(0, 400)}`);
    expect(res.body.asOf).toBe('2026-08-20');
    expect(res.body.outstanding).toBe('130000.00');
    expect(res.body.overdue).toBe('90000.00');
    expect(res.body.buckets['31-60']).toBe('60000.00');

    // Countback: August's 115,000 (Deva joined the month) consumed whole
    // (31d), then 15,000 of July's 50,000 = 0.3 x 31 = 9.3. Total 40.3.
    // Best possible spends the 40,000 current book inside August.
    const best = (40_000 / 115_000) * 31;
    expect(res.body.dsoCountback).toBeCloseTo(40.3, 10);
    expect(res.body.bestPossibleDso).toBeCloseTo(best, 10);
    expect(res.body.addDays).toBeCloseTo(40.3 - best, 10);

    // The trend covers both photographed days, stacked by bucket.
    expect(res.body.ageingTrend.map((p) => p.t)).toEqual(['2026-08-19', '2026-08-20']);

    const ashaRow = res.body.topOverdue.find((r) => r.party === 'Asha Traders');
    expect(ashaRow?.daysOverdue).toBe(45);
    // 60,000 overdue at the default 12% = 7,200 a year.
    expect(ashaRow?.costPerYear).toBe('7200.00');
    expect(ashaRow?.lastPayment).toBe('2026-08-15');
  });

  it('refuses a caller without cfo.receivables.view', async () => {
    const res = await harness.get('/cfo/receivables?from=2026-08-01&to=2026-08-31', { token: employeeToken });
    expect(res.status).toBe(403);
  });
});

describe('GET /cfo/work-lists', () => {
  it('bands the ladder, catches the breach, and keeps thin history off the churn list', async () => {
    const res = await harness.get<WorkLists>('/cfo/work-lists', { token: adminToken });

    expect(res.status).toBe(200);
    const list = (key: string) => res.body.lists.find((l) => l.key === key);

    // Asha (45 days) sits in 31-60; Bharat (10 days) in 1-30, with the
    // ladder rows carrying the priced delay in their reason.
    expect(list('overdue-31-60')?.rows.map((r) => r.party)).toEqual(['Asha Traders']);
    expect(list('overdue-31-60')?.rows[0]?.reason).toContain('7200.00 a year');
    expect(list('overdue-1-30')?.rows.map((r) => r.party)).toEqual(['Bharat Cables']);

    // 30,000 outstanding against a 25,000 limit = 120%.
    const breach = list('limit-breach')?.rows[0];
    expect(breach?.party).toBe('Bharat Cables');
    expect(breach?.utilisationPct).toBe(120);

    // Two orders is insufficient history (Q1.1): nobody here may be accused
    // of silent churn on two data points.
    expect(list('silent-churn')?.rows).toEqual([]);

    // The current bill due within seven days shows as a courtesy call.
    expect(list('due-this-week')?.rows.map((r) => r.party)).toEqual(['Asha Traders']);
  });
});


describe('GET /cfo/me', () => {
  it('scopes every figure to my own book', async () => {
    const res = await harness.get<MyCfo>('/cfo/me?from=2026-08-01&to=2026-08-31', { token: adminToken });

    expect(res.status).toBe(200);
    // Asha only: 60,000 sales this August against 50,000 last July-shifted
    // window; Bharat's 40,000 is someone else's book and must not leak in.
    expect(res.body.bookSize).toBe(1);
    expect(res.body.mySales).toBe('60000.00');
    expect(res.body.myCollections).toBe('20000.00');
    expect(res.body.myOverdue).toBe('60000.00');
    // 60,000 overdue at the default 12% -- the same D17 price the ladder shows.
    expect(res.body.delayCostPerYear).toBe('7200.00');
    const asha = res.body.customers.find((c) => c.party === 'Asha Traders');
    expect(asha?.daysOverdue).toBe(45);
    expect(res.body.customers.some((c) => c.party === 'Bharat Cables')).toBe(false);
    // Pacing runs cumulatively and ends at the period total.
    expect(res.body.pacing.at(-1)?.cumulative).toBe(60000);
  });

  it('an empty book answers zeros, not an error', async () => {
    const res = await harness.get<MyCfo>('/cfo/me?from=2026-08-01&to=2026-08-31', { token: employeeToken });
    expect(res.status).toBe(403);
  });
});


describe('GET /cfo/growth-bridge', () => {
  it('splits the window against last year and reconciles exactly (Q1.6 rule five)', async () => {
    const res = await harness.get<{
      thisYear: number;
      lastYear: number;
      change: number;
      newCustomerEffect: number;
      reconciliationError: number;
    }>('/cfo/growth-bridge?from=2026-08-01&to=2026-08-31', { token: adminToken });

    expect(res.status).toBe(200);
    // This August: Asha 60,000 + Bharat 40,000 (new) + Deva 15,000
    // (retained, ledger-only, so its -5,000 change is mix). Last August:
    // Chetan 30,000 (lost) + Deva 20,000. Change 65,000 = 100,000 new
    // - 30,000 lost - 5,000 mix, exactly.
    expect(res.body.thisYear).toBe(115_000);
    expect(res.body.lastYear).toBe(50_000);
    expect(res.body.newCustomerEffect).toBe(100_000);
    expect(res.body.reconciliationError).toBe(0);
  });
});


describe('GET /cfo/movement', () => {
  it('classifies every customer into a cell, and prices the cell honestly', async () => {
    const res = await harness.get<{
      cells: { state: string; band: string; count: number; amount: string; parties: { party: string }[] }[];
    }>('/cfo/movement?from=2026-08-01&to=2026-08-31', { token: adminToken });

    expect(res.status).toBe(200);
    const inState = (state: string) => res.body.cells.filter((c) => c.state === state && c.count > 0);

    // Bharat had nothing before the window at all: new. Asha ordered in
    // July, so with no last-August base she reads as growing, not new --
    // a customer of six weeks is not an acquisition twice. Chetan sold
    // only last year: lost, priced at last year's money. Deva fell 25%:
    // declining.
    expect(inState('new').flatMap((c) => c.parties.map((p) => p.party))).toEqual(['Bharat Cables']);
    expect(inState('growing').flatMap((c) => c.parties.map((p) => p.party))).toEqual(['Asha Traders']);
    const lost = inState('lost');
    expect(lost.flatMap((c) => c.parties.map((p) => p.party))).toEqual(['Chetan Power']);
    expect(lost[0]?.amount).toBe('30000.00');
    expect(inState('declining').flatMap((c) => c.parties.map((p) => p.party))).toEqual(['Deva Supply']);

    // Bands cover the classified set: the heaviest (Asha, 60,000) is A.
    const ashaCell = res.body.cells.find((c) => c.parties.some((p) => p.party === 'Asha Traders'));
    expect(ashaCell?.band).toBe('A');
  });
});

describe('targets and the league (G4, G5)', () => {
  it('setting a target needs cfo.targets.manage, and a bad month is refused', async () => {
    const denied = await harness.put('/cfo/targets', {
      token: employeeToken,
      body: { ownerRef: `user:${adminUserId}`, month: '2026-08', netTarget: '100000' },
    });
    expect(denied.status).toBe(403);

    const badMonth = await harness.put('/cfo/targets', {
      token: adminToken,
      body: { ownerRef: `user:${adminUserId}`, month: '2026-13', netTarget: '100000' },
    });
    expect(badMonth.status).toBe(400);
  });

  it('a stored target reads back, joins the league, and is audited', async () => {
    const put = await harness.put('/cfo/targets', {
      token: adminToken,
      body: { ownerRef: `user:${adminUserId}`, month: '2026-08', netTarget: '100000' },
    });
    expect(put.status).toBe(200);

    const list = await harness.get<{ ownerRef: string; netTarget: string }[]>('/cfo/targets?month=2026-08', {
      token: adminToken,
    });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ ownerRef: `user:${adminUserId}`, month: '2026-08', netTarget: '100000.00' }]);

    const audit = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${ORG_ID} AND action = 'cfo.target.set'
    `);
    expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('the league prices each book: sales, collections, overdue, achievement', async () => {
    const res = await harness.get<
      {
        ownerRef: string;
        ownerEmail: string | null;
        bookSize: number;
        sales: string;
        collections: string;
        overdue: string;
        target: string | null;
        achievementPct: number | null;
      }[]
    >('/cfo/league?from=2026-08-01&to=2026-08-31', { token: adminToken });

    expect(res.status).toBe(200);
    // One book exists: the owner map gives Asha to the admin. Sales 60,000
    // against the 100,000 August target reads 60%.
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    expect(row?.ownerRef).toBe(`user:${adminUserId}`);
    expect(row?.bookSize).toBe(1);
    expect(row?.sales).toBe('60000.00');
    expect(row?.collections).toBe('20000.00');
    expect(row?.overdue).toBe('60000.00');
    expect(row?.target).toBe('100000.00');
    expect(row?.achievementPct).toBe(60);
  });

  it('a window covering part of a month takes the target by day fraction (B2)', async () => {
    const res = await harness.get<{ target: string | null }[]>('/cfo/league?from=2026-08-01&to=2026-08-15', {
      token: adminToken,
    });
    // 15 of August's 31 days: 100,000 x 15/31.
    expect(res.body[0]?.target).toBe('48387.10');
  });

  it('the target reaches My CFO as achievement on my own book', async () => {
    const res = await harness.get<MyCfo>('/cfo/me?from=2026-08-01&to=2026-08-31', { token: adminToken });
    expect(res.body.target).toBe('100000.00');
    expect(res.body.achievementPct).toBe(60);
  });

  it('the league itself sits behind the module key', async () => {
    const denied = await harness.get('/cfo/league?from=2026-08-01&to=2026-08-31', { token: employeeToken });
    expect(denied.status).toBe(403);
  });
});

describe('GET /cfo/team/:ownerRef (G4 scorecard)', () => {
  it('scopes the league engine to one book, and the radar reads the team', async () => {
    const res = await harness.get<{
      ownerRef: string;
      row: { sales: string; achievementPct: number | null };
      teamSize: number;
      radar: { axis: string; mine: number | null; team: number | null; note?: string }[];
      bridge: { thisYear: number; lastYear: number; newCustomerEffect: number; reconciliationError: number };
      movement: { cells: { state: string; count: number }[] };
      ageing: Record<string, string>;
      promises: { kept: number; broken: number; open: number };
      activity: { assigned: number; closed: number };
    }>(`/cfo/team/user:${adminUserId}?from=2026-08-01&to=2026-08-31`, { token: adminToken });

    expect(res.status).toBe(200);
    expect(res.body.row.sales).toBe('60000.00');
    expect(res.body.teamSize).toBe(1);
    // The bridge is Asha's alone: her 60,000 this August against nothing
    // last August -- and it still reconciles exactly.
    expect(res.body.bridge.thisYear).toBe(60_000);
    expect(res.body.bridge.lastYear).toBe(0);
    expect(res.body.bridge.reconciliationError).toBe(0);
    // Her movement matrix holds only her: growing (July order, no LY base).
    const populated = res.body.movement.cells.filter((c) => c.count > 0);
    expect(populated.map((c) => c.state)).toEqual(['growing']);
    // Her ageing: 60,000 sits in the 31-60 bucket, 40,000 current.
    expect(res.body.ageing['31-60']).toBe('60000.00');
    expect(res.body.ageing.current).toBe('40000.00');
    // The radar: alone in the team, she is the team's best on every knowable axis.
    const sales = res.body.radar.find((a) => a.axis === 'Sales');
    expect(sales?.mine).toBe(100);
    const margin = res.body.radar.find((a) => a.axis === 'Margin');
    expect(margin?.mine).toBeNull();
    expect(margin?.note).toContain('M1');
    expect(res.body.promises).toEqual({ kept: 0, broken: 0, open: 0 });
    expect(res.body.activity).toEqual({ assigned: 0, closed: 0 });
  });

  it('another person’s scorecard needs cfo.team.view; an unknown book is 404', async () => {
    const other = await harness.get(`/cfo/team/user:${adminUserId}?from=2026-08-01&to=2026-08-31`, {
      token: employeeToken,
    });
    expect(other.status).toBe(403);
    const missing = await harness.get('/cfo/team/HOUSE?from=2026-08-01&to=2026-08-31', { token: adminToken });
    expect(missing.status).toBe(404);
  });
});

describe('the Director’s Desk (Part O)', () => {
  it('collapses the work lists into one ranked list, one name once, loudest reason first', async () => {
    await harness.db.execute(sql`DELETE FROM cfo_desk_served WHERE org_id = ${ORG_ID}`);
    await harness.db.execute(sql`DELETE FROM cfo_desk_outcomes WHERE org_id = ${ORG_ID}`);
    const res = await harness.get<{
      theme: { key: string };
      cap: number;
      qualified: number;
      rows: { rank: number; party: string; primary: { key: string }; others: { key: string }[]; score: number; breakdown: { value: number; urgency: number } }[];
    }>('/cfo/desk?mixed=1&cap=10', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.theme.key).toBe('mixed');
    const names = res.body.rows.map((r) => r.party);
    // Every name once.
    expect(new Set(names).size).toBe(names.length);
    // Asha: 45 days overdue is the loudest of her reasons; Bharat carries
    // the limit breach; Deva the decline.
    const asha = res.body.rows.find((r) => r.party === 'Asha Traders');
    expect(asha?.primary.key).toBe('overdue-31-60');
    const bharat = res.body.rows.find((r) => r.party === 'Bharat Cables');
    expect(bharat?.primary.key).toBe('limit-breach');
    expect(bharat?.others.map((o) => o.key)).toContain('overdue-1-30');
    // Ranks are dense and the score explains itself.
    expect(res.body.rows.map((r) => r.rank)).toEqual(res.body.rows.map((_, i) => i + 1));
    expect(asha?.breakdown.urgency).toBe(15);
  });

  it('an outcome is logged, audited, and cools the name down', async () => {
    const parties = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM parties WHERE org_id = ${ORG_ID} AND name = 'Asha Traders'
    `);
    const ashaId = parties.rows[0]?.id ?? '';
    const bad = await harness.post(`/cfo/desk/${ashaId}/outcome`, { token: adminToken, body: { outcome: 'CALL_AGAIN' } });
    expect(bad.status).toBe(400);
    const ok = await harness.post(`/cfo/desk/${ashaId}/outcome`, {
      token: adminToken,
      body: { outcome: 'NO_RESPONSE', notes: 'Rang twice' },
    });
    expect(ok.status).toBe(201);

    const sheet = await harness.get<{ lastContact: { outcome: string } | null; numbers: { overdue: string; delayCostPerYear: string }; why: { primary: { key: string } | null } }>(
      `/cfo/desk/${ashaId}`,
      { token: adminToken },
    );
    expect(sheet.status).toBe(200);
    expect(sheet.body.lastContact?.outcome).toBe('NO_RESPONSE');
    expect(sheet.body.numbers.overdue).toBe('60000.00');
    expect(sheet.body.numbers.delayCostPerYear).toBe('7200.00');
    expect(sheet.body.why.primary?.key).toBe('overdue-31-60');

    // Served yesterday-or-earlier is a no-repeat; served today is not. Force
    // the cooldown path instead: the fresh NO_RESPONSE takes forty points.
    await harness.db.execute(sql`DELETE FROM cfo_desk_served WHERE org_id = ${ORG_ID}`);
    const again = await harness.get<{ rows: { party: string; breakdown: { cooldown: number } }[] }>('/cfo/desk?mixed=1', { token: adminToken });
    const asha = again.body.rows.find((r) => r.party === 'Asha Traders');
    expect(asha?.breakdown.cooldown).toBe(40);

    const audit = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${ORG_ID} AND action = 'cfo.desk.outcome'
    `);
    expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('the desk sits behind the module key', async () => {
    const denied = await harness.get('/cfo/desk', { token: employeeToken });
    expect(denied.status).toBe(403);
  });
});

describe('GET /cfo/data-quality (Q3)', () => {
  it('admits what is broken, with a null where a check cannot run yet', async () => {
    const res = await harness.get<{
      headline: number | null;
      checks: { key: string; value: number | null; health: number | null; note?: string; drill: string | null }[];
    }>('/cfo/data-quality', { token: adminToken });
    expect(res.status).toBe(200);
    const byKey = new Map(res.body.checks.map((c) => [c.key, c]));
    // Four debtors, none with a phone number: the check names the count.
    expect(byKey.get('parties-no-phone')?.value).toBe(4);
    expect(byKey.get('parties-no-phone')?.health).toBe(0.6);
    // Classes exist now (Part P): the check counts debtors with no current class.
    expect(byKey.get('parties-no-class')?.value).not.toBeNull();
    expect(byKey.get('parties-no-class')?.drill).toBe('/masters/parties');
    // Negative margin still waits for the valuation decision, and says so.
    expect(byKey.get('negative-margin')?.value).toBeNull();
    expect(byKey.get('negative-margin')?.note).toContain('M1');
    // The headline averages only what could be measured.
    expect(res.body.headline).not.toBeNull();
    expect(res.body.checks).toHaveLength(12);
  });

  it('sits behind cfo.exceptions.view', async () => {
    const denied = await harness.get('/cfo/data-quality', { token: employeeToken });
    expect(denied.status).toBe(403);
  });
});

describe('customer classes and the payment grade (Part P, D18)', () => {
  it('seeds the master, assigns with a reason and a date, refuses to rewrite history', async () => {
    await harness.db.execute(sql`DELETE FROM customer_tier_assignments WHERE org_id = ${ORG_ID}`);
    const tiers = await harness.get<{ code: string; assigned: number }[]>('/cfo/tiers', { token: adminToken });
    expect(tiers.status).toBe(200);
    expect(tiers.body.map((t) => t.code)).toEqual(['A+', 'A', 'B', 'C', 'D']);

    const parties = await harness.db.execute<{ id: string }>(sql`SELECT id FROM parties WHERE org_id = ${ORG_ID} AND name = 'Asha Traders'`);
    const ashaId = parties.rows[0]?.id ?? '';
    const noReason = await harness.put(`/cfo/parties/${ashaId}/class`, { token: adminToken, body: { tierCode: 'A+', reason: '', effectiveFrom: '2026-08-01' } });
    expect(noReason.status).toBe(400);
    const first = await harness.put(`/cfo/parties/${ashaId}/class`, { token: adminToken, body: { tierCode: 'B', reason: 'Steady buyer', effectiveFrom: '2026-01-01' } });
    expect(first.status).toBe(200);
    const promoted = await harness.put(`/cfo/parties/${ashaId}/class`, { token: adminToken, body: { tierCode: 'A+', reason: 'Top 15% by revenue', effectiveFrom: '2026-08-01' } });
    expect(promoted.status).toBe(200);
    // Backdating before the current class began is refused: history stands.
    const backdated = await harness.put(`/cfo/parties/${ashaId}/class`, { token: adminToken, body: { tierCode: 'C', reason: 'Oops', effectiveFrom: '2026-07-01' } });
    expect(backdated.status).toBe(400);

    const cls = await harness.get<{ current: { tierCode: string; effectiveFrom: string } | null; history: { tierCode: string; effectiveTo: string | null }[]; grade: { grade: string; risk: number } | null }>(
      `/cfo/parties/${ashaId}/class`,
      { token: adminToken },
    );
    expect(cls.body.current?.tierCode).toBe('A+');
    expect(cls.body.history.map((h) => [h.tierCode, h.effectiveTo])).toEqual([['A+', null], ['B', '2026-07-31']]);
    // Asha: 45 days late on the 60,000 that is overdue (payment history 20 of
    // 40), 60% of her book overdue (ageing 15 of 25), no limit, no broken
    // promises: risk 35, a B. The grade explains itself.
    expect(cls.body.grade?.grade).toBe('B');
    expect(cls.body.grade?.risk).toBe(35);

    // The master will not drop a class with customers in it.
    const blocked = await harness.del('/cfo/tiers/A+', { token: adminToken });
    expect(blocked.status).toBe(409);
  });

  it('the class x grade grid names the A+ / B cell, and counts the unclassed', async () => {
    const grid = await harness.get<{
      classes: string[];
      unclassed: { count: number };
      cells: { tierCode: string; grade: string; count: number; amount: string; parties: { party: string }[] }[];
    }>('/cfo/class-grade', { token: adminToken });
    expect(grid.status).toBe(200);
    const cell = grid.body.cells.find((c) => c.tierCode === 'A+' && c.grade === 'B');
    expect(cell?.count).toBe(1);
    expect(cell?.amount).toBe('100000.00');
    expect(cell?.parties[0]?.party).toBe('Asha Traders');
    // Bharat is on the book but unclassed.
    expect(grid.body.unclassed.count).toBe(1);
  });

  it('assigning needs cfo.tier.assign; the master needs cfo.tier.master', async () => {
    const parties = await harness.db.execute<{ id: string }>(sql`SELECT id FROM parties WHERE org_id = ${ORG_ID} AND name = 'Bharat Cables'`);
    const denied = await harness.put(`/cfo/parties/${parties.rows[0]?.id ?? ''}/class`, { token: employeeToken, body: { tierCode: 'B', reason: 'x', effectiveFrom: '2026-08-01' } });
    expect(denied.status).toBe(403);
    const master = await harness.put('/cfo/tiers', { token: employeeToken, body: { code: 'Z', label: 'Zed', colourToken: 'fresh-1', creditDays: null, creditLimit: null, maxDiscountPct: null, contactEveryDays: null, sortOrder: 9 } });
    expect(master.status).toBe(403);
  });
});

describe('exception reports (F2)', () => {
  it('names the vouchers that look wrong, and a review greys one out', async () => {
    await harness.db.execute(sql`DELETE FROM cfo_exception_reviews WHERE org_id = ${ORG_ID}`);
    const res = await harness.get<{
      open: number;
      checks: { key: string; available: boolean; rows: { voucherId: string; voucherNumber: string; reason: string; review: unknown }[] }[];
    }>('/cfo/exceptions?from=2025-08-01&to=2026-08-31', { token: adminToken });
    expect(res.status).toBe(200);
    const byKey = new Map(res.body.checks.map((c) => [c.key, c]));
    // Chetan's single 30,000 sale a year ago is a one-off above materiality.
    const oneOff = byKey.get('one-off');
    expect(oneOff?.rows.map((r) => r.voucherNumber)).toContain('S-C0');
    // The checks the sync cannot feed say so instead of showing an empty list as clean.
    expect(byKey.get('negative-stock')?.available).toBe(false);
    expect(res.body.open).toBeGreaterThan(0);

    const target = oneOff?.rows[0];
    const noReason = await harness.post('/cfo/exceptions/review', { token: adminToken, body: { checkKey: 'one-off', voucherId: target?.voucherId, state: 'accepted', reason: '' } });
    expect(noReason.status).toBe(400);
    const ok = await harness.post('/cfo/exceptions/review', { token: adminToken, body: { checkKey: 'one-off', voucherId: target?.voucherId, state: 'accepted', reason: 'Project sale, known' } });
    expect(ok.status).toBe(201);
    const again = await harness.get<{ open: number; checks: { key: string; rows: { voucherId: string; review: { state: string } | null }[] }[] }>('/cfo/exceptions?from=2025-08-01&to=2026-08-31', { token: adminToken });
    const reviewed = again.body.checks.find((c) => c.key === 'one-off')?.rows.find((r) => r.voucherId === target?.voucherId);
    expect(reviewed?.review?.state).toBe('accepted');
    expect(again.body.open).toBe(res.body.open - 1);
  });

  it('sits behind cfo.exceptions.view', async () => {
    const denied = await harness.get('/cfo/exceptions?from=2026-08-01&to=2026-08-31', { token: employeeToken });
    expect(denied.status).toBe(403);
  });
});

describe('the week close (O5.3)', () => {
  it('counts called against planned and what rolls over', async () => {
    // Today's desk served Asha and Bharat earlier in this file; Asha has an
    // outcome, Bharat does not.
    const today = new Date().toISOString().slice(0, 10);
    const monday = (() => {
      const d = new Date(Date.parse(today));
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const res = await harness.get<{
      planned: number;
      called: number;
      rollovers: { party: string }[];
      byOwner: { ownerLabel: string; planned: number; called: number }[];
      outcomes: { outcome: string; count: number }[];
    }>(`/cfo/desk/week-close?week=${monday}`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.planned).toBeGreaterThanOrEqual(1);
    expect(res.body.called).toBeGreaterThanOrEqual(1);
    expect(res.body.rollovers.map((r) => r.party)).not.toContain('Asha Traders');
    expect(res.body.outcomes.map((o) => o.outcome)).toContain('NO_RESPONSE');
    expect(res.body.byOwner.reduce((n, o) => n + o.planned, 0)).toBe(res.body.planned);

    const bad = await harness.get('/cfo/desk/week-close?week=not-a-date', { token: adminToken });
    expect(bad.status).toBe(400);
  });
});

describe('GET /cfo/export (R6, O6)', () => {
  it('returns a workbook of what the screen shows, and logs the export', async () => {
    const res = await harness.getRaw('/cfo/export?report=league&from=2026-08-01&to=2026-08-31', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(res.headers.get('content-disposition')).toContain('League-table-2026-08-01-to-2026-08-31.xlsx');
    // A zip container: PK.
    expect(res.body.subarray(0, 2).toString()).toBe('PK');
    const audit = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${ORG_ID} AND action = 'cfo.export'
    `);
    expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('needs cfo.export, and a viewer cannot export past their own keys', async () => {
    const denied = await harness.getRaw('/cfo/export?report=league&from=2026-08-01&to=2026-08-31', { token: employeeToken });
    expect(denied.status).toBe(403);
    const unknown = await harness.getRaw('/cfo/export?report=ledger&from=2026-08-01&to=2026-08-31', { token: adminToken });
    expect(unknown.status).toBe(400);
  });
});
