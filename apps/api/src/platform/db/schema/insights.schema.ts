import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { primaryId } from '../columns.js';
import { organizations } from './organizations.schema.js';
import { users } from './identity.schema.js';

/**
 * A custom report (owner, 26 Aug 2026): widgets a user composed over the
 * insight areas. The widgets column is the `customWidgetSchema` array from
 * shared, validated at the API edge on every write -- jsonb because a layout
 * is read and written whole, never queried into.
 *
 * No soft delete: a report holds no figures of its own, only pointers at
 * metrics, so deleting one destroys nothing that cannot be recomposed. The
 * audit log keeps who deleted what.
 */
export const customReports = pgTable(
  'custom_reports',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** A sentence on what the report is for (the Supabase reference's create dialog asks for it). */
    description: text('description').notNull().default(''),
    shared: boolean('shared').notNull().default(false),
    widgets: jsonb('widgets').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One name per author: "Sales week" twice in one person's list is a slip,
    // not a choice, and the sidebar could not tell them apart.
    uniqueIndex('custom_reports_owner_name_ux').on(table.orgId, table.ownerUserId, table.name),
  ],
);
