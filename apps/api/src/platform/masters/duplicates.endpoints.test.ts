import { SYSTEM_ROLES, type DuplicateClusterView, type DuplicateDetectionResult, type Paginated, type PartyView, type StockItemView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Area AO's acceptance (docs/15), over real HTTP: two parties differing by
 * "Pvt Ltd" and "Private Limited" cluster and both rows carry the flag;
 * two items with one part number under two names cluster; a dismissal
 * stays dismissed across detections and comes back only when a matched
 * field changes; a member gone from Tally resolves the cluster with no
 * hand on it; nothing here writes to a party or an item.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d0';

let harness: ApiHarness;
let adminToken = '';
let accountsToken = '';
let employeeToken = '';
let ashaPvt = '';
let ashaPrivate = '';
let cat6Box = '';

interface ErrorBody {
  error: { code: string; message: string };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Duplicates Org');
  await harness.db.execute(sql`DELETE FROM bill_allocations WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM duplicate_cluster_members WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM duplicate_clusters WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const accountsRoleId = await harness.createSystemRole(SYSTEM_ROLES.ACCOUNTS, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('dup-admin'), roleIds: [adminRoleId] });
  const accounts = await harness.createUser({ email: scopedEmail('dup-accounts'), roleIds: [accountsRoleId] });
  const employee = await harness.createUser({ email: scopedEmail('dup-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  accountsToken = (await harness.login(accounts.email, accounts.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Dup Co', 'guid-dup-co') RETURNING id
  `);
  const cid = connection.rows[0]?.id ?? '';
  const insertParty = async (name: string, gstin: string | null, phone: string | null) =>
    harness.db
      .execute<{ id: string }>(sql`INSERT INTO parties (org_id, connection_id, name, parent_group, gstin, phone) VALUES (${ORG_ID}, ${cid}, ${name}, 'Sundry Debtors', ${gstin}, ${phone}) RETURNING id`)
      .then((r) => r.rows[0]?.id ?? '');
  ashaPvt = await insertParty('Asha Traders Pvt Ltd', '27AAAPL1234C1ZV', '9876543210');
  ashaPrivate = await insertParty('Asha Traders Private Limited', '27AAAPL1234C1ZV', '+91 98765 43210');
  await insertParty('Behar Supply Co', '27BBBPL9876D1Z2', null);
  const insertItem = async (name: string, alias: string | null) =>
    harness.db
      .execute<{ id: string }>(sql`INSERT INTO stock_items (org_id, connection_id, name, alias, unit, parent_group, gst_rate) VALUES (${ORG_ID}, ${cid}, ${name}, ${alias}, 'BOX', 'Cables', '18.00') RETURNING id`)
      .then((r) => r.rows[0]?.id ?? '');
  // One bill of 10,000 on the first Asha, 4,000 received against it: the cluster's outstanding is 6,000, signed rows summed.
  const voucher = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${cid}, 1, '2026-08-01', 'Sales', 'INV-D1', 'Asha Traders Pvt Ltd', ${ashaPvt}, '', false, 10000, now()) RETURNING id
  `);
  const receipt = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${cid}, 2, '2026-08-10', 'Receipt', 'RCT-D1', 'Asha Traders Pvt Ltd', ${ashaPvt}, '', false, 4000, now()) RETURNING id
  `);
  await harness.db.execute(sql`
    INSERT INTO bill_allocations (org_id, connection_id, voucher_id, party_id, party_name, bill_name, ref_type, bill_date, due_date, amount, last_pulled_at) VALUES
      (${ORG_ID}, ${cid}, ${voucher.rows[0]?.id ?? ''}, ${ashaPvt}, 'Asha Traders Pvt Ltd', 'INV-D1', 'new', '2026-08-01', '2026-08-31', 10000, now()),
      (${ORG_ID}, ${cid}, ${receipt.rows[0]?.id ?? ''}, ${ashaPvt}, 'Asha Traders Pvt Ltd', 'INV-D1', 'against', '2026-08-01', '2026-08-31', -4000, now())
  `);
  cat6Box = await insertItem('Cat6 cable box', 'CAT6-305');
  await insertItem('CAT 6 Cable 305m', 'cat6 305');
  await insertItem('RCCB 40A 30mA DP', null);
});

afterAll(async () => {
  await harness.close();
});

describe('Area AO: duplicate detection', () => {
  let clusterId = '';

  it('detects, and the parties and items cluster on what they share', async () => {
    const refused = await harness.post<ErrorBody>('/masters/duplicates/detect', { token: employeeToken, body: {} });
    expect(refused.status).toBe(403);

    const run = await harness.post<DuplicateDetectionResult[]>('/masters/duplicates/detect', { token: accountsToken, body: {} });
    expect(run.status).toBe(200);
    const parties = run.body.find((r) => r.entityType === 'party');
    expect(parties?.scanned).toBe(3);
    expect(parties?.clusters).toBe(1);
    expect(parties?.opened).toBe(1);
    const items = run.body.find((r) => r.entityType === 'stock_item');
    expect(items?.clusters).toBe(1);

    const list = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=party', { token: accountsToken });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const cluster = list.body.data[0];
    clusterId = cluster?.id ?? '';
    expect(cluster?.confidence).toBe(1);
    expect(cluster?.matchedFields).toEqual(expect.arrayContaining(['gstin', 'name', 'phone']));
    expect(cluster?.members.map((m) => m.name).sort()).toEqual(['Asha Traders Private Limited', 'Asha Traders Pvt Ltd']);
    expect(cluster?.state).toBe('open');
    expect(cluster?.impact.outstanding).toBe('6000.00');
    expect(cluster?.impact.recentTransactions).toBe(2);

    const itemClusters = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=stock_item', { token: accountsToken });
    expect(itemClusters.body.data[0]?.matchedFields).toEqual(expect.arrayContaining(['alias']));
    expect(itemClusters.body.data[0]?.members.map((m) => m.entityId)).toContain(cat6Box);
  });

  it('both rows wear the flag wherever the party or item is listed (REQ-AO-06)', async () => {
    const parties = await harness.get<Paginated<PartyView>>('/masters/parties', { token: adminToken });
    const pvt = parties.body.data.find((p) => p.id === ashaPvt);
    const behar = parties.body.data.find((p) => p.name === 'Behar Supply Co');
    expect(pvt?.duplicate?.clusterId).toBe(clusterId);
    expect(pvt?.duplicate?.others).toEqual(['Asha Traders Private Limited']);
    expect(behar?.duplicate).toBeNull();
    const one = await harness.get<PartyView>(`/masters/parties/${ashaPrivate}`, { token: adminToken });
    expect(one.body.duplicate?.others).toEqual(['Asha Traders Pvt Ltd']);
    const items = await harness.get<Paginated<StockItemView>>('/masters/items', { token: adminToken });
    expect(items.body.data.find((i) => i.id === cat6Box)?.duplicate).not.toBeNull();
    expect(items.body.data.find((i) => i.name === 'RCCB 40A 30mA DP')?.duplicate).toBeNull();
  });

  it('a dismissal needs a reason, stays dismissed across detections, and the flag comes off (REQ-AO-12)', async () => {
    const bare = await harness.post<ErrorBody>(`/masters/duplicates/${clusterId}/dismiss`, { token: accountsToken, body: { reason: '' } });
    expect(bare.status).toBe(400);
    const dismissed = await harness.post<DuplicateClusterView>(`/masters/duplicates/${clusterId}/dismiss`, { token: accountsToken, body: { reason: 'Two branches of one company, billed separately on purpose' } });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.state).toBe('dismissed');
    expect(dismissed.body.dismissedByName).not.toBeNull();

    await harness.post('/masters/duplicates/detect', { token: accountsToken, body: { entityType: 'party' } });
    const open = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=party', { token: accountsToken });
    expect(open.body.data).toHaveLength(0);
    const still = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=party&state=dismissed', { token: accountsToken });
    expect(still.body.data[0]?.id).toBe(clusterId);
    const parties = await harness.get<Paginated<PartyView>>('/masters/parties', { token: adminToken });
    expect(parties.body.data.find((p) => p.id === ashaPvt)?.duplicate).toBeNull();
  });

  it('comes back as a new cluster when a matched field changes, and resolves when a member leaves Tally', async () => {
    // The GSTIN changes on one of the pair: the old signature is gone, the name still matches -- raised anew.
    await harness.db.execute(sql`UPDATE parties SET gstin = '29ZZZPL0000Z1Z9' WHERE id = ${ashaPrivate}`);
    await harness.post('/masters/duplicates/detect', { token: accountsToken, body: { entityType: 'party' } });
    const again = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=party', { token: accountsToken });
    expect(again.body.data).toHaveLength(1);
    expect(again.body.data[0]?.id).not.toBe(clusterId);
    expect(again.body.data[0]?.matchedFields).not.toContain('gstin');
    expect(again.body.data[0]?.confidence).toBeGreaterThanOrEqual(0.75);
    const resolvedOld = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=party&state=resolved', { token: accountsToken });
    expect(resolvedOld.body.data.map((c) => c.id)).toContain(clusterId);

    const sent = await harness.post<DuplicateClusterView>(`/masters/duplicates/${again.body.data[0]?.id ?? ''}/sent-to-tally`, { token: accountsToken });
    expect(sent.body.state).toBe('sent_to_tally');

    // Merged in Tally: the next pull marks one absent; the cluster closes with no manual step.
    await harness.db.execute(sql`UPDATE parties SET absent_in_tally = true WHERE id = ${ashaPrivate}`);
    await harness.post('/masters/duplicates/detect', { token: accountsToken, body: { entityType: 'party' } });
    const after = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=party', { token: accountsToken });
    expect(after.body.data).toHaveLength(0);
    const closed = await harness.get<Paginated<DuplicateClusterView>>('/masters/duplicates?entityType=party&state=resolved', { token: accountsToken });
    expect(closed.body.data.map((c) => c.id)).toContain(sent.body.id);

    // Nothing in this area wrote to a master: the names are as they were inserted.
    const names = await harness.db.execute<{ name: string }>(sql`SELECT name FROM parties WHERE org_id = ${ORG_ID} ORDER BY name`);
    expect(names.rows.map((r) => r.name)).toEqual(['Asha Traders Private Limited', 'Asha Traders Pvt Ltd', 'Behar Supply Co']);
  });
});
