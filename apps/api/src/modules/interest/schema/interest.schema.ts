import { date, index, integer, numeric, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../../../platform/db/columns.js';
import { organizations, parties, stockItems } from '../../../platform/db/schema/index.js';

/**
 * Interest cost snapshots (D-22).
 *
 * The daily closing balance series, materialised. The nightly build writes
 * these rows and the report sources read nothing else — a report request
 * never replays vouchers. Balances only, no rate: pricing the rupee-days
 * happens at read time, so editing the annual rate re-prices history
 * without a rebuild.
 *
 * Derived and rebuildable, like the projections they are computed from:
 * truncating the daily tables loses nothing a recompute cannot restore,
 * which is why they carry no audit columns and no soft delete.
 */
export const interestDailyParty = pgTable(
  'interest_daily_party',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),
    /** End-of-day outstanding. Negative when the party is in advance. */
    closing: numeric('closing', { precision: 18, scale: 2 }).notNull(),
    /** The part of `closing` still inside credit terms. */
    withinCredit: numeric('within_credit', { precision: 18, scale: 2 }).notNull(),
    /** The part past its due date; carries the advance's negative, never clamped. */
    overdue: numeric('overdue', { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [
    // Doubles as the per-party range scan; the date index serves the
    // org-wide monthly sweeps of the cash cycle.
    uniqueIndex('interest_daily_party_uq').on(t.orgId, t.partyId, t.date),
    index('interest_daily_party_date_idx').on(t.orgId, t.date),
  ],
);

export const interestDailyStock = pgTable(
  'interest_daily_stock',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItems.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    /** Quantity on hand at the running weighted-average purchase rate — the purchase cost basis of D-22. */
    closingValue: numeric('closing_value', { precision: 18, scale: 2 }).notNull(),
    /** The value whose age since inward has outrun the vendor's credit days. */
    fundedValue: numeric('funded_value', { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('interest_daily_stock_uq').on(t.orgId, t.stockItemId, t.date),
    index('interest_daily_stock_date_idx').on(t.orgId, t.date),
  ],
);

/** How far the build has walked; the nightly run resumes from here minus the recompute window. */
export const interestBuildState = pgTable(
  'interest_build_state',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    builtThrough: date('built_through', { mode: 'string' }).notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('interest_build_state_org_uq').on(t.orgId)],
);

/**
 * The Vyuha-side per-party knobs (D-22). `parties` is a projection with no
 * application write path, so the editable rate and credit-days overrides
 * live here and beat the projection where present. A debtor with neither
 * Tally credit days nor an override is "credit terms missing" and accrues
 * from day zero — never a silent 30.
 */
export const interestPartySettings = pgTable(
  'interest_party_settings',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    /** Percent per annum; null means the org rate. */
    interestRateOverride: numeric('interest_rate_override', { precision: 6, scale: 2 }),
    creditDaysOverride: integer('credit_days_override'),
    ...standardColumns(),
  },
  (t) => [uniqueIndex('interest_party_settings_uq').on(t.orgId, t.partyId).where(ALIVE)],
);
