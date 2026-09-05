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
  PARTY_LEDGER_GROUPS,
  type TaskAnalyticsQuery,
  type TaskAnalyticsView,
  type TaskItemInput,
  type TaskAttachmentView,
  type TaskFlowWeek,
} from '@vyuha/shared';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { FileService } from '../files/file.service.js';
import { isAcceptedUpload, sniffType } from '../files/magic-bytes.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { employees, organizations, parties, stockItems, tasks } from '../db/schema/index.js';
import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';
import { hasPermission, orgContextOf, type Principal } from '../rbac/principal.js';
import { ScopeService, type ScopeGrants } from '../rbac/scope.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { localDateIn } from './local-date.js';
import { TaskSubjectRegistry } from './task-subject.registry.js';
import { TaskAnalyticsRepository } from './task-analytics.repository.js';
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

/** How many people the load chart names before the rest is noise. */
const ASSIGNEE_LOAD_LIMIT = 8;

/** Same reasoning for customers: a bar chart of forty accounts is a wall. */
const CUSTOMER_LOAD_LIMIT = 8;

/**
 * Put back the weeks in which nothing happened.
 *
 * A grouped query returns only the weeks that have rows, so a quiet week
 * would simply not be drawn -- and a line joins the week before straight to
 * the week after, which reads as steady work across a gap that is the story.
 */
function fillWeeks(rows: readonly TaskFlowWeek[], since: Date, weeks: number): TaskFlowWeek[] {
  const bySlot = new Map(rows.map((row) => [row.weekStart, row]));
  const filled: TaskFlowWeek[] = [];
  for (let index = 0; index < weeks; index += 1) {
    const at = new Date(since);
    at.setUTCDate(at.getUTCDate() + index * 7);
    const weekStart = at.toISOString().slice(0, 10);
    filled.push(bySlot.get(weekStart) ?? { weekStart, raised: 0, closed: 0 });
  }
  return filled;
}

@Injectable()
export class TaskService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly scopes: ScopeService,
    private readonly subjects: TaskSubjectRegistry,
    private readonly notifications: NotificationDispatcher,
    private readonly realtime: RealtimeService,
    private readonly files: FileService,
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
    return paginated(await this.withCoverUrls(principal, rows), query, total);
  }

  /**
   * The gallery's covers, signed here rather than one request per card.
   *
   * The card used to hold only the attachment id and fetch its own link, so a
   * fifty-card wall opened fifty HTTP requests, each re-authenticating and
   * re-reading the task before it signed anything. Signing them in the list
   * costs one file read and one HMAC each on a connection that is already
   * open, and no round trips at all.
   *
   * A link that cannot be minted -- a purged object, a file past its
   * retention -- leaves the card without a cover rather than failing the list
   * that every board and calendar also reads.
   */
  private async withCoverUrls(principal: Principal, rows: readonly TaskView[]): Promise<TaskView[]> {
    return Promise.all(
      rows.map(async (row) => {
        if (row.coverAttachmentId === null || row.coverFileId === null) return row;
        try {
          const { url } = await this.files.signedUrlFor(principal, row.coverFileId);
          return { ...row, coverUrl: url };
        } catch {
          return row;
        }
      }),
    );
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

    // Resolved before the insert, so a task naming a party that does not
    // exist fails without leaving half of itself behind.
    const party = await this.resolveParty(principal, input.partyId, 'party');
    const vendor = await this.resolveParty(principal, input.vendorId, 'vendor');
    const items = await this.resolveItems(principal, input.items);

    const created = await repository.insert({
      title: input.title,
      description: input.description ?? null,
      subjectType: subject?.type ?? null,
      subjectId: subject?.id ?? null,
      subjectLabel: subject?.label ?? null,
      assigneeId,
      ownerId: principal.employeeId,
      partyId: party?.id ?? null,
      partyName: party?.name ?? null,
      vendorId: vendor?.id ?? null,
      vendorName: vendor?.name ?? null,
      dueDate: input.dueDate ?? null,
      priority: input.priority,
      columnId: column.id,
      closedAt: column.isDone ? new Date() : null,
    });
    if (items !== null) await repository.setItems(created.id, items);
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
      patch.assigneeId = await this.resolveAssignee(principal, input.assigneeId, {
        allowNull: true,
        currentAssigneeId: existing.assigneeId,
      });
    }
    if (input.subjectType !== undefined || input.subjectId !== undefined) {
      const subject = await this.resolveSubject(principal, input.subjectType, input.subjectId);
      patch.subjectType = subject?.type ?? null;
      patch.subjectId = subject?.id ?? null;
      patch.subjectLabel = subject?.label ?? null;
    }

    if (input.partyId !== undefined) {
      const party = await this.resolveParty(principal, input.partyId, 'party');
      patch.partyId = party?.id ?? null;
      patch.partyName = party?.name ?? null;
    }
    if (input.vendorId !== undefined) {
      const vendor = await this.resolveParty(principal, input.vendorId, 'vendor');
      patch.vendorId = vendor?.id ?? null;
      patch.vendorName = vendor?.name ?? null;
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

    // Resolved before the write for the same reason as on create.
    const items = await this.resolveItems(principal, input.items);

    const updated = await repository.update(id, patch);
    if (updated === null) throw AppError.notFound('Task', id);
    if (items !== null) await repository.setItems(id, items);
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
    /*
     * The count above is for the message; the emptiness is asserted by the
     * write itself. Read and then written as two statements, a task dragged
     * into this column between them was left pointing at a column the board
     * no longer lists -- invisible on every lane, and reachable only from
     * the register.
     *
     * One statement closes the gap the two left. It does not close it
     * absolutely: a move committing after this statement's snapshot is a
     * phantom no predicate can see, and only a foreign key or a trigger
     * would refuse that. It is worth the constraint if a column is ever
     * deleted while the board is busy.
     */
    // The open-column invariant travels into the statement with it; the
    // read above stays for the message it gives.
    const deleted = await repository.softDeleteIfEmpty(id, !existing.isDone);
    if (!deleted) {
      throw AppError.conflict(
        `${existing.name} took on a task while it was being deleted. Move it and try again.`,
      );
    }
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
   * Clearing an assignee who is somebody else needs the same key: it is a
   * reassignment, and the fact that it names nobody does not make it less
   * of one.
   */
  private async resolveAssignee(
    principal: Principal,
    requested: string | null | undefined,
    options: { allowNull?: boolean; currentAssigneeId?: string | null } = {},
  ): Promise<string | null> {
    const existingAssigneeId = options.currentAssigneeId ?? null;
    const mayAssignOthers =
      hasPermission(principal, PERMISSIONS.CRM_TASK_MANAGE) ||
      hasPermission(principal, PERMISSIONS.CRM_TASK_VIEW_ALL);

    if (requested === undefined) return principal.employeeId;
    if (requested === null) {
      if (options.allowNull !== true) return principal.employeeId;
      // Taking the assignee off is the same decision as putting one on, and
      // needs the same key. It was the one path through here that asked for
      // nothing: an assignee holding only `crm.task.view.self` could clear
      // the field, which drops the task off the board of whoever was
      // carrying it and out of their reminders.
      if (!mayAssignOthers && existingAssigneeId !== null && existingAssigneeId !== principal.employeeId) {
        throw AppError.forbidden('Taking a task off somebody else needs crm.task.manage.');
      }
      return null;
    }
    if (requested === principal.employeeId) {
      // Taking a task *for* yourself is the same decision as taking it *off*
      // somebody, and has the same effect on them: it leaves their board and
      // their reminders. The null branch above was guarded and this one was
      // not, so the identical hole stayed open one branch across.
      if (!mayAssignOthers && existingAssigneeId !== null && existingAssigneeId !== principal.employeeId) {
        throw AppError.forbidden('Taking a task off somebody else needs crm.task.manage.');
      }
      return requested;
    }
    if (!mayAssignOthers) {
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

  // ------------------------------------------------------------ attachments

  /**
   * REQ-V-12: a drawing, a signed challan, a photograph of what arrived
   * damaged.
   *
   * `find` first, so the task's own scope decides whether this person may
   * touch it at all -- an attachment is not a back door into a task their
   * role does not reach. An image is re-encoded through the pipeline;
   * anything else is sniffed and stored as it came, which is what stops an
   * executable renamed `.pdf` from being served back as a document.
   */
  async addAttachment(
    principal: Principal,
    taskId: string,
    file: { bytes: Buffer; filename: string },
  ): Promise<TaskAttachmentView> {
    const task = await this.find(principal, taskId);
    const isImage = isAcceptedUpload(sniffType(file.bytes));
    const { stored, row } = await this.db.transaction(async (tx) => {
      const stored = isImage
        ? await this.files.storeImage(
            {
              orgId: principal.orgId,
              uploadedBy: principal.userId,
              purpose: 'TASK_ATTACHMENT',
              bytes: file.bytes,
              pathSegments: [task.id],
            },
            { executor: tx, deferFinalization: true },
          )
        : await this.files.storeUpload(
            {
              orgId: principal.orgId,
              uploadedBy: principal.userId,
              purpose: 'TASK_ATTACHMENT',
              bytes: file.bytes,
              filename: file.filename,
              pathSegments: [task.id],
            },
            { executor: tx, deferFinalization: true },
          );

      const inserted = await tx.execute<{ id: string; createdAt: string | Date }>(sql`
        INSERT INTO task_attachments (org_id, task_id, file_id, filename, created_by, updated_by)
        VALUES (${principal.orgId}, ${task.id}, ${stored.id}, ${file.filename}, ${principal.userId}, ${principal.userId})
        RETURNING id, created_at AS "createdAt"
      `);
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('Attachment insert returned no row.');
      return { stored, row };
    });
    await this.files.finalizeStoredFiles([stored.id]);

    this.auditContext.record({
      action: 'task.attachment_added',
      entityType: 'task',
      entityId: task.id,
      after: { filename: file.filename, bytes: stored.bytes, mime: stored.mime },
    });
    this.announce(principal, 'updated', task.id);
    return {
      id: row.id,
      fileId: stored.id,
      filename: file.filename,
      mime: stored.mime,
      bytes: stored.bytes,
      uploadedAt: new Date(row.createdAt).toISOString(),
      uploadedByName: await this.actorName(principal),
    };
  }

  async listAttachments(principal: Principal, taskId: string): Promise<TaskAttachmentView[]> {
    const task = await this.find(principal, taskId);
    const rows = await this.db.execute<{
      id: string;
      fileId: string;
      filename: string;
      mime: string;
      bytes: string | number;
      uploadedAt: string | Date;
      uploadedByName: string | null;
    }>(sql`
      SELECT a.id, a.file_id AS "fileId", a.filename, f.mime, f.bytes,
             a.created_at AS "uploadedAt",
             CASE WHEN e.id IS NULL THEN NULL ELSE concat_ws(' ', e.first_name, e.last_name) END AS "uploadedByName"
      FROM task_attachments a
      JOIN files f ON f.id = a.file_id
      LEFT JOIN users u ON u.id = a.created_by
      LEFT JOIN employees e ON e.id = u.employee_id
      WHERE a.org_id = ${principal.orgId} AND a.task_id = ${task.id} AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC
    `);
    // `bytes` comes back as text from the driver on a bigint column; a string
    // where the client expects a number breaks the size it renders.
    return rows.rows.map((row) => ({
      ...row,
      bytes: Number(row.bytes),
      uploadedAt: new Date(row.uploadedAt).toISOString(),
    }));
  }

  /**
   * One attachment, by id, proved against the task's own scope.
   *
   * `find` first for the same reason `addAttachment` does it: an attachment
   * id is not a way into a task a role does not reach. Both callers used to
   * load every attachment on the task and search the array in memory, which
   * answered the same question by reading rows nobody wanted.
   */
  private async findAttachment(
    principal: Principal,
    taskId: string,
    attachmentId: string,
  ): Promise<{ id: string; fileId: string; filename: string }> {
    const task = await this.find(principal, taskId);
    const rows = await this.db.execute<{ id: string; fileId: string; filename: string }>(sql`
      SELECT a.id, a.file_id AS "fileId", a.filename
        FROM task_attachments a
       WHERE a.org_id = ${principal.orgId}
         AND a.task_id = ${task.id}
         AND a.id = ${attachmentId}
         AND a.deleted_at IS NULL
       LIMIT 1
    `);
    const found = rows.rows[0];
    if (found === undefined) throw AppError.notFound('Attachment', attachmentId);
    return found;
  }

  async attachmentUrl(
    principal: Principal,
    taskId: string,
    attachmentId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const found = await this.findAttachment(principal, taskId, attachmentId);
    return this.files.signedUrlFor(principal, found.fileId);
  }

  async removeAttachment(principal: Principal, taskId: string, attachmentId: string): Promise<void> {
    const found = await this.findAttachment(principal, taskId, attachmentId);
    // Soft, like every other record here: the file itself stays, because the
    // trail names it and a purge is the recycle bin's job, not a delete key's.
    await this.db.execute(sql`
      UPDATE task_attachments SET deleted_at = now(), updated_by = ${principal.userId}, updated_at = now()
      WHERE org_id = ${principal.orgId} AND task_id = ${taskId} AND id = ${attachmentId}
        AND deleted_at IS NULL
    `);
    this.auditContext.record({
      action: 'task.attachment_removed',
      entityType: 'task',
      entityId: taskId,
      before: { filename: found.filename },
    });
    this.announce(principal, 'updated', taskId);
  }

  // ----------------------------------------------------------- the dashboard

  /**
   * REQ-V-11. What a manager asks about a task list: how much is open, how
   * much is late, where it is sitting, who is carrying it, and whether it is
   * being closed as fast as it arrives.
   *
   * Aggregated under `this.scope(principal)` -- the same predicate the
   * register uses -- so the totals equal the totals of the tasks that
   * person's own list would show.
   */
  async analytics(principal: Principal, query: TaskAnalyticsQuery): Promise<TaskAnalyticsView> {
    const scope = this.scope(principal);
    const repository = new TaskAnalyticsRepository(this.db, orgContextOf(principal));
    const timezone = await this.orgTimezone(principal.orgId);
    const today = localDateIn(new Date(), timezone);

    // Whole weeks, back from the Monday of this one, so neither the first
    // nor the last column is a part-week that reads as a collapse.
    const since = new Date(`${today}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - (since.getUTCDay() === 0 ? 6 : since.getUTCDay() - 1));
    since.setUTCDate(since.getUTCDate() - (query.weeks - 1) * 7);

    const [totals, columns, assignees, priorities, flow, ageing, customers] = await Promise.all([
      repository.totals(scope, today, since),
      repository.columns(scope),
      repository.assignees(scope, today, ASSIGNEE_LOAD_LIMIT),
      repository.priorities(scope),
      repository.flow(scope, since, timezone),
      repository.ageing(scope, today, timezone),
      repository.customers(scope, today, CUSTOMER_LOAD_LIMIT),
    ]);

    return {
      totals,
      columns,
      assignees,
      priorities,
      flow: fillWeeks(flow, since, query.weeks),
      ageing,
      customers,
    };
  }

  private async orgTimezone(orgId: string): Promise<string> {
    const rows = await this.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return rows[0]?.timezone ?? 'Asia/Kolkata';
  }

  /**
   * A party this organisation actually has, with the name snapshotted.
   *
   * The group is checked, not just the id: a customer chosen in the vendor
   * field is a mistake worth refusing rather than a row that quietly reads
   * "Vendor: Acme Trading Co" for ever. `null` clears the field; `undefined`
   * never reaches here.
   */
  private async resolveParty(
    principal: Principal,
    partyId: string | null | undefined,
    role: 'party' | 'vendor',
  ): Promise<{ id: string; name: string } | null> {
    if (partyId === null || partyId === undefined) return null;
    const rows = await this.db
      .select({ id: parties.id, name: parties.name, parentGroup: parties.parentGroup })
      .from(parties)
      .where(and(eq(parties.orgId, principal.orgId), eq(parties.id, partyId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw AppError.validation(`The ${role} was not found.`, { [`${role}Id`]: partyId });
    }
    // Sundry Creditors is the supplier group and Sundry Debtors the customer
    // one, verbatim from Tally (08 §3). Anything else -- a bank, an expense
    // ledger -- is neither and belongs in no task field.
    const wanted = role === 'vendor' ? PARTY_LEDGER_GROUPS.SUPPLIER : PARTY_LEDGER_GROUPS.CUSTOMER;
    if (row.parentGroup !== wanted) {
      throw AppError.validation(
        role === 'vendor'
          ? 'A vendor must be a party under Sundry Creditors.'
          : 'A party must be a customer under Sundry Debtors.',
        { [`${role}Id`]: partyId, parentGroup: row.parentGroup },
      );
    }
    return { id: row.id, name: row.name };
  }

  /**
   * The stock items named, in the order they were given.
   *
   * `null` means the caller said nothing and the existing list stands; an
   * empty array means they cleared it. Duplicates are dropped rather than
   * refused -- picking the same coupler twice is a slip, and a task carries
   * no quantities for a second row to mean anything.
   */
  /**
   * REQ-V-17: the items with what is being asked for.
   *
   * A repeat is still a slip rather than two of them -- the last one given
   * wins, so re-adding an item is how a person corrects its quantity.
   */
  private async resolveItems(
    principal: Principal,
    items: readonly TaskItemInput[] | undefined,
  ): Promise<{ id: string; name: string; quantity: string; rate: string | null; discountPct: string }[] | null> {
    if (items === undefined) return null;
    const byItemId = new Map(items.map((item) => [item.itemId, item]));
    const unique = [...byItemId.keys()];
    if (unique.length === 0) return [];
    const rows = await this.db
      .select({ id: stockItems.id, name: stockItems.name })
      .from(stockItems)
      .where(and(eq(stockItems.orgId, principal.orgId), inArray(stockItems.id, unique)));
    const byId = new Map(rows.map((row) => [row.id, row.name]));
    const missing = unique.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw AppError.validation('One of the items was not found.', { itemIds: missing });
    }
    // The caller's order, not the database's: the list reads as it was built.
    return unique.map((id) => {
      const given = byItemId.get(id);
      return {
        id,
        name: byId.get(id) ?? '',
        quantity: given?.quantity ?? '1',
        rate: given?.rate ?? null,
        discountPct: given?.discountPct ?? '0',
      };
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
    partyId: task.partyId,
    vendorId: task.vendorId,
    // The ids, not the snapshotted names: the trail records what was linked,
    // and a name that changed in Tally later did not change this task.
    items: task.items.map((item) => ({
      itemId: item.itemId,
      quantity: item.quantity,
      rate: item.rate,
      discountPct: item.discountPct,
    })),
    dueDate: task.dueDate,
    priority: task.priority,
    columnId: task.columnId,
    columnName: task.columnName,
    isClosed: task.isClosed,
  };

}
