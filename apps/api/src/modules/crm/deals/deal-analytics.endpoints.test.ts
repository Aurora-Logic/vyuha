import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type CrmAnalyticsView,
  type DealView,
  type PipelineView,
} from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * The CRM dashboard's figures (REQ-U-11).
 *
 * The property this suite exists for is the scope one. Every number is a
 * `count(*)` or a `sum()` over the deals table, and an aggregate is a way to
 * learn about rows you cannot read: told the pipeline is worth 90 lakh when
 * your own deals come to 10, you have learned the size of somebody else's
 * book. So the totals a self-scoped viewer is given must equal the totals of
 * the deals the list would show them, and that is asserted against a fixture
 * where the two genuinely differ.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f1c5';

let harness: ApiHarness;
let adminToken = '';
let raviToken = '';
let pipeline: PipelineView;

/** Puts a deal in a stage and, for a closed stage, backdates the close. */
async function makeDeal(
  token: string,
  name: string,
  value: string,
  stageName: string,
): Promise<DealView> {
  const stage = pipeline.stages.find((entry) => entry.name === stageName);
  if (stage === undefined) throw new Error(`no stage ${stageName}`);
  const response = await harness.post<DealView>('/crm/deals', {
    token,
    body: { name, value, pipelineId: pipeline.id, stageId: stage.id },
  });
  expect(response.status).toBe(201);
  return response.body;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Deal Analytics Fixture Org');

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  // view.self and manage: this account may create deals and see its own.
  const salesRoleId = await harness.createRole('Analytics sales', [
    PERMISSIONS.CRM_DEAL_VIEW_SELF,
    PERMISSIONS.CRM_DEAL_MANAGE,
  ]);

  const raviEmployeeId = await harness.createEmployee({ code: 'AN-001', firstName: 'Ravi', lastName: 'Kumar' });
  const priyaEmployeeId = await harness.createEmployee({ code: 'AN-002', firstName: 'Priya', lastName: 'Kulkarni' });

  const admin = await harness.createUser({
    email: scopedEmail('an-admin'),
    roleIds: [adminRoleId],
    employeeId: priyaEmployeeId,
  });
  const ravi = await harness.createUser({
    email: scopedEmail('an-ravi'),
    roleIds: [salesRoleId],
    employeeId: raviEmployeeId,
  });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  raviToken = (await harness.login(ravi.email, ravi.password)).token;

  const pipelines = await harness.get<PipelineView[]>('/crm/pipelines', { token: adminToken });
  const first = pipelines.body[0];
  if (first === undefined) throw new Error('no pipeline');
  pipeline = first;

  // Ravi's book: two open, one won. Priya's: one open, one lost. The two
  // differ, which is what makes the scope assertion able to fail.
  await makeDeal(raviToken, 'Ravi lead', '100000.00', 'Lead');
  await makeDeal(raviToken, 'Ravi negotiation', '250000.50', 'Negotiation');
  await makeDeal(raviToken, 'Ravi won', '400000.00', 'Won');
  await makeDeal(adminToken, 'Priya proposal', '900000.00', 'Proposal');
  await makeDeal(adminToken, 'Priya lost', '50000.00', 'Lost');
});

afterAll(async () => {
  await harness.close();
});

describe('what the dashboard counts', () => {
  it('totals the open pipeline in exact decimal text, never a float', async () => {
    const response = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    expect(response.status).toBe(200);
    // 100000.00 + 250000.50 + 900000.00. A float would land on .49 or .51
    // here, on precisely the screen someone checks against the deals.
    expect(response.body.totals.openValue).toBe('1250000.50');
    expect(typeof response.body.totals.openValue).toBe('string');
    expect(response.body.totals.openCount).toBe(3);
  });

  it('separates won from lost from open by the stage, not the deal', async () => {
    const { body } = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    expect(body.totals.wonCount).toBe(1);
    expect(body.totals.lostCount).toBe(1);
    expect(body.totals.wonValue).toBe('400000.00');
    expect(body.totals.winRatePct).toBe(50);
  });

  it('gives every stage a row, including the ones holding nothing', async () => {
    const { body } = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    // A stage that vanished when empty would make the funnel look shorter
    // than the pipeline actually is.
    expect(body.stages.map((stage) => stage.stageName)).toEqual([
      'Lead',
      'Qualified',
      'Proposal',
      'Negotiation',
      'Won',
      'Lost',
    ]);
    expect(body.stages.find((stage) => stage.stageName === 'Qualified')).toMatchObject({ count: 0, value: '0' });
    expect(body.stages.find((stage) => stage.stageName === 'Lead')).toMatchObject({ count: 1 });
  });

  it('returns one entry per month asked for, including the quiet ones', async () => {
    const { body } = await harness.get<CrmAnalyticsView>('/crm/deals/analytics?months=6', { token: adminToken });
    expect(body.outcomes).toHaveLength(6);
    // A grouped query returns only months with rows; a line drawn through
    // what is left joins across the gap and reads as continuity.
    expect(body.outcomes.every((entry) => /^\d{4}-\d{2}$/u.test(entry.month))).toBe(true);
    const closed = body.outcomes.reduce((sum, entry) => sum + entry.won + entry.lost, 0);
    expect(closed).toBe(2);
  });

  it('names who is carrying the open pipeline', async () => {
    const { body } = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    const ravi = body.owners.find((owner) => owner.ownerName === 'Ravi Kumar');
    expect(ravi).toMatchObject({ openCount: 2, openValue: '350000.50' });
  });

  it('counts nothing as overdue or stale on a pipeline created just now', async () => {
    const { body } = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    expect(body.attention).toEqual({ overdue: 0, followUpDue: 0, stale: 0, closingSoon: 0 });
  });
});

describe('an aggregate is not a way around the scope', () => {
  it('gives a self-scoped viewer the totals of their own deals and nobody else\'s', async () => {
    const mine = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: raviToken });
    expect(mine.status).toBe(200);

    // Ravi's two open deals, not the three in the organisation.
    expect(mine.body.totals.openCount).toBe(2);
    expect(mine.body.totals.openValue).toBe('350000.50');
    // Priya's lost deal is not his to count.
    expect(mine.body.totals.lostCount).toBe(0);
    expect(mine.body.totals.wonCount).toBe(1);

    const everyone = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    expect(everyone.body.totals.openCount).toBe(3);
    expect(mine.body.totals.openCount).toBeLessThan(everyone.body.totals.openCount);
  });

  it('agrees with the list the same viewer would be shown', async () => {
    // The strongest form of the property: the dashboard and the list must
    // count the same rows, whatever the scope resolves to.
    const analytics = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: raviToken });
    const list = await harness.get<{ data: DealView[]; meta: { total: number } }>(
      '/crm/deals?status=open&page=1&pageSize=100',
      { token: raviToken },
    );
    expect(analytics.body.totals.openCount).toBe(list.body.data.length);
    const listed = list.body.data.reduce((sum, deal) => sum + Number(deal.value ?? 0), 0);
    expect(Number(analytics.body.totals.openValue)).toBe(listed);
  });

  it('keeps a self-scoped viewer out of another owner row', async () => {
    const { body } = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: raviToken });
    expect(body.owners.map((owner) => owner.ownerName)).not.toContain('Priya Kulkarni');
  });

  it('refuses an account with no deal view key', async () => {
    const noneRoleId = await harness.createRole('Analytics none', [PERMISSIONS.PUNCH_SELF]);
    const nobody = await harness.createUser({ email: scopedEmail('an-none'), roleIds: [noneRoleId] });
    const token = (await harness.login(nobody.email, nobody.password)).token;
    const response = await harness.get('/crm/deals/analytics', { token });
    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated reader', async () => {
    const response = await harness.get('/crm/deals/analytics');
    expect(response.status).toBe(401);
  });
});

describe('the query', () => {
  it('narrows to one pipeline', async () => {
    const { body } = await harness.get<CrmAnalyticsView>(
      `/crm/deals/analytics?pipelineId=${pipeline.id}`,
      { token: adminToken },
    );
    expect(body.totals.openCount).toBe(3);
  });

  it('refuses a pipeline id that is not a uuid, and a period outside the range', async () => {
    expect((await harness.get('/crm/deals/analytics?pipelineId=nope', { token: adminToken })).status).toBe(400);
    expect((await harness.get('/crm/deals/analytics?months=99', { token: adminToken })).status).toBe(400);
    expect((await harness.get('/crm/deals/analytics?months=1', { token: adminToken })).status).toBe(400);
  });

  it('reads "analytics" as the route it is, not as a deal id', async () => {
    // Declared after `:id` it would be parsed as a uuid and answer 400 for a
    // route that exists.
    const response = await harness.get('/crm/deals/analytics', { token: adminToken });
    expect(response.status).toBe(200);
  });
});

describe('a soft-deleted deal', () => {
  it('leaves the totals the moment it is deleted', async () => {
    const deal = await makeDeal(adminToken, 'Deleted deal', '777.00', 'Lead');
    const before = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    expect(before.body.totals.openCount).toBe(4);

    const removed = await harness.del(`/crm/deals/${deal.id}`, { token: adminToken });
    expect(removed.status).toBe(204);

    const after = await harness.get<CrmAnalyticsView>('/crm/deals/analytics', { token: adminToken });
    expect(after.body.totals.openCount).toBe(3);
    expect(after.body.totals.openValue).toBe('1250000.50');
  });
});
