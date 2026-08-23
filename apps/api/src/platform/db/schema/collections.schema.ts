import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { employees } from './people.schema.js';
import { organizations } from './organizations.schema.js';
import { parties } from './projections.schema.js';

/**
 * Area AJ: what collections records -- intent, assignment, and the
 * reminders sent -- beside the projection it reads. Nothing here is a
 * balance (REQ-AJ-12): a promise's state is derived from the receipts
 * Tally sends against the named bills, and the columns that hold it are
 * a materialisation for the reports and the morning sweep, rewritten on
 * every evaluation.
 */

export const promiseStateEnum = pgEnum('promise_state', ['open', 'kept', 'partially_kept', 'broken']);

export const promisesToPay = pgTable(
  'promises_to_pay',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    promisedDate: date('promised_date', { mode: 'string' }).notNull(),
    /** Bill names as Tally holds them; empty means any receipt from the party counts. */
    bills: text('bills').array().notNull().default(sql`'{}'::text[]`),
    takenBy: uuid('taken_by').references(() => employees.id, { onDelete: 'set null' }),
    takenOn: date('taken_on', { mode: 'string' }).notNull(),
    notes: text('notes'),
    /** Derived, rewritten on evaluation; never set by a person (REQ-AJ-02). */
    state: promiseStateEnum('state').notNull().default('open'),
    receivedAmount: numeric('received_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    receivedOn: date('received_on', { mode: 'string' }),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    ...standardColumns(),
  },
  (t) => [
    index('promises_to_pay_org_party_idx').on(t.orgId, t.partyId).where(ALIVE),
    index('promises_to_pay_org_date_idx').on(t.orgId, t.promisedDate).where(ALIVE),
    check('promises_to_pay_amount_positive', sql`amount > 0`),
  ],
);

export const collectorAssignments = pgTable(
  'collector_assignments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    collectorId: uuid('collector_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    targetAmount: numeric('target_amount', { precision: 16, scale: 2 }),
    periodFrom: date('period_from', { mode: 'string' }).notNull(),
    periodTo: date('period_to', { mode: 'string' }),
    ...standardColumns(),
  },
  (t) => [
    // REQ-AJ-03: one party, one collector at a time.
    uniqueIndex('collector_assignments_org_party_uq').on(t.orgId, t.partyId).where(ALIVE),
    index('collector_assignments_org_collector_idx').on(t.orgId, t.collectorId).where(ALIVE),
    check('collector_assignments_period_order', sql`period_to IS NULL OR period_from <= period_to`),
  ],
);

export const reminderNotices = pgTable(
  'reminder_notices',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    /** email | whatsapp | manual, as the dispatch notices name them. */
    channel: text('channel').notNull(),
    recipient: text('recipient'),
    /** pending | sent | failed. */
    status: text('status').notNull().default('pending'),
    composedText: text('composed_text').notNull(),
    /** REQ-AJ-06: the statement the reminder carried was as of this date. */
    statementAsOf: date('statement_as_of', { mode: 'string' }).notNull(),
    outstandingAtSend: numeric('outstanding_at_send', { precision: 16, scale: 2 }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: uuid('sent_by'),
    error: text('error'),
    ...standardColumns(),
  },
  (t) => [index('reminder_notices_org_party_idx').on(t.orgId, t.partyId, t.createdAt)],
);
