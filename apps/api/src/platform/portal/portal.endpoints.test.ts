import { SYSTEM_ROLES, type IssuedPortalKey, type PortalKeyView, type PortalView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Area AL over real HTTP: the key is the credential, it names one party,
 * and a withdrawal takes effect now rather than at the next expiry.
 *
 * The refusals are the point of most of this file. Every way a key can
 * fail — unknown, expired, withdrawn, one character short — has to answer
 * the same 404, or the portal becomes an oracle that tells a stranger
 * which keys are real.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d4';

let harness: ApiHarness;
let adminToken = '';
let accountsToken = '';
let salesToken = '';
let ashaId = '';
let beharId = '';
let orderNumber = '';

interface ErrorBody {
  error: { code: string; message: string };
}
interface OrderView {
  id: string;
  number: string;
  lines: { id: string }[];
}

/** The portal is public, so its requests carry no token at all. */
async function portalGet<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${harness.baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Portal Org');
  await harness.db.execute(sql`DELETE FROM portal_access_log WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM portal_link_keys WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const accountsRoleId = await harness.createSystemRole(SYSTEM_ROLES.ACCOUNTS, { isSystem: true });
  const salesRoleId = await harness.createSystemRole(SYSTEM_ROLES.SALES, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('portal-admin'), roleIds: [adminRoleId] });
  const accounts = await harness.createUser({ email: scopedEmail('portal-accounts'), roleIds: [accountsRoleId] });
  const sales = await harness.createUser({ email: scopedEmail('portal-sales'), roleIds: [salesRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  accountsToken = (await harness.login(accounts.email, accounts.password)).token;
  salesToken = (await harness.login(sales.email, sales.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Portal Co', 'guid-portal-endpoints') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';
  const asha = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors') RETURNING id
  `);
  ashaId = asha.rows[0]?.id ?? '';
  const behar = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, 'Behar Supply Co', 'Sundry Debtors') RETURNING id
  `);
  beharId = behar.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate) VALUES (${ORG_ID}, ${connectionId}, 'Cat6 cable 305m', 'BOX', 'Cables', '18.00') RETURNING id
  `);
  const order = await harness.post<OrderView>('/sales/orders', {
    token: adminToken,
    body: { partyId: ashaId, lines: [{ stockItemId: item.rows[0]?.id ?? '', quantity: '6', rate: '4000' }] },
  });
  orderNumber = order.body.number;
  await harness.post(`/sales/orders/${order.body.id}/confirm`, { token: adminToken });
  // A bill and a receipt, so the statement has both sides.
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 1, '2026-08-02', 'Sales', 'INV-9001', 'Asha Traders', ${ashaId}, '', false, 24000, now())
  `);
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 2, '2026-08-12', 'Receipt', 'RCT-9001', 'Asha Traders', ${ashaId}, '', false, 9000, now())
  `);
  // The other party's bill, which must never show on Asha's portal.
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, 3, '2026-08-03', 'Sales', 'INV-BEHAR', 'Behar Supply Co', ${beharId}, '', false, 77000, now())
  `);
});

afterAll(async () => {
  await harness.close();
});

describe('Area AL: the customer portal', () => {
  let key = '';
  let keyId = '';

  it('is issued once, in the clear, and never readable again (REQ-AL-03)', async () => {
    const refused = await harness.post<ErrorBody>('/portal-links', { token: salesToken, body: { partyId: ashaId } });
    expect(refused.status).toBe(403);

    const issued = await harness.post<IssuedPortalKey>('/portal-links', { token: accountsToken, body: { partyId: ashaId, note: 'Sent on WhatsApp' } });
    expect(issued.status).toBe(201);
    key = issued.body.key;
    keyId = issued.body.id;
    expect(key.length).toBeGreaterThanOrEqual(40);
    expect(issued.body.url).toContain(`/portal/${key}`);
    expect(issued.body.state).toBe('active');
    // D-53: ninety days.
    const days = Math.round((new Date(issued.body.expiresAt).getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(90);

    const listed = await harness.get<PortalKeyView[]>('/portal-links', { token: accountsToken });
    expect(listed.status).toBe(200);
    const row = listed.body.find((k) => k.id === keyId);
    expect(row).toBeDefined();
    // The list is not a key.
    expect(JSON.stringify(listed.body)).not.toContain(key);
  });

  it('is stored as a hash and not as itself', async () => {
    const rows = await harness.db.execute<{ key_hash: string }>(sql`SELECT key_hash FROM portal_link_keys WHERE id = ${keyId}`);
    expect(rows.rows[0]?.key_hash).not.toBe(key);
    expect(rows.rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('opens the customer’s own orders, dispatches, invoices and statement, with no token at all (REQ-AL-01)', async () => {
    const view = await portalGet<PortalView>(`/portal/${key}`);
    expect(view.status).toBe(200);
    expect(view.body.partyName).toBe('Asha Traders');
    expect(view.body.orders.map((o) => o.number)).toContain(orderNumber);
    expect(view.body.invoices.map((i) => i.voucherNumber)).toEqual(['INV-9001']);
    // 24,000 billed less 9,000 received, and not a rupee of Behar's 77,000.
    expect(Number(view.body.outstanding)).toBe(15000);
    expect(JSON.stringify(view.body)).not.toContain('Behar');
    expect(JSON.stringify(view.body)).not.toContain('77000');
  });

  it('records every view — key, party, what was viewed, from where (REQ-AL-06)', async () => {
    const rows = await harness.db.execute<{ view: string; outcome: string; party_id: string; ip: string | null }>(sql`
      SELECT view, outcome, party_id, ip FROM portal_access_log WHERE org_id = ${ORG_ID} AND link_key_id = ${keyId} ORDER BY at DESC LIMIT 1
    `);
    expect(rows.rows[0]?.view).toBe('portal');
    expect(rows.rows[0]?.outcome).toBe('served');
    expect(rows.rows[0]?.party_id).toBe(ashaId);
    expect(rows.rows[0]?.ip).not.toBeNull();
    const counted = await harness.db.execute<{ view_count: number; last_used_at: Date | string | null }>(sql`
      SELECT view_count, last_used_at FROM portal_link_keys WHERE id = ${keyId}
    `);
    expect(Number(counted.rows[0]?.view_count ?? 0)).toBeGreaterThan(0);
    expect(counted.rows[0]?.last_used_at).not.toBeNull();
  });

  it('answers every bad key the same way, and says nothing about which was wrong (REQ-AL-03)', async () => {
    const unknown = await portalGet<ErrorBody>('/portal/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(unknown.status).toBe(404);
    const short = await portalGet<ErrorBody>('/portal/abc');
    expect(short.status).toBe(404);
    // One character off the real key.
    const nearly = await portalGet<ErrorBody>(`/portal/${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`);
    expect(nearly.status).toBe(404);
    expect(nearly.body.error.message).toBe(unknown.body.error.message);
  });

  it('serves a photograph only through a short-lived link, and never another party’s (REQ-AL-08)', async () => {
    const stranger = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO files (org_id, purpose, storage_key, mime, bytes, checksum)
      VALUES (${ORG_ID}, 'DISPATCH_PHOTO', 'dispatches/none/box.jpg', 'image/jpeg', 10, 'sum-stranger') RETURNING id
    `);
    const refused = await portalGet<ErrorBody>(`/portal/${key}/media/${stranger.rows[0]?.id ?? ''}`);
    expect(refused.status).toBe(404);
  });

  it('is withdrawn on the spot, not at the next expiry (REQ-AL-07)', async () => {
    const working = await portalGet<PortalView>(`/portal/${key}`);
    expect(working.status).toBe(200);

    const refused = await harness.post<ErrorBody>(`/portal-links/${keyId}/revoke`, { token: salesToken, body: { reason: 'Curiosity' } });
    expect(refused.status).toBe(403);

    const revoked = await harness.post<PortalKeyView>(`/portal-links/${keyId}/revoke`, { token: adminToken, body: { reason: 'The buyer left the company' } });
    expect(revoked.status).toBe(200);
    expect(revoked.body.state).toBe('revoked');
    expect(revoked.body.revokeReason).toContain('left the company');

    const dead = await portalGet<ErrorBody>(`/portal/${key}`);
    expect(dead.status).toBe(404);
    const twice = await harness.post<ErrorBody>(`/portal-links/${keyId}/revoke`, { token: adminToken, body: { reason: 'Again' } });
    expect(twice.status).toBe(409);
  });

  it('withdraws the old link when a new one is issued, so a party never has two (REQ-AL-01)', async () => {
    const first = await harness.post<IssuedPortalKey>('/portal-links', { token: adminToken, body: { partyId: beharId } });
    expect(first.status).toBe(201);
    const second = await harness.post<IssuedPortalKey>('/portal-links', { token: adminToken, body: { partyId: beharId } });
    expect(second.status).toBe(201);

    expect((await portalGet<ErrorBody>(`/portal/${first.body.key}`)).status).toBe(404);
    expect((await portalGet<PortalView>(`/portal/${second.body.key}`)).status).toBe(200);

    const live = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM portal_link_keys WHERE org_id = ${ORG_ID} AND party_id = ${beharId} AND revoked_at IS NULL AND deleted_at IS NULL
    `);
    expect(Number(live.rows[0]?.n ?? 0)).toBe(1);
  });

  it('slows one link that is being scraped, counting from its own log (REQ-AL-05)', async () => {
    const issued = await harness.post<IssuedPortalKey>('/portal-links', { token: adminToken, body: { partyId: ashaId } });
    // The budget is an hour's worth; writing the log directly is how a
    // scraper's hour is reproduced without spending one.
    await harness.db.execute(sql`
      INSERT INTO portal_access_log (org_id, link_key_id, party_id, view, outcome, ip)
      SELECT ${ORG_ID}, ${issued.body.id}, ${ashaId}, 'portal', 'served', '203.0.113.9' FROM generate_series(1, 400)
    `);
    const refused = await portalGet<ErrorBody>(`/portal/${issued.body.key}`);
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain('too many times');
    const throttled = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM portal_access_log WHERE link_key_id = ${issued.body.id} AND outcome = 'throttled'
    `);
    expect(Number(throttled.rows[0]?.n ?? 0)).toBe(1);
    await harness.post(`/portal-links/${issued.body.id}/revoke`, { token: adminToken, body: { reason: 'Test link' } });
  });

  it('answers while the office is shut, because a customer is not staff (REQ-AL-09)', async () => {
    const issued = await harness.post<IssuedPortalKey>('/portal-links', { token: adminToken, body: { partyId: ashaId } });
    // The window every member of staff is refused by, closed for the whole day.
    const closed = await harness.put('/settings/access-window', {
      token: adminToken,
      body: { enabled: true, closesAt: '00:00', reopensAt: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
    });
    expect([200, 204]).toContain(closed.status);
    try {
      const view = await portalGet<PortalView>(`/portal/${issued.body.key}`);
      expect(view.status).toBe(200);
      expect(view.body.partyName).toBe('Asha Traders');
    } finally {
      await harness.put('/settings/access-window', {
        token: adminToken,
        body: { enabled: false, closesAt: '19:30', reopensAt: '09:00', days: [0, 1, 2, 3, 4, 5, 6] },
      });
    }
  });

  it('refuses an expired key without waiting for anybody to withdraw it', async () => {
    const issued = await harness.post<IssuedPortalKey>('/portal-links', { token: adminToken, body: { partyId: ashaId, days: 1 } });
    await harness.db.execute(sql`UPDATE portal_link_keys SET expires_at = now() - interval '1 minute' WHERE id = ${issued.body.id}`);
    expect((await portalGet<ErrorBody>(`/portal/${issued.body.key}`)).status).toBe(404);
    const listed = await harness.get<PortalKeyView[]>('/portal-links?partyId=' + ashaId, { token: adminToken });
    expect(listed.body.find((k) => k.id === issued.body.id)?.state).toBe('expired');
  });
});
