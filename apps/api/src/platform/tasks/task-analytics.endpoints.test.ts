import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type Paginated,
  type TaskAnalyticsView,
  type TaskBoardColumnView,
  type TaskView,
} from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * REQ-V-11: the task dashboard.
 *
 * The property this suite exists for is the scope one, as on the CRM
 * dashboard. Every figure is a `count(*)` over the tasks table, and a count
 * is a way to learn about rows you cannot read: told there are ninety open
 * tasks when your own list shows four, you have learned the size of somebody
 * else's workload. So a self-scoped viewer's totals must equal the totals of
 * the tasks their own register would show, asserted against a fixture where
 * the two genuinely differ.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f1c8';

let harness: ApiHarness;
let adminToken = '';
let meeraToken = '';
let meeraId = '';
let raviId = '';
let todoColumnId = '';
let doneColumnId = '';

async function makeTask(token: string, body: Record<string, unknown>): Promise<TaskView> {
  const response = await harness.post<TaskView>('/tasks', { token, body });
  expect(response.status).toBe(201);
  return response.body;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Task Analytics Fixture Org');

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  // view.self and manage: may raise tasks and see only their own.
  const selfRoleId = await harness.createRole('Analytics self', [
    PERMISSIONS.CRM_TASK_VIEW_SELF,
    PERMISSIONS.CRM_TASK_MANAGE,
  ]);

  raviId = await harness.createEmployee({ code: 'TA-001', firstName: 'Ravi', lastName: 'Kumar' });
  meeraId = await harness.createEmployee({ code: 'TA-002', firstName: 'Meera', lastName: 'Iyer' });

  const admin = await harness.createUser({ email: scopedEmail('ta-admin'), roleIds: [adminRoleId], employeeId: raviId });
  const meera = await harness.createUser({ email: scopedEmail('ta-meera'), roleIds: [selfRoleId], employeeId: meeraId });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  meeraToken = (await harness.login(meera.email, meera.password)).token;

  const columns = await harness.get<TaskBoardColumnView[]>('/tasks/columns', { token: adminToken });
  todoColumnId = columns.body.find((column) => !column.isDone)?.id ?? '';
  doneColumnId = columns.body.find((column) => column.isDone)?.id ?? '';
  expect(todoColumnId).not.toBe('');
  expect(doneColumnId).not.toBe('');

  // Meera's: two open (one overdue), one closed. Ravi's: two open. The two
  // books differ, which is what lets the scope assertion fail.
  await makeTask(adminToken, { title: 'Meera overdue', assigneeId: meeraId, dueDate: '2020-01-01', priority: 'HIGH' });
  await makeTask(adminToken, { title: 'Meera open', assigneeId: meeraId });
  await makeTask(adminToken, { title: 'Meera done', assigneeId: meeraId, columnId: doneColumnId });
  await makeTask(adminToken, { title: 'Ravi open one', assigneeId: raviId });
  await makeTask(adminToken, { title: 'Ravi open two', assigneeId: raviId, priority: 'LOW' });
  // Creating with a null assignee still lands it on the creator by design,
  // so an unassigned task is made the way a person makes one: by clearing it.
  const orphan = await makeTask(adminToken, { title: 'Nobody at all' });
  const cleared = await harness.patch<TaskView>(`/tasks/${orphan.id}`, { token: adminToken, body: { assigneeId: null } });
  expect(cleared.body.assigneeId).toBeNull();
});

afterAll(async () => {
  await harness.close();
});

describe('what the dashboard counts', () => {
  it('separates open from closed, and counts what is late', async () => {
    const response = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    expect(response.status).toBe(200);
    const { totals } = response.body;
    // Five open (the done one is not), one of them overdue since 2020.
    expect(totals.open).toBe(5);
    expect(totals.overdue).toBe(1);
    expect(totals.closedInPeriod).toBe(1);
  });

  it('counts work with nobody on it, which is the most actionable number here', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    expect(body.totals.unassigned).toBe(1);
  });

  it('gives every board column a row, including the empty ones', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    // An empty "In progress" is information: it says nothing was started.
    expect(body.columns.length).toBeGreaterThanOrEqual(2);
    const todo = body.columns.find((column) => column.columnId === todoColumnId);
    expect(todo?.count).toBe(5);
    // A done column holds no *open* tasks by definition.
    expect(body.columns.find((column) => column.columnId === doneColumnId)?.count).toBe(0);
  });

  it('names who is carrying open work and how much of theirs is late', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    const meera = body.assignees.find((row) => row.assigneeName === 'Meera Iyer');
    expect(meera).toMatchObject({ openCount: 2, overdueCount: 1 });
    // Unassigned work is a row, not a gap: it is the row somebody must act on.
    expect(body.assignees.some((row) => row.assigneeId === null)).toBe(true);
  });

  it('splits open work by priority', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    expect(body.priorities.find((row) => row.priority === 'HIGH')?.openCount).toBe(1);
    expect(body.priorities.find((row) => row.priority === 'LOW')?.openCount).toBe(1);
  });

  it('returns one entry per week asked for, including the quiet ones', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics?weeks=8', { token: adminToken });
    expect(body.flow).toHaveLength(8);
    expect(body.flow.every((week) => /^\d{4}-\d{2}-\d{2}$/u.test(week.weekStart))).toBe(true);
    // Everything was raised just now, so it lands in the last bucket.
    expect(body.flow.at(-1)?.raised).toBeGreaterThan(0);
    expect(body.flow.reduce((sum, week) => sum + week.closed, 0)).toBe(1);
  });

  it('refuses a period outside the range it will draw', async () => {
    expect((await harness.get('/tasks/analytics?weeks=99', { token: adminToken })).status).toBe(400);
    expect((await harness.get('/tasks/analytics?weeks=1', { token: adminToken })).status).toBe(400);
  });

  it('reads "analytics" as the route it is, not as a task id', async () => {
    expect((await harness.get('/tasks/analytics', { token: adminToken })).status).toBe(200);
  });
});

describe('a count is not a way around the scope', () => {
  it('gives a self-scoped viewer the totals of their own tasks and nobody else\'s', async () => {
    const mine = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: meeraToken });
    expect(mine.status).toBe(200);
    // Meera's two open, not the organisation's five.
    expect(mine.body.totals.open).toBe(2);
    expect(mine.body.totals.overdue).toBe(1);

    const everyone = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    expect(everyone.body.totals.open).toBe(5);
    expect(mine.body.totals.open).toBeLessThan(everyone.body.totals.open);
  });

  it('agrees with the register the same viewer would be shown', async () => {
    // The strongest form: the dashboard and the list must count the same
    // rows, whatever the scope resolves to.
    const analytics = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: meeraToken });
    const list = await harness.get<Paginated<TaskView>>('/tasks?pageSize=100', { token: meeraToken });
    expect(analytics.body.totals.open).toBe(list.body.data.filter((task) => !task.isClosed).length);
  });

  it('keeps a self-scoped viewer out of another person\'s row', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: meeraToken });
    expect(body.assignees.map((row) => row.assigneeName)).not.toContain('Ravi Kumar');
  });

  it('refuses an account holding no task view key', async () => {
    const noneRoleId = await harness.createRole('Analytics no tasks', [PERMISSIONS.PUNCH_SELF]);
    const nobody = await harness.createUser({ email: scopedEmail('ta-none'), roleIds: [noneRoleId] });
    const token = (await harness.login(nobody.email, nobody.password)).token;
    expect((await harness.get('/tasks/analytics', { token })).status).toBe(403);
  });

  it('refuses an unauthenticated reader', async () => {
    expect((await harness.get('/tasks/analytics')).status).toBe(401);
  });
});

/**
 * Owner, 1 Sep 2026: "In Task Dashboard add more charts". Two aggregates the
 * page could not previously draw -- how old the open work is, and which
 * customer is generating it.
 */
describe('how old the backlog is, and whose it is', () => {
  it('buckets open work by age, and everything just raised is under a week', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    const week = body.ageing.find((row) => row.bucket === 'WEEK');
    // The fixture is created in this run, so every open task is minutes old.
    expect(week?.openCount).toBe(body.totals.open);
    expect(body.ageing.every((row) => row.overdueCount <= row.openCount)).toBe(true);
  });

  it('counts the late ones inside the bucket rather than beside it', async () => {
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    const overdue = body.ageing.reduce((sum, row) => sum + row.overdueCount, 0);
    expect(overdue).toBe(body.totals.overdue);
  });

  it('names a customer only once a task actually carries one', async () => {
    const before = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: adminToken });
    // Nothing in the fixture has a party, and internal work must not be
    // grouped into a "None" bar that towers over every real account.
    expect(before.body.customers).toEqual([]);
  });

  it('keeps the age buckets inside the caller‘s own scope', async () => {
    // The scope property this suite exists for, extended to the new figures:
    // a self-scoped viewer's buckets must sum to their own open count, not
    // to the organisation's.
    const { body } = await harness.get<TaskAnalyticsView>('/tasks/analytics', { token: meeraToken });
    const open = body.ageing.reduce((sum, row) => sum + row.openCount, 0);
    expect(open).toBe(body.totals.open);
    expect(open).toBeLessThan(6);
  });
});
