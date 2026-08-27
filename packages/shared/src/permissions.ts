/**
 * Permission keys and the seed role matrix from PRD §2.1.
 *
 * PRD §2: "Roles are not hardcoded into logic. They are named bundles of
 * permissions." Nothing in this codebase may branch on a role name — every
 * check goes through a key defined here.
 */

import { z } from 'zod';

import type { UserStatus } from './enums.js';
import { adminReasonSchema } from './org.js';

export const PERMISSIONS = {
  PUNCH_SELF: 'punch.self',

  ATTENDANCE_VIEW_SELF: 'attendance.view.self',
  ATTENDANCE_VIEW_TEAM: 'attendance.view.team',
  ATTENDANCE_VIEW_ALL: 'attendance.view.all',
  ATTENDANCE_EDIT: 'attendance.edit',
  ATTENDANCE_LOCK: 'attendance.lock',
  /**
   * REQ-E-09: "Unlocking requires Admin and a reason."
   *
   * Separate from `attendance.lock` because gating unlock on the lock key makes
   * unlock exactly as available as lock, which is not what the requirement
   * says — and nothing may branch on a role name to make up the difference
   * (PRD §2). See docs/OPEN-QUESTIONS P2-1, which recorded that this key was
   * the fix and that adding it changes the seed matrix.
   */
  ATTENDANCE_UNLOCK: 'attendance.unlock',

  LEAVE_APPLY_SELF: 'leave.apply.self',
  LEAVE_APPROVE_TEAM: 'leave.approve.team',
  LEAVE_APPROVE_ALL: 'leave.approve.all',
  LEAVE_POLICY_MANAGE: 'leave.policy.manage',


  EMPLOYEE_VIEW: 'employee.view',
  EMPLOYEE_MANAGE: 'employee.manage',

  SHIFT_MANAGE: 'shift.manage',
  HOLIDAY_MANAGE: 'holiday.manage',

  REPORT_VIEW: 'report.view',
  REPORT_EXPORT: 'report.export',

  SETTINGS_MANAGE: 'settings.manage',
  ROLES_MANAGE: 'roles.manage',
  AUDIT_VIEW: 'audit.view',
  INTEGRATION_MANAGE: 'integration.manage',

  /**
   * 08 §2.2, the first Phase 6-8 key: read the Tally masters projection.
   * Sales, Sales manager, Purchase and Accounts gain it when those roles
   * arrive with their phases; Admin holds it from the moment the screen
   * exists, because a projection nobody can see cannot be reconciled.
   */
  MASTERS_TALLY_VIEW: 'masters.tally.view',
  RECEIVABLES_VIEW: 'receivables.view',
  /**
   * Assign or change the relationship manager on a customer (party). The RM
   * owns that customer's sales and collections; changing who is responsible is
   * a manager's call, so it is its own key rather than folded into masters view.
   */
  PARTIES_RM_ASSIGN: 'parties.rm.assign',
  /**
   * D-46: the daily exception sweep writes to whoever holds this, seeded to
   * Admin and Accounts. A permission rather than a role name because roles
   * are not hardcoded into logic — an org can hand the digest to anyone.
   */
  REPORTS_EXCEPTIONS_NOTIFY: 'reports.exceptions.notify',
  /** D-46: the margin proxy is for Sales manager, Accounts and Admin; nobody else sees cost against price. */
  REPORTS_MARGIN_VIEW: 'reports.margin.view',

  /**
   * Virtual CFO (brief K3, decided 26 Aug 2026). The two deliberate choices
   * the owner confirmed: salespeople see the league table but never each
   * other's detail (team.view separates them), and margin reaches a
   * salesperson only as a percentage on their own book (margin.view is the
   * rupee sight, held by owner, sales head and accounts-side roles).
   */
  CFO_SALES_VIEW: 'cfo.sales.view',
  CFO_MARGIN_VIEW: 'cfo.margin.view',
  CFO_RECEIVABLES_VIEW: 'cfo.receivables.view',
  CFO_BRAND_VIEW: 'cfo.brand.view',
  CFO_TEAM_VIEW: 'cfo.team.view',
  CFO_COMPLIANCE_VIEW: 'cfo.compliance.view',
  CFO_EXCEPTIONS_VIEW: 'cfo.exceptions.view',
  CFO_EXPORT: 'cfo.export',
  CFO_LISTS_ASSIGN: 'cfo.lists.assign',
  CFO_TARGETS_MANAGE: 'cfo.targets.manage',
  CFO_TIER_ASSIGN: 'cfo.tier.assign',
  CFO_TIER_MASTER: 'cfo.tier.master',

  /**
   * Phase 7 (08 §2.2). Self/all breadths for contacts and deals; tasks are a
   * platform concern (D-17) but keep the `crm.` spelling the PRD gave them.
   * The Sales roles that hold the self keys arrive with the role expansion;
   * until then Admin holds every key, as it does for every module.
   */
  CRM_CONTACT_VIEW_SELF: 'crm.contact.view.self',
  CRM_CONTACT_VIEW_ALL: 'crm.contact.view.all',
  CRM_CONTACT_MANAGE: 'crm.contact.manage',
  CRM_DEAL_VIEW_SELF: 'crm.deal.view.self',
  CRM_DEAL_VIEW_ALL: 'crm.deal.view.all',
  CRM_DEAL_MANAGE: 'crm.deal.manage',
  CRM_PIPELINE_MANAGE: 'crm.pipeline.manage',
  CRM_TASK_VIEW_SELF: 'crm.task.view.self',
  CRM_TASK_VIEW_TEAM: 'crm.task.view.team',
  CRM_TASK_MANAGE: 'crm.task.manage',

  /** Phase 8a (08 §2.2). Documents are the estimate now; orders, challans and invoices as they land. */
  SALES_DOCUMENT_VIEW_SELF: 'sales.document.view.self',
  SALES_DOCUMENT_VIEW_ALL: 'sales.document.view.all',
  SALES_DOCUMENT_CREATE: 'sales.document.create',
  SALES_DOCUMENT_ALTER: 'sales.document.alter',
  SALES_DISCOUNT_APPROVE: 'sales.discount.approve',
  /** 08 REQ-W-09: release an order blocked by the party's credit position, with a reason. */
  SALES_CREDIT_OVERRIDE: 'sales.credit.override',
  // 15 REQ-AN-10: price lists are drafted by one key and activated by another.
  PRICING_MANAGE: 'pricing.manage',
  PRICING_APPROVE: 'pricing.approve',
  // 15 REQ-AO-14: duplicates are seen by one key and decided by another.
  DUPLICATES_VIEW: 'duplicates.view',
  DUPLICATES_MANAGE: 'duplicates.manage',
  // 15 REQ-AJ-11: my parties, everyone's parties, and the right to record intent.
  COLLECTIONS_VIEW_SELF: 'collections.view.self',
  COLLECTIONS_VIEW_ALL: 'collections.view.all',
  COLLECTIONS_MANAGE: 'collections.manage',
  // 15 REQ-AK-11: seeing returns, recording them, and deciding a line is scrap.
  RETURNS_VIEW: 'returns.view',
  RETURNS_MANAGE: 'returns.manage',
  RETURNS_DISPOSITION: 'returns.disposition',
  // 15 REQ-AL-03/AL-07: issuing a customer's portal link, and withdrawing it.
  PORTAL_MANAGE: 'portal.manage',

  /** 08 §2.2 / 13. Purchase and Accounts roles arrive with their phases; Admin holds these meanwhile. */
  PURCHASE_DOCUMENT_VIEW: 'purchase.document.view',
  PURCHASE_DOCUMENT_CREATE: 'purchase.document.create',
  PURCHASE_DOCUMENT_APPROVE: 'purchase.document.approve',

  /**
   * D-22: working-capital interest on money blocked with customers and in
   * stock. Viewing is Accounts' and Admin's; configuring — the rate, the
   * per-party overrides, the recompute — is a separate key because a changed
   * rate silently re-prices every figure the viewers act on.
   */
  INTEREST_VIEW: 'interest_cost.view',
  INTEREST_CONFIGURE: 'interest_cost.configure',

  /** 12 REQ-AB-03: exempt from the sign-in window. Admin only by default. */
  ACCESS_OUTSIDE_WINDOW: 'access.outside_window',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as readonly PermissionKey[];

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  'punch.self': 'Record own punch in and out',
  'attendance.view.self': 'View own attendance',
  'attendance.view.team': "View the team's attendance",
  'attendance.view.all': 'View attendance for the whole organisation',
  'attendance.edit': 'Override an attendance day with a reason',
  'attendance.lock': 'Lock an attendance period',
  'attendance.unlock': 'Unlock a locked attendance period with a reason',
  'leave.apply.self': 'Apply for own leave',
  'leave.approve.team': "Approve the team's leave",
  'leave.approve.all': 'Approve leave for anyone',
  'leave.policy.manage': 'Manage leave types and balances',
  'employee.view': 'View employee records',
  'employee.manage': 'Create and edit employee records',
  'shift.manage': 'Manage shifts, rosters, and weekly-off patterns',
  'holiday.manage': 'Manage holiday calendars',
  'report.view': 'View reports',
  'report.export': 'Export reports to Excel',
  'settings.manage': 'Change organisation settings',
  'roles.manage': 'Create roles and assign permissions',
  'audit.view': 'View the audit log',
  'masters.tally.view': 'View the Tally masters projection: parties, items, price lists',
  'receivables.view': 'View vouchers and receivables pulled from Tally: invoices, receipts, statements, ageing',
  'parties.rm.assign': 'Assign or change the relationship manager on a customer',
  'reports.exceptions.notify': 'Receive the daily exception-report digest',
  'reports.margin.view': 'View the gross margin proxy report',
  'cfo.sales.view': 'Open the Virtual CFO module: company summary and own scorecard',
  'cfo.margin.view': 'See margin in rupees across the Virtual CFO module',
  'cfo.receivables.view': 'See the full receivable book in the Virtual CFO module',
  'cfo.brand.view': 'See brand and principal economics, slabs and schemes',
  'cfo.team.view': 'Open every person\u2019s scorecard, beyond the league table',
  'cfo.compliance.view': 'See the compliance exposure reports',
  'cfo.exceptions.view': 'See the nightly exception reports',
  'cfo.export': 'Export Virtual CFO reports (every export is logged)',
  'cfo.lists.assign': 'Assign work-list entries and daily-call names to owners',
  'cfo.targets.manage': 'Set and revise monthly sales targets per person',
  'cfo.tier.assign': 'Set a customer\u2019s class (A+ to D) with a reason and an effective date',
  'cfo.tier.master': 'Edit the customer class master: labels, terms, discount ceilings, contact frequency',
  'crm.contact.view.self': 'View the contacts and companies you own',
  'crm.contact.view.all': 'View every contact and company',
  'crm.contact.manage': 'Create and edit contacts and companies',
  'crm.deal.view.self': 'View the deals you own',
  'crm.deal.view.all': 'View every deal',
  'crm.deal.manage': 'Create deals and move them between stages',
  'crm.pipeline.manage': 'Configure pipelines and their stages',
  'crm.task.view.self': 'View tasks assigned to you or owned by you',
  'crm.task.view.team': 'View your team’s tasks',
  'crm.task.manage': 'Create, assign and close tasks',
  'sales.document.view.self': 'View the sales documents you own',
  'sales.document.view.all': 'View every sales document',
  'sales.document.create': 'Raise estimates, sales orders and challans',
  'sales.document.alter': 'Alter an accepted document (re-pushed against its GUID)',
  'sales.discount.approve': 'Approve a discount above the threshold',
  'sales.credit.override': 'Release a sales order blocked by the party’s credit limit, with a reason',
  'pricing.manage': 'Draft and edit price lists and submit them for approval',
  'pricing.approve': 'Approve a price list into force',
  'duplicates.view': 'See likely duplicate masters and the clusters behind them',
  'duplicates.manage': 'Dismiss a duplicate cluster or mark it sent to Tally',
  'collections.view.self': 'See the collections work for the parties assigned to me',
  'collections.view.all': 'See every collector’s parties, promises and targets',
  'collections.manage': 'Take a promise to pay, assign a collector, send a reminder',
  'returns.view': 'See sales returns and what they are waiting on',
  'returns.manage': 'Receive a return, link its credit note, raise a replacement',
  'returns.disposition': 'Decide a returned line is scrap rather than restock',
  'portal.manage': 'Issue a customer portal link and withdraw one',
  'purchase.document.view': 'View purchase orders, GRNs and the procurement queue',
  'purchase.document.create': 'Raise purchase orders and record receipts',
  'purchase.document.approve': 'Approve a purchase order above the threshold, and short-close one',
  'interest_cost.view': 'View interest cost on receivables and stock, and the cash cycle',
  'interest_cost.configure': 'Set the interest rate and per-party overrides, and trigger a recompute',
  'access.outside_window': 'Sign in and work outside the access window (19:30 to 09:00 by default)',
  'integration.manage': 'Manage integration connections',
};

/**
 * Data scope for a permission that can be held at more than one breadth.
 * PRD §2: "team = employees whose reporting_manager_id chain reaches the user,
 * plus employees in departments the user owns." Resolved in the repository
 * layer by ScopeService, never in the UI.
 */
export const DATA_SCOPES = { SELF: 'self', TEAM: 'team', ALL: 'all' } as const;
export type DataScope = (typeof DATA_SCOPES)[keyof typeof DATA_SCOPES];

export const SYSTEM_ROLES = {
  EMPLOYEE: 'Employee',
  OPERATIONS: 'Operations',
  HR: 'HR',
  ADMIN: 'Admin',
  /**
   * 08 §2 (Phase 7). Held alongside Employee, never instead of it (D-15: a
   * salesperson is also an employee who punches, so attendance keys are not
   * duplicated here). Purchase and Accounts arrived with docs 12 and 13,
   * which gave them screens to reach.
   */
  SALES: 'Sales',
  SALES_MANAGER: 'Sales manager',
  /**
   * The person who owns a book of customers end to end -- their sales and
   * their collections. Held alongside Employee like the other sales roles; the
   * customers they own are the parties they are assigned as RM on, and the
   * self-scoped keys below read against that assignment.
   */
  RELATIONSHIP_MANAGER: 'Relationship manager',
  PURCHASE: 'Purchase',
  ACCOUNTS: 'Accounts',
} as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

const EMPLOYEE_PERMISSIONS = [
  PERMISSIONS.PUNCH_SELF,
  PERMISSIONS.ATTENDANCE_VIEW_SELF,
  PERMISSIONS.LEAVE_APPLY_SELF,
] as const satisfies readonly PermissionKey[];

const OPERATIONS_PERMISSIONS = [
  ...EMPLOYEE_PERMISSIONS,
  PERMISSIONS.ATTENDANCE_VIEW_TEAM,
  PERMISSIONS.LEAVE_APPROVE_TEAM,
  PERMISSIONS.EMPLOYEE_VIEW,
  PERMISSIONS.SHIFT_MANAGE,
  PERMISSIONS.REPORT_VIEW,
] as const satisfies readonly PermissionKey[];

const HR_PERMISSIONS = [
  ...OPERATIONS_PERMISSIONS,
  PERMISSIONS.ATTENDANCE_VIEW_ALL,
  PERMISSIONS.ATTENDANCE_EDIT,
  PERMISSIONS.ATTENDANCE_LOCK,
  PERMISSIONS.LEAVE_APPROVE_ALL,
  PERMISSIONS.LEAVE_POLICY_MANAGE,
  PERMISSIONS.EMPLOYEE_MANAGE,
  PERMISSIONS.HOLIDAY_MANAGE,
  PERMISSIONS.REPORT_EXPORT,
] as const satisfies readonly PermissionKey[];

/**
 * Admin holds every permission there is, derived rather than listed.
 *
 * This used to be an enumeration -- HR's set, then thirty-odd keys named one
 * by one. It was complete, and that is the problem: it was complete because
 * somebody remembered each time, and the failure mode is silent. A permission
 * added for a new module and not added here leaves the owner of the system
 * unable to reach a screen they are supposed to own, and nothing anywhere
 * says so; they simply find a 403 one day and assume it is a bug elsewhere.
 *
 * Reading the catalogue makes "Admin can do everything" true by construction.
 * A key that exists is a key Admin has, on the day it is added, without anyone
 * doing anything.
 *
 * This is a *seed*, not an invariant -- REQ-B-07 lets an administrator edit
 * any role afterwards, including their own, and the last-holder guard in
 * `RbacAdminService` is what stops that going too far.
 */
const ADMIN_PERMISSIONS = Object.values(PERMISSIONS) satisfies readonly PermissionKey[];

/**
 * Seed only. Admin can edit any of these in the UI afterwards (REQ-B-07), so
 * this matrix is a starting point, not an invariant the code may rely on.
 */
/** 08 §2.2, the Sales column, for the keys that exist so far. */
const SALES_PERMISSIONS = [
  PERMISSIONS.MASTERS_TALLY_VIEW,
  PERMISSIONS.CRM_CONTACT_VIEW_SELF,
  PERMISSIONS.CRM_CONTACT_MANAGE,
  PERMISSIONS.CRM_DEAL_VIEW_SELF,
  PERMISSIONS.CRM_DEAL_MANAGE,
  PERMISSIONS.CRM_TASK_VIEW_SELF,
  PERMISSIONS.CRM_TASK_MANAGE,
  PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
  PERMISSIONS.SALES_DOCUMENT_CREATE,
  PERMISSIONS.RETURNS_VIEW,
  // K3: the salesperson row — company summary and their own scorecard
  // (margin as a percentage on their own book comes with it; the rupee
  // sight is cfo.margin.view, which this row does not hold).
  PERMISSIONS.CFO_SALES_VIEW,
] as const satisfies readonly PermissionKey[];

/** 08 §2.2, the Sales manager column: all of Sales at full scope, plus receivables. */
const SALES_MANAGER_PERMISSIONS = [
  ...SALES_PERMISSIONS,
  PERMISSIONS.CRM_CONTACT_VIEW_ALL,
  PERMISSIONS.CRM_DEAL_VIEW_ALL,
  PERMISSIONS.CRM_PIPELINE_MANAGE,
  PERMISSIONS.CRM_TASK_VIEW_TEAM,
  PERMISSIONS.PARTIES_RM_ASSIGN,
  PERMISSIONS.RECEIVABLES_VIEW,
  PERMISSIONS.REPORTS_MARGIN_VIEW,
  PERMISSIONS.SALES_DOCUMENT_VIEW_ALL,
  PERMISSIONS.SALES_DOCUMENT_ALTER,
  PERMISSIONS.SALES_DISCOUNT_APPROVE,
  PERMISSIONS.SALES_CREDIT_OVERRIDE,
  PERMISSIONS.PRICING_MANAGE,
  PERMISSIONS.DUPLICATES_VIEW,
  PERMISSIONS.DUPLICATES_MANAGE,
  PERMISSIONS.COLLECTIONS_VIEW_SELF,
  PERMISSIONS.COLLECTIONS_VIEW_ALL,
  PERMISSIONS.COLLECTIONS_MANAGE,
  PERMISSIONS.RETURNS_MANAGE,
  // K3: the sales head row — everything the owner sees.
  PERMISSIONS.CFO_MARGIN_VIEW,
  PERMISSIONS.CFO_RECEIVABLES_VIEW,
  PERMISSIONS.CFO_BRAND_VIEW,
  PERMISSIONS.CFO_TEAM_VIEW,
  PERMISSIONS.CFO_EXPORT,
  PERMISSIONS.CFO_LISTS_ASSIGN,
  PERMISSIONS.CFO_TARGETS_MANAGE,
  PERMISSIONS.CFO_TIER_ASSIGN,
] as const satisfies readonly PermissionKey[];

/**
 * The relationship manager owns a book of customers: their sales at self scope,
 * their collections (and the right to record intent), and the receivables
 * behind them. It is the Sales set plus the collections-for-own-parties keys --
 * not Sales manager, which sees everyone's. The book is the parties they are
 * assigned as RM on; the self-scoped reads resolve against that assignment.
 */
const RELATIONSHIP_MANAGER_PERMISSIONS = [
  ...SALES_PERMISSIONS,
  PERMISSIONS.RECEIVABLES_VIEW,
  PERMISSIONS.COLLECTIONS_VIEW_SELF,
  PERMISSIONS.COLLECTIONS_MANAGE,
] as const satisfies readonly PermissionKey[];

/** 08 §2.2, the Purchase column: the procurement queue, POs and receipts, tasks, and the masters. */
const PURCHASE_PERMISSIONS = [
  PERMISSIONS.MASTERS_TALLY_VIEW,
  PERMISSIONS.CRM_TASK_VIEW_SELF,
  PERMISSIONS.CRM_TASK_MANAGE,
  PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
  PERMISSIONS.PURCHASE_DOCUMENT_CREATE,
] as const satisfies readonly PermissionKey[];

/**
 * 08 §2.2, the Accounts column: every sales document (the awaiting-invoice
 * queue is theirs), receivables, the purchase approval line and the credit
 * override, tasks, and the masters. No create keys — accounts decides and
 * bills; it does not raise orders.
 */
const ACCOUNTS_PERMISSIONS = [
  PERMISSIONS.MASTERS_TALLY_VIEW,
  PERMISSIONS.CRM_TASK_VIEW_SELF,
  PERMISSIONS.CRM_TASK_MANAGE,
  PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
  PERMISSIONS.SALES_DOCUMENT_VIEW_ALL,
  PERMISSIONS.SALES_CREDIT_OVERRIDE,
  PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
  PERMISSIONS.PURCHASE_DOCUMENT_APPROVE,
  PERMISSIONS.RECEIVABLES_VIEW,
  PERMISSIONS.REPORTS_EXCEPTIONS_NOTIFY,
  PERMISSIONS.REPORTS_MARGIN_VIEW,
  // K3: the accounts row — company figures and the whole receivable book,
  // no brand economics, no team detail, no rupee margin.
  PERMISSIONS.CFO_SALES_VIEW,
  PERMISSIONS.CFO_RECEIVABLES_VIEW,
  PERMISSIONS.CFO_COMPLIANCE_VIEW,
  PERMISSIONS.CFO_EXCEPTIONS_VIEW,
  PERMISSIONS.CFO_EXPORT,
  PERMISSIONS.DUPLICATES_VIEW,
  PERMISSIONS.DUPLICATES_MANAGE,
  PERMISSIONS.COLLECTIONS_VIEW_SELF,
  PERMISSIONS.COLLECTIONS_VIEW_ALL,
  PERMISSIONS.COLLECTIONS_MANAGE,
  // REQ-AK-05: the awaiting-credit-note queue is the accountant's, exactly
  // as the awaiting-invoice one is -- and writing goods off is theirs too.
  // Sales manages returns and raises replacements; it does not scrap stock,
  // because the person a customer is complaining to should not be the person
  // who decides the goods were worthless.
  PERMISSIONS.RETURNS_VIEW,
  PERMISSIONS.RETURNS_MANAGE,
  PERMISSIONS.RETURNS_DISPOSITION,
  PERMISSIONS.PORTAL_MANAGE,
  // D-22: the working-capital interest figures are the accountant's lens,
  // and the rate and overrides are theirs to keep honest.
  PERMISSIONS.INTEREST_VIEW,
  PERMISSIONS.INTEREST_CONFIGURE,
] as const satisfies readonly PermissionKey[];

export const ROLE_PERMISSION_MATRIX: Record<SystemRoleName, readonly PermissionKey[]> = {
  Employee: EMPLOYEE_PERMISSIONS,
  Operations: OPERATIONS_PERMISSIONS,
  HR: HR_PERMISSIONS,
  Admin: ADMIN_PERMISSIONS,
  Sales: SALES_PERMISSIONS,
  'Sales manager': SALES_MANAGER_PERMISSIONS,
  'Relationship manager': RELATIONSHIP_MANAGER_PERMISSIONS,
  Purchase: PURCHASE_PERMISSIONS,
  Accounts: ACCOUNTS_PERMISSIONS,
};

/**
 * REQ-B-07: "The last account holding roles.manage cannot be stripped of it."
 * Exported so the guard that enforces it names the same constant the seed does.
 */
export const IRREVOCABLE_LAST_HOLDER_PERMISSION = PERMISSIONS.ROLES_MANAGE;

// ---------------------------------------------------------------------------
// REQ-B-07 write contract: `GET/POST/PATCH/DELETE /roles`
// ---------------------------------------------------------------------------

/**
 * One role as the roles screen reads it.
 *
 * `memberCount` counts *active* accounts. A suspended holder cannot sign in, so
 * counting them would tell an administrator the role is still in use by someone
 * who can do nothing with it.
 */
export interface RoleSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /**
   * A seeded role. Editable (REQ-B-07 says Admin edits permission sets and
   * makes no exception), but not renameable and not deletable — the seed
   * reconciles by name, so a renamed `Admin` becomes a second `Admin` on the
   * next run and the original silently stops being reconciled.
   */
  readonly isSystem: boolean;
  readonly permissions: readonly PermissionKey[];
  readonly memberCount: number;
}

const roleNameField = z.string().trim().min(2).max(60);
const roleDescriptionField = z.string().trim().min(1).max(240);

/**
 * The permission set as a whole, never a delta.
 *
 * REQ-B-07 edits are wholesale for the same reason a reorder sends the whole
 * order: two administrators each sending "add X" and "remove Y" against a set
 * they both read a moment ago would compose into a set neither of them chose.
 */
const permissionSetField = z
  .array(z.enum(ALL_PERMISSIONS as unknown as [PermissionKey, ...PermissionKey[]]))
  .max(ALL_PERMISSIONS.length)
  .transform((keys) => [...new Set(keys)]);

export const createRoleSchema = z.object({
  name: roleNameField,
  description: roleDescriptionField.nullish(),
  permissions: permissionSetField.default([]),
  reason: adminReasonSchema,
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

/**
 * Absent means unchanged, which is what makes this a PATCH. An empty
 * `permissions` array is *not* absent — it is "this role grants nothing", and
 * the last-holder guard in `RbacAdminService` is what stops that locking
 * everybody out.
 */
export const updateRoleSchema = z
  .object({
    name: roleNameField,
    description: roleDescriptionField.nullable(),
    permissions: permissionSetField,
  })
  .partial()
  .extend({ reason: adminReasonSchema })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.permissions !== undefined,
    { message: 'Change at least one of name, description or permissions.' },
  );

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

// ---------------------------------------------------------------------------
// REQ-B-07 assignment contract: `/employees/:id/access`
//
// "Admin can create roles, edit permission sets, and **assign multiple roles to
// a user**." The first two shipped with the roles screen; this is the third,
// and it hangs off the employee because that is where an administrator is
// standing when the question arises. Roles attach to the *account*, not to the
// employee record — REQ-B-02 keeps them separate, and an employee with no login
// has nothing to hold a role.
// ---------------------------------------------------------------------------

/** The login account behind an employee record, when one exists (REQ-B-02). */
export interface EmployeeAccount {
  readonly id: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly lastLoginAt: string | null;
  /** REQ-B-09: an authenticator is confirmed on the account. */
  readonly mfaEnabled: boolean;
}

/**
 * One role as the assignment control reads it.
 *
 * Carries its permission keys so the screen can say what granting it actually
 * confers, rather than showing a name and leaving the reader to go and look the
 * role up on another screen. `memberCount` is deliberately absent: it is a
 * property of the role, not of this person's hold on it, and it would go stale
 * the moment this endpoint granted or revoked one.
 */
export interface AssignedRole {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly PermissionKey[];
}

export interface EmployeeAccess {
  readonly employeeId: string;
  /** Null for an employee who has never been invited (REQ-A-06 imports). */
  readonly account: EmployeeAccount | null;
  readonly roles: readonly AssignedRole[];
}

/**
 * One role at a time, not a set.
 *
 * The permission set on a role is replaced wholesale because two administrators
 * composing deltas would produce a set neither chose. Membership is the
 * opposite case: each grant and each revoke has to be judged against the
 * REQ-B-07 last-holder invariant on its own, and a wholesale set that failed
 * halfway would have already applied the earlier half.
 */
export const assignRoleSchema = z.object({
  roleId: z.uuid(),
  reason: adminReasonSchema,
});

export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

export const setCredentialsSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  roleId: z.string().uuid().optional(),
  reason: adminReasonSchema.optional(),
});

export type SetCredentialsInput = z.infer<typeof setCredentialsSchema>;
