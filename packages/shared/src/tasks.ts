import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * Tasks (08 Area V). A platform record, not a CRM one (D-17): a task hangs
 * off a contact, a deal, an invoice, an employee, or nothing at all, through
 * a polymorphic `(subjectType, subjectId)` — the approvals table's shape.
 *
 * Status is the board column (REQ-V-03): columns are configuration, so
 * "done" is a property of the column a task sits in, not a hard-coded enum.
 */

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

/** Ordered for the board and the list: high first. */
export const TASK_PRIORITY_RANK: Record<TaskPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * REQ-V-07's three slices of the due date, in the organisation's day. `open`
 * is the default: everything not yet done, whatever its date.
 */
export const TASK_DUE_FILTERS = ['open', 'overdue', 'today', 'upcoming', 'undated'] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];

export const TASK_SORT_FIELDS = ['dueDate', 'priority', 'title', 'createdAt', 'updatedAt'] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];
export const DEFAULT_TASK_SORT = 'dueDate';

/**
 * A subject type is the same string the Go To palette routes on, so the
 * client opens a task's subject the way it opens a search hit. The server's
 * `TaskSubjectRegistry` decides which of these are known in a given build.
 */
const subjectTypeField = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/u, 'a lower-case type name');

export interface TaskBoardColumnView {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  /** A task in this column is closed (REQ-V-01 status "done" is a column property). */
  readonly isDone: boolean;
}

/**
 * One stock item on a task. No quantity and no rate: a task is a piece of
 * work, not a document -- the moment it carries amounts it is a sales order
 * wearing the wrong name, and sales owns that model.
 */
export interface TaskItemView {
  readonly itemId: string;
  readonly itemName: string;
}

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  /** The subject's name at the time it was attached; the client routes by type + id. */
  readonly subjectLabel: string | null;
  /**
   * REQ-V-09: the customer and the supplier this task is about.
   *
   * Both, and separately: "chase Sanghvi for the coupler Acme is waiting on"
   * names a vendor and a party at once, and they are not the same slot. The
   * name is the snapshot taken when it was chosen, so a register of hundreds
   * of rows never joins the projection to print a word.
   */
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly vendorId: string | null;
  readonly vendorName: string | null;
  /** REQ-V-10: the stock items this task is about, in the order they were added. */
  readonly items: readonly TaskItemView[];
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  /** `YYYY-MM-DD` or null. */
  readonly dueDate: string | null;
  readonly priority: TaskPriority;
  readonly columnId: string;
  readonly columnName: string;
  readonly isClosed: boolean;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** REQ-V-04: the board is this list, grouped. One filter shape for both. */
export const taskFilterSchema = z.object({
  /** Free text over title and description. */
  q: z.string().trim().min(1).max(80).optional(),
  /** Assigned to the caller. Absent means everyone the caller may see. */
  mine: z.coerce.boolean().optional(),
  assigneeId: z.uuid().optional(),
  columnId: z.uuid().optional(),
  priority: taskPrioritySchema.optional(),
  due: z.enum(TASK_DUE_FILTERS).optional(),
  subjectType: subjectTypeField.optional(),
  subjectId: z.uuid().optional(),
  /** Every task about one customer, or one supplier, or naming one item. */
  partyId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  itemId: z.uuid().optional(),
  /** Closed tasks are hidden unless asked for; `due` other than `open` implies open. */
  includeClosed: z.coerce.boolean().optional(),
});
export type TaskFilter = z.infer<typeof taskFilterSchema>;

export const taskListQuerySchema = pageQuerySchema.extend(taskFilterSchema.shape).extend({
  sort: z.string().max(200).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const taskBoardQuerySchema = taskFilterSchema;
export type TaskBoardQuery = z.infer<typeof taskBoardQuerySchema>;

export interface TaskBoardLane {
  readonly column: TaskBoardColumnView;
  readonly tasks: readonly TaskView[];
  /** Beyond `tasks` when the lane was capped; the list view has the rest. */
  readonly total: number;
}

export interface TaskBoardView {
  readonly lanes: readonly TaskBoardLane[];
}

/** How many cards a lane carries before it says "and N more" (REQ-V-04's board is a rendering, not a report). */
export const TASK_BOARD_LANE_CAP = 100;

/**
 * How many items one task may name. A task listing thirty items is a picking
 * list, and this product has one of those already.
 */
export const TASK_ITEM_CAP = 20;

const titleField = z.string().trim().min(1).max(200);
const descriptionField = z.string().trim().max(4000);

export const createTaskSchema = z
  .object({
    title: titleField,
    description: descriptionField.nullish(),
    subjectType: subjectTypeField.nullish(),
    subjectId: z.uuid().nullish(),
    /** Defaults to the creator; a `manage` holder may assign anyone in the organisation. */
    assigneeId: z.uuid().nullish(),
    /** REQ-V-09: a Tally party under Sundry Debtors. */
    partyId: z.uuid().nullish(),
    /** REQ-V-09: a Tally party under Sundry Creditors. */
    vendorId: z.uuid().nullish(),
    /** REQ-V-10: stock item ids. Order is kept; a repeat is a slip, not a quantity. */
    itemIds: z.array(z.uuid()).max(TASK_ITEM_CAP).optional(),
    dueDate: z.iso.date().nullish(),
    priority: taskPrioritySchema.default('MEDIUM'),
    /** Defaults to the first column. */
    columnId: z.uuid().nullish(),
  })
  .refine((t) => (t.subjectType == null) === (t.subjectId == null), {
    message: 'subjectType and subjectId go together',
    path: ['subjectId'],
  });
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: titleField.optional(),
    description: descriptionField.nullish(),
    subjectType: subjectTypeField.nullish(),
    subjectId: z.uuid().nullish(),
    assigneeId: z.uuid().nullish(),
    partyId: z.uuid().nullish(),
    vendorId: z.uuid().nullish(),
    /** The whole list, or absent to leave it alone. An empty array clears it. */
    itemIds: z.array(z.uuid()).max(TASK_ITEM_CAP).optional(),
    dueDate: z.iso.date().nullish(),
    priority: taskPrioritySchema.optional(),
    /** REQ-V-06: a drag is this field changing, and nothing else. */
    columnId: z.uuid().optional(),
  })
  .refine(
    (t) =>
      (t.subjectType === undefined && t.subjectId === undefined) ||
      (t.subjectType == null) === (t.subjectId == null),
    { message: 'subjectType and subjectId go together', path: ['subjectId'] },
  );
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const createBoardColumnSchema = z.object({
  name: z.string().trim().min(1).max(60),
  isDone: z.boolean().default(false),
});
export type CreateBoardColumnInput = z.infer<typeof createBoardColumnSchema>;

export const updateBoardColumnSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  isDone: z.boolean().optional(),
});
export type UpdateBoardColumnInput = z.infer<typeof updateBoardColumnSchema>;

/** The whole order at once, so two quick moves cannot leave two columns claiming one slot. */
export const reorderBoardColumnsSchema = z.object({
  columnIds: z.array(z.uuid()).min(1).max(50),
});
export type ReorderBoardColumnsInput = z.infer<typeof reorderBoardColumnsSchema>;

/** The columns an organisation starts with; renamed and reordered from there. */
export const DEFAULT_BOARD_COLUMNS: readonly { name: string; isDone: boolean }[] = [
  { name: 'To do', isDone: false },
  { name: 'In progress', isDone: false },
  { name: 'Done', isDone: true },
];

/**
 * REQ-V-11: the task dashboard.
 *
 * Aggregated on the server under the same scope the register applies -- a
 * self-scoped viewer's totals must equal the totals of the tasks their own
 * list would show, or the dashboard becomes a way to learn how much work
 * exists that you are not allowed to see.
 */
export const taskAnalyticsQuerySchema = z.object({
  /** How many weeks of raised-and-closed history to plot, including this one. */
  weeks: z.coerce.number().int().min(4).max(26).default(8),
});

export type TaskAnalyticsQuery = z.infer<typeof taskAnalyticsQuerySchema>;

export interface TaskColumnLoad {
  readonly columnId: string;
  readonly columnName: string;
  readonly sortOrder: number;
  readonly isDone: boolean;
  readonly count: number;
}

export interface TaskAssigneeLoad {
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly openCount: number;
  readonly overdueCount: number;
}

export interface TaskFlowWeek {
  /** The Monday of the week, `YYYY-MM-DD`, in the organisation's timezone. */
  readonly weekStart: string;
  readonly raised: number;
  readonly closed: number;
}

export interface TaskAnalyticsView {
  readonly totals: {
    readonly open: number;
    readonly overdue: number;
    readonly dueToday: number;
    readonly dueThisWeek: number;
    readonly unassigned: number;
    readonly closedInPeriod: number;
    /** Mean days from raising to closing, for what closed in the period; null when nothing did. */
    readonly avgDaysToClose: number | null;
  };
  readonly columns: readonly TaskColumnLoad[];
  readonly assignees: readonly TaskAssigneeLoad[];
  readonly priorities: readonly { readonly priority: TaskPriority; readonly openCount: number }[];
  readonly flow: readonly TaskFlowWeek[];
}

/**
 * Below this many closed tasks, a mean time-to-close is one slow task
 * wearing a statistic's clothes.
 */
export const MIN_CLOSED_FOR_AVERAGE = 5;
