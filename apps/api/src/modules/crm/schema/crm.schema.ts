import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../../../platform/db/columns.js';
import { employees, files, organizations, parties } from '../../../platform/db/schema/index.js';

/**
 * CRM tables (09 §4.4). Vyuha's own records: nothing here is written by the
 * sync engine and nothing here is pushed to Tally (REQ-U-03).
 *
 * `owner_id` is an employee, not a user. 08 §2.1 says a salesperson is also an
 * employee, and §2.2 scopes `crm.*.view.self` "where the user is the owner" —
 * spelling the owner as an employee is what lets `ScopeService` resolve that
 * with the same reporting-chain walk it uses for attendance, rather than a
 * second scoping mechanism keyed on user ids. Nullable: an Admin account with
 * no employee record may still create a company nobody yet owns.
 */

/** Owner, 31 Aug 2026: how hard this one is being chased. */
export const dealPriorityEnum = pgEnum('crm_deal_priority', ['low', 'normal', 'high', 'urgent']);

export const crmCompanies = pgTable(
  'crm_companies',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    website: text('website'),
    city: text('city'),
    notes: text('notes'),
    ownerId: uuid('owner_id').references(() => employees.id, { onDelete: 'restrict' }),
    /**
     * REQ-U-03: set on conversion, never at creation. 09 §4.4 sketches this
     * link "via external_refs"; a direct reference to the projection row is
     * used instead because `external_refs` already pins `parties.id` to the
     * Tally GUID (owner-aware adoption keeps that id stable across pulls), so
     * a second GUID-keyed hop would only restate what that table proves.
     * `SET NULL` rather than `RESTRICT`: a rebuilt projection may drop the
     * row, and a company should outlive its link, not block the rebuild.
     */
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    ...standardColumns(),
  },
  (t) => [
    index('crm_companies_org_name_idx').on(t.orgId, t.name).where(ALIVE),
    index('crm_companies_org_owner_idx').on(t.orgId, t.ownerId).where(ALIVE),
  ],
);

export const crmContacts = pgTable(
  'crm_contacts',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    phone: text('phone'),
    /**
     * REQ-U-08's comparison key, kept alongside the typed text so the
     * duplicate check is an index lookup and not a per-row normalisation.
     * Digits only, national significant number (see `normalizePhone`).
     */
    phoneKey: text('phone_key'),
    email: text('email'),
    designation: text('designation'),
    companyId: uuid('company_id').references(() => crmCompanies.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id').references(() => employees.id, { onDelete: 'restrict' }),
    source: text('source'),
    notes: text('notes'),
    ...standardColumns(),
  },
  (t) => [
    index('crm_contacts_org_name_idx').on(t.orgId, t.name).where(ALIVE),
    index('crm_contacts_org_owner_idx').on(t.orgId, t.ownerId).where(ALIVE),
    index('crm_contacts_org_company_idx').on(t.orgId, t.companyId).where(ALIVE),
    index('crm_contacts_org_phone_key_idx').on(t.orgId, t.phoneKey).where(ALIVE),
    index('crm_contacts_org_email_idx').on(t.orgId, t.email).where(ALIVE),
  ],
);

/**
 * REQ-U-04: pipelines and their stages are rows, not code. `is_default` names
 * the one a new deal lands in when none is chosen; the unique partial index
 * keeps it to one per organisation.
 */
export const crmPipelines = pgTable(
  'crm_pipelines',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('crm_pipelines_org_name_uq').on(t.orgId, t.name).where(ALIVE),
    uniqueIndex('crm_pipelines_org_default_uq').on(t.orgId).where(sql`is_default AND deleted_at IS NULL`),
  ],
);

export const crmPipelineStages = pgTable(
  'crm_pipeline_stages',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => crmPipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** 0–100. The stage's default; a deal's own probability is this until a later phase says otherwise. */
    probability: integer('probability').notNull().default(0),
    isWon: boolean('is_won').notNull().default(false),
    isLost: boolean('is_lost').notNull().default(false),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('crm_pipeline_stages_pipeline_name_uq').on(t.pipelineId, t.name).where(ALIVE),
    index('crm_pipeline_stages_pipeline_sort_idx').on(t.pipelineId, t.sortOrder),
  ],
);

/**
 * REQ-U-05: a deal has no accounting existence and is never pushed. `value`
 * is numeric text end to end (see the shared contract). `closed_at` is set
 * when the deal enters a won or lost stage and cleared if it is moved back —
 * the task table's `closed_at`, for the same reason.
 */
export const crmDeals = pgTable(
  'crm_deals',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    companyId: uuid('company_id').references(() => crmCompanies.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => crmContacts.id, { onDelete: 'set null' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => crmPipelines.id, { onDelete: 'restrict' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => crmPipelineStages.id, { onDelete: 'restrict' }),
    value: numeric('value', { precision: 16, scale: 2 }),
    expectedCloseDate: date('expected_close_date', { mode: 'string' }),
    ownerId: uuid('owner_id').references(() => employees.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * Owner, 31 Aug 2026: the five things a pipeline review asks that this
     * sheet could not answer. Free text where the answer is a name the trade
     * uses (a competitor, a source), a short enum where it is one of a fixed
     * set, a date where it is a date. Loss reason is written when a deal is
     * lost and kept afterwards -- the pattern of losses is the point.
     */
    leadSource: text('lead_source'),
    priority: dealPriorityEnum('priority'),
    nextFollowUpDate: date('next_follow_up_date', { mode: 'string' }),
    competitor: text('competitor'),
    lossReason: text('loss_reason'),
    notes: text('notes'),
    ...standardColumns(),
  },
  (t) => [
    index('crm_deals_org_stage_idx').on(t.orgId, t.stageId).where(ALIVE),
    index('crm_deals_org_owner_idx').on(t.orgId, t.ownerId).where(ALIVE),
    index('crm_deals_org_company_idx').on(t.orgId, t.companyId).where(ALIVE),
    index('crm_deals_org_contact_idx').on(t.orgId, t.contactId).where(ALIVE),
    index('crm_deals_org_name_idx').on(t.orgId, t.name).where(ALIVE),
  ],
);

/**
 * REQ-U-05 (owner, 31 Aug 2026): what is attached to a deal -- a quote, a
 * drawing, a photograph of a site. The bytes live in object storage like
 * every other file; this table is only the link, plus the name the person
 * uploaded it under, because a storage key is not a thing to show anybody.
 *
 * `restrict` on the file so a row can never point at nothing, `cascade` on
 * the deal because an attachment has no life without it.
 */
export const crmDealAttachments = pgTable(
  'crm_deal_attachments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => crmDeals.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    /** As the browser gave it, shown in the list and used for the download. */
    filename: text('filename').notNull(),
    ...standardColumns(),
  },
  (t) => [index('crm_deal_attachments_deal_idx').on(t.dealId).where(ALIVE)],
);
