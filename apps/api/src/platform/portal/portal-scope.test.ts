import { SYSTEM_ROLES } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { PortalRepository } from './portal.repository.js';

/**
 * REQ-AL-11, literally: every method of the portal repository, called for
 * one party while another party's rows exist beside them, must return only
 * the first party's.
 *
 * Two parties are seeded with the *same shapes* — orders, dispatches with
 * photographs, invoices, receipts, promises — because a test where the
 * other party has no data proves nothing: an unscoped query would pass it.
 *
 * The last test in this file is the one that keeps the rest honest. It
 * enumerates the class's own methods and fails when one of them has no
 * assertion here, so a method added next year cannot quietly ship without
 * a party-scope test. A repository method that would return another
 * party's rows is a defect whether or not a screen calls it that way.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d3';

let harness: ApiHarness;
let adminToken = '';
let connectionId = '';
let ashaId = '';
let beharId = '';
let ashaFileId = '';
let beharFileId = '';

interface OrderView {
  id: string;
  number: string;
  lines: { id: string }[];
}

async function seedParty(name: string, orderRate: string): Promise<{ partyId: string; orderNumber: string; fileId: string }> {
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group) VALUES (${ORG_ID}, ${connectionId}, ${name}, 'Sundry Debtors') RETURNING id
  `);
  const partyId = party.rows[0]?.id ?? '';
  const item = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate)
    VALUES (${ORG_ID}, ${connectionId}, ${`Cable for ${name}`}, 'BOX', 'Cables', '18.00') RETURNING id
  `);
  const created = await harness.post<OrderView>('/sales/orders', {
    token: adminToken,
    body: { partyId, lines: [{ stockItemId: item.rows[0]?.id ?? '', quantity: '4', rate: orderRate }] },
  });
  const orderId = created.body.id;
  const lineId = created.body.lines[0]?.id ?? '';
  await harness.post(`/sales/orders/${orderId}/confirm`, { token: adminToken });
  await harness.post(`/sales/orders/${orderId}/picks`, { token: adminToken, body: { lines: [{ lineId, quantity: '4' }] } });
  await harness.post(`/sales/orders/${orderId}/packs`, { token: adminToken, body: { lines: [{ lineId, quantity: '4' }] } });
  await harness.db.execute(sql`UPDATE sales_document_lines SET invoiced_qty = 4 WHERE id = ${lineId}`);

  // A dispatch with a photograph, written directly: the file row is what the
  // media check reads, and going through multipart here would only be slower.
  const dispatch = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO dispatches (org_id, document_id, number, mode, lr_number, transporter_name)
    VALUES (${ORG_ID}, ${orderId}, ${`DN-${name.slice(0, 4)}`}, 'outstation', ${`LR-${name.slice(0, 4)}`}, 'Speedy Roadways') RETURNING id
  `);
  const dispatchId = dispatch.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO dispatch_lines (org_id, dispatch_id, line_id, quantity) VALUES (${ORG_ID}, ${dispatchId}, ${lineId}, '4')
  `);
  await harness.db.execute(sql`UPDATE sales_document_lines SET dispatched_qty = 4 WHERE id = ${lineId}`);
  const file = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO files (org_id, purpose, storage_key, mime, bytes, checksum)
    VALUES (${ORG_ID}, 'DISPATCH_PHOTO', ${`dispatches/${dispatchId}/box.jpg`}, 'image/jpeg', 1024, ${`sum-${name}`}) RETURNING id
  `);
  const fileId = file.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO dispatch_attachments (org_id, dispatch_id, file_id, kind) VALUES (${ORG_ID}, ${dispatchId}, ${fileId}, 'box')
  `);

  // An invoice and a receipt in the projection, and a promise against them.
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, '2026-08-01', 'Sales', ${`INV-${name.slice(0, 4)}`}, ${name}, ${partyId}, ${`for ${name}`}, false, 20000, now())
  `);
  await harness.db.execute(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, '2026-08-10', 'Receipt', ${`RCT-${name.slice(0, 4)}`}, ${name}, ${partyId}, '', false, 5000, now())
  `);
  await harness.db.execute(sql`
    INSERT INTO promises_to_pay (org_id, party_id, amount, promised_date, state, received_amount, taken_on, bills)
    VALUES (${ORG_ID}, ${partyId}, 15000, '2099-01-31', 'open', 0, CURRENT_DATE, ARRAY[]::text[])
  `);
  return { partyId, orderNumber: created.body.number, fileId };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Portal Scope Org');
  await harness.db.execute(sql`DELETE FROM portal_access_log WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM portal_link_keys WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('portal-scope-admin'), roleIds: [adminRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Portal Co', 'guid-portal-scope') RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';

  const asha = await seedParty('Asha Traders', '5000');
  const behar = await seedParty('Behar Supply Co', '7000');
  ashaId = asha.partyId;
  beharId = behar.partyId;
  ashaFileId = asha.fileId;
  beharFileId = behar.fileId;
});

afterAll(async () => {
  await harness.close();
});

describe('REQ-AL-11: the portal repository is scoped to one party and nothing else', () => {
  /**
   * Every method, with the assertion that proves it. The keys are checked
   * against the class's own prototype by the last test in this file.
   */
  const CHECKS: Record<string, () => Promise<void>> = {
    orders: async () => {
      const mine = await new PortalRepository(harness.db, ORG_ID, ashaId).orders();
      const theirs = await new PortalRepository(harness.db, ORG_ID, beharId).orders();
      expect(mine.length).toBeGreaterThan(0);
      expect(theirs.length).toBeGreaterThan(0);
      const overlap = mine.filter((order) => theirs.some((other) => other.number === order.number));
      expect(overlap).toEqual([]);
    },
    dispatches: async () => {
      const mine = await new PortalRepository(harness.db, ORG_ID, ashaId).dispatches();
      expect(mine.length).toBe(1);
      expect(mine[0]?.lrNumber).toBe('LR-Asha');
      expect(mine.flatMap((d) => d.photos).map((p) => p.fileId)).not.toContain(beharFileId);
      const theirs = await new PortalRepository(harness.db, ORG_ID, beharId).dispatches();
      expect(theirs[0]?.lrNumber).toBe('LR-Beha');
    },
    invoices: async () => {
      const mine = await new PortalRepository(harness.db, ORG_ID, ashaId).invoices();
      expect(mine.map((i) => i.voucherNumber)).toEqual(['INV-Asha']);
    },
    statement: async () => {
      const mine = await new PortalRepository(harness.db, ORG_ID, ashaId).statement();
      expect(mine.rows.map((r) => r.voucherNumber).sort()).toEqual(['INV-Asha', 'RCT-Asha']);
      // 20,000 billed less 5,000 received, and not a rupee of the other party's.
      expect(Number(mine.outstanding)).toBe(15000);
    },
    promises: async () => {
      const mine = await new PortalRepository(harness.db, ORG_ID, ashaId).promises();
      expect(mine).toHaveLength(1);
      expect(Number(mine[0]?.amount)).toBe(15000);
    },
    partyName: async () => {
      expect(await new PortalRepository(harness.db, ORG_ID, ashaId).partyName()).toBe('Asha Traders');
      expect(await new PortalRepository(harness.db, ORG_ID, beharId).partyName()).toBe('Behar Supply Co');
      // A party of another organisation is not this organisation's party.
      expect(await new PortalRepository(harness.db, '01900000-0000-7000-8000-0000000000ff', ashaId).partyName()).toBeNull();
    },
    ownsPhoto: async () => {
      const asha = new PortalRepository(harness.db, ORG_ID, ashaId);
      expect(await asha.ownsPhoto(ashaFileId)).toBe(true);
      // The heart of REQ-AL-08: the other party's photograph is not theirs to see.
      expect(await asha.ownsPhoto(beharFileId)).toBe(false);
      expect(await asha.ownsPhoto('01900000-0000-7000-8000-0000000000fe')).toBe(false);
    },
  };

  for (const [method, check] of Object.entries(CHECKS)) {
    it(`${method}() returns this party's rows and no other party's`, async () => {
      await check();
    });
  }

  it('has a check for every method the repository declares', () => {
    const declared = Object.getOwnPropertyNames(PortalRepository.prototype).filter((name) => name !== 'constructor');
    // If this fails, a method was added without a party-scope test. Write the
    // test; do not add the name to the list.
    expect(declared.sort()).toEqual(Object.keys(CHECKS).sort());
  });

  it('takes the party from the key and offers no way to pass another', () => {
    // The constructor is the only place a party id enters, and no method
    // accepts one: `ownsPhoto` takes a file id, everything else takes nothing.
    for (const name of Object.getOwnPropertyNames(PortalRepository.prototype).filter((n) => n !== 'constructor')) {
      const method = (PortalRepository.prototype as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[name];
      expect(method?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});
