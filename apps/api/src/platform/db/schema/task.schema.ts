import { boolean, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { files } from './file.schema.js';
import { organizations } from './organizations.schema.js';
import { employees } from './people.schema.js';
import { parties, stockItems } from './projections.schema.js';

/**
 * Tasks (08 Area V, D-17): platform, not CRM. The subject is polymorphic —
 * `(subject_type, subject_id)` like `approval_requests` — so a task may hang
 * off a contact, an invoice, an employee, or nothing, and no module has to
 * import another to attach one.
 *
 * Status is the board column (REQ-V-03): "columns are configuration, not
 * code", so what "done" means is `task_board_columns.is_done`, and closing a
 * task is moving it into such a column. `closed_at` is set by that move so
 * "closed last week" is answerable without replaying the audit log.
 */

export const taskPriorityEnum = pgEnum('task_priority', ['LOW', 'MEDIUM', 'HIGH']);

export const taskBoardColumns = pgTable(
  'task_board_columns',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isDone: boolean('is_done').notNull().default(false),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('task_board_columns_org_name_uq').on(t.orgId, t.name).where(ALIVE),
    index('task_board_columns_org_sort_idx').on(t.orgId, t.sortOrder),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description'),
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    /** The subject's name when attached. A snapshot: the label is display, the ids are the link. */
    subjectLabel: text('subject_label'),
    /** Employees, like every scoped record (08 §2.1: a salesperson is an employee). */
    assigneeId: uuid('assignee_id').references(() => employees.id, { onDelete: 'restrict' }),
    ownerId: uuid('owner_id').references(() => employees.id, { onDelete: 'restrict' }),
    /**
     * REQ-V-09: the customer and the supplier a task is about.
     *
     * Two columns rather than a second polymorphic subject, because a task
     * genuinely has both at once -- "chase Sanghvi for the coupler Acme is
     * waiting on" names a vendor and a party and they are not the same slot.
     * The name is snapshotted beside the id for the same reason
     * `subjectLabel` is: the register lists hundreds of rows and must not
     * join the projection to print a word.
     */
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    partyName: text('party_name'),
    vendorId: uuid('vendor_id').references(() => parties.id, { onDelete: 'set null' }),
    vendorName: text('vendor_name'),
    dueDate: date('due_date', { mode: 'string' }),
    priority: taskPriorityEnum('priority').notNull().default('MEDIUM'),
    columnId: uuid('column_id')
      .notNull()
      .references(() => taskBoardColumns.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...standardColumns(),
  },
  (t) => [
    index('tasks_org_assignee_due_idx').on(t.orgId, t.assigneeId, t.dueDate).where(ALIVE),
    index('tasks_org_owner_idx').on(t.orgId, t.ownerId).where(ALIVE),
    index('tasks_org_column_idx').on(t.orgId, t.columnId).where(ALIVE),
    index('tasks_org_subject_idx').on(t.orgId, t.subjectType, t.subjectId).where(ALIVE),
    // The reminder sweep: open tasks by due date, across the organisation.
    index('tasks_org_due_open_idx').on(t.orgId, t.dueDate).where(ALIVE),
  ],
);

/**
 * REQ-V-10: the stock items a task is about.
 *
 * Its own table rather than an array column: an item is a real record with a
 * real id, and `restrict` on the reference is what stops a synced item
 * disappearing under a task that names it. The name is snapshotted for the
 * same reason the party's is -- the task list must not join the catalogue to
 * render a row.
 */
export const taskItems = pgTable(
  'task_items',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => stockItems.id, { onDelete: 'restrict' }),
    itemName: text('item_name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...standardColumns(),
  },
  (t) => [
    index('task_items_task_idx').on(t.orgId, t.taskId).where(ALIVE),
    // One item once per task: adding the same coupler twice is a slip, not a
    // quantity -- a task carries no quantities.
    uniqueIndex('task_items_unique_idx').on(t.taskId, t.itemId).where(ALIVE),
  ],
);

/**
 * REQ-V-12: a document or a photograph on a task.
 *
 * The deal attachment's shape exactly (`crm_deal_attachments`), because the
 * need is the same one: a drawing, a signed challan, a photograph of what
 * arrived damaged. The file itself goes through the platform pipeline and
 * this row is only the link, so a task never holds bytes.
 *
 * `restrict` on the file, `cascade` on the task: deleting the task takes its
 * links with it, while a file that something still points at cannot vanish
 * underneath it.
 */
export const taskAttachments = pgTable(
  'task_attachments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    /** As the browser gave it, shown in the list and used for the download. */
    filename: text('filename').notNull(),
    ...standardColumns(),
  },
  (t) => [index('task_attachments_task_idx').on(t.orgId, t.taskId).where(ALIVE)],
);
