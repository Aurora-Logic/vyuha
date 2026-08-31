import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { organizations } from './organizations.schema.js';
import { employees } from './people.schema.js';

export const userStatusEnum = pgEnum('user_status', ['INVITED', 'ACTIVE', 'SUSPENDED']);
export const deviceStatusEnum = pgEnum('device_status', [
  'ACTIVE',
  'PENDING_REBIND',
  'REVOKED',
]);

/**
 * REQ-B-02: the login account and the employee record are separate entities
 * linked 1:1. A bulk import (REQ-A-06) creates employees, not users, and an
 * employee may never have an account at all.
 *
 * There is no signup path anywhere in this product. An account comes into
 * existence only through an invitation (REQ-B-03) — see ADR 0002.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),

    email: text('email').notNull(),

    /** Null until the invitation is accepted and a password is set. */
    passwordHash: text('password_hash'),

    status: userStatusEnum('status').notNull().default('INVITED'),

    /** REQ-B-09. Encrypted at rest by the application, never returned by any endpoint. */
    totpSecret: text('totp_secret'),
    /** The last TOTP step accepted, so the same six digits cannot sign in twice inside their window. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    /** REQ-B-10: five failures per account per fifteen minutes, then a lockout. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /**
     * When the current run of failures started. Without it "five per fifteen
     * minutes" degenerates into "five ever": a user who mistypes once a
     * quarter would be locked out after five quarters, and the lockout would
     * look like a bug in the password rather than a counter nobody resets.
     */
    failedAttemptsSince: timestamp('failed_attempts_since', { withTimezone: true }),

    /** REQ-B-04: changing a password invalidates every other session. */
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),

    ...standardColumns(),
  },
  (t) => [
    // Lower-cased so "Asha@example.com" and "asha@example.com" cannot both
    // exist. Login normalises the same way; without this, two accounts differ
    // only by shift key and one of them silently wins.
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`).where(ALIVE),
    uniqueIndex('users_employee_uq').on(t.employeeId).where(ALIVE),
    index('users_org_status_idx').on(t.orgId, t.status),
  ],
);

/**
 * The permission catalogue. Global rather than per-org: keys are code
 * constants from `@vyuha/shared`, and a permission that no code checks is
 * meaningless. The seed reconciles this table against `ALL_PERMISSIONS`.
 */
export const permissions = pgTable(
  'permissions',
  {
    id: primaryId(),
    key: text('key').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('permissions_key_uq').on(t.key)],
);

/** REQ-B-07: roles are user-defined bundles, editable in the UI. */
export const roles = pgTable(
  'roles',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Seeded roles are protected from deletion, not from edits. */
    isSystem: boolean('is_system').notNull().default(false),
    ...standardColumns(),
  },
  (t) => [uniqueIndex('roles_org_name_uq').on(t.orgId, t.name).where(ALIVE)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index('role_permissions_permission_idx').on(t.permissionId),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index('user_roles_role_idx').on(t.roleId),
  ],
);

/**
 * REQ-B-05. One row per issued refresh token, not per login.
 *
 * `familyId` groups every token descended from a single login. Rotation writes
 * a new row and marks the old one used; presenting an already-used token means
 * it was captured, so the whole family is revoked. Storing only the hash means
 * a database leak does not hand over usable sessions.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    refreshTokenHash: text('refresh_token_hash').notNull(),
    familyId: uuid('family_id').notNull(),

    deviceFingerprint: text('device_fingerprint'),
    ip: text('ip'),
    userAgent: text('user_agent'),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when this token is exchanged. A second exchange is reuse. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_uq').on(t.refreshTokenHash),
    index('sessions_user_idx').on(t.userId, t.createdAt),
    index('sessions_family_idx').on(t.familyId),
  ],
);

/** REQ-B-08: the first mobile punch binds a device; rebinding needs approval. */
export const devices = pgTable(
  'devices',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    label: text('label'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    status: deviceStatusEnum('status').notNull().default('ACTIVE'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('devices_employee_fingerprint_uq')
      .on(t.employeeId, t.fingerprint)
      .where(ALIVE),
  ],
);

/**
 * REQ-B-03: single-use, 72-hour token. Only the hash is stored, so a database
 * leak cannot be used to claim a pending account.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by'),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('invitations_token_uq').on(t.tokenHash),
    index('invitations_email_idx').on(t.orgId, sql`lower(${t.email})`),
  ],
);

/** REQ-B-04: password reset, 30-minute single-use token. Hash only. */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_resets_token_uq').on(t.tokenHash),
    index('password_resets_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * REQ-B-09, the part the `users.totp_secret` column was waiting for. Three
 * tables, one per thing that is not the secret:
 *
 * - a recovery code is a one-time credential, stored as a keyed hash like
 *   every token the client presents (`opaque-token.ts`), spent by `used_at`;
 * - a trusted device is a browser the person chose to remember for thirty
 *   days, identified by the hash of a cookie, revocable from the profile;
 * - a challenge is the five minutes between a correct password and a
 *   correct code, so the code step cannot be reached without the password
 *   and the password step does not issue a session.
 */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mfa_recovery_codes_hash_uq').on(t.codeHash),
    index('mfa_recovery_codes_user_idx').on(t.userId),
  ],
);

export const mfaTrustedDevices = pgTable(
  'mfa_trusted_devices',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mfa_trusted_devices_hash_uq').on(t.tokenHash),
    index('mfa_trusted_devices_user_idx').on(t.userId, t.createdAt),
  ],
);

export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** Wrong codes against this challenge; five spends it. */
    attempts: integer('attempts').notNull().default(0),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mfa_challenges_hash_uq').on(t.tokenHash),
    index('mfa_challenges_user_idx').on(t.userId, t.createdAt),
  ],
);

