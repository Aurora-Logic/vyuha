import { SYSTEM_ROLES, type Paginated, type PriceListDetail, type PriceListDiff, type PriceListSummary, type RateSimulation } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Area AN's acceptance (docs/15), over real HTTP: a party on a 12% list
 * gets 12% off and the line says which list and version; an active list
 * refuses an edit at the API; a new version leaves every existing
 * document alone; a superseded version still resolves for its own dates;
 * overlapping slabs are refused with the lines named; a rate below the
 * floor needs a reason and goes to the inbox.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0cf';

let harness: ApiHarness;
let adminToken = '';
let managerToken = '';
let salesToken = '';
let employeeToken = '';
let partyId = '';
let itemId = '';

interface ErrorBody {
  error: { code: string; message: string; details?: { fields?: { path: string; message: string }[] } };
}
interface DocumentView {
  id: string;
  number: string;
  status: string;
  lines: { id: string; rate: string; resolvedRate: string | null; priceListId: string | null; priceListVersion: number | null; appliedDiscountPct: string | null; amount: string }[];
}

function draft(discountPct: string, over: Record<string, unknown> = {}) {
  return { name: 'Asha terms', effectiveFrom: '2026-04-01', lines: [{ stockItemId: itemId, basis: 'discount_pct', discountPct }], assignments: [{ partyId }], ...over };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Pricing Org');
  await harness.db.execute(sql`DELETE FROM price_list_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM price_list_assignments WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM price_lists WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const managerRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES_MANAGER, { isSystem: true });
  const salesRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('pricing-admin'), roleIds: [adminRoleId] });
  const manager = await harness.createUser({ email: scopedEmail('pricing-manager'), roleIds: [managerRoleId] });
  // A document's owner is an employee (the sales scope reads owner_id against the person's employee), so the salesperson needs one.
  const seller = await harness.createEmployee({ code: 'PR-001', firstName: 'Priya', lastName: 'Sales' });
  const sales = await harness.createUser({ email: scopedEmail('pricing-sales'), roleIds: [salesRoleId], employeeId: seller });
  const employee = await harness.createUser({ email: scopedEmail('pricing-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  managerToken = (await harness.login(manager.email, manager.password)).token;
  salesToken = (await harness.login(sales.email, sales.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Pricing Co', 'guid-pricing-co') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate, sale_price) VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00', 4000) RETURNING id
  `);
  itemId = item.rows[0]?.id ?? '';
});

afterAll(async () => {
  await harness.close();
});

describe('Area AN: price lists', () => {
  let listId = '';
  let firstEstimateId = '';

  it('refuses overlapping quantity slabs at save, naming the lines', async () => {
    const res = await harness.post<ErrorBody>('/pricing/lists', {
      token: managerToken,
      body: draft('10', {
        lines: [
          { stockItemId: itemId, basis: 'rate', rate: '3900', minQty: '0', maxQty: '10' },
          { stockItemId: itemId, basis: 'rate', rate: '3700', minQty: '5', maxQty: '20' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('lines 1 and 2');
    const refused = await harness.post<ErrorBody>('/pricing/lists', { token: employeeToken, body: draft('10') });
    expect(refused.status).toBe(403);
  });

  it('a draft goes to the inbox for pricing.approve and comes back active', async () => {
    const created = await harness.post<PriceListDetail>('/pricing/lists', { token: managerToken, body: draft('12') });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('draft');
    listId = created.body.id;

    const submitted = await harness.post<PriceListDetail>(`/pricing/lists/${listId}/submit`, { token: managerToken });
    expect(submitted.status).toBe(200);
    expect(submitted.body.state).toBe('pending_approval');
    expect(submitted.body.approvalRequestId).not.toBeNull();

    const approved = await harness.post<unknown>(`/approvals/${submitted.body.approvalRequestId ?? ''}/approve`, { token: adminToken, body: {} });
    expect([200, 201]).toContain(approved.status);
    const active = await harness.get<PriceListDetail>(`/pricing/lists/${listId}`, { token: managerToken });
    expect(active.body.state).toBe('active');
    expect(active.body.approvedByName).not.toBeNull();
  });

  it('a party on the 12% list gets 12% off a new estimate, and the line says which list and version', async () => {
    const res = await harness.post<DocumentView>('/sales/estimates', { token: salesToken, body: { partyId, lines: [{ stockItemId: itemId, quantity: '2' }] } });
    expect(res.status).toBe(201);
    const line = res.body.lines[0];
    expect(line?.rate).toBe('3520.00');
    expect(line?.resolvedRate).toBe('3520.00');
    expect(line?.priceListId).toBe(listId);
    expect(line?.priceListVersion).toBe(1);
    expect(line?.appliedDiscountPct).toBe('12.00');
    expect(line?.amount).toBe('7040.00');
    firstEstimateId = res.body.id;

    const simulated = await harness.get<RateSimulation>(`/pricing/simulate?partyId=${partyId}&stockItemId=${itemId}&quantity=1`, { token: salesToken });
    expect(simulated.status).toBe(200);
    expect(simulated.body.rate).toBe('3520.00');
    expect(simulated.body.source).toBe('party');
    expect(simulated.body.explanation).toContain('12% off the Tally rate of 4000.00');
  });

  it('an active list cannot be edited; a new version supersedes it and leaves the old estimate alone', async () => {
    const edit = await harness.put<ErrorBody>(`/pricing/lists/${listId}`, { token: managerToken, body: draft('20') });
    expect(edit.status).toBe(409);

    const version = await harness.post<PriceListDetail>(`/pricing/lists/${listId}/versions`, { token: managerToken });
    expect(version.status).toBe(201);
    expect(version.body.version).toBe(2);
    expect(version.body.supersedesId).toBe(listId);
    const v2 = version.body.id;
    const edited = await harness.put<PriceListDetail>(`/pricing/lists/${v2}`, { token: managerToken, body: draft('20') });
    expect(edited.status).toBe(200);

    const diff = await harness.get<PriceListDiff>(`/pricing/lists/${v2}/diff`, { token: adminToken });
    expect(diff.body.against).toEqual({ id: listId, version: 1 });
    expect(diff.body.changed).toHaveLength(1);
    expect(diff.body.changed[0]?.before.discountPct).toBe('12.00');
    expect(diff.body.changed[0]?.after.discountPct).toBe('20.00');
    expect(diff.body.partiesAffected.map((p) => p.name)).toContain('Asha Traders');

    // The key holder activates directly; the old version ends at the same instant.
    const activated = await harness.post<PriceListDetail>(`/pricing/lists/${v2}/submit`, { token: adminToken });
    expect(activated.body.state).toBe('active');
    const old = await harness.get<PriceListDetail>(`/pricing/lists/${listId}`, { token: managerToken });
    expect(old.body.state).toBe('superseded');
    expect(old.body.supersededAt).not.toBeNull();

    const untouched = await harness.get<DocumentView>(`/sales/estimates/${firstEstimateId}`, { token: salesToken });
    expect(untouched.body.lines[0]?.rate, JSON.stringify({ status: untouched.status, body: untouched.body }).slice(0, 400)).toBe('3520.00');
    expect(untouched.body.lines[0]?.priceListVersion).toBe(1);

    const fresh = await harness.post<DocumentView>('/sales/estimates', { token: salesToken, body: { partyId, lines: [{ stockItemId: itemId, quantity: '1' }] } });
    expect(fresh.body.lines[0]?.rate).toBe('3200.00');
    expect(fresh.body.lines[0]?.priceListVersion).toBe(2);

    // A date from the old version's reign still resolves against it (REQ-AN-07).
    const then = await harness.get<RateSimulation>(`/pricing/simulate?partyId=${partyId}&stockItemId=${itemId}&date=2026-05-01`, { token: salesToken });
    expect(then.body.rate).toBe('3520.00');
    expect(then.body.priceListVersion).toBe(1);
  });

  it('a version that starts in the future does not leave the lineage bare until it does', async () => {
    // v2 is active from 2026-04-01 at 20% off. v3 is drafted to start next year
    // and approved today: until it starts, v2 must still be the list in force.
    const active = await harness.get<Paginated<PriceListSummary>>('/pricing/lists?state=active&page=1&pageSize=10', { token: managerToken });
    const current = active.body.data.find((l) => l.name === 'Asha terms');
    expect(current?.version).toBe(2);
    const v3 = await harness.post<PriceListDetail>(`/pricing/lists/${current?.id ?? ''}/versions`, { token: managerToken });
    expect(v3.status).toBe(201);
    await harness.put<PriceListDetail>(`/pricing/lists/${v3.body.id}`, { token: managerToken, body: draft('30', { effectiveFrom: '2027-01-01' }) });
    const activated = await harness.post<PriceListDetail>(`/pricing/lists/${v3.body.id}/submit`, { token: adminToken });
    expect(activated.body.state).toBe('active');

    const today = await harness.get<RateSimulation>(`/pricing/simulate?partyId=${partyId}&stockItemId=${itemId}`, { token: salesToken });
    expect(today.body.rate, JSON.stringify(today.body.considered)).toBe('3200.00');
    expect(today.body.priceListVersion).toBe(2);
    const later = await harness.get<RateSimulation>(`/pricing/simulate?partyId=${partyId}&stockItemId=${itemId}&date=2027-01-05`, { token: salesToken });
    expect(later.body.rate).toBe('2800.00');
    expect(later.body.priceListVersion).toBe(3);
  });

  it('the floor reads what the line actually charges, not the rate above its discount', async () => {
    // The list resolves 3200; 4000 less 90% works out at 400, and reading only
    // the typed rate let exactly this through.
    const dressed = await harness.post<DocumentView>('/sales/orders', { token: salesToken, body: { partyId, lines: [{ stockItemId: itemId, quantity: '1', rate: '4000', discountPct: '90' }] } });
    expect(dressed.status).toBe(201);
    const refused = await harness.post<ErrorBody>(`/sales/orders/${dressed.body.id}/confirm`, { token: salesToken });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('works out at 400.00');
  });

  it('a rate below the floor needs a reason, and then waits in the inbox', async () => {
    const silent = await harness.post<DocumentView>('/sales/orders', { token: salesToken, body: { partyId, lines: [{ stockItemId: itemId, quantity: '1', rate: '3000' }] } });
    expect(silent.status).toBe(201);
    const refused = await harness.post<ErrorBody>(`/sales/orders/${silent.body.id}/confirm`, { token: salesToken });
    expect(refused.status, JSON.stringify(refused.body).slice(0, 400)).toBe(400);
    expect(refused.body.error.message).toContain('floor of 3200.00');

    const explained = await harness.post<DocumentView>('/sales/orders', {
      token: salesToken,
      body: { partyId, lines: [{ stockItemId: itemId, quantity: '1', rate: '3000', rateOverrideReason: 'Matching a competitor quote' }] },
    });
    const routed = await harness.post<DocumentView>(`/sales/orders/${explained.body.id}/confirm`, { token: salesToken });
    expect(routed.status).toBe(200);
    expect(routed.body.status).toBe('PENDING_APPROVAL');
  });
});

describe('a list whose season has passed (audit 26)', () => {
  /**
   * `expired` is declared in the contract and offered as a filter, and no
   * code path ever wrote it. A list past its effective-to date went on
   * reading `active`: the register showed it as in force, the filter for
   * expired lists returned nothing for ever, and the only clue was the date
   * printed beside it.
   */
  it('reads as expired once its effective-to date has passed', async () => {
    const created = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO price_lists (org_id, name, version, state, effective_from, effective_to)
      VALUES (${ORG_ID}, 'Diwali 2025', 1, 'active', '2025-10-01', '2025-11-15')
      RETURNING id
    `);
    const id = created.rows[0]?.id ?? '';

    const detail = await harness.get<{ state: string; name: string }>(`/pricing/lists/${id}`, { token: adminToken });
    expect(detail.status).toBe(200);
    expect(detail.body.state).toBe('expired');

    // The filter finds it, which it never could before.
    const expired = await harness.get<{ data: { id: string; state: string }[] }>('/pricing/lists?state=expired&pageSize=100', { token: adminToken });
    expect(expired.body.data.some((row) => row.id === id)).toBe(true);
    expect(expired.body.data.every((row) => row.state === 'expired')).toBe(true);

    // And it is no longer counted among the active ones.
    const active = await harness.get<{ data: { id: string }[] }>('/pricing/lists?state=active&pageSize=100', { token: adminToken });
    expect(active.body.data.some((row) => row.id === id)).toBe(false);

    // Carrying last season forward is the whole reason the lineage exists.
    const next = await harness.post<{ id: string; version: number; state: string }>(`/pricing/lists/${id}/versions`, { token: adminToken });
    expect(next.status, next.text).toBe(201);
    expect(next.body.version).toBe(2);
    expect(next.body.state).toBe('draft');

    await harness.db.execute(sql`DELETE FROM price_lists WHERE org_id = ${ORG_ID} AND name = 'Diwali 2025'`);
  });

  it('leaves a list with no end date alone', async () => {
    const created = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO price_lists (org_id, name, version, state, effective_from, effective_to)
      VALUES (${ORG_ID}, 'Standing List', 1, 'active', '2025-01-01', NULL)
      RETURNING id
    `);
    const id = created.rows[0]?.id ?? '';
    const detail = await harness.get<{ state: string }>(`/pricing/lists/${id}`, { token: adminToken });
    expect(detail.body.state).toBe('active');
    await harness.db.execute(sql`DELETE FROM price_lists WHERE id = ${id}`);
  });
});
