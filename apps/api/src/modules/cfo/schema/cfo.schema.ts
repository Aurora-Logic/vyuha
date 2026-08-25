import { date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { primaryId } from '../../../platform/db/columns.js';
import { organizations, parties } from '../../../platform/db/schema/index.js';

/**
 * The Virtual CFO's daily receivable photograph (owner's brief §0.10, D-23).
 *
 * This is the module's first and only irreversible piece, and the reason it
 * ships before any UI exists: DSO, CEI, days-late and credit-grade trends
 * need a daily record of the open book, and a day nobody photographed cannot
 * be reconstructed later — receipts keep settling bills, and the projection
 * only ever holds the present. Unlike the interest snapshots, which a
 * recompute restores, truncating this table loses history for good.
 *
 * Every row names its `source`: `billwise` rows come from Tally's own
 * bill_allocations, `voucher` rows from the voucher-grain fallback (each
 * Sales voucher a bill, receipts and credit notes settling oldest-first),
 * upgraded in place the day Tally starts sending bill-wise detail for the
 * party. No audit columns and no soft delete: a nightly job writes it, and
 * the day is replaced as a unit when rebuilt.
 */
export const factReceivableSnapshot = pgTable(
  'fact_receivable_snapshot',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    snapshotDate: date('snapshot_date').notNull(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    /** The Tally bill name where bill-wise, else the voucher number. */
    billRef: text('bill_ref').notNull(),
    billDate: date('bill_date'),
    dueDate: date('due_date'),
    /** What the bill was raised for. */
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    /** What was still open at the end of the snapshot day; always positive — settled bills are absent. */
    outstanding: numeric('outstanding', { precision: 16, scale: 2 }).notNull(),
    /** GREATEST(0, snapshot_date - due_date); 0 when not yet due. */
    daysOverdue: integer('days_overdue').notNull(),
    /** By DUE date (brief D02): 'current' | '0-30' | '31-60' | '61-90' | '91-180' | '180+'. */
    bucket: text('bucket').notNull(),
    /** 'billwise' | 'voucher' — which construction produced the row. */
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fact_receivable_snapshot_uq').on(t.orgId, t.snapshotDate, t.partyId, t.billRef),
    // K2: the trend reads are range scans — one party's history, and one
    // day's whole book — so both lead with what the range is over.
    index('fact_receivable_snapshot_party_idx').on(t.orgId, t.partyId, t.snapshotDate),
    index('fact_receivable_snapshot_date_idx').on(t.orgId, t.snapshotDate),
  ],
);
