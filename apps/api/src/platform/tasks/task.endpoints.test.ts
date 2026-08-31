import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type Paginated,
  type TaskBoardColumnView,
  type TaskBoardView,
  type TaskView,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { JobRegistry } from '../jobs/job-handler.js';
import { NotificationDispatcher, type NotificationEvent } from '../notifications/notification.dispatcher.js';

/**
 * Tasks (REQ-V-01…V-08, D-17). What this suite pins: the board is the list
 * grouped (one filter shape, both routes), a drag is a PATCH with `columnId`
 * and one audit entry, closing is entering a done column, `view.self` sees
 * assigned-or-owned and nothing else, and every reminder goes through the
 * dispatcher — spied here, since delivery is `notifications.test.ts`'s.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d3';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken: string;
let raviToken: string;
let meeraToken: string;
let employeeToken: string;
let noTaskToken: string;
let opsToken: string;
let viewAllToken: string;
let raviId = '';
let meeraId = '';
let outsiderId = '';
let opsId = '';
const emitted: NotificationEvent[] = [];

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Tasks Fixture Org');
  const dispatcher = harness.resolve(NotificationDispatcher);
  vi.spyOn(dispatcher, 'emit').mockImplementation((event) => {
    emitted.push(event);
    return Promise.resolve('spied');
  });

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const operationsRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS, { isSystem: true });
  const salesRoleId = await harness.createRole('Sales', [
    PERMISSIONS.PUNCH_SELF,
    PERMISSIONS.CRM_TASK_VIEW_SELF,
    PERMISSIONS.CRM_TASK_MANAGE,
  ]);
  const selfOnlyRoleId = await harness.createRole('Self only', [PERMISSIONS.CRM_TASK_VIEW_SELF]);
  // P7-2 moved the task keys into the Employee seed, so the refusal fixture
  // needs a role that genuinely holds none of them.
  const noTaskRoleId = await harness.createRole('No tasks', [PERMISSIONS.PUNCH_SELF]);
  // P7-1: the register key on its own — no manage — to pin what it grants.
  const viewAllRoleId = await harness.createRole('Task register', [PERMISSIONS.CRM_TASK_VIEW_ALL]);

  raviId = await harness.createEmployee({ code: 'TSK-001', firstName: 'Ravi', lastName: 'Kumar' });
  meeraId = await harness.createEmployee({ code: 'TSK-002', firstName: 'Meera', lastName: 'Iyer' });
  outsiderId = await harness.createEmployee({ code: 'TSK-003', firstName: 'Omar', lastName: 'Shaikh' });
  opsId = await harness.createEmployee({ code: 'TSK-004', firstName: 'Leela', lastName: 'Nair' });

  const admin = await harness.createUser({ email: scopedEmail('tasks-admin'), roleIds: [adminRoleId] });
  const ravi = await harness.createUser({ email: scopedEmail('tasks-ravi'), roleIds: [salesRoleId], employeeId: raviId });
  const meera = await harness.createUser({
    email: scopedEmail('tasks-meera'),
    roleIds: [selfOnlyRoleId],
    employeeId: meeraId,
  });
  const employee = await harness.createUser({
    email: scopedEmail('tasks-employee'),
    roleIds: [employeeRoleId],
    employeeId: outsiderId,
  });
  const ops = await harness.createUser({ email: scopedEmail('tasks-ops'), roleIds: [operationsRoleId], employeeId: opsId });
  const noTask = await harness.createUser({ email: scopedEmail('tasks-none'), roleIds: [noTaskRoleId] });
  const viewAll = await harness.createUser({ email: scopedEmail('tasks-register'), roleIds: [viewAllRoleId] });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  raviToken = (await harness.login(ravi.email, ravi.password)).token;
  meeraToken = (await harness.login(meera.email, meera.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;
  opsToken = (await harness.login(ops.email, ops.password)).token;
  noTaskToken = (await harness.login(noTask.email, noTask.password)).token;
  viewAllToken = (await harness.login(viewAll.email, viewAll.password)).token;
});

afterAll(async () => {
  await harness.close();
});

let columns: TaskBoardColumnView[] = [];
let todoId = '';
let doneId = '';
let firstTaskId = '';
let meeraTaskId = '';

describe('columns are configuration (REQ-V-03)', () => {
  it('refuses an account holding no view key, and admits the Employee seed (P7-2)', async () => {
    const refused = await harness.get<ErrorBody>('/tasks', { token: noTaskToken });
    expect(refused.status).toBe(403);

    // P7-2: the Employee system role carries crm.task.view.self now, so any
    // employee can be handed a task and find it somewhere.
    const admitted = await harness.get<Paginated<TaskView>>('/tasks', { token: employeeToken });
    expect(admitted.status).toBe(200);
  });

  it('gives a fresh organisation the default board on first read', async () => {
    const response = await harness.get<TaskBoardColumnView[]>('/tasks/columns', { token: raviToken });
    expect(response.status).toBe(200);
    expect(response.body.map((c) => [c.name, c.isDone])).toEqual([
      ['To do', false],
      ['In progress', false],
      ['Done', true],
    ]);
    columns = response.body;
    todoId = columns[0]?.id ?? '';
    doneId = columns[2]?.id ?? '';
  });

  it('lets settings.manage add, rename, reorder and remove columns, and refuses the last open one', async () => {
    const forbidden = await harness.post<ErrorBody>('/tasks/columns', {
      token: raviToken,
      body: { name: 'Blocked' },
    });
    expect(forbidden.status).toBe(403);

    const created = await harness.post<TaskBoardColumnView>('/tasks/columns', {
      token: adminToken,
      body: { name: 'Blocked' },
    });
    expect(created.status).toBe(201);
    expect(created.body.sortOrder).toBe(3);

    const dup = await harness.post<ErrorBody>('/tasks/columns', { token: adminToken, body: { name: 'blocked' } });
    expect(dup.status).toBe(409);

    const renamed = await harness.patch<TaskBoardColumnView>(`/tasks/columns/${created.body.id}`, {
      token: adminToken,
      body: { name: 'Waiting' },
    });
    expect(renamed.body.name).toBe('Waiting');

    const reordered = await harness.put<TaskBoardColumnView[]>('/tasks/columns/order', {
      token: adminToken,
      body: { columnIds: [created.body.id, todoId, columns[1]?.id, doneId] },
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((c) => c.name)).toEqual(['Waiting', 'To do', 'In progress', 'Done']);

    const partial = await harness.put<ErrorBody>('/tasks/columns/order', {
      token: adminToken,
      body: { columnIds: [todoId] },
    });
    expect(partial.status).toBe(400);

    // Put it back so the rest of the file reads naturally.
    await harness.put('/tasks/columns/order', {
      token: adminToken,
      body: { columnIds: [todoId, columns[1]?.id, doneId, created.body.id] },
    });
    const removed = await harness.del(`/tasks/columns/${created.body.id}`, { token: adminToken });
    expect(removed.status).toBe(204);
    expect(await harness.waitForAuditAction('task.column.deleted')).toBe(true);
  });
});

describe('creating and reading tasks (REQ-V-01, V-02, V-07)', () => {
  it('a viewer raises a task for themselves; it lands in the first open column, owned by them', async () => {
    const created = await harness.post<TaskView>('/tasks', {
      token: raviToken,
      body: { title: 'Call Asha about the quote', dueDate: '2026-08-01', priority: 'HIGH' },
    });
    expect(created.status).toBe(201);
    expect(created.body.columnName).toBe('To do');
    expect(created.body.assigneeId).toBe(raviId);
    expect(created.body.ownerId).toBe(raviId);
    expect(created.body.isClosed).toBe(false);
    firstTaskId = created.body.id;
    expect(await harness.waitForAuditAction('task.created')).toBe(true);
    // Assigned to themselves: no notification (REQ-V-08 is about being told by somebody else).
    expect(emitted.filter((e) => e.type === 'task.assigned')).toHaveLength(0);
  });

  it('a manage holder assigns somebody else, who is told through the dispatcher', async () => {
    const created = await harness.post<TaskView>('/tasks', {
      token: raviToken,
      body: { title: 'Send the catalogue', assigneeId: meeraId, dueDate: '2026-08-10' },
    });
    expect(created.status).toBe(201);
    expect(created.body.assigneeName).toBe('Meera Iyer');
    expect(created.body.ownerId).toBe(raviId);
    meeraTaskId = created.body.id;

    const notice = emitted.find((e) => e.type === 'task.assigned');
    expect(notice?.audience).toEqual({ kind: 'employees', employeeIds: [meeraId] });
    expect(notice?.payload?.title).toBe('Send the catalogue');
    expect(notice?.payload?.assignedBy).toBe('Ravi Kumar');
  });

  it('a self-only viewer may not assign to another, and may not attach an unknown subject', async () => {
    const forbidden = await harness.post<ErrorBody>('/tasks', {
      token: meeraToken,
      body: { title: 'For Ravi', assigneeId: raviId },
    });
    expect(forbidden.status).toBe(403);

    const unknown = await harness.post<ErrorBody>('/tasks', {
      token: raviToken,
      body: { title: 'On a starship', subjectType: 'starship', subjectId: raviId },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details?.known).toEqual(expect.arrayContaining(['employee', 'contact', 'company']));

    const half = await harness.post<ErrorBody>('/tasks', {
      token: raviToken,
      body: { title: 'Half a subject', subjectType: 'employee' },
    });
    expect(half.status).toBe(400);
  });

  it('attaches to an employee, snapshotting the label', async () => {
    const created = await harness.post<TaskView>('/tasks', {
      token: raviToken,
      body: { title: 'Brief the new joiner', subjectType: 'employee', subjectId: outsiderId },
    });
    expect(created.status).toBe(201);
    expect(created.body.subjectLabel).toBe('Omar Shaikh');

    const missing = await harness.post<ErrorBody>('/tasks', {
      token: raviToken,
      body: { title: 'On nobody', subjectType: 'employee', subjectId: '01900000-0000-7000-8000-00000000dead' },
    });
    expect(missing.status).toBe(400);
  });

  it('view.self sees assigned-or-owned and nothing else', async () => {
    const meera = await harness.get<Paginated<TaskView>>('/tasks', { token: meeraToken });
    expect(meera.body.data.map((t) => t.title)).toEqual(['Send the catalogue']);

    const hidden = await harness.get<ErrorBody>(`/tasks/${firstTaskId}`, { token: meeraToken });
    expect(hidden.status).toBe(404);

    // Ravi owns all three, whoever they are assigned to.
    const ravi = await harness.get<Paginated<TaskView>>('/tasks', { token: raviToken });
    expect(ravi.body.meta.total).toBe(3);

    // P7-1: the administrator has no employee record — nothing is assigned to
    // or owned by them — and still sees every task, because Admin now holds
    // crm.task.view.all.
    const admin = await harness.get<Paginated<TaskView>>('/tasks', { token: adminToken });
    expect(admin.body.meta.total).toBe(3);
    const another = await harness.get<TaskView>(`/tasks/${firstTaskId}`, { token: adminToken });
    expect(another.status).toBe(200);
    expect(another.body.ownerId).toBe(raviId);
  });

  it('REQ-V-07: mine + due slices, dated first and the urgent one first within a day', async () => {
    const mine = await harness.get<Paginated<TaskView>>('/tasks?mine=true', { token: raviToken });
    expect(mine.body.data.map((t) => t.title)).toEqual(['Call Asha about the quote', 'Brief the new joiner']);

    // Fixture dates are in the past relative to any run after 18 Aug 2026;
    // "overdue" is therefore what has a date at all, and "undated" the rest.
    const overdue = await harness.get<Paginated<TaskView>>('/tasks?due=overdue', { token: raviToken });
    expect(overdue.body.data.map((t) => t.title)).toEqual(['Call Asha about the quote', 'Send the catalogue']);
    const undated = await harness.get<Paginated<TaskView>>('/tasks?due=undated', { token: raviToken });
    expect(undated.body.data.map((t) => t.title)).toEqual(['Brief the new joiner']);

    const search = await harness.get<Paginated<TaskView>>('/tasks?q=catalogue', { token: raviToken });
    expect(search.body.data.map((t) => t.title)).toEqual(['Send the catalogue']);
  });

  it('the board is the same query grouped, with every column a lane (REQ-V-04)', async () => {
    const board = await harness.get<TaskBoardView>('/tasks/board?q=catalogue', { token: raviToken });
    expect(board.status).toBe(200);
    expect(board.body.lanes.map((l) => [l.column.name, l.tasks.length])).toEqual([
      ['To do', 1],
      ['In progress', 0],
      ['Done', 0],
    ]);
    expect(board.body.lanes[0]?.tasks[0]?.title).toBe('Send the catalogue');
  });
});

describe('moving, closing, editing (REQ-V-05, V-06)', () => {
  it('a move is a PATCH with columnId and one audit entry; entering Done closes', async () => {
    const inProgress = columns[1]?.id ?? '';
    const moved = await harness.patch<TaskView>(`/tasks/${firstTaskId}`, {
      token: raviToken,
      body: { columnId: inProgress },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.columnName).toBe('In progress');
    expect(moved.body.isClosed).toBe(false);
    expect(await harness.waitForAuditAction('task.moved')).toBe(true);

    const closed = await harness.patch<TaskView>(`/tasks/${firstTaskId}`, {
      token: raviToken,
      body: { columnId: doneId },
    });
    expect(closed.body.isClosed).toBe(true);
    expect(closed.body.closedAt).not.toBeNull();
    expect(await harness.waitForAuditAction('task.closed')).toBe(true);

    // Closed tasks leave the default list and come back on request.
    const open = await harness.get<Paginated<TaskView>>('/tasks?mine=true', { token: raviToken });
    expect(open.body.data.map((t) => t.title)).toEqual(['Brief the new joiner']);
    const all = await harness.get<Paginated<TaskView>>('/tasks?mine=true&includeClosed=true', { token: raviToken });
    expect(all.body.meta.total).toBe(2);

    const reopened = await harness.patch<TaskView>(`/tasks/${firstTaskId}`, {
      token: raviToken,
      body: { columnId: todoId },
    });
    expect(reopened.body.isClosed).toBe(false);
    expect(await harness.waitForAuditAction('task.reopened')).toBe(true);
  });

  it('the assignee may edit their own task; reassigning notifies the new person once', async () => {
    emitted.length = 0;
    const edited = await harness.patch<TaskView>(`/tasks/${meeraTaskId}`, {
      token: meeraToken,
      body: { description: 'Sent the PDF, waiting for a reply.' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.description).toBe('Sent the PDF, waiting for a reply.');
    expect(emitted).toHaveLength(0);

    const reassigned = await harness.patch<TaskView>(`/tasks/${meeraTaskId}`, {
      token: raviToken,
      body: { assigneeId: outsiderId },
    });
    expect(reassigned.body.assigneeName).toBe('Omar Shaikh');
    expect(emitted.filter((e) => e.type === 'task.assigned').map((e) => e.audience)).toEqual([
      { kind: 'employees', employeeIds: [outsiderId] },
    ]);

    // Meera no longer sees it: not assigned, not owned.
    const gone = await harness.get<ErrorBody>(`/tasks/${meeraTaskId}`, { token: meeraToken });
    expect(gone.status).toBe(404);
  });

  it('a column with tasks refuses to go; deleting a task needs manage', async () => {
    const refused = await harness.del<ErrorBody>(`/tasks/columns/${todoId}`, { token: adminToken });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details?.taskCount).toBeGreaterThan(0);

    const noManage = await harness.del<ErrorBody>(`/tasks/${meeraTaskId}`, { token: meeraToken });
    expect(noManage.status).toBe(403);

    const deleted = await harness.del(`/tasks/${meeraTaskId}`, { token: raviToken });
    expect(deleted.status).toBe(204);
    expect(await harness.waitForAuditAction('task.deleted')).toBe(true);
  });
});

describe('reminders (REQ-V-08)', () => {
  it('the sweep emits due-today and overdue to assignees, keyed so a re-run is silent', async () => {
    emitted.length = 0;
    // A task due "today" for the sweep's fixed date, and the overdue one from above.
    await harness.post<TaskView>('/tasks', {
      token: raviToken,
      body: { title: 'Follow up on the sample', dueDate: '2026-08-20' },
    });
    const handler = harness.resolve(JobRegistry).get('send-task-reminders');
    if (handler === null) throw new Error('send-task-reminders is not registered');
    const result = await handler.run({ date: '2026-08-20' }, { jobId: 'test', attempt: 1 });
    expect(result).toMatchObject({ dueToday: expect.any(Number) as number, overdue: expect.any(Number) as number });

    const dueToday = emitted.filter((e) => e.orgId === ORG_ID && e.type === 'task.due_today');
    expect(dueToday.map((e) => e.payload?.title)).toEqual(['Follow up on the sample']);
    expect(dueToday[0]?.audience).toEqual({ kind: 'employees', employeeIds: [raviId] });
    expect(dueToday[0]?.idempotencyKey).toMatch(/^task-due-.*-2026-08-20$/u);

    const overdue = emitted.filter((e) => e.orgId === ORG_ID && e.type === 'task.overdue');
    expect(overdue.map((e) => e.payload?.title).sort()).toEqual(['Call Asha about the quote']);
    expect(overdue[0]?.idempotencyKey).toMatch(/^task-overdue-/u);
  });
});

describe('P7-1: crm.task.view.all is the whole register', () => {
  it('sees and may reassign a task it neither owns nor is assigned — even one owned by nobody', async () => {
    // A task raised by an account with no employee record: owner and assignee
    // both null. No self or team chain can ever reach it.
    const orphan = await harness.post<TaskView>('/tasks', { token: adminToken, body: { title: 'Chase the unclaimed refund' } });
    expect(orphan.status).toBe(201);
    expect(orphan.body.ownerId).toBeNull();
    expect(orphan.body.assigneeId).toBeNull();

    const seen = await harness.get<TaskView>(`/tasks/${orphan.body.id}`, { token: viewAllToken });
    expect(seen.status).toBe(200);

    // The register key alone carries the reassign right (P7-1) — no manage.
    const reassigned = await harness.patch<TaskView>(`/tasks/${orphan.body.id}`, {
      token: viewAllToken,
      body: { assigneeId: raviId },
    });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.assigneeId).toBe(raviId);
  });
});

describe('P7-2: an Operations account works its own list', () => {
  it('is assigned a task by a manage holder and completes it', async () => {
    emitted.length = 0;
    const assigned = await harness.post<TaskView>('/tasks', {
      token: raviToken,
      body: { title: 'Restock the front rack', assigneeId: opsId },
    });
    expect(assigned.status).toBe(201);
    expect(emitted.filter((e) => e.type === 'task.assigned').map((e) => e.audience)).toEqual([
      { kind: 'employees', employeeIds: [opsId] },
    ]);

    // Seen under the view.self the Operations seed now carries, and dragged
    // into Done by the person it was handed to.
    const mine = await harness.get<Paginated<TaskView>>('/tasks?mine=true', { token: opsToken });
    expect(mine.body.data.map((t) => t.title)).toContain('Restock the front rack');
    const closed = await harness.patch<TaskView>(`/tasks/${assigned.body.id}`, {
      token: opsToken,
      body: { columnId: doneId },
    });
    expect(closed.status).toBe(200);
    expect(closed.body.isClosed).toBe(true);
  });
});

describe('the fixture leaves nothing behind that a re-run would trip over', () => {
  it('has task rows only for this organisation', async () => {
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tasks WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
    );
    expect(rows.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('a courtesy notice must not lose the work (found live, 31 Aug 2026)', () => {
  it('saves and assigns the task even when the notification cannot be queued', async () => {
    // What the owner saw: "Saving the task failed - background work could not
    // be queued". The task was already written and audited; only the notice
    // to the assignee failed, and the obvious retry made a second task.
    const dispatcher = harness.resolve(NotificationDispatcher);
    const failing = vi.spyOn(dispatcher, 'emit').mockRejectedValue(
      new Error('Background work could not be queued just now. Try again shortly.'),
    );
    try {
      const created = await harness.post<TaskView>('/tasks', {
        token: adminToken,
        body: { title: 'Ohmnova tech - Dispatch Via Courier', assigneeId: meeraId, priority: 'HIGH' },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.title).toBe('Ohmnova tech - Dispatch Via Courier');
      expect(created.body.assigneeId).toBe(meeraId);
      expect(failing, 'the notice was genuinely attempted').toHaveBeenCalled();

      // And on a reassignment, which notifies the same way.
      const moved = await harness.patch<TaskView>(`/tasks/${created.body.id}`, {
        token: adminToken,
        body: { assigneeId: raviId },
      });
      expect(moved.status).toBe(200);
      expect(moved.body.assigneeId).toBe(raviId);
    } finally {
      failing.mockRestore();
      // Put the capturing spy back for anything that runs after this file.
      vi.spyOn(dispatcher, 'emit').mockImplementation((event) => {
        emitted.push(event);
        return Promise.resolve('spied');
      });
    }
  });
});

describe('Operations can hand work to anybody (owner, 31 Aug 2026)', () => {
  it('sees every colleague in the picker and assigns outside its own reporting line', async () => {
    // The report was "Operations cannot assign everyone a task". The keys
    // were never the blocker -- Operations holds crm.task.manage -- the
    // picker was: it read the employee register, whose whole-org breadth is
    // employee.manage, so an Operations user saw only themselves and their
    // reporting line and could not name anyone else.
    const directory = await harness.get<{ id: string }[]>('/employees/assignable', { token: opsToken });
    expect(directory.status).toBe(200);
    const ids = directory.body.map((row) => row.id);
    expect(ids, 'a colleague on nobody in their line').toContain(outsiderId);
    expect(ids).toContain(raviId);
    expect(ids).toContain(meeraId);

    const assigned = await harness.post<TaskView>('/tasks', {
      token: opsToken,
      body: { title: 'Dispatch via courier', assigneeId: outsiderId, priority: 'HIGH' },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    expect(assigned.body.assigneeId).toBe(outsiderId);
  });
});
