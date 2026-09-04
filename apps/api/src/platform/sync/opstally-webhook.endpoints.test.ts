import { createHmac } from 'node:crypto';

import {
  SYSTEM_ROLES,
  type IntegrationListResponse,
  type OpsTallyAck,
  type SyncExceptionView,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { OpsTallyWebhookService, WEBHOOK_MAX_EVENT_AGE_DAYS } from './opstally-webhook.service.js';
import { INBOX_RETENTION_DAYS } from './sync-scheduler.service.js';

/**
 * The OpsTally webhook door, over real HTTP, signed the way the Agent signs
 * (hex HMAC-SHA256 over the exact bytes). What this file holds still is the
 * receiving contract: verify before anything, bind on first delivery, one
 * row per event id, project through the same writer as the pull path, and
 * answer 2xx for everything verified — including what Vyuha cannot yet use.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d0';
const SECRET = 'whsec_test_secret_for_the_opstally_door_0001';
const INSTALL = '6b6f9b0a-2f3e-4a3a-8d21-6a7b1e9d4c3f';
const COMPANY = 'Acme Trading Co';

let harness: ApiHarness;
let adminToken: string;
let employeeToken: string;
let connectionId = '';
let webhookUrl = '';

function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** One event as OpsTally would send it: envelope + payload, signed over the raw text. */
async function deliver<T = OpsTallyAck>(
  event: Record<string, unknown>,
  options: { secret?: string; signature?: string; path?: string; eventIdHeader?: string } = {},
) {
  const rawBody = JSON.stringify(event);
  const signature = options.signature ?? sign(rawBody, options.secret);
  const response = await fetch(options.path ?? webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tally-signature': signature,
      'x-tally-event': typeof event['event'] === 'string' ? event['event'] : '',
      ...(options.eventIdHeader === undefined ? {} : { 'x-tally-event-id': options.eventIdHeader }),
      'user-agent': 'opstally-agent/1.4.0',
    },
    body: rawBody,
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

function envelope(id: string, event: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id,
    event,
    // Fresh, not a constant: deliveries past the acceptance window are
    // refused as replays, and a pinned date would start failing on its own.
    created_at: new Date().toISOString(),
    company: COMPANY,
    install_id: INSTALL,
    payload,
    ...overrides,
  };
}

const CABLE = {
  guid: 'st-guid-cable',
  masterId: '1042',
  alterId: 501,
  name: 'Cat6 Cable Box',
  parent: 'Networking',
  baseUnits: 'NOS',
  closingQty: 40,
  closingRate: 3800,
  closingValue: 152000,
  salePrice: 4150.5,
  costPrice: 3800,
};

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'OpsTally Webhook Fixture Org');

  await harness.db.execute(sql`DELETE FROM sync_inbox WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_exceptions WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_jobs WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_cursors WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM external_refs WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM price_list_entries WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('wh-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('wh-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  // The company name is deliberately *not* Tally's exact spelling: the first
  // delivery is authoritative and must overwrite it, not lock the door.
  const created = await harness.post<{ id: string }>('/integrations', {
    token: adminToken,
    body: { name: 'Acme via OpsTally', companyName: 'Acme Trading Company Ltd' },
  });
  connectionId = created.body.id;
});

afterAll(async () => {
  await harness.close();
});

describe('storing the secret (the handshake, Vyuha half)', () => {
  it('is integration.manage only, and refuses a secret without the whsec_ prefix', async () => {
    const refused = await harness.put(`/integrations/${connectionId}/webhook-secret`, {
      token: employeeToken,
      body: { secret: SECRET },
    });
    expect(refused.status).toBe(403);

    const malformed = await harness.put(`/integrations/${connectionId}/webhook-secret`, {
      token: adminToken,
      body: { secret: 'not-a-whsec-value-at-all-really' },
    });
    expect(malformed.status).toBe(400);
  });

  it('stores it sealed and answers the URL to paste into OpsTally', async () => {
    const response = await harness.put<{ connectionId: string; webhookUrl: string }>(
      `/integrations/${connectionId}/webhook-secret`,
      { token: adminToken, body: { secret: SECRET } },
    );
    expect(response.status).toBe(200);
    expect(response.body.webhookUrl).toContain(`/sync/webhooks/opstally/${connectionId}`);
    // The harness listens on its own port; the URL the API composes is the
    // configured public one. Deliver to the harness's own address.
    webhookUrl = `${harness.baseUrl}/sync/webhooks/opstally/${connectionId}`;

    // Sealed at rest: the plaintext must not be in the row.
    const row = await harness.db.execute<{ enc: string }>(sql`
      SELECT webhook_secret_enc AS enc FROM integration_connections WHERE id = ${connectionId}
    `);
    expect(row.rows[0]?.enc).not.toContain(SECRET);
    expect(row.rows[0]?.enc.startsWith('v1.')).toBe(true);

    const list = await harness.get<IntegrationListResponse>('/integrations', { token: adminToken });
    const view = list.body.data.find((c) => c.id === connectionId);
    expect(view?.transport).toBe('webhook');
    // Nothing about the secret crosses into any user-facing payload.
    expect(JSON.stringify(list.body)).not.toContain(SECRET.slice(6));
  });

  it('a webhook connection has no agent token — one door', async () => {
    const response = await harness.post(`/integrations/${connectionId}/token`, { token: adminToken });
    expect(response.status).toBe(409);
  });
});

describe('verifying signatures (reference §4)', () => {
  it('refuses a wrong signature, a missing one, and a body signed with another secret', async () => {
    const event = envelope('evt_sig_1', 'ping', { message: 'hello' });
    expect((await deliver(event, { signature: 'deadbeef' })).status).toBe(401);
    expect((await deliver(event, { signature: '' })).status).toBe(401);
    expect((await deliver(event, { secret: 'whsec_some_other_secret_entirely_00' })).status).toBe(401);
    // Refused means untouched: no inbox row, no journal row.
    const inbox = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM sync_inbox WHERE connection_id = ${connectionId}
    `);
    expect(Number(inbox.rows[0]?.count)).toBe(0);
  });

  it('refuses a delivery for a connection that has no secret, indistinguishably', async () => {
    const other = await harness.post<{ id: string }>('/integrations', {
      token: adminToken,
      body: { name: 'No secret yet' },
    });
    const response = await deliver(envelope('evt_sig_2', 'ping', { message: 'x' }), {
      path: `${harness.baseUrl}/sync/webhooks/opstally/${other.body.id}`,
    });
    expect(response.status).toBe(401);
  });

  it('accepts the exact bytes, whichever hex case the signature arrives in', async () => {
    const event = envelope('evt_sig_3', 'ping', { message: 'hello' });
    const raw = JSON.stringify(event);
    const response = await deliver(event, { signature: sign(raw).toUpperCase() });
    expect(response.status).toBe(200);
    expect(response.body.result).toBe('pong');
  });
});

describe('binding on the first delivery (REQ-Q-03, REQ-Q-05 for the push door)', () => {
  it('the ping above bound the install and overwrote the typed company name with Tally’s exact one', async () => {
    const list = await harness.get<IntegrationListResponse>('/integrations', { token: adminToken });
    const view = list.body.data.find((c) => c.id === connectionId);
    expect(view?.webhookInstallId).toBe(INSTALL);
    expect(view?.companyName).toBe(COMPANY);
    expect(view?.status).toBe('CONNECTED');
    expect(view?.lastHeartbeatAt).not.toBeNull();
  });

  it('refuses a second install pointed at the same connection', async () => {
    const response = await deliver<{ error: { message: string } }>(
      envelope('evt_bind_1', 'ping', { message: 'rival' }, { install_id: 'another-install' }),
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('another OpsTally install');
  });

  it('refuses the wrong company, naming both, and marks the condition', async () => {
    const response = await deliver<{ error: { message: string } }>(
      envelope('evt_bind_2', 'ping', { message: 'wrong books' }, { company: 'Some Other Co' }),
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('Some Other Co');
    const list = await harness.get<IntegrationListResponse>('/integrations', { token: adminToken });
    const view = list.body.data.find((c) => c.id === connectionId);
    expect(view?.lastCondition).toBe('WRONG_COMPANY_OPEN');
    expect(view?.status).toBe('ERROR');
  });
});

describe('projection through the writer (REQ-R-01, R-02, T-03)', () => {
  it('stock.updated lands as a stock item with the held figures, exactly', async () => {
    const response = await deliver(envelope('evt_stock_1', 'stock.updated', CABLE));
    expect(response.status).toBe(200);
    expect(response.body.result).toBe('ok: 1 stock item');

    const row = await harness.db.execute<{
      name: string; unit: string; parent_group: string; closing_qty: string; sale_price: string; cost_price: string;
    }>(sql`
      SELECT name, unit, parent_group, closing_qty, sale_price, cost_price
        FROM stock_items WHERE org_id = ${ORG_ID} AND name = 'Cat6 Cable Box'
    `);
    expect(row.rows[0]).toEqual({
      name: 'Cat6 Cable Box',
      unit: 'NOS',
      parent_group: 'Networking',
      closing_qty: '40',
      sale_price: '4150.5',
      cost_price: '3800',
    });
    // The condition recovered on a verified delivery.
    const list = await harness.get<IntegrationListResponse>('/integrations', { token: adminToken });
    expect(list.body.data.find((c) => c.id === connectionId)?.status).toBe('CONNECTED');
  });

  it('zero is not "free": a later 0 price keeps the stored figure, but a 0 quantity lands', async () => {
    const response = await deliver(
      envelope('evt_stock_2', 'stock.updated', { ...CABLE, alterId: 502, closingQty: 0, salePrice: 0, costPrice: 0 }),
    );
    expect(response.status).toBe(200);
    const row = await harness.db.execute<{ closing_qty: string; sale_price: string; cost_price: string }>(sql`
      SELECT closing_qty, sale_price, cost_price FROM stock_items WHERE org_id = ${ORG_ID} AND name = 'Cat6 Cable Box'
    `);
    expect(row.rows[0]).toEqual({ closing_qty: '0', sale_price: '4150.5', cost_price: '3800' });
    // And Tally wins on a real change.
    await deliver(envelope('evt_stock_3', 'stock.updated', { ...CABLE, alterId: 503, salePrice: 4200 }));
    const after = await harness.db.execute<{ sale_price: string }>(sql`
      SELECT sale_price FROM stock_items WHERE org_id = ${ORG_ID} AND name = 'Cat6 Cable Box'
    `);
    expect(after.rows[0]?.sale_price).toBe('4200');
  });

  it('a retry with the same event id is a no-op, whatever it carries', async () => {
    const response = await deliver(
      envelope('evt_stock_1', 'stock.updated', { ...CABLE, name: 'Replayed Rename', alterId: 999 }),
    );
    expect(response.status).toBe(200);
    expect(response.body.duplicate).toBe(true);
    const row = await harness.db.execute<{ name: string }>(sql`
      SELECT name FROM stock_items WHERE org_id = ${ORG_ID} AND name = 'Replayed Rename'
    `);
    expect(row.rows.length).toBe(0);
  });

  it('a stock.snapshot chunk upserts every item it carries', async () => {
    const response = await deliver(
      envelope('evt_snap_1', 'stock.snapshot', {
        items: [
          { ...CABLE, alterId: 510 },
          { ...CABLE, guid: 'st-guid-conduit', masterId: '1043', alterId: 511, name: 'PVC Conduit 20mm', baseUnits: 'MTR', parent: 'Electrical', salePrice: 38.5, costPrice: 30 },
        ],
        chunk: 1,
        total_chunks: 1,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.result).toContain('snapshot chunk 1/1, 2 stock items');
    const count = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM stock_items WHERE org_id = ${ORG_ID}
    `);
    expect(Number(count.rows[0]?.count)).toBe(2);
    const cursor = await harness.db.execute<{ last_alter_id: number }>(sql`
      SELECT last_alter_id FROM sync_cursors WHERE connection_id = ${connectionId} AND entity_type = 'stock_item'
    `);
    expect(Number(cursor.rows[0]?.last_alter_id)).toBe(511);
  });

  it('a debtor ledger becomes a party; a bank ledger is acknowledged and skipped', async () => {
    const debtor = await deliver(
      envelope('evt_led_1', 'ledger.created', {
        guid: 'led-guid-asha', masterId: '77', alterId: 300, name: 'Asha Traders',
        parent: 'Sundry Debtors', gstin: '27AAAPL1234C1ZV',
      }),
    );
    expect(debtor.status).toBe(200);
    expect(debtor.body.result).toBe('ok: 1 party');

    const bank = await deliver(
      envelope('evt_led_2', 'ledger.created', {
        guid: 'led-guid-hdfc', masterId: '78', alterId: 301, name: 'HDFC Current A/c', parent: 'Bank Accounts',
      }),
    );
    expect(bank.status).toBe(200);
    expect(bank.body.result).toContain('not a party group');

    // A sub-group under the standard one still counts.
    const creditor = await deliver(
      envelope('evt_led_3', 'ledger.updated', {
        guid: 'led-guid-behar', masterId: '79', alterId: 302, name: 'Behar Supply Co', parent: 'Sundry Creditors - North',
      }),
    );
    expect(creditor.body.result).toBe('ok: 1 party');

    const parties = await harness.db.execute<{ name: string; parent_group: string; gstin: string | null }>(sql`
      SELECT name, parent_group, gstin FROM parties WHERE org_id = ${ORG_ID} ORDER BY name
    `);
    expect(parties.rows).toEqual([
      { name: 'Asha Traders', parent_group: 'Sundry Debtors', gstin: '27AAAPL1234C1ZV' },
      { name: 'Behar Supply Co', parent_group: 'Sundry Creditors - North', gstin: null },
    ]);
  });

  it('a party ledger carries its balances, address, contact and credit terms', async () => {
    const response = await deliver(
      envelope('evt_led_detail', 'ledger.created', {
        guid: 'led-guid-detail', masterId: '90', alterId: 320, name: 'Sunmill Traders',
        parent: 'Sundry Debtors', gstin: '27AABCU9603R1ZM', gstRegistrationType: 'Regular',
        openingBalance: -25000, closingBalance: 184250.5,
        address: ['Unit 4, Sunmill Compound', 'Lower Parel West', 'Mumbai'],
        state: 'Maharashtra', country: 'India', pincode: '400018',
        contactPerson: 'Ravi Menon', phone: '022-24001188', mobile: '9820011223',
        email: 'accounts@sunmill.in', creditLimit: 500000, creditPeriodDays: 45, isBillWiseOn: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.result).toBe('ok: 1 party');

    const party = await harness.db.execute<{
      gst_registration_type: string | null; address: string | null; state: string | null;
      country: string | null; pincode: string | null; contact_person: string | null;
      email: string | null; phone: string | null; credit_limit: string | null;
      credit_days: number | null; opening_balance: string | null; closing_balance: string | null;
      bill_wise_tracking: boolean | null;
    }>(sql`
      SELECT gst_registration_type, address, state, country, pincode, contact_person, email, phone,
             credit_limit, credit_days, opening_balance, closing_balance, bill_wise_tracking
        FROM parties WHERE org_id = ${ORG_ID} AND name = 'Sunmill Traders'
    `);
    const row = party.rows[0];
    expect(row?.gst_registration_type).toBe('Regular');
    // Tally's own line structure is kept; it is a postal address, not one string.
    expect(row?.address).toBe('Unit 4, Sunmill Compound\nLower Parel West\nMumbai');
    expect(row?.state).toBe('Maharashtra');
    expect(row?.country).toBe('India');
    expect(row?.pincode).toBe('400018');
    expect(row?.contact_person).toBe('Ravi Menon');
    expect(row?.email).toBe('accounts@sunmill.in');
    // The mobile wins over the landline: it is the number a person is reached on.
    expect(row?.phone).toBe('9820011223');
    expect(Number(row?.credit_limit)).toBe(500000);
    expect(row?.credit_days).toBe(45);
    // Tally's sign convention survives: debit positive, credit negative.
    expect(Number(row?.opening_balance)).toBe(-25000);
    expect(Number(row?.closing_balance)).toBe(184250.5);
    expect(row?.bill_wise_tracking).toBe(true);
  });

  it('a ledger from an Agent that predates the detail fields still lands, and holds what is stored', async () => {
    // Same GUID as the detailed delivery above, with only the fields an older
    // Agent sends. The detail must survive: absent is "not reported", not
    // "cleared", or an install that has not updated would blank the projection.
    const response = await deliver(
      envelope('evt_led_old_agent', 'ledger.updated', {
        guid: 'led-guid-detail', masterId: '90', alterId: 321, name: 'Sunmill Traders',
        parent: 'Sundry Debtors', gstin: '27AABCU9603R1ZM',
      }),
    );
    expect(response.body.result).toBe('ok: 1 party');

    const party = await harness.db.execute<{ address: string | null; closing_balance: string | null; state: string | null }>(sql`
      SELECT address, closing_balance, state FROM parties WHERE org_id = ${ORG_ID} AND name = 'Sunmill Traders'
    `);
    expect(party.rows[0]?.state).toBe('Maharashtra');
    expect(party.rows[0]?.address).toContain('Sunmill Compound');
    expect(Number(party.rows[0]?.closing_balance)).toBe(184250.5);
  });

  it('a settled account lands its zero balance rather than keeping the stored figure', async () => {
    const response = await deliver(
      envelope('evt_led_settled', 'ledger.updated', {
        guid: 'led-guid-detail', masterId: '90', alterId: 322, name: 'Sunmill Traders',
        parent: 'Sundry Debtors', closingBalance: 0,
      }),
    );
    expect(response.body.result).toBe('ok: 1 party');

    const party = await harness.db.execute<{ closing_balance: string | null }>(sql`
      SELECT closing_balance FROM parties WHERE org_id = ${ORG_ID} AND name = 'Sunmill Traders'
    `);
    expect(Number(party.rows[0]?.closing_balance)).toBe(0);
  });

  it('a ledger snapshot projects the party groups and counts the rest as skipped', async () => {
    const response = await deliver(
      envelope('evt_led_snap', 'ledger.snapshot', {
        chunk: 1,
        total_chunks: 1,
        ledgers: [
          { guid: 'led-snap-1', masterId: '201', alterId: 410, name: 'Kaveri Hardware', parent: 'Sundry Debtors', closingBalance: 9100 },
          { guid: 'led-snap-2', masterId: '202', alterId: 411, name: 'Nandi Timber', parent: 'Sundry Creditors', closingBalance: -3300 },
          { guid: 'led-snap-3', masterId: '203', alterId: 412, name: 'CGST Payable', parent: 'Duties & Taxes' },
          { guid: 'led-snap-4', masterId: '204', alterId: 413, name: 'Office Rent', parent: 'Indirect Expenses' },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.result).toBe('ok: snapshot chunk 1/1, 2 parties, 2 non-party ledgers skipped');

    const parties = await harness.db.execute<{ name: string; closing_balance: string | null }>(sql`
      SELECT name, closing_balance FROM parties
       WHERE org_id = ${ORG_ID} AND name IN ('Kaveri Hardware', 'Nandi Timber', 'CGST Payable', 'Office Rent')
       ORDER BY name
    `);
    expect(parties.rows.map((r) => r.name)).toEqual(['Kaveri Hardware', 'Nandi Timber']);
    expect(Number(parties.rows[1]?.closing_balance)).toBe(-3300);

    // The cursor advances to the highest AlterID actually written, not the
    // highest in the chunk -- the skipped ledgers were never projected.
    const cursor = await harness.db.execute<{ last_alter_id: number }>(sql`
      SELECT last_alter_id FROM sync_cursors WHERE connection_id = ${connectionId} AND entity_type = 'party'
    `);
    expect(Number(cursor.rows[0]?.last_alter_id)).toBe(411);
  });

  it('a ledger snapshot chunk with no party groups is acknowledged and skipped', async () => {
    const response = await deliver(
      envelope('evt_led_snap_empty', 'ledger.snapshot', {
        chunk: 2,
        total_chunks: 2,
        ledgers: [
          { guid: 'led-snap-5', masterId: '205', alterId: 420, name: 'Bank OD A/c', parent: 'Bank OCC A/c' },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.result).toContain('no party-group ledgers in 1 ledgers');
  });

  it('a voucher carries its order, terms, dispatch and consignee detail', async () => {
    const response = await deliver(
      envelope('evt_vch_detail', 'voucher.created', {
        guid: 'vch-guid-detail', masterId: '5100', alterId: 940, date: '20260818',
        voucherType: 'Sales', voucherNumber: 'INV-0100', party: 'Asha Traders',
        narration: '', isCancelled: false, amount: 9100,
        ledgerEntries: [{ ledgerName: 'Asha Traders', amount: 9100, isDeemedPositive: true }],
        inventoryEntries: [],
        reference: 'PIXM/21-22/05', referenceDate: '20260810',
        orderRef: 'Lead 9480', buyerOrderNumber: 'PO-7781', buyerOrderDate: '20260805',
        paymentTerms: '100% Advance Payment',
        deliveryTerms: ['1. Ex-Works', '2. Risk passes on despatch'],
        dispatchedThrough: 'Harish / Rutik', dispatchDocNo: 'ORD-INN/24_25/00012',
        vehicleNumber: 'GJ03AZ6791', destination: 'Ludhiyana',
        buyerName: 'Asha Traders', buyerAddress: ['Unit 4, Sunmill', 'Lower Parel'],
        partyGstin: '27AAAPL1234C1ZV', partyState: 'Maharashtra', placeOfSupply: 'Maharashtra',
        consigneeName: 'Asha Traders Warehouse', consigneeState: 'Gujarat',
        consigneePincode: '360006', consigneeGstin: '24AKRPD7559E1ZY',
      }),
    );
    expect(response.status).toBe(200);

    const v = await harness.db.execute<{
      reference: string | null; reference_date: string | null; buyer_order_number: string | null;
      buyer_order_date: string | null; payment_terms: string | null; delivery_terms: string | null;
      dispatched_through: string | null; vehicle_number: string | null; destination: string | null;
      buyer_address: string | null; consignee_pincode: string | null; consignee_gstin: string | null;
    }>(sql`
      SELECT reference, reference_date::text AS reference_date, buyer_order_number,
             buyer_order_date::text AS buyer_order_date, payment_terms, delivery_terms,
             dispatched_through, vehicle_number, destination, buyer_address,
             consignee_pincode, consignee_gstin
        FROM vouchers WHERE org_id = ${ORG_ID} AND voucher_number = 'INV-0100'
    `);
    const row = v.rows[0];
    expect(row?.reference).toBe('PIXM/21-22/05');
    // Tally's YYYYMMDD converted into a real date column.
    expect(row?.reference_date).toBe('2026-08-10');
    expect(row?.buyer_order_number).toBe('PO-7781');
    expect(row?.buyer_order_date).toBe('2026-08-05');
    expect(row?.payment_terms).toBe('100% Advance Payment');
    // Multi-line source joined into the single block the column holds.
    expect(row?.delivery_terms).toBe('1. Ex-Works\n2. Risk passes on despatch');
    expect(row?.buyer_address).toBe('Unit 4, Sunmill\nLower Parel');
    expect(row?.dispatched_through).toBe('Harish / Rutik');
    expect(row?.vehicle_number).toBe('GJ03AZ6791');
    expect(row?.destination).toBe('Ludhiyana');
    expect(row?.consignee_pincode).toBe('360006');
    expect(row?.consignee_gstin).toBe('24AKRPD7559E1ZY');
  });

  it('a receipt carries settlement on the bank line, not on the voucher', async () => {
    const response = await deliver(
      envelope('evt_vch_receipt', 'voucher.created', {
        guid: 'vch-guid-receipt', masterId: '5200', alterId: 950, date: '20260819',
        voucherType: 'Receipt', voucherNumber: 'RCPT-9', party: 'Asha Traders',
        narration: '', isCancelled: false, amount: 6313,
        ledgerEntries: [
          {
            ledgerName: 'Bank of Baroda', amount: -6313, isDeemedPositive: true,
            bankAllocation: {
              transactionType: 'Cheque/DD', paymentMode: 'Transacted',
              instrumentNumber: '328650', instrumentDate: '20260819',
              bankName: 'State Bank of India (India)', paymentFavouring: 'Rajesh Sharma',
            },
          },
          { ledgerName: 'Asha Traders', amount: 6313, isDeemedPositive: false },
        ],
        inventoryEntries: [],
      }),
    );
    expect(response.status).toBe(200);

    const lines = await harness.db.execute<{
      line_no: number; ledger_name: string | null; settlement_type: string | null;
      settlement_mode: string | null; instrument_number: string | null;
      instrument_date: string | null; bank_name: string | null; payment_favouring: string | null;
    }>(sql`
      SELECT l.line_no, l.ledger_name, l.settlement_type, l.settlement_mode, l.instrument_number,
             l.instrument_date::text AS instrument_date, l.bank_name, l.payment_favouring
        FROM voucher_lines l
        JOIN vouchers v ON v.id = l.voucher_id
       WHERE v.org_id = ${ORG_ID} AND v.voucher_number = 'RCPT-9'
       ORDER BY l.line_no
    `);
    expect(lines.rows).toHaveLength(2);

    // Settlement belongs to the bank line — that is where Tally records it.
    const bank = lines.rows[0];
    expect(bank?.ledger_name).toBe('Bank of Baroda');
    expect(bank?.settlement_type).toBe('Cheque/DD');
    expect(bank?.settlement_mode).toBe('Transacted');
    expect(bank?.instrument_number).toBe('328650');
    expect(bank?.instrument_date).toBe('2026-08-19');
    expect(bank?.bank_name).toBe('State Bank of India (India)');
    expect(bank?.payment_favouring).toBe('Rajesh Sharma');

    // The party line has none, and must not inherit the bank line's.
    expect(lines.rows[1]?.ledger_name).toBe('Asha Traders');
    expect(lines.rows[1]?.settlement_type).toBeNull();
  });

  it('a voucher from an Agent that predates the detail fields holds what is stored', async () => {
    // Same GUID as the detailed voucher, with only the old fields set. Absent
    // means "not reported", not "cleared" — an install that has not updated
    // must not blank detail a newer Agent already wrote.
    const response = await deliver(
      envelope('evt_vch_old_agent', 'voucher.updated', {
        guid: 'vch-guid-detail', masterId: '5100', alterId: 941, date: '20260818',
        voucherType: 'Sales', voucherNumber: 'INV-0100', party: 'Asha Traders',
        narration: 'edited', isCancelled: false, amount: 9100,
        ledgerEntries: [], inventoryEntries: [],
      }),
    );
    expect(response.status).toBe(200);

    const v = await harness.db.execute<{
      narration: string; dispatched_through: string | null; buyer_order_number: string | null;
    }>(sql`
      SELECT narration, dispatched_through, buyer_order_number
        FROM vouchers WHERE org_id = ${ORG_ID} AND voucher_number = 'INV-0100'
    `);
    expect(v.rows[0]?.narration).toBe('edited');
    expect(v.rows[0]?.dispatched_through).toBe('Harish / Rutik');
    expect(v.rows[0]?.buyer_order_number).toBe('PO-7781');
  });

  const INVOICE = {
    guid: 'vch-guid-1', masterId: '5001', alterId: 900, date: '20260817', voucherType: 'Sales',
    voucherNumber: 'INV-0042', party: 'Asha Traders', narration: 'Cable order', isCancelled: false, amount: 4150.5,
    ledgerEntries: [
      { ledgerName: 'Asha Traders', amount: 4150.5, isDeemedPositive: true },
      { ledgerName: 'Sales', amount: -4150.5, isDeemedPositive: false },
    ],
    inventoryEntries: [{ stockItemName: 'Cat6 Cable Box', actualQty: '1 NOS', billedQty: '1 NOS', rate: 4150.5, amount: 4150.5 }],
  };

  it('a voucher lands with its lines, its party and item resolved by Tally’s own names (6c)', async () => {
    const response = await deliver(envelope('evt_vch_1', 'voucher.created', INVOICE));
    expect(response.status).toBe(200);
    expect(response.body.result).toBe('ok: 1 voucher (Sales)');

    const voucher = await harness.db.execute<{
      id: string; voucher_date: string; voucher_number: string; party_name: string; party_id: string | null; amount: string;
    }>(sql`
      SELECT v.id, v.voucher_date::text AS voucher_date, v.voucher_number, v.party_name, v.party_id, v.amount
        FROM vouchers v WHERE v.org_id = ${ORG_ID} AND v.voucher_number = 'INV-0042'
    `);
    const row = voucher.rows[0];
    expect(row?.voucher_date).toBe('2026-08-17');
    expect(row?.party_name).toBe('Asha Traders');
    // The debtor ledger delivered above is this voucher's party.
    expect(row?.party_id).not.toBeNull();
    expect(row?.amount).toBe('4150.5');

    const lines = await harness.db.execute<{ line_no: number; kind: string; ledger_name: string | null; stock_item_id: string | null; amount: string }>(sql`
      SELECT line_no, kind, ledger_name, stock_item_id, amount FROM voucher_lines WHERE voucher_id = ${row?.id ?? ''} ORDER BY line_no
    `);
    expect(lines.rows.map((l) => [l.line_no, l.kind, l.ledger_name])).toEqual([
      [1, 'ledger', 'Asha Traders'],
      [2, 'ledger', 'Sales'],
      [3, 'inventory', null],
    ]);
    // The inventory line resolved the projected stock item by name.
    expect(lines.rows[2]?.stock_item_id).not.toBeNull();
    expect(lines.rows[1]?.amount).toBe('-4150.5');
  });

  it('an update replaces the lines wholesale; a cancellation flips the flag', async () => {
    await deliver(envelope('evt_vch_2', 'voucher.updated', { ...INVOICE, alterId: 901, inventoryEntries: [] }));
    const lines = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
       WHERE v.org_id = ${ORG_ID} AND v.voucher_number = 'INV-0042'
    `);
    expect(Number(lines.rows[0]?.count)).toBe(2);

    const cancelled = await deliver(envelope('evt_vch_3', 'voucher.cancelled', { ...INVOICE, alterId: 902, isCancelled: true }));
    expect(cancelled.body.result).toContain('cancelled');
    const flag = await harness.db.execute<{ is_cancelled: boolean; count: string }>(sql`
      SELECT bool_or(is_cancelled) AS is_cancelled, count(*) AS count FROM vouchers
       WHERE org_id = ${ORG_ID} AND voucher_number = 'INV-0042'
    `);
    // One row per GUID however many events; the flag is Tally's.
    expect(flag.rows[0]).toEqual({ is_cancelled: true, count: '1' });
  });

  it('vouchers retained before the projection existed replay through the same path', async () => {
    // Simulate a pre-6c inbox row: acknowledged, payload kept, nothing projected.
    const retained = envelope('evt_vch_old', 'voucher.created', {
      ...INVOICE, guid: 'vch-guid-old', masterId: '4000', alterId: 800, voucherNumber: 'INV-0001', date: '20260601',
    });
    await harness.db.execute(sql`
      INSERT INTO sync_inbox (org_id, connection_id, event_id, event_type, result, payload)
      VALUES (${ORG_ID}, ${connectionId}, 'evt_vch_old', 'voucher.created', 'deferred', ${JSON.stringify(retained)}::jsonb)
    `);
    const service = harness.resolve(OpsTallyWebhookService);
    const outcome = await service.replayDeferred();
    expect(outcome.replayed).toBeGreaterThanOrEqual(1);

    const row = await harness.db.execute<{ voucher_date: string }>(sql`
      SELECT voucher_date::text AS voucher_date FROM vouchers WHERE org_id = ${ORG_ID} AND voucher_number = 'INV-0001'
    `);
    expect(row.rows[0]?.voucher_date).toBe('2026-06-01');
    const inbox = await harness.db.execute<{ payload: unknown; result: string }>(sql`
      SELECT payload, result FROM sync_inbox WHERE connection_id = ${connectionId} AND event_id = 'evt_vch_old'
    `);
    expect(inbox.rows[0]?.payload).toBeNull();
    expect(inbox.rows[0]?.result).toContain('replayed');
    // A second replay finds nothing to do.
    expect((await service.replayDeferred()).replayed).toBe(0);
  });

  it('every accepted delivery is in the journal with the body hash', async () => {
    const rows = await harness.db.execute<{ request_hash: string; result: string }>(sql`
      SELECT request_hash, result FROM sync_journal WHERE connection_id = ${connectionId} ORDER BY created_at
    `);
    expect(rows.rows.length).toBeGreaterThanOrEqual(7);
    expect(rows.rows.every((r) => r.request_hash.startsWith('sha256:'))).toBe(true);
    expect(rows.rows.some((r) => r.result === 'pong')).toBe(true);
  });
});

describe('what Vyuha cannot understand', () => {
  it('a verified but malformed event is acknowledged and raised as an exception, once', async () => {
    const response = await deliver(
      envelope('evt_bad_1', 'stock.updated', { guid: 'x', name: 'missing everything else' }),
    );
    expect(response.status).toBe(200);
    expect(response.body.result).toContain('rejected');

    // The retry the Agent sends anyway does not raise a second one.
    const retry = await deliver(envelope('evt_bad_1', 'stock.updated', { guid: 'x', name: 'missing everything else' }));
    expect(retry.body.duplicate).toBe(true);

    const exceptions = await harness.get<{ data: SyncExceptionView[] }>('/integrations/exceptions', {
      token: adminToken,
    });
    const ours = exceptions.body.data.filter((e) => e.connectionId === connectionId && e.kind === 'REJECTION');
    expect(ours.length).toBe(1);
    expect(ours[0]?.tallyError).toContain('could not be understood');
  });

  it('a non-JSON body that is correctly signed is acknowledged the same way', async () => {
    const raw = 'this is not json';
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tally-signature': sign(raw), 'x-tally-event-id': 'evt_bad_2' },
      body: raw,
    });
    // Express's JSON parser refuses the bytes before the handler: the Agent
    // sees a 4xx and retries — acceptable for a body OpsTally would never send.
    expect([200, 400]).toContain(response.status);
  });

  it('a request with no JSON body at all is 400, not 401', async () => {
    const response = await fetch(webhookUrl, { method: 'POST', headers: { 'x-tally-signature': 'aa' } });
    expect(response.status).toBe(400);
  });
});

describe('the acceptance window (the replay bound)', () => {
  const staleCreatedAt = new Date(
    Date.now() - (WEBHOOK_MAX_EVENT_AGE_DAYS + 1) * 86_400_000,
  ).toISOString();

  it('refuses a validly signed event past the window: acknowledged, recorded, never projected', async () => {
    const response = await deliver(
      envelope(
        'evt_stale_1',
        'stock.updated',
        { ...CABLE, guid: 'st-guid-stale', masterId: '1099', name: 'Stale Replay Item' },
        { created_at: staleCreatedAt },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body.result).toContain('acceptance window');

    const row = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM stock_items WHERE org_id = ${ORG_ID} AND name = 'Stale Replay Item'
    `);
    expect(row.rows.length).toBe(0);

    const exceptions = await harness.get<{ data: SyncExceptionView[] }>('/integrations/exceptions', {
      token: adminToken,
    });
    const stale = exceptions.body.data.filter(
      (e) => e.connectionId === connectionId && e.tallyError?.includes('acceptance window'),
    );
    expect(stale.length).toBe(1);
    expect(stale[0]?.tallyError).toContain('replayed capture');
  });

  it('replaying the refused event answers duplicate, without a second exception', async () => {
    const retry = await deliver(
      envelope(
        'evt_stale_1',
        'stock.updated',
        { ...CABLE, guid: 'st-guid-stale', masterId: '1099', name: 'Stale Replay Item' },
        { created_at: staleCreatedAt },
      ),
    );
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);

    const exceptions = await harness.get<{ data: SyncExceptionView[] }>('/integrations/exceptions', {
      token: adminToken,
    });
    const stale = exceptions.body.data.filter(
      (e) => e.connectionId === connectionId && e.tallyError?.includes('acceptance window'),
    );
    expect(stale.length).toBe(1);
  });

  it('an unparseable created_at is not refused for its date', async () => {
    // It can only arrive inside a validly signed body — from the real Agent —
    // and a working integration must not break over a date format.
    const response = await deliver(
      envelope(
        'evt_stale_2',
        'stock.updated',
        { ...CABLE, guid: 'st-guid-dateless', masterId: '1100', alterId: 900, name: 'Dateless Item' },
        { created_at: 'well past teatime' },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body.result).toBe('ok: 1 stock item');
  });

  it('sits far inside the inbox retention, so pruning a row never re-opens what the window refuses', () => {
    // Inside the window a replay is answered by the sync_inbox row; past it,
    // by the refusal above. Let the window grow past the retention and there
    // is a stretch where neither answers — this is the line that fails first.
    expect(WEBHOOK_MAX_EVENT_AGE_DAYS).toBeLessThan(INBOX_RETENTION_DAYS);
  });
});
