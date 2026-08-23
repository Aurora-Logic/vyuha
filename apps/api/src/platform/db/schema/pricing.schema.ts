import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { organizations } from './organizations.schema.js';
import { parties, stockItems } from './projections.schema.js';

/**
 * Area AN: price lists Vyuha owns (docs/11 D-49, the second exception to
 * D-01 after item_vendors). Platform, not a module: the sales module reads
 * the resolver when it writes a line, and modules may not import each
 * other. Beside the projection, not on it -- the projection is truncatable
 * and these must survive that.
 *
 * A list is one version of a lineage: `supersedes_id` points at the
 * version it replaced, `superseded_at` is stamped when the next one
 * activates, and nothing is ever deleted, so a document from any date can
 * name the version that was in force (REQ-AN-06/07).
 */

export const priceListStateEnum = pgEnum('price_list_state', ['draft', 'pending_approval', 'active', 'superseded', 'expired']);
export const priceBasisEnum = pgEnum('price_basis', ['rate', 'discount_pct', 'both']);

export const priceLists = pgTable(
  'price_lists',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    /** The version this one replaced; null on the first of a lineage. */
    supersedesId: uuid('supersedes_id'),
    state: priceListStateEnum('state').notNull().default('draft'),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    notes: text('notes'),
    approvalRequestId: uuid('approval_request_id'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Stamped on the old version when the next one activates; the end of its reign for resolution by date. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    ...standardColumns(),
  },
  (t) => [
    index('price_lists_org_state_idx').on(t.orgId, t.state).where(ALIVE),
    index('price_lists_org_name_idx').on(t.orgId, t.name).where(ALIVE),
    check('price_lists_effective_order', sql`effective_to IS NULL OR effective_from <= effective_to`),
    check('price_lists_version_positive', sql`version >= 1`),
  ],
);

export const priceListLines = pgTable(
  'price_list_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    stockItemId: uuid('stock_item_id').references(() => stockItems.id, { onDelete: 'restrict' }),
    /** The item group's name as Tally holds it (stock_items.parent_group); groups are not entities in the projection. */
    itemGroup: text('item_group'),
    basis: priceBasisEnum('basis').notNull(),
    rate: numeric('rate', { precision: 16, scale: 2 }),
    discountPct: numeric('discount_pct', { precision: 5, scale: 2 }),
    minQty: numeric('min_qty', { precision: 16, scale: 3 }),
    maxQty: numeric('max_qty', { precision: 16, scale: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('price_list_lines_list_idx').on(t.priceListId),
    index('price_list_lines_org_item_idx').on(t.orgId, t.stockItemId),
    check('price_list_lines_target', sql`stock_item_id IS NOT NULL OR item_group IS NOT NULL`),
    check('price_list_lines_basis_values', sql`(basis = 'discount_pct' AND discount_pct IS NOT NULL) OR (basis = 'rate' AND rate IS NOT NULL) OR (basis = 'both' AND rate IS NOT NULL AND discount_pct IS NOT NULL)`),
    check('price_list_lines_slab_order', sql`min_qty IS NULL OR max_qty IS NULL OR min_qty < max_qty`),
  ],
);

export const priceListAssignments = pgTable(
  'price_list_assignments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'restrict' }),
    /** The party group's name as Tally holds it (parties.parent_group). */
    partyGroup: text('party_group'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('price_list_assignments_list_idx').on(t.priceListId),
    index('price_list_assignments_org_party_idx').on(t.orgId, t.partyId),
    uniqueIndex('price_list_assignments_list_party_uq').on(t.priceListId, t.partyId),
    check('price_list_assignments_one_target', sql`((party_id IS NOT NULL)::int + (party_group IS NOT NULL)::int + (is_default)::int) = 1`),
  ],
);
