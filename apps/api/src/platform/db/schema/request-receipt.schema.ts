import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema.js';
import { users } from './identity.schema.js';

export const requestReceipts = pgTable('request_receipts', {
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  operation: text('operation').notNull(),
  requestKey: text('request_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  entityId: uuid('entity_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.orgId, table.userId, table.operation, table.requestKey] })]);
