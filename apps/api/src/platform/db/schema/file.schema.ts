import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { auditColumns, primaryId, standardColumns } from '../columns.js';
import { users } from './identity.schema.js';
import { organizations } from './organizations.schema.js';

export const filePurposeEnum = pgEnum('file_purpose', [
  'PUNCH_PHOTO',
  'PUNCH_PHOTO_THUMB',
  'EXPORT',
  'ATTACHMENT',
  'ORG_LOGO',
  'IMPORT',
  'DISPATCH_PHOTO',
  'CRM_ATTACHMENT',
  'TASK_ATTACHMENT',
]);

/**
 * NFR-09: files live in object storage, never in the database and never on a
 * public URL. This table holds the pointer and the metadata; access is granted
 * per request through a short-lived signed URL after a permission check.
 */
export const files = pgTable(
  'files',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    /** Set at write time so tampering with the object is detectable later. */
    checksum: text('checksum').notNull(),
    purpose: filePurposeEnum('purpose').notNull(),

    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),

    /** REQ-L-03: the retention job purges past this and nulls the reference. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }),

    ...standardColumns(),
  },
  (t) => [
    index('files_org_purpose_idx').on(t.orgId, t.purpose),
    index('files_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Durable intent to remove an object that may not have a live metadata row.
 *
 * Object storage and Postgres cannot share a transaction. A task is therefore
 * committed before each put. Successful metadata finalisation removes it;
 * any crash/failure leaves a key that the cleanup worker can retry. A short
 * grace period prevents the worker racing an upload that is still in flight.
 */
export const fileCleanupTasks = pgTable(
  'file_cleanup_tasks',
  {
    id: primaryId(),
    // Deliberately no organisation FK: cleanup must remain possible after an
    // organisation row is removed, and an invalid/missing org must not stop us
    // recording the key before object storage is touched.
    orgId: uuid('org_id').notNull(),
    purpose: filePurposeEnum('purpose').notNull(),
    storageKey: text('storage_key').notNull(),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('file_cleanup_tasks_object_uq').on(t.purpose, t.storageKey),
    index('file_cleanup_tasks_due_idx').on(t.runAfter),
  ],
);

/*
 * `export_jobs` and `saved_views` used to live here and now live in
 * `report.schema.ts`. They reference `files` but are not about object storage,
 * and the report slice needed to extend them; keeping three tables in a file
 * named for one of them was the only reason they were together.
 */
