import { bigint, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { primaryId, standardColumns } from '../columns.js';
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

/*
 * `export_jobs` and `saved_views` used to live here and now live in
 * `report.schema.ts`. They reference `files` but are not about object storage,
 * and the report slice needed to extend them; keeping three tables in a file
 * named for one of them was the only reason they were together.
 */
