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

/**
 * The sales fact (brief K2): one row per day x party x item x salesperson x
 * voucher type, everything ex-GST, money exact to two decimals. The grain
 * the brief names also carries godown and business line; the projection has
 * no godown today (raised in the Phase 1 decisions table), and business
 * line is a column already so Export lands without a migration when export
 * billing begins (K1 item 7).
 *
 * A day is replaced as a unit when rebuilt, like the receivable snapshot —
 * no updates, no partial days. Margin columns exist but stay null until the
 * valuation method is confirmed (B1: cost basis blocked); nothing computes
 * on a null margin.
 *
 * `salespersonRef` resolves AS OF VOUCHER DATE and is never rewritten
 * (B4). Its forms: 'user:<uuid>' | 'HOUSE' | 'UNASSIGNED'. The Unassigned
 * bucket is a visible data-quality figure, never a silent drop (B3).
 */
export const factSalesDaily = pgTable(
  'fact_sales_daily',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    partyName: text('party_name').notNull().default(''),
    /** Stock item when the line moved goods; null for ledger-only vouchers. */
    itemId: uuid('item_id'),
    itemName: text('item_name').notNull().default(''),
    /** The stock group, which M12 confirms separates C&S and BCH cleanly. */
    brand: text('brand').notNull().default('Unbranded'),
    /** 'DOMESTIC' today; 'EXPORT' when K1 item 7's flag exists. */
    businessLine: text('business_line').notNull().default('DOMESTIC'),
    salespersonRef: text('salesperson_ref').notNull().default('UNASSIGNED'),
    voucherType: text('voucher_type').notNull(),
    /** Base-UOM quantity where parseable; 0 for ledger lines (R11 note). */
    qty: numeric('qty', { precision: 18, scale: 3 }).notNull().default('0'),
    /** R01: sales voucher value before discounts and returns. */
    gross: numeric('gross', { precision: 16, scale: 2 }).notNull().default('0'),
    /** R02: discount ledger lines on sales vouchers. */
    discount: numeric('discount', { precision: 16, scale: 2 }).notNull().default('0'),
    /** R03: credit notes. Nature (goods return vs rate diff) is a pending decision; all sit here until it lands. */
    returns: numeric('returns', { precision: 16, scale: 2 }).notNull().default('0'),
    /** R04: rate-difference credit notes, empty until natures are classified. */
    rateDiff: numeric('rate_diff', { precision: 16, scale: 2 }).notNull().default('0'),
    /** R05 = gross - discount - returns - rate_diff. Growth measures this. */
    net: numeric('net', { precision: 16, scale: 2 }).notNull().default('0'),
    /** M06/M07: null until the Tally valuation method is confirmed. */
    landedCost: numeric('landed_cost', { precision: 16, scale: 2 }),
    pocketMargin: numeric('pocket_margin', { precision: 16, scale: 2 }),
    voucherCount: integer('voucher_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('fact_sales_daily_date_idx').on(t.orgId, t.date),
    index('fact_sales_daily_party_idx').on(t.orgId, t.partyId, t.date),
    index('fact_sales_daily_item_idx').on(t.orgId, t.itemId, t.date),
    index('fact_sales_daily_person_idx').on(t.orgId, t.salespersonRef, t.date),
  ],
);

/**
 * Customer -> owner, effective-dated (B4). Resolution order for a voucher:
 * the voucher's own salesperson when Tally sends one (the sync does not
 * carry cost centres yet — raised in the decisions table), then this map as
 * of the voucher date, then UNASSIGNED. History is never rewritten:
 * reassigning today closes the open interval today and opens a new one, and
 * last year's facts keep last year's owner.
 *
 * Split credit: at most two open rows per party (M13, decided at two), with
 * shares summing to 100. An owner of null with kind HOUSE marks the house
 * book explicitly — never a blank (B4).
 */
export const customerOwnerMap = pgTable(
  'customer_owner_map',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    /** 'user:<uuid>' | 'HOUSE'. The fact copies this verbatim. */
    ownerRef: text('owner_ref').notNull(),
    /** Percent of the credit, 1..100; open rows for a party sum to 100. */
    share: integer('share').notNull().default(100),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    /** Null while current; set to the day before the successor starts. */
    effectiveTo: date('effective_to', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customer_owner_map_party_idx').on(t.orgId, t.partyId, t.effectiveFrom),
  ],
);
