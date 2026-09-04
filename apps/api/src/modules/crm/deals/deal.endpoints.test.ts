import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type CompanyView,
  type ContactView,
  type DealBoardView,
  type DealView,
  type Paginated,
  type PipelineStageView,
  type PipelineView,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * Pipelines and deals (REQ-U-03…U-05). Pins: the default pipeline appears
 * on first read and is configuration thereafter; a deal lands in the first
 * open stage; a stage move is one audited write and won/lost closes; the
 * board is the list grouped by stage with a value total per lane; ownership
 * scopes like contacts; and the won company links to a Tally party by a
 * person's hand, never by name.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d4';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken: string;
let salesToken: string;
let salesEmployeeId = '';
let partyId = '';
let acmeId = '';
let ashaId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Deals Fixture Org');
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const salesRoleId = await harness.createRole('Sales', [
    PERMISSIONS.CRM_CONTACT_VIEW_SELF,
    PERMISSIONS.CRM_CONTACT_MANAGE,
    PERMISSIONS.CRM_DEAL_VIEW_SELF,
    PERMISSIONS.CRM_DEAL_MANAGE,
  ]);
  salesEmployeeId = await harness.createEmployee({ code: 'DL-001', firstName: 'Ravi', lastName: 'Kumar' });
  const admin = await harness.createUser({ email: scopedEmail('deals-admin'), roleIds: [adminRoleId] });
  const sales = await harness.createUser({ email: scopedEmail('deals-sales'), roleIds: [salesRoleId], employeeId: salesEmployeeId });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  salesToken = (await harness.login(sales.email, sales.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Deals Co', 'guid-deals-co') RETURNING id
  `);
  const party = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group)
    VALUES (${ORG_ID}, ${connection.rows[0]?.id ?? ''}, 'Acme Trading Co', 'Sundry Debtors') RETURNING id
  `);
  partyId = party.rows[0]?.id ?? '';

  // Owned by the salesperson, so their view.self reaches both (a deal may
  // only name a company and contact its owner can see).
  const acme = await harness.post<CompanyView>('/crm/companies', { token: salesToken, body: { name: 'Acme Trading Co' } });
  acmeId = acme.body.id;
  const asha = await harness.post<ContactView>('/crm/contacts', {
    token: salesToken,
    body: { name: 'Asha Menon', companyId: acmeId },
  });
  ashaId = asha.body.id;
});

afterAll(async () => {
  await harness.close();
});

let pipeline: PipelineView;
let stages: PipelineStageView[] = [];
let dealId = '';

describe('pipelines are configuration (REQ-U-04)', () => {
  it('ships one on first read, with a won and a lost stage at the end', async () => {
    const response = await harness.get<PipelineView[]>('/crm/pipelines', { token: salesToken });
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    const first = response.body[0];
    if (first === undefined) throw new Error('no pipeline');
    pipeline = first;
    stages = [...first.stages];
    expect(first.isDefault).toBe(true);
    expect(first.stages.map((s) => [s.name, s.probability, s.isWon, s.isLost])).toEqual([
      ['Lead', 10, false, false],
      ['Qualified', 30, false, false],
      ['Proposal', 60, false, false],
      ['Negotiation', 80, false, false],
      ['Won', 100, true, false],
      ['Lost', 0, false, true],
    ]);
  });

  it('crm.pipeline.manage adds a stage, renames it, reorders, refuses a won-and-lost stage, and removes it', async () => {
    const forbidden = await harness.post<ErrorBody>(`/crm/pipelines/${pipeline.id}/stages`, {
      token: salesToken,
      body: { name: 'Demo' },
    });
    expect(forbidden.status).toBe(403);

    const created = await harness.post<PipelineStageView>(`/crm/pipelines/${pipeline.id}/stages`, {
      token: adminToken,
      body: { name: 'Demo', probability: 45 },
    });
    expect(created.status).toBe(201);
    expect(created.body.sortOrder).toBe(6);

    const both = await harness.patch<ErrorBody>(`/crm/pipelines/${pipeline.id}/stages/${created.body.id}`, {
      token: adminToken,
      body: { isWon: true, isLost: true },
    });
    expect(both.status).toBe(400);

    const renamed = await harness.patch<PipelineStageView>(`/crm/pipelines/${pipeline.id}/stages/${created.body.id}`, {
      token: adminToken,
      body: { name: 'Demo given', probability: 50 },
    });
    expect(renamed.body.name).toBe('Demo given');

    const order = [stages[0]?.id, stages[1]?.id, created.body.id, stages[2]?.id, stages[3]?.id, stages[4]?.id, stages[5]?.id];
    const reordered = await harness.put<PipelineView>(`/crm/pipelines/${pipeline.id}/stages/order`, {
      token: adminToken,
      body: { stageIds: order },
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.stages.map((s) => s.name)[2]).toBe('Demo given');

    const partial = await harness.put<ErrorBody>(`/crm/pipelines/${pipeline.id}/stages/order`, {
      token: adminToken,
      body: { stageIds: [created.body.id] },
    });
    expect(partial.status).toBe(400);

    const removed = await harness.del(`/crm/pipelines/${pipeline.id}/stages/${created.body.id}`, { token: adminToken });
    expect(removed.status).toBe(204);
    expect(await harness.waitForAuditAction('crm.pipeline.stage.deleted')).toBe(true);
  });

  it('a second pipeline can be made the default, and the only default cannot be unset', async () => {
    const created = await harness.post<PipelineView>('/crm/pipelines', {
      token: adminToken,
      body: { name: 'Exports', isDefault: true },
    });
    expect(created.status).toBe(201);
    expect(created.body.isDefault).toBe(true);
    const list = await harness.get<PipelineView[]>('/crm/pipelines', { token: adminToken });
    expect(list.body.filter((p) => p.isDefault).map((p) => p.name)).toEqual(['Exports']);

    const unset = await harness.patch<ErrorBody>(`/crm/pipelines/${created.body.id}`, { token: adminToken, body: { isDefault: false } });
    expect(unset.status).toBe(409);

    // Back to Sales as the default for the rest of the file.
    const back = await harness.patch<PipelineView>(`/crm/pipelines/${pipeline.id}`, { token: adminToken, body: { isDefault: true } });
    expect(back.body.isDefault).toBe(true);
  });
});

describe('deals (REQ-U-05)', () => {
  it('lands in the default pipeline’s first open stage, owned by the creator, with the value kept as text', async () => {
    const created = await harness.post<DealView>('/crm/deals', {
      token: salesToken,
      body: { name: 'Acme annual supply', companyId: acmeId, contactId: ashaId, value: '1250000.50', expectedCloseDate: '2026-09-30' },
    });
    expect(created.status).toBe(201);
    expect(created.body.stageName).toBe('Lead');
    expect(created.body.probability).toBe(10);
    expect(created.body.status).toBe('open');
    expect(created.body.value).toBe('1250000.50');
    expect(created.body.ownerId).toBe(salesEmployeeId);
    expect(created.body.companyName).toBe('Acme Trading Co');
    expect(created.body.contactName).toBe('Asha Menon');
    expect(created.body.partyId).toBeNull();
    dealId = created.body.id;
    expect(await harness.waitForAuditAction('crm.deal.created')).toBe(true);
  });

  it('refuses a contact from another company, a bad value, and a stage outside the pipeline', async () => {
    const other = await harness.post<CompanyView>('/crm/companies', { token: adminToken, body: { name: 'Behar Supply' } });
    const mismatch = await harness.post<ErrorBody>('/crm/deals', {
      token: adminToken,
      body: { name: 'Mismatch', companyId: other.body.id, contactId: ashaId },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.message).toContain('Asha Menon belongs to Acme Trading Co');

    const badValue = await harness.post<ErrorBody>('/crm/deals', { token: adminToken, body: { name: 'Bad', value: '1,000' } });
    expect(badValue.status).toBe(400);

    const badStage = await harness.patch<ErrorBody>(`/crm/deals/${dealId}`, {
      token: salesToken,
      body: { stageId: '01900000-0000-7000-8000-00000000dead' },
    });
    expect(badStage.status).toBe(400);
  });

  it('a stage move is one audited write; entering Won closes and records deal.won', async () => {
    const proposal = stages.find((s) => s.name === 'Proposal');
    const won = stages.find((s) => s.isWon);
    const moved = await harness.patch<DealView>(`/crm/deals/${dealId}`, { token: salesToken, body: { stageId: proposal?.id } });
    expect(moved.body.stageName).toBe('Proposal');
    expect(moved.body.probability).toBe(60);
    expect(await harness.waitForAuditAction('crm.deal.stage_changed')).toBe(true);

    const closed = await harness.patch<DealView>(`/crm/deals/${dealId}`, { token: salesToken, body: { stageId: won?.id } });
    expect(closed.body.status).toBe('won');
    expect(closed.body.closedAt).not.toBeNull();
    expect(await harness.waitForAuditAction('crm.deal.won')).toBe(true);

    // Won deals leave the default (open) list and are found under status=won.
    const open = await harness.get<Paginated<DealView>>('/crm/deals', { token: salesToken });
    expect(open.body.data.map((d) => d.name)).toEqual([]);
    const wonList = await harness.get<Paginated<DealView>>('/crm/deals?status=won', { token: salesToken });
    expect(wonList.body.data.map((d) => d.name)).toEqual(['Acme annual supply']);
  });

  it('REQ-U-03: the won company is linked to its Tally party by hand, and the deal shows the link', async () => {
    const missing = await harness.put<ErrorBody>(`/crm/companies/${acmeId}/party`, {
      token: adminToken,
      body: { partyId: '01900000-0000-7000-8000-00000000dead' },
    });
    expect(missing.status).toBe(400);

    const linked = await harness.put<CompanyView>(`/crm/companies/${acmeId}/party`, { token: adminToken, body: { partyId } });
    expect(linked.status).toBe(200);
    expect(linked.body.partyId).toBe(partyId);
    expect(await harness.waitForAuditAction('crm.company.party_linked')).toBe(true);

    const deal = await harness.get<DealView>(`/crm/deals/${dealId}`, { token: salesToken });
    expect(deal.body.partyId).toBe(partyId);
  });

  it('the board is the list by stage, every stage a lane, values summed per lane', async () => {
    await harness.post<DealView>('/crm/deals', { token: salesToken, body: { name: 'Acme spares', companyId: acmeId, value: '4000' } });
    await harness.post<DealView>('/crm/deals', { token: salesToken, body: { name: 'Acme service', companyId: acmeId, value: '600.25' } });

    const board = await harness.get<DealBoardView>('/crm/deals/board', { token: salesToken });
    expect(board.status).toBe(200);
    expect(board.body.pipeline.name).toBe('Sales');
    const byName = Object.fromEntries(board.body.lanes.map((l) => [l.stage.name, [l.total, l.valueTotal]]));
    expect(byName.Lead).toEqual([2, '4600.25']);
    expect(byName.Won).toEqual([1, '1250000.50']);
    expect(byName.Lost).toEqual([0, '0']);

    const filtered = await harness.get<DealBoardView>('/crm/deals/board?q=spares', { token: salesToken });
    expect(filtered.body.lanes.find((l) => l.stage.name === 'Lead')?.deals.map((d) => d.name)).toEqual(['Acme spares']);
  });

  it('view.self sees only what it owns; view.all sees all and may reassign', async () => {
    const adminDeal = await harness.post<DealView>('/crm/deals', { token: adminToken, body: { name: 'Admin’s deal' } });
    const mine = await harness.get<Paginated<DealView>>('/crm/deals?status=all', { token: salesToken });
    expect(mine.body.data.map((d) => d.name).sort()).toEqual(['Acme annual supply', 'Acme service', 'Acme spares']);
    const hidden = await harness.get<ErrorBody>(`/crm/deals/${adminDeal.body.id}`, { token: salesToken });
    expect(hidden.status).toBe(404);

    const giveAway = await harness.post<ErrorBody>('/crm/deals', { token: salesToken, body: { name: 'Given', ownerId: '01900000-0000-7000-8000-00000000beef' } });
    expect(giveAway.status).toBe(403);

    const handed = await harness.patch<DealView>(`/crm/deals/${adminDeal.body.id}`, { token: adminToken, body: { ownerId: salesEmployeeId } });
    expect(handed.body.ownerName).toBe('Ravi Kumar');
    const now = await harness.get<DealView>(`/crm/deals/${adminDeal.body.id}`, { token: salesToken });
    expect(now.status).toBe(200);
  });

  it('a stage with deals refuses to go; a deal deletes and leaves the board', async () => {
    const lead = stages.find((s) => s.name === 'Lead');
    const refused = await harness.del<ErrorBody>(`/crm/pipelines/${pipeline.id}/stages/${lead?.id}`, { token: adminToken });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details?.dealCount).toBeGreaterThan(0);

    const gone = await harness.del(`/crm/deals/${dealId}`, { token: salesToken });
    expect(gone.status).toBe(204);
    expect(await harness.waitForAuditAction('crm.deal.deleted')).toBe(true);
    const after = await harness.get<ErrorBody>(`/crm/deals/${dealId}`, { token: salesToken });
    expect(after.status).toBe(404);
  });
});

describe('the pipeline-review fields (owner, 31 Aug 2026)', () => {
  it('carries lead source, priority, follow-up, competitor and loss reason through create, read and patch', async () => {
    const created = await harness.post<DealView>('/crm/deals', {
      token: salesToken,
      body: {
        name: 'Nashik switchgear tender',
        leadSource: 'Referral - Godavari Electricals',
        priority: 'high',
        nextFollowUpDate: '2026-09-12',
        competitor: 'Legrand',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.leadSource).toBe('Referral - Godavari Electricals');
    expect(created.body.priority).toBe('high');
    expect(created.body.nextFollowUpDate).toBe('2026-09-12');
    expect(created.body.competitor).toBe('Legrand');
    // Not asked for at creation, and not invented either.
    expect(created.body.lossReason).toBeNull();

    const read = await harness.get<DealView>(`/crm/deals/${created.body.id}`, { token: salesToken });
    expect(read.body.priority).toBe('high');

    // A loss reason is written when the deal is lost, and a field can be
    // cleared by naming it null rather than by omitting it.
    const patched = await harness.patch<DealView>(`/crm/deals/${created.body.id}`, {
      token: salesToken,
      body: { lossReason: 'Price - lost to Legrand by 4%', competitor: null, priority: 'urgent' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.lossReason).toBe('Price - lost to Legrand by 4%');
    expect(patched.body.competitor).toBeNull();
    expect(patched.body.priority).toBe('urgent');
    // Untouched fields survive a patch that never mentions them.
    expect(patched.body.leadSource).toBe('Referral - Godavari Electricals');
    expect(patched.body.nextFollowUpDate).toBe('2026-09-12');
  });

  it('refuses a priority outside the four and an over-long source', async () => {
    const badPriority = await harness.post('/crm/deals', {
      token: salesToken,
      body: { name: 'Bad priority', priority: 'whenever' },
    });
    expect(badPriority.status).toBe(400);
    const longSource = await harness.post('/crm/deals', {
      token: salesToken,
      body: { name: 'Long source', leadSource: 'x'.repeat(121) },
    });
    expect(longSource.status).toBe(400);
  });
});

describe('deal attachments (REQ-U-05, owner 31 Aug 2026)', () => {
  const upload = async (dealId: string, token: string, bytes: Buffer, filename: string, type: string) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
    const response = await fetch(`${harness.baseUrl}/crm/deals/${dealId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>) };
  };

  const pdf = Buffer.concat([Buffer.from('%PDF-1.7', 'latin1'), Buffer.alloc(2048, 0x20)]);

  it('takes a PDF, lists it, mints a link for it and lets it be removed', async () => {
    const deal = await harness.post<DealView>('/crm/deals', { token: salesToken, body: { name: 'Attachment probe' } });
    const added = await upload(deal.body.id, salesToken, pdf, 'quotation.pdf', 'application/pdf');
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body?.filename).toBe('quotation.pdf');
    expect(added.body?.mime).toBe('application/pdf');
    expect(await harness.waitForAuditAction('crm.deal.attachment_added')).toBe(true);

    const listed = await harness.get<{ id: string; filename: string; bytes: number }[]>(`/crm/deals/${deal.body.id}/attachments`, { token: salesToken });
    expect(listed.body.map((a) => a.filename)).toEqual(['quotation.pdf']);
    // The contract says number, and raw SQL hands back text: the create path
    // returned a real number while the list returned a string, so the sheet
    // refused the shape. Asserted here because the screen is where it showed.
    expect(typeof listed.body[0]?.bytes).toBe('number');

    const url = await harness.get<{ url: string; expiresInSeconds: number }>(
      `/crm/deals/${deal.body.id}/attachments/${listed.body[0]?.id ?? ''}/url`,
      { token: salesToken },
    );
    expect(url.status).toBe(200);
    expect(url.body.url).toContain('http');
    expect(url.body.expiresInSeconds).toBeGreaterThan(0);

    const removed = await harness.del(`/crm/deals/${deal.body.id}/attachments/${listed.body[0]?.id ?? ''}`, { token: salesToken });
    expect(removed.status).toBe(204);
    const after = await harness.get<unknown[]>(`/crm/deals/${deal.body.id}/attachments`, { token: salesToken });
    expect(after.body).toEqual([]);
  });

  it('refuses what only claims to be a document, by its bytes', async () => {
    const deal = await harness.post<DealView>('/crm/deals', { token: salesToken, body: { name: 'Hostile upload probe' } });
    // An executable wearing a PDF name and a PDF content-type.
    const disguised = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(2048, 0x41)]);
    const refused = await upload(deal.body.id, salesToken, disguised, 'invoice.pdf', 'application/pdf');
    expect(refused.status).toBe(400);
    // And an empty file.
    const empty = await upload(deal.body.id, salesToken, Buffer.alloc(0), 'nothing.pdf', 'application/pdf');
    expect(empty.status).toBe(400);
    const listed = await harness.get<unknown[]>(`/crm/deals/${deal.body.id}/attachments`, { token: salesToken });
    expect(listed.body, 'nothing was stored').toEqual([]);
  });

  it('will not attach to a deal the caller cannot see', async () => {
    // The sales user holds view.self only, so an admin-created deal is
    // outside their scope -- and an attachment must not be a way in.
    const mine = await harness.post<DealView>('/crm/deals', { token: adminToken, body: { name: 'Someone else deal' } });
    const refused = await upload(mine.body.id, salesToken, pdf, 'quote.pdf', 'application/pdf');
    expect([403, 404]).toContain(refused.status);
  });
});
