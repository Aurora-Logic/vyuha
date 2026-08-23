import { SYSTEM_ROLES, uuidv7, type CollectorAssignmentView, type CollectorDashboard, type CreditPosition, type Paginated, type PromiseView, type ReminderNoticeView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BrokenPromiseSweepHandler } from './broken-promise-sweep.handler.js';
import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Area AJ's acceptance (docs/15), over real HTTP. The rule the whole area
 * rests on: a promise's state is derived from the receipts Tally sent
 * against the named bills, never set by hand (REQ-AJ-02), and nothing
 * here writes to a balance (REQ-AJ-12). A broken promise flags the credit
 * check and never blocks an order (docs/11 D-54).
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0d1';

let harness: ApiHarness;
let adminToken = '';
let accountsToken = '';
let employeeToken = '';
let asha = '';
let behar = '';
let connectionId = '';
let collectorId = '';
let accountsRole = '';

interface ErrorBody {
  error: { code: string; message: string };
}

async function raiseBill(partyId: string, partyName: string, billName: string, amount: number, billDate: string, dueDate: string): Promise<void> {
  const voucher = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, ${billDate}, 'Sales', ${billName}, ${partyName}, ${partyId}, '', false, ${amount}, now()) RETURNING id
  `);
  await harness.db.execute(sql`
    INSERT INTO bill_allocations (org_id, connection_id, voucher_id, party_id, party_name, bill_name, ref_type, bill_date, due_date, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${voucher.rows[0]?.id ?? ''}, ${partyId}, ${partyName}, ${billName}, 'new', ${billDate}, ${dueDate}, ${amount}, now())
  `);
}

/** A receipt against a named bill, as Tally sends it: an `against` row, negative. */
async function receive(partyId: string, partyName: string, billName: string, amount: number, on: string): Promise<void> {
  const voucher = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, ${on}, 'Receipt', ${`RCT-${billName}`}, ${partyName}, ${partyId}, '', false, ${amount}, now()) RETURNING id
  `);
  await harness.db.execute(sql`
    INSERT INTO bill_allocations (org_id, connection_id, voucher_id, party_id, party_name, bill_name, ref_type, bill_date, due_date, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${voucher.rows[0]?.id ?? ''}, ${partyId}, ${partyName}, ${billName}, 'against', ${on}, ${on}, ${-amount}, now())
  `);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Collections Org');
  await harness.db.execute(sql`DELETE FROM reminder_notices WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM promises_to_pay WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM collector_assignments WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM bill_allocations WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const accountsRoleId = await harness.createSystemRole(SYSTEM_ROLES.ACCOUNTS, { isSystem: true });
  accountsRole = accountsRoleId;
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const collector = await harness.createEmployee({ code: 'CL-001', firstName: 'Meena', lastName: 'Collector' });
  collectorId = collector;
  const admin = await harness.createUser({ email: scopedEmail('coll-admin'), roleIds: [adminRoleId] });
  const accounts = await harness.createUser({ email: scopedEmail('coll-accounts'), roleIds: [accountsRoleId], employeeId: collector });
  const employee = await harness.createUser({ email: scopedEmail('coll-employee'), roleIds: [employeeRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  accountsToken = (await harness.login(accounts.email, accounts.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'Coll Co', 'guid-coll-co') RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';
  const one = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days, credit_limit, email)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Sundry Debtors', 30, 100000, 'accounts@asha.example') RETURNING id
  `);
  asha = one.rows[0]?.id ?? '';
  const two = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days) VALUES (${ORG_ID}, ${connectionId}, 'Behar Supply Co', 'Sundry Debtors', 15) RETURNING id
  `);
  behar = two.rows[0]?.id ?? '';

  // Asha: 40,000 raised long ago and overdue; Behar: 10,000, not yet due.
  await raiseBill(asha, 'Asha Traders', 'INV-A1', 40000, '2026-05-01', '2026-05-31');
  await raiseBill(behar, 'Behar Supply Co', 'INV-B1', 10000, '2026-08-20', '2099-12-31');
});

afterAll(async () => {
  await harness.close();
});

describe('Area AJ: collections', () => {
  let keptPromise = '';
  let brokenPromise = '';

  it('assigns a collector, one party at a time, and refuses a stranger', async () => {
    const refused = await harness.post<ErrorBody>('/collections/assignments', { token: employeeToken, body: { partyId: asha, collectorId, periodFrom: '2026-08-01' } });
    expect(refused.status).toBe(403);

    const first = await harness.post<CollectorAssignmentView>('/collections/assignments', { token: accountsToken, body: { partyId: asha, collectorId, targetAmount: '50000', periodFrom: '2026-08-01', periodTo: '2026-08-31' } });
    expect(first.status).toBe(201);
    expect(first.body.collectorName).toContain('Meena');
    await harness.post<CollectorAssignmentView>('/collections/assignments', { token: accountsToken, body: { partyId: behar, collectorId, periodFrom: '2026-08-01' } });

    // Assigning again replaces rather than doubles: one party, one collector (REQ-AJ-03).
    const again = await harness.post<CollectorAssignmentView>('/collections/assignments', { token: accountsToken, body: { partyId: asha, collectorId, targetAmount: '60000', periodFrom: '2026-08-01' } });
    expect(again.status).toBe(201);
    const list = await harness.get<Paginated<CollectorAssignmentView>>('/collections/assignments?page=1&pageSize=50', { token: accountsToken });
    expect(list.body.data.filter((a) => a.partyId === asha)).toHaveLength(1);
    expect(list.body.data.find((a) => a.partyId === asha)?.targetAmount).toBe('60000.00');
  });

  it('derives a promise from the receipts against its bills, and offers no way to say otherwise (REQ-AJ-02)', async () => {
    const taken = await harness.post<PromiseView>('/collections/promises', {
      token: accountsToken,
      body: { partyId: asha, amount: '40000', promisedDate: '2026-08-10', bills: ['INV-A1'], takenOn: '2026-08-01', notes: 'Said the funds clear on the 10th' },
    });
    expect(taken.status).toBe(201);
    expect(taken.body.state).toBe('broken');
    expect(taken.body.receivedAmount).toBe('0.00');
    brokenPromise = taken.body.id;

    // Nothing accepts a state: the only way to move it is a receipt from Tally.
    const forced = await harness.post<ErrorBody>(`/collections/promises/${brokenPromise}/keep`, { token: accountsToken, body: { state: 'kept' } });
    expect(forced.status).toBe(404);

    const future = await harness.post<PromiseView>('/collections/promises', { token: accountsToken, body: { partyId: behar, amount: '10000', promisedDate: '2099-01-01', bills: ['INV-B1'], takenOn: '2026-08-01' } });
    expect(future.body.state).toBe('open');
    keptPromise = future.body.id;

    // The receipt arrives against the named bill; the promise reads as kept without anyone touching it.
    await receive(behar, 'Behar Supply Co', 'INV-B1', 10000, '2026-08-21');
    const reread = await harness.get<PromiseView>(`/collections/promises/${keptPromise}`, { token: accountsToken });
    expect(reread.body.state).toBe('kept');
    expect(reread.body.receivedAmount).toBe('10000.00');
    expect(reread.body.receivedOn).toBe('2026-08-21');

    // Part of Asha's arrives, after the promised date: partly kept, not kept.
    await receive(asha, 'Asha Traders', 'INV-A1', 15000, '2026-08-18');
    const partly = await harness.get<PromiseView>(`/collections/promises/${brokenPromise}`, { token: accountsToken });
    expect(partly.body.state).toBe('partially_kept');
    expect(partly.body.receivedAmount).toBe('15000.00');

    // A receipt older than the promise does not count towards it.
    const earlier = await harness.post<PromiseView>('/collections/promises', { token: accountsToken, body: { partyId: asha, amount: '5000', promisedDate: '2026-08-25', bills: ['INV-A1'], takenOn: '2026-08-19' } });
    expect(earlier.body.receivedAmount).toBe('0.00');
  });

  it('refuses a promise for a date before it was taken, and one for a party that is not there', async () => {
    const backwards = await harness.post<ErrorBody>('/collections/promises', { token: accountsToken, body: { partyId: asha, amount: '100', promisedDate: '2026-07-01', takenOn: '2026-08-01' } });
    expect(backwards.status).toBe(400);
    const nobody = await harness.post<ErrorBody>('/collections/promises', { token: accountsToken, body: { partyId: '01900000-0000-7000-8000-0000000000ff', amount: '100', promisedDate: '2099-01-01' } });
    expect(nobody.status).toBe(404);
  });

  it('shows the collector their morning: outstanding, overdue, promises, collected against target (REQ-AJ-07)', async () => {
    const board = await harness.get<CollectorDashboard>('/collections/dashboard?from=2026-08-01&to=2026-08-31', { token: accountsToken });
    expect(board.status).toBe(200);
    expect(board.body.assignedParties).toBe(2);
    // Asha owes 40,000 less the 15,000 received; Behar's 10,000 is settled.
    expect(board.body.totalOutstanding).toBe('25000.00');
    expect(board.body.overdue).toBe('25000.00');
    const ashaRow = board.body.rows.find((r) => r.partyId === asha);
    expect(ashaRow?.outstanding).toBe('25000.00');
    expect(ashaRow?.brokenPromises).toBeGreaterThanOrEqual(1);
    // Both receipts landed in August; they count towards the period.
    expect(Number(board.body.collectedThisPeriod)).toBe(25000);
    expect(board.body.target).toBe('60000.00');

    const refused = await harness.get<ErrorBody>('/collections/dashboard', { token: employeeToken });
    expect(refused.status).toBe(403);
  });

  it('flags the credit check with the broken promise and never blocks on it (REQ-AJ-10 / D-54)', async () => {
    const order = await harness.post<{ id: string; number: string; status: string }>('/sales/orders', { token: adminToken, body: { partyId: asha, lines: [{ description: 'Cable', quantity: '1', rate: '500' }] } });
    expect(order.status).toBe(201);
    const position = await harness.get<CreditPosition>(`/sales/orders/${order.body.id}/credit-position`, { token: adminToken });
    expect(position.status).toBe(200);
    expect(position.body.brokenPromises).toBeGreaterThanOrEqual(1);
    expect(Number(position.body.brokenPromiseAmount)).toBeGreaterThan(0);
    // Well within the limit: the broken promise is a flag beside it, not a second gate.
    const confirmed = await harness.post<{ status: string }>(`/sales/orders/${order.body.id}/confirm`, { token: adminToken });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
  });

  it('records a reminder with the statement date and the bills behind it (REQ-AJ-05/06)', async () => {
    const sent = await harness.post<readonly ReminderNoticeView[]>('/collections/reminders', { token: accountsToken, body: { partyId: asha, channels: ['email', 'whatsapp'], asOf: '2026-08-22' } });
    expect(sent.status).toBe(201);
    expect(sent.body).toHaveLength(2);
    const email = sent.body.find((n) => n.channel === 'email');
    const whatsapp = sent.body.find((n) => n.channel === 'whatsapp');
    expect(email?.status).toBe('sent');
    expect(email?.recipient).toBe('accounts@asha.example');
    expect(email?.statementAsOf).toBe('2026-08-22');
    expect(email?.outstandingAtSend).toBe('25000.00');
    expect(email?.composedText).toContain('INV-A1');
    expect(email?.composedText).toContain('25,000.00');
    // WhatsApp waits for a person to say it went: the manual fallback.
    expect(whatsapp?.status).toBe('pending');
    const marked = await harness.post<ReminderNoticeView>(`/collections/reminders/${whatsapp?.id ?? ''}/sent`, { token: accountsToken });
    expect(marked.body.status).toBe('sent');
    expect(marked.body.sentAt).not.toBeNull();

    const history = await harness.get<Paginated<ReminderNoticeView>>(`/collections/parties/${asha}/reminders`, { token: accountsToken });
    expect(history.body.meta.total).toBe(2);

    const nothing = await harness.post<ErrorBody>('/collections/reminders', { token: accountsToken, body: { partyId: behar, channels: ['email'] } });
    expect(nothing.status).toBe(409);
  });

  it('never writes a balance: the allocations and vouchers are exactly as Tally left them (REQ-AJ-12)', async () => {
    const totals = await harness.db.execute<{ allocations: string; vouchers: string; sum: string }>(sql`
      SELECT (SELECT count(*) FROM bill_allocations WHERE org_id = ${ORG_ID})::text AS allocations,
             (SELECT count(*) FROM vouchers WHERE org_id = ${ORG_ID})::text AS vouchers,
             (SELECT coalesce(sum(amount), 0) FROM bill_allocations WHERE org_id = ${ORG_ID})::text AS sum
    `);
    // Two bills raised, two receipts: four allocation rows, four vouchers, 25,000 net.
    expect(totals.rows[0]?.allocations).toBe('4');
    expect(totals.rows[0]?.vouchers).toBe('4');
    expect(Number(totals.rows[0]?.sum)).toBe(25000);
  });

  it('scopes by the collector: another collector sees none of it, an all-holder sees everything', async () => {
    const otherEmployee = await harness.createEmployee({ code: 'CL-002', firstName: 'Ravi', lastName: 'Other' });
    const other = await harness.createUser({ email: scopedEmail('coll-other'), roleIds: [accountsRole], employeeId: otherEmployee });
    const otherToken = (await harness.login(other.email, other.password)).token;
    // Accounts holds the all key, so a second collector still sees the organisation's work.
    const board = await harness.get<CollectorDashboard>('/collections/dashboard', { token: otherToken });
    expect(board.body.assignedParties).toBe(2);
    const mine = await harness.get<CollectorDashboard>(`/collections/dashboard?collectorId=${collectorId}`, { token: otherToken });
    expect(mine.body.collector?.name).toContain('Meena');
  });

  it('filters and counts promises by state across the whole set, not one page (audit 9)', async () => {
    // Six more open promises, so a page of two cannot hold them all.
    for (let n = 0; n < 6; n += 1) {
      const made = await harness.post<PromiseView>('/collections/promises', {
        token: accountsToken,
        body: { partyId: asha, amount: '100', promisedDate: '2099-02-0' + String(n + 1), bills: ['INV-PAGE-' + String(n)], takenOn: '2026-08-01' },
      });
      expect(made.body.state).toBe('open');
    }

    const whole = await harness.get<{ data: PromiseView[]; meta: { total: number } }>('/collections/promises?state=open&page=1&pageSize=100', { token: accountsToken });
    expect(whole.status).toBe(200);
    const openCount = whole.body.meta.total;
    expect(openCount).toBeGreaterThanOrEqual(7);
    expect(whole.body.data).toHaveLength(openCount);
    expect(whole.body.data.every((p) => p.state === 'open')).toBe(true);

    // The filter used to run over one page: a page of two returned however
    // many of those two were open, and reported that as the total.
    const paged = await harness.get<{ data: PromiseView[]; meta: { total: number } }>('/collections/promises?state=open&page=1&pageSize=2', { token: accountsToken });
    expect(paged.body.data).toHaveLength(2);
    expect(paged.body.meta.total).toBe(openCount);
    expect(paged.body.data.every((p) => p.state === 'open')).toBe(true);

    // A page beyond the first is reachable, which it was not when the filter
    // only saw page one's rows.
    const second = await harness.get<{ data: PromiseView[] }>('/collections/promises?state=open&page=2&pageSize=2', { token: accountsToken });
    expect(second.body.data).toHaveLength(2);
    expect(second.body.data.every((p) => p.state === 'open')).toBe(true);
    expect(second.body.data.map((p) => p.id)).not.toEqual(paged.body.data.map((p) => p.id));

    // The state the row shows is the state it was filtered by: the SQL that
    // selects and the function that derives agree, or these disagree.
    const broken = await harness.get<{ data: PromiseView[]; meta: { total: number } }>('/collections/promises?state=broken&page=1&pageSize=100', { token: accountsToken });
    expect(broken.body.data.every((p) => p.state === 'broken')).toBe(true);
    expect(broken.body.meta.total).toBe(broken.body.data.length);
  });

  it('re-reads a kept promise after Tally cancels the receipt behind it (audit 10)', async () => {
    // The stored state is what the reports, the sweep's notice and the credit
    // flag read. The sweep used to look only at open, partly kept and broken
    // promises, which made kept absorbing -- but Tally is the system of
    // record and a receipt can be cancelled there, so a promise stayed kept
    // against money that had gone away.
    //
    // Its own bill and its own receipt, so cancelling one voucher cannot
    // reach any other test's arithmetic.
    const promise = await harness.post<PromiseView>('/collections/promises', {
      token: accountsToken,
      body: { partyId: behar, amount: '7000', promisedDate: '2026-08-20', bills: ['INV-CANCELME'], takenOn: '2026-08-01' },
    });
    const promiseId = promise.body.id;
    await receive(behar, 'Behar Supply Co', 'INV-CANCELME', 7000, '2026-08-19');

    const stored = async (): Promise<string> =>
      (await harness.db.execute<{ state: string }>(sql`SELECT state FROM promises_to_pay WHERE id = ${promiseId}`)).rows[0]?.state ?? '';

    const sweep = harness.resolve(BrokenPromiseSweepHandler);
    await sweep.run({ now: '2026-08-22T02:00:00.000Z' }, { jobId: 'test', attempt: 1 });
    expect(await stored()).toBe('kept');

    // Tally cancels the receipt and the next pull brings the cancellation.
    await harness.db.execute(sql`
      UPDATE vouchers SET is_cancelled = true WHERE org_id = ${ORG_ID} AND voucher_number = 'RCT-INV-CANCELME'
    `);
    await sweep.run({ now: '2026-08-22T02:00:00.000Z' }, { jobId: 'test', attempt: 1 });
    // Promised on the 20th, nothing received, read on the 22nd: broken.
    expect(await stored()).toBe('broken');

    const reread = await harness.get<PromiseView>(`/collections/promises/${promiseId}`, { token: accountsToken });
    expect(reread.body.receivedAmount).toBe('0.00');
    expect(reread.body.state).toBe('broken');
  });


  it('a self-scoped collector reads only their own parties\' bills and reminders (audit 0)', async () => {
    // Every other collections read narrows by the collector scope. The party's
    // bills and its reminder history did not, so a holder of
    // `collections.view.self` could read the open bills of any party in the
    // organisation by passing its id -- and `GET /masters/parties` hands those
    // ids out to anyone who can raise a promise.
    // A code of its own each run: resetOrganisation keeps people, because an
    // employee who has ever punched can never be deleted.
    const code = `CL-${uuidv7().slice(-8)}`;
    const otherEmployee = await harness.createEmployee({ code, firstName: 'Nita', lastName: 'Collector' });
    const selfRoleId = await harness.createRole('Collector Self Only', ['collections.view.self']);
    const nita = await harness.createUser({ email: scopedEmail('coll-nita'), roleIds: [selfRoleId], employeeId: otherEmployee });
    const nitaToken = (await harness.login(nita.email, nita.password)).token;

    // A party of her own with a real open bill, so the empty answer below is
    // the scope talking and not an empty fixture. Behar's bills net to nought,
    // which would have proved nothing either way.
    const mine = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group, credit_days)
      VALUES (${ORG_ID}, ${connectionId}, ${`Nita's Customer ${code}`}, 'Sundry Debtors', 30)
      RETURNING id
    `);
    const herParty = mine.rows[0]?.id ?? '';
    await raiseBill(herParty, `Nita's Customer ${code}`, `INV-N-${code}`, 12000, '2026-08-02', '2026-09-01');
    await harness.post('/collections/assignments', { token: accountsToken, body: { partyId: herParty, collectorId: otherEmployee, periodFrom: '2026-08-01' } });

    type Bills = { data?: unknown[] } | unknown[];
    const rowsOf = (body: Bills): unknown[] => (Array.isArray(body) ? body : (body.data ?? []));

    const hers = await harness.get<Bills>(`/collections/parties/${herParty}/bills`, { token: nitaToken });
    expect(hers.status).toBe(200);
    expect(rowsOf(hers.body).length, 'her own party has bills, so an empty answer below means the scope and not an empty fixture').toBeGreaterThan(0);

    // Asha is somebody else's party.
    const theirs = await harness.get<Bills>(`/collections/parties/${asha}/bills`, { token: nitaToken });
    expect(theirs.status).toBe(200);
    expect(rowsOf(theirs.body)).toEqual([]);

    const theirReminders = await harness.get<{ data: unknown[]; meta: { total: number } }>(`/collections/parties/${asha}/reminders`, { token: nitaToken });
    expect(theirReminders.status).toBe(200);
    expect(theirReminders.body.data).toEqual([]);
    // The count has to agree with the rows, or the pager offers pages of nothing.
    expect(theirReminders.body.meta.total).toBe(0);

    // And an accounts holder, who may see everyone's, still does.
    const all = await harness.get<Bills>(`/collections/parties/${asha}/bills`, { token: accountsToken });
    expect(rowsOf(all.body).length).toBeGreaterThan(0);
  });
});
