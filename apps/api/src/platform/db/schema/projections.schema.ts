import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId } from '../columns.js';
import { integrationConnections } from './integration.schema.js';
import { organizations } from './organizations.schema.js';

/**
 * Projections of Tally masters (09 §1.1 and §4.3, REQ-R-01).
 *
 * Derived, disposable, rebuildable: if these tables were truncated and
 * refilled from a backfill, nothing financial would be lost — that property
 * is a design constraint, not a happy accident, and it is why the rules here
 * differ from every other table in the product:
 *
 * - **No application write path.** Only the sync writer touches these rows.
 *   There is no create endpoint, no edit endpoint, and no repair script that
 *   would make Vyuha's copy disagree with Tally's original (REQ-R-04); a
 *   divergence is fixed by pulling again, never by editing the projection.
 * - **No soft delete.** A master that disappears from Tally is marked
 *   `absent_in_tally` and retained (REQ-R-06), so anything pointing at it
 *   keeps resolving. Deleting a projection row is what a re-pull is for.
 * - **Money is `numeric`, held not computed.** Credit limit and opening
 *   balance are Tally's figures (D-01); they are stored to the paisa and no
 *   code in this application does arithmetic on them.
 *
 * The GUID anchoring lives in `external_refs` — entity type 'party', the
 * projection row as the internal id — so the join key discipline is the same
 * one every synced entity uses.
 */
export const parties = pgTable(
  'parties',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    alias: text('alias'),
    /** Sundry Debtors / Sundry Creditors, verbatim (08 §3: what a party is). */
    parentGroup: text('parent_group').notNull(),
    gstin: text('gstin'),
    /** Regular / Composition / Unregistered / Consumer, verbatim. */
    gstRegistrationType: text('gst_registration_type'),
    /** The mailing address as one block; a multi-line source joins on newlines. */
    address: text('address'),
    state: text('state'),
    country: text('country'),
    /** Text, not a number: a postal code's leading zero is part of it. */
    pincode: text('pincode'),
    /** 12 REQ-AA-28: the ledger's email and mobile, where the company keeps them in Tally. */
    email: text('email'),
    phone: text('phone'),
    contactPerson: text('contact_person'),
    creditLimit: numeric('credit_limit'),
    creditDays: integer('credit_days'),
    openingBalance: numeric('opening_balance'),
    /**
     * The outstanding as Tally last reported it. Held, never computed on
     * (D-01): this is a projection of Tally's own figure, not a receivable
     * Vyuha asserts. Nothing in this application nets it, ages it, or sums it
     * into a total a person might mistake for an accounting position.
     */
    closingBalance: numeric('closing_balance'),
    /** Whether Tally tracks this party bill by bill. */
    billWiseTracking: boolean('bill_wise_tracking'),
    /** REQ-R-06: gone from Tally is a fact worth keeping, not a row worth losing. */
    absentInTally: boolean('absent_in_tally').notNull().default(false),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('parties_connection_idx').on(t.connectionId, t.name),
    // The Go To source and the parties screen both search by name.
    index('parties_org_name_idx').on(t.orgId, t.name),
  ],
);

/** REQ-R-02: name, alias, unit, group, GST rate — the PRD's list, no more. */
export const stockItems = pgTable(
  'stock_items',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    alias: text('alias'),
    /** The base unit, verbatim — "Nos", "Kg". */
    unit: text('unit').notNull(),
    /** The stock group, verbatim from the parent. */
    parentGroup: text('parent_group').notNull(),
    /** GST percentage as numeric: 2.5 stays 2.5 (D-01). */
    gstRate: numeric('gst_rate'),
    /**
     * Held figures a source may carry (OpsTally does). Stored as they arrived,
     * never computed on; a zero price from the source is "unresolvable", not
     * "free", and the writer keeps a stored non-zero over it.
     */
    closingQty: numeric('closing_qty'),
    salePrice: numeric('sale_price'),
    costPrice: numeric('cost_price'),
    absentInTally: boolean('absent_in_tally').notNull().default(false),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stock_items_connection_idx').on(t.connectionId, t.name),
    index('stock_items_org_name_idx').on(t.orgId, t.name),
  ],
);

/**
 * REQ-R-03: rates per stock item per price level — the per-party-group list.
 *
 * No `external_refs` anchor, unlike the other projections: a rate has no
 * GUID of its own in Tally. Its identity is (connection, item, level), held
 * by the unique index the writer upserts against, and the item reference is
 * the *projected row* — a rate for an item the pull has not delivered yet
 * has nothing to hang from, and the agent orders item chunks first.
 */
export const priceListEntries = pgTable(
  'price_list_entries',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItems.id, { onDelete: 'cascade' }),
    priceLevel: text('price_level').notNull(),
    /** Exact decimal, held not computed (D-01). */
    rate: numeric('rate').notNull(),
    unit: text('unit'),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('price_list_entries_uq').on(t.connectionId, t.stockItemId, t.priceLevel),
    index('price_list_entries_org_level_idx').on(t.orgId, t.priceLevel),
  ],
);

/**
 * Vouchers (09 §4.3): one table with a `voucher_type` discriminator, because
 * Tally models it that way and every receivables query in Area Y is a filter
 * over this one table. Same projection rules as the masters above — no
 * application write path, no soft delete, money `numeric` held not computed.
 *
 * `is_cancelled` is Tally's own flag (REQ-T-04's `voided_in_tally` for a
 * voucher whose GUID *disappears* is the pull path's business; a push source
 * reports cancellation explicitly). `party_id` is resolved by exact ledger
 * name within the connection at write time — that is Tally's own reference
 * (a voucher names its party ledger), not a name-match heuristic — and
 * stays null when no projected party carries that name yet; `party_name`
 * is always the verbatim value.
 */
export const vouchers = pgTable(
  'vouchers',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'restrict' }),
    /** Tally's per-company id and revision counter, held for reconciliation. */
    masterId: text('master_id'),
    alterId: bigint('alter_id', { mode: 'number' }).notNull().default(0),
    voucherDate: date('voucher_date').notNull(),
    /** Configurable per company in Tally — free text, verbatim. */
    voucherType: text('voucher_type').notNull(),
    voucherNumber: text('voucher_number').notNull().default(''),
    partyName: text('party_name').notNull().default(''),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    narration: text('narration').notNull().default(''),
    isCancelled: boolean('is_cancelled').notNull().default(false),
    amount: numeric('amount').notNull(),
    /*
     * Order, terms, dispatch and consignee detail, as the source reported it.
     * All nullable, and null means "not reported" rather than "blank in Tally":
     * which of these a company fills is a data-entry habit, not a property of
     * the integration, and two real companies fill disjoint subsets. Nothing
     * here may be treated as reliably present.
     */
    reference: text('reference'),
    referenceDate: date('reference_date'),
    orderRef: text('order_ref'),
    buyerOrderNumber: text('buyer_order_number'),
    buyerOrderDate: date('buyer_order_date'),
    paymentTerms: text('payment_terms'),
    /** Terms of delivery as one block; a multi-line source joins on newlines. */
    deliveryTerms: text('delivery_terms'),
    dispatchedThrough: text('dispatched_through'),
    dispatchDocNo: text('dispatch_doc_no'),
    vehicleNumber: text('vehicle_number'),
    destination: text('destination'),
    buyerName: text('buyer_name'),
    buyerAddress: text('buyer_address'),
    partyGstin: text('party_gstin'),
    partyState: text('party_state'),
    placeOfSupply: text('place_of_supply'),
    consigneeName: text('consignee_name'),
    consigneeState: text('consignee_state'),
    /** Text, not a number: a postal code's leading zero is part of it. */
    consigneePincode: text('consignee_pincode'),
    consigneeGstin: text('consignee_gstin'),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The vouchers screen and every Area Y report read by date within an org;
    // the reconciliation groups by type and month over the same index.
    index('vouchers_org_date_idx').on(t.orgId, t.voucherDate),
    index('vouchers_org_type_date_idx').on(t.orgId, t.voucherType, t.voucherDate),
    index('vouchers_party_idx').on(t.partyId, t.voucherDate),
    // Go To by voucher number (09 §6: "typing a voucher number opens that voucher").
    index('vouchers_org_number_idx').on(t.orgId, t.voucherNumber),
  ],
);

/**
 * The lines under a voucher: ledger entries and inventory entries, one row
 * each, in Tally's order. Derived from the voucher and replaced wholesale on
 * every upsert — a line has no identity of its own across syncs, so
 * reconciling it row by row would invent one.
 */
export const voucherLines = pgTable(
  'voucher_lines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    kind: text('kind').$type<'ledger' | 'inventory'>().notNull(),
    ledgerName: text('ledger_name'),
    /** Tally's debit/credit convention — true on the debit side. */
    isDeemedPositive: boolean('is_deemed_positive'),
    stockItemName: text('stock_item_name'),
    stockItemId: uuid('stock_item_id').references(() => stockItems.id, { onDelete: 'set null' }),
    /** Tally's own formatted quantity strings, may carry a unit suffix. */
    actualQty: text('actual_qty'),
    billedQty: text('billed_qty'),
    rate: numeric('rate'),
    amount: numeric('amount').notNull(),
    /*
     * Bank settlement, held on the LINE because that is where Tally records it.
     * Deliberately not flattened onto the voucher header: a header field would
     * be easier to query but would assert that a voucher has one settlement,
     * which a contra with two bank lines disproves. Null on every non-bank line.
     */
    settlementType: text('settlement_type'),
    settlementMode: text('settlement_mode'),
    instrumentNumber: text('instrument_number'),
    instrumentDate: date('instrument_date'),
    bankName: text('bank_name'),
    paymentFavouring: text('payment_favouring'),
  },
  (t) => [
    uniqueIndex('voucher_lines_uq').on(t.voucherId, t.lineNo),
    index('voucher_lines_item_idx').on(t.stockItemId),
  ],
);

/**
 * Tally's bill-wise details: which bill each amount is against (09 §3.1,
 * "Bill-wise outstanding | Tally | pull").
 *
 * This is the row that makes ageing real. Without it, "outstanding" can only
 * be a party's net balance, which ages from nothing -- the oldest unpaid
 * *invoice* is invisible inside a single figure, and a customer who pays every
 * new bill while an old one rots looks current. With it, an outstanding is a
 * named bill with a date, and 0-30 / 31-60 / 61-90 / 90+ is arithmetic rather
 * than a guess (REQ-Y-02).
 *
 * It is also where days-to-pay comes from (REQ-Y-04): a settlement carries the
 * bill it settles, so the gap between the two dates is observed rather than
 * inferred from the order payments happen to arrive in.
 *
 * A projection like the rest: `connection_id`, no application write path, and
 * truncatable -- only the sync writer touches it.
 */
export const billAllocations = pgTable(
  'bill_allocations',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'restrict' }),
    /**
     * The voucher this allocation was read from -- cascade, because an
     * allocation has no meaning once its voucher is gone and a re-pull
     * rewrites both together.
     */
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    /** Verbatim, because it is the party's own reference and the join key. */
    partyName: text('party_name').notNull().default(''),
    /**
     * Tally's bill reference -- the invoice number as the customer knows it.
     * Not unique on its own: two companies raise "001", and Tally allows the
     * same name under different parties.
     */
    billName: text('bill_name').notNull(),
    /**
     * How this row relates to the bill. Tally's own four:
     *   `new`        this voucher raises the bill
     *   `against`    this voucher settles some of it
     *   `advance`    money taken before a bill exists
     *   `on_account` money with no bill named at all
     * Kept as text for the reason `voucher_type` is: the vocabulary is Tally's
     * and an enum would need a migration the day it grows one.
     */
    refType: text('ref_type').notNull(),
    /** The bill's own date, which is what ages. Null on `on_account`. */
    billDate: date('bill_date'),
    /** Tally's credit period on this bill, when the company sets one. */
    dueDate: date('due_date'),
    /**
     * Signed against the party: positive is owed to us, negative is settled.
     * Summing every row for a bill gives what is still outstanding on it, so
     * ageing needs no separate "paid" flag to fall out of step with.
     */
    amount: numeric('amount').notNull(),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ageing and the statement both read every open bill for one party,
    // oldest first.
    index('bill_allocations_party_idx').on(t.orgId, t.partyId, t.billDate),
    // Summing a bill means gathering its rows: the raise and every settlement
    // against it.
    index('bill_allocations_bill_idx').on(t.orgId, t.partyName, t.billName),
    // A re-pull rewrites a voucher's allocations as a set.
    index('bill_allocations_voucher_idx').on(t.voucherId),
  ],
);
