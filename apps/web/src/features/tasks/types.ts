import { z } from 'zod';

import { TASK_PRIORITIES, type TaskPriority } from '@vyuha/shared';

/** What `/tasks` answers (REQ-V-01), parsed at the boundary. */

export const boardColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  sortOrder: z.number(),
  isDone: z.boolean(),
});
export type BoardColumn = z.infer<typeof boardColumnSchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  subjectLabel: z.string().nullable(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  // REQ-V-09 / REQ-V-10. Defaulted, so a client built before the server
  // shipped these reads a task without throwing on a missing key.
  partyId: z.string().nullable().default(null),
  partyName: z.string().nullable().default(null),
  vendorId: z.string().nullable().default(null),
  vendorName: z.string().nullable().default(null),
  items: z
    .array(
      z.object({
        itemId: z.string(),
        itemName: z.string(),
        // Defaulted so a client built before REQ-V-17 still reads a task, and
        // so zod does not strip what it has not declared.
        quantity: z.string().default('1'),
        rate: z.string().nullable().default(null),
        discountPct: z.string().default('0'),
        amount: z.string().nullable().default(null),
      }),
    )
    .default([]),
  // REQ-V-12. Defaulted like the rest: a client built before the server
  // shipped it must still read a task. Missing it entirely is what made the
  // Files cell render blank instead of a count -- zod drops what it does not
  // declare, so the card asked for a field that had already been stripped.
  attachmentCount: z.number().default(0),
  /** The image the gallery leads with, when the task carries one. */
  coverAttachmentId: z.string().nullable().default(null),
  coverFileId: z.string().nullable().default(null),
  /** Signed with the list, so a gallery card needs no request of its own. */
  coverUrl: z.string().nullable().default(null),
  dueDate: z.string().nullable(),
  priority: z.enum(TASK_PRIORITIES),
  columnId: z.string(),
  columnName: z.string(),
  isClosed: z.boolean(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

/**
 * A task is an order when it carries item lines (REQ-V-17: the order a task
 * carries). Placing an order writes exactly that -- a party and its items -- so
 * the presence of items is what marks a card as an order on every surface, and
 * this is the one place that rule is written.
 */
export function isOrderTask(task: Pick<Task, 'items'>): boolean {
  return task.items.length > 0;
}

export const tasksResponseSchema = z.object({
  data: z.array(taskSchema),
  meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
});
export type TasksResponse = z.infer<typeof tasksResponseSchema>;

export const boardResponseSchema = z.object({
  lanes: z.array(z.object({ column: boardColumnSchema, tasks: z.array(taskSchema), total: z.number() })),
});
export type BoardResponse = z.infer<typeof boardResponseSchema>;

export const boardColumnsSchema = z.array(boardColumnSchema);

/** One line of the order a task is carrying (REQ-V-17). */
export interface TaskItemLine {
  itemId: string;
  itemName: string;
  quantity: string;
  rate: string | null;
  discountPct: string;
  amount: string | null;
}

/** The sheet's working copy. */
export interface TaskDraft {
  id?: string;
  title: string;
  description: string;
  assigneeId: string | null;
  dueDate: string | null;
  priority: TaskPriority;
  columnId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  partyId: string | null;
  /** Carried beside the id so the picker's trigger reads without a second fetch. */
  partyName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  items: TaskItemLine[];
}

export function emptyTaskDraft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    title: '',
    description: '',
    assigneeId: null,
    dueDate: null,
    priority: 'MEDIUM',
    columnId: null,
    subjectType: null,
    subjectId: null,
    subjectLabel: null,
    partyId: null,
    partyName: null,
    vendorId: null,
    vendorName: null,
    items: [],
    ...overrides,
  };
}

export function taskToDraft(task: Task): TaskDraft {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    assigneeId: task.assigneeId,
    dueDate: task.dueDate,
    priority: task.priority,
    columnId: task.columnId,
    subjectType: task.subjectType,
    subjectId: task.subjectId,
    subjectLabel: task.subjectLabel,
    partyId: task.partyId,
    partyName: task.partyName,
    vendorId: task.vendorId,
    vendorName: task.vendorName,
    items: task.items.map((item) => ({ ...item })),
  };
}
