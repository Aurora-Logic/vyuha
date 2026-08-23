import { PERMISSIONS, type PermissionKey } from './permissions.js';
import type { KnownApprovalSubjectType } from './approvals.js';

/**
 * Which permission keys govern each approval subject type (REQ-P-04).
 *
 * This exists because two consumers cannot read the runtime registry. The
 * `@RequirePermission(...)` decorators on the approvals controller are
 * evaluated when the class is defined, before any module has registered a
 * handler; and the inbox's scope resolution needs the whole family at once.
 * Both used to hard-code leave keys inside `platform/approvals` — the exact
 * fallback REQ-P-04 forbids, because a CRM discount approver holding only
 * `sales.discount.approve` would have been refused at the door by a guard
 * that had never heard of their key.
 *
 * So the keys are *declared* here, in the contract layer both sides already
 * build against, and everything else derives:
 *
 * - the route guards take the unions below;
 * - each subject's handler reads its own entry, so the slice and the guard
 *   cannot disagree;
 * - `ApprovalSubjectRegistry.register` refuses a handler whose keys are not
 *   these, which turns drift into a boot failure instead of a quiet widening.
 *
 * Adding an approval subject in a later module means adding its entry here —
 * a shared-contract change, like a permission key itself — and registering a
 * handler that carries the same keys.
 */

export interface ApprovalSubjectKeyDeclaration {
  /** Keys that let a holder decide this kind of request. */
  readonly act: readonly [PermissionKey, ...PermissionKey[]];
  /**
   * Keys that additionally let a holder act on a step never routed to them —
   * who REQ-G-09 escalates to when the reporting line runs out.
   */
  readonly override: readonly PermissionKey[];
  /** Keys a requester of this kind holds. Reading the inbox needs any key in the family. */
  readonly raise: readonly [PermissionKey, ...PermissionKey[]];
  /**
   * Which of this subject's keys widen inbox *browsing* beyond the caller's
   * own requests. Deliberately not implied by `act`: a correction approver
   * decides what is routed to them, and holding `regularization.approve` has
   * never meant browsing the whole team's inbox. Absent means "routing only".
   */
  readonly scope: {
    readonly team?: readonly PermissionKey[];
    readonly all?: readonly PermissionKey[];
  };
}

export const APPROVAL_SUBJECT_KEYS: Partial<
  Record<KnownApprovalSubjectType, ApprovalSubjectKeyDeclaration>
> = {
  leave_request: {
    act: [PERMISSIONS.LEAVE_APPROVE_TEAM, PERMISSIONS.LEAVE_APPROVE_ALL],
    override: [PERMISSIONS.LEAVE_APPROVE_ALL],
    raise: [PERMISSIONS.LEAVE_APPLY_SELF],
    scope: {
      team: [PERMISSIONS.LEAVE_APPROVE_TEAM],
      all: [PERMISSIONS.LEAVE_APPROVE_ALL],
    },
  },
  // Owner, 21 Aug 2026: corrections and on-duty requests can no longer be
  // raised; the keys that raised them are gone. Requests already open stay
  // decidable from the inbox by whoever may edit attendance, and an
  // employee may still see their own under `raise` (punch.self is what every
  // employee holds).
  regularization: {
    act: [PERMISSIONS.ATTENDANCE_EDIT],
    override: [PERMISSIONS.ATTENDANCE_EDIT],
    raise: [PERMISSIONS.PUNCH_SELF],
    scope: {},
  },
  on_duty_request: {
    act: [PERMISSIONS.ATTENDANCE_EDIT],
    override: [PERMISSIONS.ATTENDANCE_EDIT],
    raise: [PERMISSIONS.PUNCH_SELF],
    scope: {},
  },
  // Owner, 21 Aug 2026: a late or out-of-window punch is flagged into the
  // inbox and acted on by whoever may edit attendance. The punch itself was
  // raised by the employee punching.
  punch: {
    act: [PERMISSIONS.ATTENDANCE_EDIT],
    override: [PERMISSIONS.ATTENDANCE_EDIT],
    raise: [PERMISSIONS.PUNCH_SELF],
    scope: { all: [PERMISSIONS.ATTENDANCE_EDIT] },
  },
  // 13 REQ-X-16: a PO over the threshold is decided by holders of
  // purchase.document.approve, and by nobody else -- HR's leave key does
  // not buy a purchase.
  purchase_order: {
    act: [PERMISSIONS.PURCHASE_DOCUMENT_APPROVE],
    override: [PERMISSIONS.PURCHASE_DOCUMENT_APPROVE],
    raise: [PERMISSIONS.PURCHASE_DOCUMENT_CREATE],
    scope: { all: [PERMISSIONS.PURCHASE_DOCUMENT_APPROVE] },
  },
  // 08 REQ-W-08: a discount past the threshold is a Sales manager's call.
  sales_order: {
    act: [PERMISSIONS.SALES_DISCOUNT_APPROVE],
    override: [PERMISSIONS.SALES_DISCOUNT_APPROVE],
    raise: [PERMISSIONS.SALES_DOCUMENT_CREATE],
    scope: { all: [PERMISSIONS.SALES_DISCOUNT_APPROVE] },
  },
  // 15 REQ-AN-09/10/11: a price list activates only by pricing.approve, its own key, never an attendance or sales one.
  price_list: {
    act: [PERMISSIONS.PRICING_APPROVE],
    override: [PERMISSIONS.PRICING_APPROVE],
    raise: [PERMISSIONS.PRICING_MANAGE],
    scope: { all: [PERMISSIONS.PRICING_APPROVE] },
  },
};

/**
 * The declaration for one subject type, for the handler that implements it.
 * Throws rather than returning undefined: a handler for an undeclared subject
 * is exactly the drift the registry refuses, and failing here names the file
 * to fix while the stack still points at the slice that forgot.
 */
export function declaredApprovalKeys(
  subjectType: KnownApprovalSubjectType,
): ApprovalSubjectKeyDeclaration {
  const entry = APPROVAL_SUBJECT_KEYS[subjectType];
  if (entry === undefined) {
    throw new Error(
      `Approval subject "${subjectType}" has no entry in APPROVAL_SUBJECT_KEYS ` +
        '(packages/shared/src/approval-keys.ts).',
    );
  }
  return entry;
}

/** Every declared entry, for consumers that iterate rather than look up. */
export function approvalSubjectKeyEntries(): ReadonlyArray<
  readonly [KnownApprovalSubjectType, ApprovalSubjectKeyDeclaration]
> {
  return Object.entries(APPROVAL_SUBJECT_KEYS) as ReadonlyArray<
    readonly [KnownApprovalSubjectType, ApprovalSubjectKeyDeclaration]
  >;
}

function union(pick: (entry: ApprovalSubjectKeyDeclaration) => readonly PermissionKey[]): PermissionKey[] {
  const keys = new Set<PermissionKey>();
  for (const [, entry] of approvalSubjectKeyEntries()) {
    for (const key of pick(entry)) keys.add(key);
  }
  return [...keys];
}

/**
 * A derived union as the non-empty tuple `@RequirePermission` demands.
 * Throwing at module load is right: an empty union means the catalogue above
 * was emptied, and a guard derived from it would deny every approver in the
 * product — a build that must not start.
 */
function nonEmpty(keys: PermissionKey[], name: string): readonly [PermissionKey, ...PermissionKey[]] {
  const [first, ...rest] = keys;
  if (first === undefined) {
    throw new Error(`${name} derived to an empty set; the approval key catalogue is empty.`);
  }
  return [first, ...rest];
}

/**
 * The guard for decision endpoints: holding any of these means the caller
 * approves *something*. Which requests they may actually decide is the
 * handler's `actPermissions`, checked per row in `decideWithin`.
 */
export const APPROVAL_ACT_KEYS = nonEmpty(
  union((entry) => [...entry.act, ...entry.override]),
  'APPROVAL_ACT_KEYS',
);

/**
 * The guard for read endpoints: the whole family, act and raise sides both.
 * Wider than the act union on purpose — a requester reads the inbox to see
 * their own request — and wider than the pre-catalogue list in one honest
 * way: it includes every act key, so an approver can always list what they
 * are asked to decide.
 */
export const APPROVAL_READ_KEYS = nonEmpty(
  union((entry) => [...entry.act, ...entry.override, ...entry.raise]),
  'APPROVAL_READ_KEYS',
);

/**
 * Inbox browsing breadth, per band. `self` is every raise key: whoever can
 * create a request of any kind can see their own. `team` and `all` are only
 * the keys each subject *declared* as browse-widening.
 */
export const APPROVAL_SCOPE_KEYS: {
  readonly self: readonly PermissionKey[];
  readonly team: readonly PermissionKey[];
  readonly all: readonly PermissionKey[];
} = {
  self: union((entry) => entry.raise),
  team: union((entry) => entry.scope.team ?? []),
  all: union((entry) => entry.scope.all ?? []),
};
