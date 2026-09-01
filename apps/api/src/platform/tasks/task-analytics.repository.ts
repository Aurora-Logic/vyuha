import type {
  TaskAgeBucket,
  TaskAgeLoad,
  TaskAssigneeLoad,
  TaskColumnLoad,
  TaskCustomerLoad,
  TaskFlowWeek,
  TaskPriority,
} from '@vyuha/shared';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../db/db.provider.js';
import { employees, parties, taskBoardColumns, tasks } from '../db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../db/scoped-repository.js';

/**
 * The task dashboard's arithmetic, in the database (REQ-V-11).
 *
 * Every query carries `this.scoped(scope, ...)` — the organisation and
 * whatever the caller's task scope resolves to, the same pair the register
 * carries. A count is a way to learn about rows you cannot read: told there
 * are ninety open tasks when your own list shows four, you have learned the
 * size of somebody else's workload.
 */

const assignee = alias(employees, 'analytics_assignee');

const personName = (person: { id: PgColumn; firstName: PgColumn; lastName: PgColumn }): SQL<string | null> =>
  sql<string | null>`CASE WHEN ${person.id} IS NULL THEN NULL ELSE concat_ws(' ', ${person.firstName}, ${person.lastName}) END`;

/** Open is "not in a done column", the same rule the register closes a task by. */
const IS_OPEN = sql`${tasks.closedAt} IS NULL`;

export interface TaskTotals {
  readonly open: number;
  readonly overdue: number;
  readonly dueToday: number;
  readonly dueThisWeek: number;
  readonly unassigned: number;
  readonly closedInPeriod: number;
  readonly avgDaysToClose: number | null;
}

export class TaskAnalyticsRepository extends ScopedRepository<typeof tasks> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, tasks, ctx);
  }

  /**
   * The headline counts.
   *
   * `today` is the organisation's calendar date, passed in rather than taken
   * from the database's clock: an office in Nashik reading a server in
   * another timezone would see work go overdue hours early.
   */
  async totals(scope: SQL, today: string, since: Date): Promise<TaskTotals> {
    const rows = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${IS_OPEN})::int`,
        overdue: sql<number>`count(*) filter (where ${IS_OPEN} and ${tasks.dueDate} < ${today}::date)::int`,
        dueToday: sql<number>`count(*) filter (where ${IS_OPEN} and ${tasks.dueDate} = ${today}::date)::int`,
        dueThisWeek: sql<number>`count(*) filter (where ${IS_OPEN} and ${tasks.dueDate} between ${today}::date and (${today}::date + 6))::int`,
        unassigned: sql<number>`count(*) filter (where ${IS_OPEN} and ${tasks.assigneeId} is null)::int`,
        closedInPeriod: sql<number>`count(*) filter (where ${tasks.closedAt} >= ${since})::int`,
        avgDaysToClose: sql<number | null>`avg(extract(epoch from (${tasks.closedAt} - ${tasks.createdAt})) / 86400) filter (where ${tasks.closedAt} >= ${since})`,
      })
      .from(tasks)
      .where(this.scoped(scope));

    const row = rows[0];
    return {
      open: row?.open ?? 0,
      overdue: row?.overdue ?? 0,
      dueToday: row?.dueToday ?? 0,
      dueThisWeek: row?.dueThisWeek ?? 0,
      unassigned: row?.unassigned ?? 0,
      closedInPeriod: row?.closedInPeriod ?? 0,
      // Null is "nothing closed in the period", which is not zero days.
      avgDaysToClose:
        row?.avgDaysToClose === null || row?.avgDaysToClose === undefined
          ? null
          : Math.round(Number(row.avgDaysToClose) * 10) / 10,
    };
  }

  /** Open tasks per board column, every column present even when empty. */
  async columns(scope: SQL): Promise<TaskColumnLoad[]> {
    return this.db
      .select({
        columnId: taskBoardColumns.id,
        columnName: taskBoardColumns.name,
        sortOrder: taskBoardColumns.sortOrder,
        isDone: taskBoardColumns.isDone,
        count: sql<number>`count(${tasks.id})::int`,
      })
      .from(taskBoardColumns)
      // Left, so an empty "In progress" is drawn. An empty column is
      // information: it says nothing has been started.
      .leftJoin(tasks, and(eq(tasks.columnId, taskBoardColumns.id), this.scoped(scope, sql`${IS_OPEN}`)))
      .where(and(eq(taskBoardColumns.orgId, this.ctx.orgId), isNull(taskBoardColumns.deletedAt)))
      .groupBy(taskBoardColumns.id, taskBoardColumns.name, taskBoardColumns.sortOrder, taskBoardColumns.isDone)
      .orderBy(taskBoardColumns.sortOrder);
  }

  /** Who is carrying open work, and how much of theirs is late. */
  async assignees(scope: SQL, today: string, limit: number): Promise<TaskAssigneeLoad[]> {
    return this.db
      .select({
        assigneeId: tasks.assigneeId,
        assigneeName: personName(assignee),
        openCount: sql<number>`count(*)::int`,
        overdueCount: sql<number>`count(*) filter (where ${tasks.dueDate} < ${today}::date)::int`,
      })
      .from(tasks)
      .leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
      .where(this.scoped(scope, sql`${IS_OPEN}`))
      .groupBy(tasks.assigneeId, assignee.id, assignee.firstName, assignee.lastName)
      .orderBy(sql`count(*) desc`)
      .limit(limit);
  }

  /**
   * How long the open work has been open.
   *
   * The count of open tasks cannot answer this and it is the question that
   * matters: seventeen open is fine if they all arrived this week and a
   * problem if nine have been sitting a month. Bucketed in SQL rather than in
   * the browser so the page carries four rows instead of every open task.
   *
   * Ages are whole days from `created_at` in the organisation's timezone --
   * the same clock the flow chart's weeks are cut on, so "this week" means
   * one thing across the dashboard.
   */
  async ageing(scope: SQL, today: string, timezone: string): Promise<TaskAgeLoad[]> {
    const age = sql`(${today}::date - (${tasks.createdAt} at time zone ${timezone})::date)`;
    const bucket = sql<TaskAgeBucket>`CASE
      WHEN ${age} < 7 THEN 'WEEK'
      WHEN ${age} < 14 THEN 'FORTNIGHT'
      WHEN ${age} < 30 THEN 'MONTH'
      ELSE 'OLDER'
    END`;
    return this.db
      .select({
        bucket,
        openCount: sql<number>`count(*)::int`,
        overdueCount: sql<number>`count(*) filter (where ${tasks.dueDate} < ${today}::date)::int`,
      })
      .from(tasks)
      .where(this.scoped(scope, sql`${IS_OPEN}`))
      // By ordinal, not by the expression. Repeating a CASE that carries
      // bound parameters renumbers its placeholders in the GROUP BY, and
      // Postgres answers 500 rather than grouping -- the same trap the CFO
      // aggregates hit.
      .groupBy(sql`1`);
  }

  /**
   * Open tasks per customer.
   *
   * "Who is carrying it" answers which colleague; this answers which account,
   * which is the one an owner asks about a week before a renewal. Tasks with
   * no customer are left out rather than grouped as "None": they are the
   * internal work, and a bar for them would tower over every real account and
   * say nothing.
   */
  async customers(scope: SQL, today: string, limit: number): Promise<TaskCustomerLoad[]> {
    return this.db
      .select({
        partyId: sql<string>`${tasks.partyId}`,
        partyName: sql<string>`${parties.name}`,
        openCount: sql<number>`count(*)::int`,
        overdueCount: sql<number>`count(*) filter (where ${tasks.dueDate} < ${today}::date)::int`,
      })
      .from(tasks)
      .innerJoin(parties, eq(parties.id, tasks.partyId))
      .where(this.scoped(scope, sql`${IS_OPEN}`))
      .groupBy(tasks.partyId, parties.name)
      .orderBy(sql`count(*) desc`)
      .limit(limit);
  }

  async priorities(scope: SQL): Promise<{ priority: TaskPriority; openCount: number }[]> {
    return this.db
      .select({ priority: tasks.priority, openCount: sql<number>`count(*)::int` })
      .from(tasks)
      .where(this.scoped(scope, sql`${IS_OPEN}`))
      .groupBy(tasks.priority);
  }

  /**
   * Raised against closed, by week.
   *
   * Two counts on one axis. The question is whether work is being closed as
   * fast as it arrives, and that is only readable when both are measured the
   * same way — which is exactly what a second axis destroys.
   */
  async flow(scope: SQL, since: Date, timezone: string): Promise<TaskFlowWeek[]> {
    const rows = await this.db
      .select({
        weekStart: sql<string>`to_char(date_trunc('week', ${tasks.createdAt} at time zone ${timezone}), 'YYYY-MM-DD')`,
        raised: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(this.scoped(scope, sql`${tasks.createdAt} >= ${since}`))
      // By ordinal: drizzle emits the timezone as a fresh placeholder per
      // clause, so `group by to_char(... $4 ...)` is a different expression
      // to the one selected and Postgres refuses the query.
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const closedRows = await this.db
      .select({
        weekStart: sql<string>`to_char(date_trunc('week', ${tasks.closedAt} at time zone ${timezone}), 'YYYY-MM-DD')`,
        closed: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(this.scoped(scope, sql`${tasks.closedAt} >= ${since}`))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const closedByWeek = new Map(closedRows.map((row) => [row.weekStart, row.closed]));
    const weeks = new Map<string, TaskFlowWeek>();
    for (const row of rows) {
      weeks.set(row.weekStart, { weekStart: row.weekStart, raised: row.raised, closed: closedByWeek.get(row.weekStart) ?? 0 });
    }
    // A week in which nothing was raised but something closed is still a week.
    for (const [weekStart, closed] of closedByWeek) {
      if (!weeks.has(weekStart)) weeks.set(weekStart, { weekStart, raised: 0, closed });
    }
    return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }
}
