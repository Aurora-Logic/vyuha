import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';

export const settingScopeEnum = pgEnum('setting_scope', ['ORG', 'LOCATION']);

/**
 * REQ-L-01. One legal entity today; `org_id` on every other table means a
 * second is additive rather than a rewrite (PRD §8 assumption 1).
 */
export const organizations = pgTable('organizations', {
  id: primaryId(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  dateFormat: text('date_format').notNull().default('dd-MM-yyyy'),
  /** ISO-8601 weekday, 1 = Monday. */
  weekStart: smallint('week_start').notNull().default(1),
  /** REQ-G-04, confirmed April in 05-decisions. */
  leaveYearStartMonth: smallint('leave_year_start_month').notNull().default(4),
  logoKey: text('logo_key'),
  ...standardColumns(),
});

/**
 * REQ-A-01. One location at launch (05-decisions), but the table is plural
 * from the start because per-location holiday calendars and period locks are
 * already modelled — they simply ship hidden.
 */
export const locations = pgTable(
  'locations',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    address: text('address'),
    timezone: text('timezone'),

    // REQ-D-08. Null until the office coordinates are supplied (OPEN-QUESTIONS
    // item 1). Geofenced punch stays disabled while these are null rather than
    // falling back to a guessed centre.
    geofenceLat: doublePrecision('geofence_lat'),
    geofenceLng: doublePrecision('geofence_lng'),
    geofenceRadiusM: integer('geofence_radius_m').notNull().default(100),

    // REQ-D-09. Empty until the office addresses are supplied (item 3). An
    // empty allowlist blocks web punch; it does not mean "allow everything".
    ipAllowlist: text('ip_allowlist')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    // Points at attendance.holiday_calendars, which does not exist until
    // Phase 1. Declared without a foreign key so the platform schema never has
    // to import a module schema (technical design §1); the constraint is added
    // in the Phase 1 migration alongside the table it references.
    holidayCalendarId: uuid('holiday_calendar_id'),

    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('locations_org_code_uq').on(t.orgId, t.code).where(ALIVE),
    index('locations_org_idx').on(t.orgId),
  ],
);

/**
 * REQ-L-02/L-05. Policy lives in rows, not in code, so REQ-K-01's promise that
 * "changing a policy setting immediately alters punch behaviour without a
 * redeploy" can hold.
 */
export const settings = pgTable(
  'settings',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    scope: settingScopeEnum('scope').notNull().default('ORG'),
    /** Null for org scope; a location id for location scope. */
    scopeId: uuid('scope_id'),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    ...standardColumns(),
  },
  (t) => [
    // COALESCE because Postgres treats NULLs as distinct in a unique index,
    // which would otherwise allow unlimited duplicate org-scoped rows for the
    // same key.
    uniqueIndex('settings_scope_key_uq')
      .on(t.orgId, t.scope, sql`coalesce(${t.scopeId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key)
      .where(ALIVE),
  ],
);

/**
 * REQ-AJ-05 (owner, 28 Aug 2026): a question the help panel could not answer,
 * sent on by its asker with an explicit action -- never silent logging, since
 * the text is employee free text. The notification to settings.manage holders
 * is the delivery; this table is the record behind it.
 */
export const helpQuestions = pgTable('help_questions', {
  id: primaryId(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull(),
  question: text('question').notNull(),
  askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
});
