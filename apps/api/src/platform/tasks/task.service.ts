import { Injectable } from '@nestjs/common';
import {
  DEFAULT_TASK_SORT,
  NOTIFICATION_EVENTS,
  PERMISSIONS,
  TASK_SORT_FIELDS,
  pageSlice,
  paginated,
  parseSort,
  type CreateBoardColumnInput,
  type CreateTaskInput,
  type Paginated,
  type ReorderBoardColumnsInput,
  type TaskBoardColumnView,
  type TaskBoardQuery,
  type TaskBoardView,
  type TaskListQuery,
  type TaskView,
  type UpdateBoardColumnInput,
  type UpdateTaskInput,
  REALTIME_RESOURCES,
} from '@vyuha/shared';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { employees, organizations, tasks } from '../db/schema/index.js';
import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';
import { hasPermission, orgContextOf, type Principal } from '../rbac/principal.js';
import { ScopeService, type ScopeGrants } from '../rbac/scope.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { localDateIn } from './local-date.js';
import { TaskSubjectRegistry } from './task-subject.registry.js';
import { BoardColumnRepository, TaskRepository } from './task.repository.js';

/**
 * Tasks (REQ-V-01…V-08).
 *
 * Who sees a task: `crm.task.view.self` covers what is assigned to you or
 * owned by you; `.team` extends both to your reporting chain; `.all` (P7-1,
 * owner 28 Aug 2026) is the whole register — including a task whose owner or
 * assignee has no employee record, which no chain can reach. `ScopeService`
 * is asked twice, once per person column, and the two fragments are OR-ed.
 *
 * Every write is one audit entry (REQ-V-06): a drag on the board is a PATCH
 * with `columnId`, which lands here like any other edit and is recorded as
 * `task.moved`, with the closing move recorded as `task.closed`.
 */

const TASK_GRANTS: ScopeGrants = {
  self: PERMISSIONS.CRM_TASK_VIEW_SELF,
  team: PERMISSIONS.CRM_TASK_VIEW_TEAM,
  all: PERMISSIONS.CRM_TASK_VIEW_ALL,
};

const SQL_TRUE = sql`true`;

@Injectable()
export class TaskService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly scopes: ScopeService,
    private readonly subjects: TaskSubjectRegistry,
    private readonly notifications: NotificationDispatcher,
    private readonly realtime: RealtimeService,
  ) {}

  // ------------------------------------------------------------------ reads

  async list(principal: Principal, query: TaskListQuery): Promise<Paginated<TaskView>> {
    const { limit, offset } = pageSlice(query);
    const { rows, total } = await this.tasks(principal).list(this.scope(principal), {
      filter: query,
      sort: parseSort(query.sort ?? DEFAULT_TASK_SORT, TASK_SORT_FIELDS),
      limit,
      offset,
      selfEmployeeId: principal.employeeId,
      today: await this.today(principal.orgId),
    });
    return paginated(rows, query, total);
  }

  async board(principal: Principal, query: TaskBoardQuery): Promise<TaskBoardView> {
    const columns = await this.columns(principal).listOrCreateDefaults();
    const lanes = await this.tasks(principal).board(
      this.scope(principal),
      { filter: query, selfEmployeeId: principal.employeeId, today: await this.today(principal.orgId) },
      columns,
    );
    return {
      lanes: columns.map((column) => {
        const lane = lanes.find((l) => l.columnId === column.id);
        return { column, tasks: lane?.tasks ?? [], total: lane?.total ?? 0 };
      }),
    };
  }

  async find(principal: Principal, id: string): Promise<TaskView> {
    const task = await this.tasks(principal).view(this.scope(principal), id);
    if (task === null) throw AppError.notFound('Task', id);
    return task;
  }

  listColumns(principal: Principal): Promise<TaskBoardColumnView[]> {
    return this.columns(principal).listOrCreateDefaults();
  }

  // ----------------------------------------------------------------- writes

  async create(principal: Principal, input: CreateTaskInput): Promise<TaskView> {
    const repository = this.tasks(principal);
    const columns = this.columns(principal);

    const assigneeId = await this.resolveAssignee(principal, input.assigneeId);
    const subject = await this.resolveSubject(principal, input.subjectType, input.subjectId);
    const column =
      input.columnId === undefined || input.columnId === null
        ? await columns.firstOpen()
        : await columns.find(input.columnId);
    if (column === null) throw AppError.validation('The board column was not found.', { columnId: input.columnId ?? null });

    const created = await repository.insert({
      title: input.title,
      description: input.description ?? null,
      subjectType: subject?.type ?? null,
      subjectId: subject?.id ?? null,
      subjectLabel: subject?.label ?? null,
      assigneeId,
      ownerId: principal.employeeId,
      dueDate: input.dueDate ?? null,
      priority: input.priority,
      columnId: column.id,
      closedAt: column.isDone ? new Date() : null,
    });
    const task = await repository.view(SQL_TRUE, created.id);
    if (task === null) throw new Error(`Task ${created.id} vanished between insert and read-back.`);

    this.auditContext.record({
      action: 'task.created',
      entityType: 'task',
      entityId: task.id,
      before: null,
      after: taskAuditView(task),
    });
    this.announce(principal, 'created', task.id);
    await this.notifyAssigned(principal, task, null);
    return task;
  }

  async update(principal: Principal, id: string, input: UpdateTaskInput): Promise<TaskView> {
    const repository = this.tasks(principal);
    const existing = await this.find(principal, id);

    const patch: Parameters<TaskRepository['update']>[1] = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
      patch.assigneeId = await this.resolveAssignee(principal, input.assigneeId, { allowNull: true });
    }
    if (input.subjectType !== undefined || input.subjectId !== undefined) {
      const subject = await this.resolveSubject(principal, input.subjectType, input.subjectId);
      patch.subjectType = subject?.type ?? null;
      patch.subjectId = subject?.id ?? null;
      patch.subjectLabel = subject?.label ?? null;
    }

    let moved: { from: string; to: TaskBoardColumnView } | null = null;
    if (input.columnId !== undefined && input.columnId !== existing.columnId) {
      const column = await this.columns(principal).find(input.columnId);
      if (column === null) throw AppError.validation('The board column was not found.', { columnId: input.columnId });
      patch.columnId = column.id;
      // Closing is entering a done column; reopening is leaving one. A move
      // between two open columns, or two done columns, changes neither.
      if (column.isDone && !existing.isClosed) patch.closedAt = new Date();
      if (!column.isDone && existing.isClosed) patch.closedAt = null;
      moved = { from: existing.columnName, to: column };
    }

    const updated = await repository.update(id, patch);
    if (updated === null) throw AppError.notFound('Task', id);
    const task = await repository.view(SQL_TRUE, id);
    if (task === null) throw AppError.notFound('Task', id);

    // One entry per write, named for what the write was: a drag is `moved`
    // (REQ-V-06), a drag into Done is `closed`, anything else `updated`.
    const action =
      moved === null
        ? 'task.updated'
        : moved.to.isDone && !existing.isClosed
          ? 'task.closed'
          : !moved.to.isDone && existing.isClosed
            ? 'task.reopened'
            : 'task.moved';
    this.auditContext.record({
      action,
      entityType: 'task',
      entityId: id,
      before: taskAuditView(existing),
      after: taskAuditView(task),
    });
    this.announce(principal, 'updated', id);

    if (patch.assigneeId !== undefined && task.assigneeId !== null) {
      await this.notifyAssigned(principal, task, existing.assigneeId);
    }
    return task;
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const existing = await this.find(principal, id);
    const deleted = await this.tasks(principal).softDelete(id);
    if (!deleted) throw AppError.notFound('Task', id);
    this.auditContext.record({
      action: 'task.deleted',
      entityType: 'task',
      entityId: id,
      before: taskAuditView(existing),
      after: null,
    });
    this.announce(principal, 'deleted', id);
  }

  // ---------------------------------------------------------------- columns

  async createColumn(principal: Principal, input: CreateBoardColumnInput): Promise<TaskBoardColumnView> {
    const repository = this.columns(principal);
    const existing = await repository.listOrCreateDefaults();
    if ((await repository.findByName(input.name)) !== null) {
      throw AppError.conflict(`A column called ${input.name} already exists.`);
    }
    const created = await repository.insert({
      name: input.name,
      isDone: input.isDone,
      sortOrder: existing.length,
    });
    const view = { id: created.id, name: created.name, sortOrder: created.sortOrder, isDone: created.isDone };
    this.auditContext.record({
      action: 'task.column.created',
      entityType: 'task_board_column',
      entityId: view.id,
      before: null,
      after: { ...view },
    });
    this.announce(principal, 'updated', null);
    return view;
  }

  async updateColumn(principal: Principal, id: string, input: UpdateBoardColumnInput): Promise<TaskBoardColumnView> {
    const repository = this.columns(principal);
    const existing = await repository.find(id);
    if (existing === null) throw AppError.notFound('Board column', id);
    if (input.name !== undefined && (await repository.findByName(input.name, id)) !== null) {
      throw AppError.conflict(`A column called ${input.name} already exists.`);
    }
    // The last open column cannot become a done column: a new task would
    // have nowhere to start.
    if (input.isDone === true && !existing.isDone && !(await repository.anyOpenColumn(id))) {
      throw AppError.conflict('At least one column must be open, or a new task has nowhere to start.');
    }
    const patch: Parameters<BoardColumnRepository['update']>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isDone !== undefined) patch.isDone = input.isDone;
    const updated = await repository.update(id, patch);
    if (updated === null) throw AppError.notFound('Board column', id);
    const view = { id: updated.id, name: updated.name, sortOrder: updated.sortOrder, isDone: updated.isDone };

    // Flipping is_done re-labels every task in the column: they were open and
    // are now closed, or the reverse. Their closed_at follows, in one statement.
    if (input.isDone !== undefined && input.isDone !== existing.isDone) {
      await this.db
        .update(tasks)
        .set({ closedAt: input.isDone ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(tasks.orgId, principal.orgId), eq(tasks.columnId, id), isNull(tasks.deletedAt)));
    }

    this.auditContext.record({
      action: 'task.column.updated',
      entityType: 'task_board_column',
      entityId: id,
      before: { ...existing },
      after: { ...view },
    });
    this.announce(principal, 'updated', null);
    return view;
  }

  async reorderColumns(principal: Principal, input: ReorderBoardColumnsInput): Promise<TaskBoardColumnView[]> {
    const repository = this.columns(principal);
    if (!(await repository.isCompleteSet(input.columnIds))) {
      throw AppError.validation('The order must name every column exactly once.', { columnIds: input.columnIds });
    }
    const before = await repository.listOrdered();
    await repository.reorder(input.columnIds);
    const after = await repository.listOrdered();
    this.auditContext.record({
      action: 'task.column.reordered',
      entityType: 'task_board_column',
      entityId: principal.orgId,
      before: { order: before.map((c) => c.id) },
      after: { order: after.map((c) => c.id) },
    });
    this.announce(principal, 'updated', null);
    return after;
  }

  async deleteColumn(principal: Principal, id: string): Promise<void> {
    const repository = this.columns(principal);
    const existing = await repository.find(id);
    if (existing === null) throw AppError.notFound('Board column', id);
    const inColumn = await this.tasks(principal).countInColumn(id);
    if (inColumn > 0) {
      throw AppError.conflict(
        `${existing.name} still holds ${inColumn} task${inColumn === 1 ? '' : 's'}. Move them first.`,
        { taskCount: inColumn },
      );
    }
    if (!existing.isDone && !(await repository.anyOpenColumn(id))) {
      throw AppError.conflict('At least one column must be open, or a new task has nowhere to start.');
    }
    const deleted = await repository.softDelete(id);
    if (!deleted) throw AppError.notFound('Board column', id);
    this.auditContext.record({
      action: 'task.column.deleted',
      entityType: 'task_board_column',
      entityId: id,
      before: { ...existing },
      after: null,
    });
    this.announce(principal, 'updated', null);
  }

  // ---------------------------------------------------------------- helpers

  private scope(principal: Principal): SQL {
    const byAssignee = this.scopes.resolve(principal, TASK_GRANTS, tasks.assigneeId).where;
    const byOwner = this.scopes.resolve(principal, TASK_GRANTS, tasks.ownerId).where;
    return sql`(${byAssignee} OR ${byOwner})`;
  }

  /**
   * Who the task is for. Absent means the creator; naming somebody needs
   * `crm.task.manage` — or `crm.task.view.all`, whose P7-1 grant is "sees and
   * may reassign every task" — and they must be a current employee of the org.
   */
  private async resolveAssignee(
    principal: Principal,
    requested: string | null | undefined,
    options: { allowNull?: boolean } = {},
  ): Promise<string | null> {
    if (requested === undefined) return principal.employeeId;
    if (requested === null) return options.allowNull === true ? null : principal.employeeId;
    if (requested === principal.employeeId) return requested;
    if (
      !hasPermission(principal, PERMISSIONS.CRM_TASK_MANAGE) &&
      !hasPermission(principal, PERMISSIONS.CRM_TASK_VIEW_ALL)
    ) {
      throw AppError.forbidden('Assigning a task to somebody else needs crm.task.manage.');
    }
    const rows = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.orgId, principal.orgId), eq(employees.id, requested), isNull(employees.deletedAt)))
      .limit(1);
    if (rows.length === 0) throw AppError.validation('The assignee must be a current employee.', { assigneeId: requested });
    return requested;
  }

  private async resolveSubject(
    principal: Principal,
    type: string | null | undefined,
    id: string | null | undefined,
  ): Promise<{ type: string; id: string; label: string } | null> {
    if (type === undefined || type === null || id === undefined || id === null) return null;
    const describer = this.subjects.find(type);
    if (describer === null) {
      throw AppError.validation(`A task cannot be attached to a "${type}".`, {
        subjectType: type,
        known: this.subjects.types(),
      });
    }
    const described = await describer.describe(principal, id);
    if (described === null) throw AppError.validation('The subject was not found.', { subjectType: type, subjectId: id });
    return { type, id, label: described.label };
  }

  /** REQ-V-08: the assignee hears about it, unless they assigned it to themselves. */
  private async notifyAssigned(principal: Principal, task: TaskView, previousAssigneeId: string | null): Promise<void> {
    if (task.assigneeId === null || task.assigneeId === previousAssigneeId) return;
    if (task.assigneeId === principal.employeeId) return;
    await this.notifications.emitAfterCommit({
      orgId: principal.orgId,
      type: NOTIFICATION_EVENTS.TASK_ASSIGNED,
      audience: { kind: 'employees', employeeIds: [task.assigneeId] },
      payload: {
        taskId: task.id,
        title: task.title,
        dueDate: task.dueDate ?? '',
        subjectLabel: task.subjectLabel ?? '',
        assignedBy: await this.actorName(principal),
      },
    });
  }

  /** The actor as the assignee will read it: their employee name, or their email when they have no record. */
  private async actorName(principal: Principal): Promise<string> {
    if (principal.employeeId === null) return principal.email;
    const rows = await this.db
      .select({ firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(eq(employees.id, principal.employeeId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? principal.email : [row.firstName, row.lastName].filter((p) => p !== null && p !== '').join(' ');
  }

  private async today(orgId: string): Promise<string> {
    const rows = await this.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return localDateIn(new Date(), rows[0]?.timezone ?? 'Asia/Kolkata');
  }

  private tasks(principal: Principal): TaskRepository {
    return new TaskRepository(this.db, orgContextOf(principal));
  }

  private columns(principal: Principal): BoardColumnRepository {
    return new BoardColumnRepository(this.db, orgContextOf(principal));
  }

  /**
   * Tell everyone else's open boards. A column change names no record: every
   * card on the board moved, so naming one would leave the rest stale.
   */
  private announce(principal: Principal, action: 'created' | 'updated' | 'deleted', recordId: string | null): void {
    this.realtime.publish(principal.orgId, {
      resource: REALTIME_RESOURCES.TASK,
      action,
      recordId,
      actorUserId: principal.userId,
    });
  }

}

function taskAuditView(task: TaskView): Record<string, unknown> {
  return {
    title: task.title,
    description: task.description,
    subjectType: task.subjectType,
    subjectId: task.subjectId,
    assigneeId: task.assigneeId,
    ownerId: task.ownerId,
    dueDate: task.dueDate,
    priority: task.priority,
    columnId: task.columnId,
    columnName: task.columnName,
    isClosed: task.isClosed,
  };

}
