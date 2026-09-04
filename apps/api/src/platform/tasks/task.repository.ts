import {
  DEFAULT_BOARD_COLUMNS,
  TASK_BOARD_LANE_CAP,
  taskLineAmount,
  type SortTerm,
  type TaskBoardColumnView,
  type TaskFilter,
  type TaskView,
  type TaskItemView,
} from '@vyuha/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../db/db.provider.js';
import { employees, files, taskAttachments, taskBoardColumns, taskItems, tasks } from '../db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../db/scoped-repository.js';
import { masterSearch } from '../org/master-query.js';

/**
 * Tasks and board columns (REQ-V-01…V-07). Two scoped repositories in one
 * file because neither reads without the other: a task carries its column's
 * name, a lane is a column with its tasks.
 *
 * REQ-V-04 is held here rather than promised: `list` and `board` build the
 * WHERE from one `filterPredicate`, so a filter the list understands is a
 * filter the board understands, by construction.
 */

const assignee = alias(employees, 'task_assignee');
const owner = alias(employees, 'task_owner');

const personName = (person: { id: PgColumn; firstName: PgColumn; lastName: PgColumn }): SQL<string | null> =>
  sql<string | null>`CASE WHEN ${person.id} IS NULL THEN NULL ELSE concat_ws(' ', ${person.firstName}, ${person.lastName}) END`;

const PRIORITY_RANK = sql`CASE ${tasks.priority} WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END`;

export interface TaskListOptions {
  readonly filter: TaskFilter;
  readonly sort: readonly SortTerm[];
  readonly limit: number;
  readonly offset: number;
  /** The caller's own employee id, for `mine`. Null when they have none: `mine` then matches nothing. */
  readonly selfEmployeeId: string | null;
  /** The organisation's calendar date, for the due filters. */
  readonly today: string;
}

export class TaskRepository extends ScopedRepository<typeof tasks> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, tasks, ctx);
  }

  private selection() {
    return {
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      subjectType: tasks.subjectType,
      subjectId: tasks.subjectId,
      subjectLabel: tasks.subjectLabel,
      assigneeId: tasks.assigneeId,
      assigneeName: personName(assignee),
      ownerId: tasks.ownerId,
      ownerName: personName(owner),
      partyId: tasks.partyId,
      partyName: tasks.partyName,
      vendorId: tasks.vendorId,
      vendorName: tasks.vendorName,
      dueDate: tasks.dueDate,
      priority: tasks.priority,
      columnId: tasks.columnId,
      columnName: taskBoardColumns.name,
      isDone: taskBoardColumns.isDone,
      closedAt: tasks.closedAt,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    };
  }

/**
   * The items on a page of tasks, in one query.
   *
   * Fetched for the whole result set rather than per row: the board draws a
   * hundred cards, and a read per card is a hundred round trips to render one
   * screen. Sorted here so a card's items always read in the order they were
   * added.
   */
  private async itemsFor(taskIds: readonly string[]): Promise<Map<string, TaskItemView[]>> {
    const byTask = new Map<string, TaskItemView[]>();
    if (taskIds.length === 0) return byTask;
    const rows = await this.db
      .select({
        taskId: taskItems.taskId,
        itemId: taskItems.itemId,
        itemName: taskItems.itemName,
        quantity: taskItems.quantity,
        rate: taskItems.rate,
        discountPct: taskItems.discountPct,
      })
      .from(taskItems)
      .where(and(eq(taskItems.orgId, this.ctx.orgId), isNull(taskItems.deletedAt), inArray(taskItems.taskId, [...taskIds])))
      .orderBy(taskItems.sortOrder, taskItems.itemName);
    for (const row of rows) {
      const list = byTask.get(row.taskId) ?? [];
      list.push({
        itemId: row.itemId,
        itemName: row.itemName,
        quantity: row.quantity,
        rate: row.rate,
        discountPct: row.discountPct,
        // Computed where it is read rather than stored: a stored total is a
        // second source of truth that goes stale the moment a rate is edited.
        amount: taskLineAmount(row.quantity, row.rate, row.discountPct),
      });
      byTask.set(row.taskId, list);
    }
    return byTask;
  }

  /**
   * How many files each task on a page carries, in one query.
   *
   * The same batching as `itemsFor`, for the same reason: the board draws a
   * hundred cards and a count per card would be a hundred round trips.
   */
  /**
   * How many files a task carries, and which one the gallery leads with.
   *
   * Both in one query. The cover is the earliest image on the task -- the
   * photograph somebody took first, which on a site visit is the one that
   * says what the task is about. `mime` lives on `files`, so this joins;
   * `ARRAY_AGG ... FILTER` picks the cover without a second round trip and
   * without fetching every attachment of every task on the board.
   */
  private async attachmentCounts(
    taskIds: readonly string[],
  ): Promise<Map<string, { count: number; coverId: string | null }>> {
    const counts = new Map<string, { count: number; coverId: string | null }>();
    if (taskIds.length === 0) return counts;
    const rows = await this.db
      .select({
        taskId: taskAttachments.taskId,
        count: sql<number>`count(*)::int`,
        coverId: sql<string | null>`(array_agg(${taskAttachments.id} ORDER BY ${taskAttachments.createdAt})
          FILTER (WHERE ${files.mime} LIKE 'image/%'))[1]`,
      })
      .from(taskAttachments)
      .innerJoin(files, eq(files.id, taskAttachments.fileId))
      .where(
        and(
          eq(taskAttachments.orgId, this.ctx.orgId),
          isNull(taskAttachments.deletedAt),
          inArray(taskAttachments.taskId, [...taskIds]),
        ),
      )
      .groupBy(taskAttachments.taskId);
    for (const row of rows) counts.set(row.taskId, { count: row.count, coverId: row.coverId });
    return counts;
  }

  /** Replace a task's items wholesale. Absent means "leave them alone"; empty means "clear them". */
  async setItems(
    taskId: string,
    chosen: readonly { id: string; name: string; quantity: string; rate: string | null; discountPct: string }[],
  ): Promise<void> {
    // Deleted outright rather than soft-deleted: a task item is a link, not a
    // record with a history anybody reads, and the unique index is partial on
    // `deleted_at IS NULL` -- a soft delete would leave a row that blocks the
    // same item being added back.
    await this.db.delete(taskItems).where(and(eq(taskItems.orgId, this.ctx.orgId), eq(taskItems.taskId, taskId)));
    if (chosen.length === 0) return;
    await this.db.insert(taskItems).values(
      chosen.map((item, index) => ({
        orgId: this.ctx.orgId,
        taskId,
        itemId: item.id,
        itemName: item.name,
        quantity: item.quantity,
        rate: item.rate,
        discountPct: item.discountPct,
        sortOrder: index,
        createdBy: this.ctx.actorUserId,
        updatedBy: this.ctx.actorUserId,
      })),
    );
  }

  private query(where: SQL) {
    return this.db
      .select(this.selection())
      .from(tasks)
      .innerJoin(taskBoardColumns, eq(taskBoardColumns.id, tasks.columnId))
      .leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
      .leftJoin(owner, eq(owner.id, tasks.ownerId))
      .where(where);
  }

  /** The one filter both renderings share (REQ-V-04). */
  static filterPredicate(
    filter: TaskFilter,
    selfEmployeeId: string | null,
    today: string,
  ): SQL | undefined {
    const parts: (SQL | undefined)[] = [];
    if (filter.q !== undefined) parts.push(masterSearch(filter.q, [tasks.title, tasks.description]));
    if (filter.mine === true) {
      parts.push(selfEmployeeId === null ? sql`false` : eq(tasks.assigneeId, selfEmployeeId));
    }
    if (filter.assigneeId !== undefined) parts.push(eq(tasks.assigneeId, filter.assigneeId));
    if (filter.columnId !== undefined) parts.push(eq(tasks.columnId, filter.columnId));
    if (filter.priority !== undefined) parts.push(eq(tasks.priority, filter.priority));
    if (filter.subjectType !== undefined) parts.push(eq(tasks.subjectType, filter.subjectType));
    if (filter.subjectId !== undefined) parts.push(eq(tasks.subjectId, filter.subjectId));
    if (filter.partyId !== undefined) parts.push(eq(tasks.partyId, filter.partyId));
    if (filter.vendorId !== undefined) parts.push(eq(tasks.vendorId, filter.vendorId));
    if (filter.itemId !== undefined) {
      // EXISTS rather than a join: a join would return one row per matching
      // item and page a task twice if it ever named the same item twice.
      parts.push(sql`EXISTS (
        SELECT 1 FROM ${taskItems}
        WHERE ${taskItems.taskId} = ${tasks.id}
          AND ${taskItems.itemId} = ${filter.itemId}
          AND ${taskItems.deletedAt} IS NULL
      )`);
    }

    const due = filter.due;
    // Closed tasks are out unless asked for, and every due slice is about
    // open work: an overdue task that was closed yesterday is not overdue.
    const openOnly = filter.includeClosed !== true || (due !== undefined && due !== 'open');
    if (openOnly) parts.push(isNull(tasks.closedAt));
    switch (due) {
      case 'overdue':
        parts.push(sql`${tasks.dueDate} < ${today}::date`);
        break;
      case 'today':
        parts.push(sql`${tasks.dueDate} = ${today}::date`);
        break;
      case 'upcoming':
        parts.push(sql`${tasks.dueDate} > ${today}::date`);
        break;
      case 'undated':
        parts.push(isNull(tasks.dueDate));
        break;
      default:
        break;
    }
    return and(...parts);
  }

  private orderBy(sort: readonly SortTerm[]): (SQL | PgColumn)[] {
    const clauses: (SQL | PgColumn)[] = [];
    for (const term of sort) {
      const dir = term.direction === 'desc' ? desc : asc;
      switch (term.field) {
        case 'dueDate':
          // Undated last either way: a task with no date is not "due first".
          clauses.push(sql`${tasks.dueDate} IS NULL`, dir(tasks.dueDate));
          break;
        case 'priority':
          clauses.push(dir(PRIORITY_RANK));
          break;
        case 'title':
          clauses.push(dir(tasks.title));
          break;
        case 'createdAt':
          clauses.push(dir(tasks.createdAt));
          break;
        case 'updatedAt':
          clauses.push(dir(tasks.updatedAt));
          break;
        default:
          break;
      }
    }
    if (clauses.length === 0) clauses.push(sql`${tasks.dueDate} IS NULL`, asc(tasks.dueDate));
    // REQ-V-07's order within a day: the urgent one first, then stable.
    clauses.push(asc(PRIORITY_RANK), asc(tasks.createdAt), asc(tasks.id));
    return clauses;
  }

  async list(scope: SQL, options: TaskListOptions): Promise<{ rows: TaskView[]; total: number }> {
    const predicate = TaskRepository.filterPredicate(options.filter, options.selfEmployeeId, options.today);
    const rows = await this.query(this.scoped(scope, predicate))
      .orderBy(...this.orderBy(options.sort))
      .limit(options.limit)
      .offset(options.offset);
    const total = await this.count(and(scope, predicate));
    const ids = rows.map((row) => row.id);
    const [items, attachments] = await Promise.all([this.itemsFor(ids), this.attachmentCounts(ids)]);
    return { rows: rows.map((row) => toTaskView(row, items, attachments)), total };
  }

  /**
   * REQ-V-03/V-04: the same predicate, grouped by column. Every alive column
   * is a lane even when empty — an empty "In progress" is information. Each
   * lane is capped; the count says what the cap hid.
   */
  async board(
    scope: SQL,
    options: Omit<TaskListOptions, 'limit' | 'offset' | 'sort'>,
    columns: readonly TaskBoardColumnView[],
  ): Promise<{ columnId: string; tasks: TaskView[]; total: number }[]> {
    const predicate = TaskRepository.filterPredicate(options.filter, options.selfEmployeeId, options.today);
    const lanes: { columnId: string; tasks: TaskView[]; total: number }[] = [];
    for (const column of columns) {
      const where = this.scoped(scope, predicate, eq(tasks.columnId, column.id));
      const rows = await this.query(where)
        .orderBy(...this.orderBy([{ field: 'dueDate', direction: 'asc' }]))
        .limit(TASK_BOARD_LANE_CAP);
      const total =
        rows.length < TASK_BOARD_LANE_CAP
          ? rows.length
          : await this.count(and(scope, predicate, eq(tasks.columnId, column.id)));
      const ids = rows.map((row) => row.id);
      const [items, attachments] = await Promise.all([this.itemsFor(ids), this.attachmentCounts(ids)]);
      lanes.push({ columnId: column.id, tasks: rows.map((row) => toTaskView(row, items, attachments)), total });
    }
    return lanes;
  }

  async view(scope: SQL, id: string): Promise<TaskView | null> {
    const rows = await this.query(this.scoped(scope, eq(tasks.id, id))).limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const [items, attachments] = await Promise.all([this.itemsFor([row.id]), this.attachmentCounts([row.id])]);
    return toTaskView(row, items, attachments);
  }

  /** How many open tasks sit in a column — the guard on deleting one. */
  async countInColumn(columnId: string): Promise<number> {
    return this.count(eq(tasks.columnId, columnId));
  }

  /**
   * The reminder sweep's two questions (REQ-V-08), for one organisation and
   * one calendar date: what falls due today, and what went past. Assignees
   * only — a task nobody is assigned reminds nobody.
   */
  async dueOn(today: string): Promise<{ id: string; title: string; assigneeId: string; subjectLabel: string | null; dueDate: string }[]> {
    const rows = await this.db
      .select({ id: tasks.id, title: tasks.title, assigneeId: tasks.assigneeId, subjectLabel: tasks.subjectLabel, dueDate: tasks.dueDate })
      .from(tasks)
      .where(this.scoped(isNull(tasks.closedAt), isNotNull(tasks.assigneeId), sql`${tasks.dueDate} = ${today}::date`));
    return rows.flatMap((r) =>
      r.assigneeId === null || r.dueDate === null ? [] : [{ ...r, assigneeId: r.assigneeId, dueDate: r.dueDate }],
    );
  }

  async overdueOn(today: string): Promise<{ id: string; title: string; assigneeId: string; subjectLabel: string | null; dueDate: string }[]> {
    const rows = await this.db
      .select({ id: tasks.id, title: tasks.title, assigneeId: tasks.assigneeId, subjectLabel: tasks.subjectLabel, dueDate: tasks.dueDate })
      .from(tasks)
      .where(this.scoped(isNull(tasks.closedAt), isNotNull(tasks.assigneeId), sql`${tasks.dueDate} < ${today}::date`));
    return rows.flatMap((r) =>
      r.assigneeId === null || r.dueDate === null ? [] : [{ ...r, assigneeId: r.assigneeId, dueDate: r.dueDate }],
    );
  }
}

export class BoardColumnRepository extends ScopedRepository<typeof taskBoardColumns> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, taskBoardColumns, ctx);
  }

  /**
   * The organisation's columns, in order — created from the defaults on
   * first read, so a fresh organisation has a board and no migration has to
   * know which organisations exist. Two racing first reads are settled by
   * the unique name index: the loser re-reads.
   */
  async listOrCreateDefaults(): Promise<TaskBoardColumnView[]> {
    const existing = await this.listOrdered();
    if (existing.length > 0) return existing;
    try {
      await this.insertMany(
        DEFAULT_BOARD_COLUMNS.map((column, index) => ({ name: column.name, isDone: column.isDone, sortOrder: index })),
      );
    } catch {
      // Lost the race; the winner's rows are read below.
    }
    return this.listOrdered();
  }

  async listOrdered(): Promise<TaskBoardColumnView[]> {
    const rows = await this.findMany({ orderBy: [asc(taskBoardColumns.sortOrder), asc(taskBoardColumns.createdAt)] });
    return rows.map((row) => ({ id: row.id, name: row.name, sortOrder: row.sortOrder, isDone: row.isDone }));
  }

  async findByName(name: string, excludeId?: string): Promise<string | null> {
    const rows = await this.findMany({
      where: and(
        sql`lower(${taskBoardColumns.name}) = lower(${name})`,
        excludeId === undefined ? undefined : sql`${taskBoardColumns.id} <> ${excludeId}`,
      ),
      limit: 1,
    });
    return rows[0]?.id ?? null;
  }

  async reorder(columnIds: readonly string[]): Promise<void> {
    for (const [index, id] of columnIds.entries()) {
      await this.update(id, { sortOrder: index });
    }
  }

  async firstOpen(): Promise<TaskBoardColumnView | null> {
    const columns = await this.listOrCreateDefaults();
    return columns.find((c) => !c.isDone) ?? columns[0] ?? null;
  }

  async find(id: string): Promise<TaskBoardColumnView | null> {
    const row = await this.findById(id);
    return row === null ? null : { id: row.id, name: row.name, sortOrder: row.sortOrder, isDone: row.isDone };
  }

  /** Whether the ids are exactly this organisation's alive columns, for `reorder`. */
  async isCompleteSet(columnIds: readonly string[]): Promise<boolean> {
    const alive = await this.listOrdered();
    if (alive.length !== columnIds.length) return false;
    const set = new Set(columnIds);
    return alive.every((c) => set.has(c.id)) && set.size === columnIds.length;
  }

  async anyOpenColumn(excludeId: string): Promise<boolean> {
    const rows = await this.findMany({ where: and(eq(taskBoardColumns.isDone, false), sql`${taskBoardColumns.id} <> ${excludeId}`), limit: 1 });
    return rows.length > 0;
  }

  /** Whether an id names a column of this org — a scoped `IN` for the service's guards. */
  async existAll(ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    return (await this.count(inArray(taskBoardColumns.id, [...ids]))) === ids.length;
  }
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  partyId: string | null;
  partyName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  dueDate: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  columnId: string;
  columnName: string;
  isDone: boolean;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Shared by every task with no items, so the common case allocates nothing. */
const EMPTY_ITEMS: readonly TaskItemView[] = [];

function toTaskView(
  row: TaskRow,
  items: ReadonlyMap<string, TaskItemView[]>,
  attachments: ReadonlyMap<string, { count: number; coverId: string | null }>,
): TaskView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeName,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    partyId: row.partyId,
    partyName: row.partyName,
    vendorId: row.vendorId,
    vendorName: row.vendorName,
    items: items.get(row.id) ?? EMPTY_ITEMS,
    attachmentCount: attachments.get(row.id)?.count ?? 0,
    coverAttachmentId: attachments.get(row.id)?.coverId ?? null,
    dueDate: row.dueDate,
    priority: row.priority,
    columnId: row.columnId,
    columnName: row.columnName,
    isClosed: row.closedAt !== null,
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
