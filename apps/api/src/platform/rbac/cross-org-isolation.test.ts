import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SYSTEM_ROLES } from '@vyuha/shared';

import { runSeed } from '../../../seed/seed.js';
import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { hashPassword } from '../auth/password.js';

/**
 * P-25: every route, walked as somebody else's administrator.
 *
 * Twelve files asserted isolation for a handful of endpoints, chosen by
 * whoever wrote them. That is coverage by memory, and the review that raised
 * this said the quiet part: no leak was found because nothing was looking.
 * There are 350 routes.
 *
 * So this walks the router itself. For every GET route shaped `/prefix/:id`
 * whose `/prefix` is also a GET route, it asks the first organisation's list
 * for a real id, then asks the second organisation's administrator for that
 * exact row. An administrator is used deliberately: they hold every permission
 * there is, so a refusal can only be about the organisation, never about the
 * key. Anything but a refusal is a row crossing a tenant boundary.
 *
 * The second organisation is built directly against the first harness's
 * database and signs in through the same server. It used to get a harness of
 * its own, which meant a second Nest app -- and a second set of BullMQ workers
 * competing for the shared queues for as long as this file ran. That made
 * other files fail at random: punch approvals, a discount inbox, a retention
 * sweep, a timing test, a different one each run. One app, one worker set.
 *
 * What it cannot reach is counted and named at the end rather than passed over
 * in silence: a route whose list needs filters answers 400 and yields no id,
 * and a route with two path parameters cannot be filled from one list.
 */

const ORG_A = '01900000-0000-7000-8000-00000000f0d6';
const ORG_B = '01900000-0000-7000-8000-00000000f0d7';

/** Statuses that are a refusal rather than a leak. */
const REFUSALS = [400, 401, 403, 404, 410];

/**
 * Routes whose id is not an organisation's to own. Each needs a reason, and
 * the reason has to be about the route rather than about the test.
 */
const NOT_TENANT_OWNED = new Set([
  // A signed object key, not a row: the signature carries the authority and
  // `file.service.ts` checks the organisation behind it. Covered by
  // file.service.test.ts.
  '/files/raw/:bucket',
]);

interface Route {
  readonly method: string;
  readonly path: string;
}

let a: ApiHarness;
let tokenA = '';
let tokenB = '';
let routes: Route[] = [];

function routeTable(harness: ApiHarness): Route[] {
  const app = (harness as unknown as { app: { getHttpAdapter(): { getInstance(): Record<string, unknown> } } }).app;
  const instance = app.getHttpAdapter().getInstance();
  const router = (instance.router ?? instance._router) as
    | { stack?: { route?: { path: string; methods: Record<string, boolean> } }[] }
    | undefined;
  return (router?.stack ?? [])
    .flatMap((layer) => (layer.route === undefined ? [] : [layer.route]))
    .flatMap((route) => Object.keys(route.methods).map((method) => ({ method, path: route.path })));
}

beforeAll(async () => {
  a = await ApiHarness.start(ORG_A, 'Isolation Org A');

  const roleA = await a.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const adminA = await a.createUser({ email: scopedEmail('iso-a-admin'), roleIds: [roleA] });
  tokenA = (await a.login(adminA.email, adminA.password)).token;

  // The second organisation, written straight into the same database: an
  // administrator of it, holding every permission the catalogue defines, who
  // signs in through the same server. Nothing about the request that follows
  // is unusual -- only the tenant.
  const emailB = scopedEmail('iso-b-admin');
  const passwordB = 'fixture-passphrase-2026';
  await a.db.execute(sql`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE org_id = ${ORG_B})`);
  await a.db.execute(sql`DELETE FROM users WHERE org_id = ${ORG_B}`);
  await a.db.execute(sql`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE org_id = ${ORG_B})`);
  await a.db.execute(sql`DELETE FROM roles WHERE org_id = ${ORG_B}`);
  await a.db.execute(sql`
    INSERT INTO organizations (id, name) VALUES (${ORG_B}, 'Isolation Org B')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL
  `);
  const roleB = await a.db.execute<{ id: string }>(sql`
    INSERT INTO roles (org_id, name, is_system) VALUES (${ORG_B}, ${SYSTEM_ROLES.ADMIN}, true) RETURNING id
  `);
  const roleBId = roleB.rows[0]?.id ?? '';
  await a.db.execute(sql`
    INSERT INTO role_permissions (role_id, permission_id) SELECT ${roleBId}, id FROM permissions
  `);
  const userB = await a.db.execute<{ id: string }>(sql`
    INSERT INTO users (org_id, email, password_hash, status, password_changed_at)
    VALUES (${ORG_B}, ${emailB}, ${await hashPassword(passwordB)}, 'ACTIVE', now() - interval '1 minute')
    RETURNING id
  `);
  await a.db.execute(sql`INSERT INTO user_roles (user_id, role_id) VALUES (${userB.rows[0]?.id ?? ''}, ${roleBId})`);
  tokenB = (await a.login(emailB, passwordB)).token;

  // The real seed, so the fixture is the product's own master data rather
  // than a hand-written imitation that drifts: departments, designations,
  // locations, shifts, holiday calendars, leave types, weekly-off patterns
  // and people. Without rows in the first organisation there is nothing for
  // the second to be refused.
  // Without leave types the accrual job has nothing to post, so this org's
  // example people stay deletable and the fixture can reset between runs.
  await runSeed(a.db, { orgId: ORG_A, orgName: 'Isolation Org A', adminEmail: scopedEmail('iso-a-seed'), examplePeople: true, leaveTypes: false });

  // The Tally-side projections have no create endpoint by design (REQ-R-04),
  // so the few rows the masters routes read are written directly. Cleared
  // first: `resetOrganisation` leaves the projection tables alone, and a
  // second run would collide on the connection's unique name.
  await a.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_A}`);
  await a.db.execute(sql`DELETE FROM bill_allocations WHERE org_id = ${ORG_A}`);
  await a.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_A}`);
  await a.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_A}`);
  await a.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_A}`);
  await a.db.execute(sql`DELETE FROM integration_connections WHERE org_id = ${ORG_A}`);
  const connection = await a.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_A}, 'TALLY', 'Isolation Co', 'guid-isolation-a') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const party = await a.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_limit)
    VALUES (${ORG_A}, ${connectionId}, 'Isolation Traders', 'Sundry Debtors', 50000) RETURNING id
  `);
  const partyId = party.rows[0]?.id ?? '';
  const item = await a.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, parent_group, unit, gst_rate, closing_qty, cost_price)
    VALUES (${ORG_A}, ${connectionId}, 'Isolation Cable', 'Cables', 'NOS', '18.00', 10, 100) RETURNING id
  `);
  const itemId = item.rows[0]?.id ?? '';
  const voucher = await a.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, is_cancelled, amount)
    VALUES (${ORG_A}, ${connectionId}, CURRENT_DATE, 'Sales', 'ISO-1', 'Isolation Traders', ${partyId}, false, '1000.00') RETURNING id
  `);
  await a.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount)
    VALUES (${ORG_A}, ${voucher.rows[0]?.id ?? ''}, 1, 'ledger', 'Isolation Traders', true, '1000.00')
  `);

  // And a document of each kind the sales module hands out by id.
  const estimate = await a.post<{ id: string }>('/sales/estimates', {
    token: tokenA,
    body: { partyId, lines: [{ stockItemId: itemId, quantity: '2', rate: '500' }] },
  });
  const order = await a.post<{ id: string; lines: { id: string }[] }>('/sales/orders', {
    token: tokenA,
    body: { partyId, lines: [{ stockItemId: itemId, quantity: '2', rate: '500' }] },
  });
  expect([estimate.status, order.status]).toEqual([201, 201]);

  // The rest of the fixture is best effort. Every row it manages to create
  // puts one more route within reach of the sweep, and every one it cannot is
  // reported by the sweep as a route with nothing to borrow -- so a body that
  // goes stale costs coverage and says so, rather than failing a test about
  // isolation for a reason that has nothing to do with isolation.
  const orderId = order.body.id;
  const lineId = order.body.lines[0]?.id ?? '';
  await a.post(`/sales/orders/${orderId}/confirm`, { token: tokenA });
  await a.post(`/sales/orders/${orderId}/picks`, { token: tokenA, body: { lines: [{ lineId, quantity: '2' }] } });
  await a.post(`/sales/orders/${orderId}/packs`, { token: tokenA, body: { lines: [{ lineId, quantity: '2' }] } });
  await a.post(`/sales/orders/${orderId}/invoices`, { token: tokenA, body: {} });

  const company = await a.post<{ id: string }>('/crm/companies', { token: tokenA, body: { name: 'Isolation Trading Co' } });
  await a.post('/crm/contacts', { token: tokenA, body: { name: 'Isolation Contact', companyId: company.body.id } });
  await a.post('/crm/deals', { token: tokenA, body: { name: 'Isolation deal' } });
  await a.post('/tasks', { token: tokenA, body: { title: 'Isolation task', dueDate: '2026-08-01', priority: 'HIGH' } });
  await a.post('/leave/types', { token: tokenA, body: { name: 'Isolation Leave', code: 'ISOL' } });
  await a.post('/collections/promises', {
    token: tokenA,
    body: { partyId, amount: '1000', promisedDate: '2099-01-01', takenOn: '2026-08-01' },
  });

  routes = routeTable(a);
}, 180_000);

afterAll(async () => {
  await a.close();
});

describe('every route, as the wrong organisation (P-25)', () => {
  it('has a router to walk at all', () => {
    // If this ever reads zero the sweep below passes vacuously, which is the
    // way a test like this fails without anyone noticing.
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.filter((r) => r.method === 'get').length).toBeGreaterThan(100);
  });

  it('never serves one organisation a row belonging to another', async () => {
    const gets = routes.filter((route) => route.method === 'get');
    const paths = new Set(gets.map((route) => route.path));

    const leaks: string[] = [];
    const errors: string[] = [];
    const skippedNoList: string[] = [];
    const skippedNoRow: string[] = [];
    const skippedManyParams: string[] = [];
    let checked = 0;

    for (const route of gets) {
      const parts = route.path.split('/');
      const firstParam = parts.findIndex((part) => part.startsWith(':') || part.startsWith('*'));
      if (firstParam === -1) continue;
      const listPath = parts.slice(0, firstParam).join('/');
      if (NOT_TENANT_OWNED.has(listPath.replace('/api/v1', '') + '/' + parts[firstParam])) continue;
      if (parts.slice(firstParam + 1).some((part) => part.startsWith(':') || part.startsWith('*'))) {
        skippedManyParams.push(route.path);
        continue;
      }
      if (!paths.has(listPath)) {
        skippedNoList.push(route.path);
        continue;
      }

      const list = await a.get<unknown>(listPath.replace('/api/v1', ''), { token: tokenA });
      if (list.status !== 200) {
        skippedNoRow.push(`${route.path} (list ${String(list.status)})`);
        continue;
      }
      const body = list.body as { data?: { id?: string }[] } | { id?: string }[];
      const rows = Array.isArray(body) ? body : (body.data ?? []);
      const id = rows[0]?.id;
      if (typeof id !== 'string' || id === '') {
        skippedNoRow.push(`${route.path} (list empty)`);
        continue;
      }

      // Org A's row, asked for by org B's administrator, against org A's own
      // server. Nothing about this request is malformed -- only the tenant.
      const target = route.path.replace('/api/v1', '').replace(parts[firstParam] ?? '', id);
      const answer = await a.get<unknown>(target, { token: tokenB });
      checked += 1;
      if (answer.status === 200) leaks.push(`${target} answered 200 for the other organisation`);
      else if (!REFUSALS.includes(answer.status)) errors.push(`${target} answered ${String(answer.status)}`);
    }

    // Named, not merely counted: a sweep that quietly checked nine routes and
    // reported success would be worse than no sweep.
    const summary = [
      `checked ${String(checked)}`,
      `no list route ${String(skippedNoList.length)}`,
      `no row to borrow ${String(skippedNoRow.length)}`,
      `two path parameters ${String(skippedManyParams.length)}`,
    ].join(', ');

    // Reported on every run, not only on failure: a sweep that quietly
    // reached nine routes and passed would be worse than no sweep at all.
    console.log(`[cross-org isolation] ${summary}`);
    expect(checked, `the sweep reached almost nothing -- ${summary}`).toBeGreaterThan(25);
    expect(leaks, `cross-organisation reads (${summary})`).toEqual([]);
    expect(errors, `routes that failed rather than refused (${summary})`).toEqual([]);
  }, 300_000);

  it('refuses the routes the sweep cannot reach because they have no list', async () => {
    // A route with no list route of its own is invisible to the sweep, so the
    // few that take an id another organisation owns are named here. The
    // party's bills and reminder history are the ones that matter: they are
    // read by party id alone, and an audit lead claimed they carry no scope.
    const parties = await a.db.execute<{ id: string }>(sql`SELECT id FROM parties WHERE org_id = ${ORG_A} LIMIT 1`);
    const partyId = parties.rows[0]?.id ?? '';
    expect(partyId).not.toBe('');

    for (const path of [`/collections/parties/${partyId}/bills`, `/collections/parties/${partyId}/reminders`]) {
      const answer = await a.get<unknown>(path, { token: tokenB });
      // These two are collection-shaped, so 200 with nothing in it is the
      // correct answer for a party the caller's organisation does not have --
      // the leak would be rows, not a status.
      const body = answer.body as { data?: unknown[] } | unknown[] | null;
      const rows = Array.isArray(body) ? body : (body?.data ?? []);
      expect(rows, `${path} handed the other organisation ${String(rows.length)} rows`).toEqual([]);
    }
  });

  it('refuses a second organisation even when the row does not exist', async () => {
    // The other half of an IDOR check: a 404 for a real id must be the same
    // 404 as for an invented one, or the difference is itself an oracle.
    const invented = '01900000-0000-7000-8000-0000000f0000';
    const parties = await a.db.execute<{ id: string }>(
      sql`SELECT id FROM parties WHERE org_id = ${ORG_A} LIMIT 1`,
    );
    const real = parties.rows[0]?.id;
    if (real === undefined) return;
    const forReal = await a.get(`/masters/parties/${real}`, { token: tokenB });
    const forInvented = await a.get(`/masters/parties/${invented}`, { token: tokenB });
    expect(forReal.status).toBe(forInvented.status);
  });
});
