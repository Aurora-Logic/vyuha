import { SYSTEM_ROLES, TASK_ITEM_CAP, type Paginated, type TaskView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * REQ-V-09 and REQ-V-10: the customer, the supplier and the stock items a
 * task is about.
 *
 * The property worth pinning is that the two party fields are not
 * interchangeable. A customer chosen in the vendor box is a mistake the
 * server refuses, because the alternative is a row that reads "Vendor: Acme
 * Trading Co" for the rest of its life and nobody ever notices.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f1c6';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let token = '';
let customerId = '';
let secondCustomerId = '';
let supplierId = '';
let bankLedgerId = '';
let cableId = '';
let couplerId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Task Links Fixture Org');
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  // The fixture connection outlives `resetOrganisation`, and its unique index
  // is partial on `deleted_at IS NULL` -- retiring it frees the name for this
  // run, exactly as the deals suite does.
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeId = await harness.createEmployee({ code: 'TL-001', firstName: 'Ravi', lastName: 'Kumar' });
  const user = await harness.createUser({ email: scopedEmail('tl-admin'), roleIds: [adminRoleId], employeeId });
  token = (await harness.login(user.email, user.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Links Co', 'guid-links-co') RETURNING id
  `);
  const connectionId = connection.rows[0]?.id ?? '';

  const party = async (name: string, group: string) => {
    const row = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group)
      VALUES (${ORG_ID}, ${connectionId}, ${name}, ${group}) RETURNING id
    `);
    return row.rows[0]?.id ?? '';
  };
  customerId = await party('Acme Trading Co', 'Sundry Debtors');
  secondCustomerId = await party('Bharat Infra', 'Sundry Debtors');
  supplierId = await party('Sanghvi Polymers', 'Sundry Creditors');
  // Neither a customer nor a supplier: a ledger that belongs in no task field.
  bankLedgerId = await party('HDFC Current A/c', 'Bank Accounts');

  const item = async (name: string) => {
    const row = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group, gst_rate)
      VALUES (${ORG_ID}, ${connectionId}, ${name}, 'NOS', 'Pipes', '18.00') RETURNING id
    `);
    return row.rows[0]?.id ?? '';
  };
  cableId = await item('HDPE pipe 90mm');
  couplerId = await item('Coupler 90mm');
});

afterAll(async () => {
  await harness.close();
});

async function makeTask(body: Record<string, unknown>) {
  return harness.post<TaskView>('/tasks', { token, body: { title: 'Chase the delivery', ...body } });
}

describe('a task names a customer and a supplier (REQ-V-09)', () => {
  it('carries both at once, with their names snapshotted', async () => {
    const response = await makeTask({ partyId: customerId, vendorId: supplierId });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      partyId: customerId,
      partyName: 'Acme Trading Co',
      vendorId: supplierId,
      vendorName: 'Sanghvi Polymers',
    });
  });

  it('refuses a customer in the vendor field, and a supplier in the party field', async () => {
    // The failure this prevents: a row reading "Vendor: Acme Trading Co" for
    // ever, because nothing ever checked which side of the ledger it was on.
    const asVendor = await harness.post<ErrorBody>('/tasks', {
      token,
      body: { title: 'Wrong way round', vendorId: customerId },
    });
    expect(asVendor.status).toBe(400);
    expect(asVendor.body.error.message).toContain('Sundry Creditors');

    const asParty = await harness.post<ErrorBody>('/tasks', {
      token,
      body: { title: 'Wrong way round', partyId: supplierId },
    });
    expect(asParty.status).toBe(400);
    expect(asParty.body.error.message).toContain('Sundry Debtors');
  });

  it('refuses a ledger that is neither', async () => {
    const response = await harness.post<ErrorBody>('/tasks', {
      token,
      body: { title: 'A bank is not a customer', partyId: bankLedgerId },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a party that does not exist, and one from another organisation', async () => {
    const response = await harness.post<ErrorBody>('/tasks', {
      token,
      body: { title: 'Ghost', partyId: '01900000-0000-7000-8000-0000000000ff' },
    });
    expect(response.status).toBe(400);
  });

  it('clears a link with null and leaves it alone when the field is absent', async () => {
    const created = await makeTask({ partyId: customerId, vendorId: supplierId });
    const id = created.body.id;

    const untouched = await harness.patch<TaskView>(`/tasks/${id}`, { token, body: { title: 'Renamed only' } });
    expect(untouched.body.partyId).toBe(customerId);
    expect(untouched.body.vendorId).toBe(supplierId);

    const cleared = await harness.patch<TaskView>(`/tasks/${id}`, { token, body: { partyId: null } });
    expect(cleared.body.partyId).toBeNull();
    expect(cleared.body.partyName).toBeNull();
    // Clearing one must not clear the other.
    expect(cleared.body.vendorId).toBe(supplierId);
  });
});

describe('a task names stock items (REQ-V-10)', () => {
  it('keeps them in the order they were given', async () => {
    const response = await makeTask({ items: [{ itemId: couplerId }, { itemId: cableId }] });
    expect(response.status).toBe(201);
    expect(response.body.items.map((item) => item.itemName)).toEqual(['Coupler 90mm', 'HDPE pipe 90mm']);
    expect(response.body.items[0]).toMatchObject({ itemId: couplerId });
  });

  it('drops a repeat rather than refusing it', async () => {
    // Picking the same coupler twice is a slip. A task carries no quantities,
    // so a second row would mean nothing.
    const response = await makeTask({ items: [{ itemId: cableId }, { itemId: cableId }] });
    expect(response.status).toBe(201);
    expect(response.body.items).toHaveLength(1);
  });

  it('replaces the whole list on update, and an empty array clears it', async () => {
    const created = await makeTask({ items: [{ itemId: cableId }, { itemId: couplerId }] });
    const id = created.body.id;

    const replaced = await harness.patch<TaskView>(`/tasks/${id}`, { token, body: { items: [{ itemId: couplerId }] } });
    expect(replaced.body.items.map((item) => item.itemId)).toEqual([couplerId]);

    const cleared = await harness.patch<TaskView>(`/tasks/${id}`, { token, body: { items: [] } });
    expect(cleared.body.items).toEqual([]);

    // Absent leaves them alone, which is what a drag on the board sends.
    const dragged = await harness.patch<TaskView>(`/tasks/${id}`, { token, body: { priority: 'HIGH' } });
    expect(dragged.body.items).toEqual([]);
  });

  it('lets an item be added back after it was removed', async () => {
    // The unique index is partial on `deleted_at IS NULL`; a soft delete would
    // leave a row that blocks exactly this.
    const created = await makeTask({ items: [{ itemId: cableId }] });
    const id = created.body.id;
    await harness.patch<TaskView>(`/tasks/${id}`, { token, body: { items: [] } });
    const again = await harness.patch<TaskView>(`/tasks/${id}`, { token, body: { items: [{ itemId: cableId }] } });
    expect(again.status).toBe(200);
    expect(again.body.items.map((item) => item.itemId)).toEqual([cableId]);
  });

  it('refuses an item that does not exist, naming which one', async () => {
    const ghost = '01900000-0000-7000-8000-0000000000fe';
    const response = await harness.post<ErrorBody>('/tasks', {
      token,
      body: { title: 'Ghost item', items: [{ itemId: cableId }, { itemId: ghost }] },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details?.itemIds).toEqual([ghost]);
  });

  it('refuses more items than a task is meant to carry', async () => {
    const tooMany = Array.from({ length: TASK_ITEM_CAP + 1 }, () => cableId);
    const response = await harness.post<ErrorBody>('/tasks', {
      token,
      body: { title: 'A picking list in disguise', items: tooMany.map((id) => ({ itemId: id })) },
    });
    expect(response.status).toBe(400);
  });
});

describe('the register filters by them', () => {
  it('finds every task about one customer, one supplier or one item', async () => {
    const marker = 'Filter fixture';
    await makeTask({ title: `${marker} party`, partyId: secondCustomerId });
    await makeTask({ title: `${marker} vendor`, vendorId: supplierId });
    await makeTask({ title: `${marker} item`, items: [{ itemId: couplerId }] });

    const byParty = await harness.get<Paginated<TaskView>>(`/tasks?partyId=${secondCustomerId}&pageSize=100`, { token });
    expect(byParty.body.data.every((task) => task.partyId === secondCustomerId)).toBe(true);
    expect(byParty.body.data.length).toBeGreaterThan(0);

    const byVendor = await harness.get<Paginated<TaskView>>(`/tasks?vendorId=${supplierId}&pageSize=100`, { token });
    expect(byVendor.body.data.every((task) => task.vendorId === supplierId)).toBe(true);

    const byItem = await harness.get<Paginated<TaskView>>(`/tasks?itemId=${couplerId}&pageSize=100`, { token });
    expect(byItem.body.data.length).toBeGreaterThan(0);
    expect(byItem.body.data.every((task) => task.items.some((item) => item.itemId === couplerId))).toBe(true);
  });

  it('returns a task once however many items it names', async () => {
    // An inner join would page a task twice the moment it named two items.
    const created = await makeTask({ title: 'Two items, one row', items: [{ itemId: cableId }, { itemId: couplerId }] });
    const listed = await harness.get<Paginated<TaskView>>('/tasks?pageSize=100', { token });
    expect(listed.body.data.filter((task) => task.id === created.body.id)).toHaveLength(1);
  });
});

/**
 * REQ-V-17 (owner, 2 Sep 2026): "immediately place order — select party,
 * select item, qty and disc, total."
 *
 * The task carries the order as agreed. What matters at this boundary is that
 * the numbers survive it exactly: these become a sales order's lines, and a
 * line that changed value in the crossing is the worst bug this path could
 * have.
 */
describe('a task carries the order somebody placed', () => {
  it('keeps quantity, rate and discount exactly as given, and prices the line', async () => {
    const response = await makeTask({
      partyId: customerId,
      items: [{ itemId: cableId, quantity: '2.5', rate: '1200.50', discountPct: '10' }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.items[0]).toMatchObject({
      itemId: cableId,
      quantity: '2.500',
      rate: '1200.50',
      discountPct: '10.00',
      // 2.5 x 1200.50 = 3001.25, less 10% = 2701.125, rounded to 2701.13.
      amount: '2701.13',
    });
  });

  it('leaves an unpriced item unpriced rather than calling it zero', async () => {
    // An enquiry is a real state: somebody has asked for three of something
    // before anybody has said what it costs.
    const response = await makeTask({ items: [{ itemId: cableId, quantity: '3' }] });
    expect(response.status).toBe(201);
    expect(response.body.items[0]).toMatchObject({ quantity: '3.000', rate: null, amount: null });
  });

  it('defaults a bare item to one, so the old shape still means what it did', async () => {
    const response = await makeTask({ items: [{ itemId: cableId }] });
    expect(response.status).toBe(201);
    expect(response.body.items[0]).toMatchObject({ quantity: '1.000', discountPct: '0.00' });
  });

  it('refuses a quantity or a discount that is not one', async () => {
    for (const bad of [
      { itemId: cableId, quantity: '-1' },
      { itemId: cableId, quantity: 'many' },
      { itemId: cableId, discountPct: '120' },
      { itemId: cableId, rate: '10.999' },
    ]) {
      const response = await makeTask({ items: [bad] });
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('takes the last word when the same item is given twice', async () => {
    // A repeat is a slip, not two of them -- re-adding is how a quantity is
    // corrected.
    const response = await makeTask({
      items: [
        { itemId: cableId, quantity: '2' },
        { itemId: cableId, quantity: '7' },
      ],
    });
    expect(response.status).toBe(201);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]?.quantity).toBe('7.000');
  });
});
