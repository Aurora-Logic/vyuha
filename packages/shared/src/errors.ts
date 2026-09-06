/**
 * Error codes are the contract. Technical design §6: "The web client maps codes
 * to messages; it never string-matches on `message`."
 */

export const ERROR_CODES = {
  // Generic
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /**
   * The request was fine and the server could not serve it right now — a
   * contended row lock, an exhausted connection pool, a dependency that is
   * down. Distinct from INTERNAL_ERROR because the two say opposite things to
   * a client: a 500 means "this will not work, stop", while this one is worth
   * retrying, and the punch outbox (REQ-D-10) is built to hold a punch and
   * re-send it. Carries `retryAfterSeconds` in `details`, and the same value
   * in a `Retry-After` header.
   */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // Auth (REQ-B-01…B-10)
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  /** REQ-B-09: the code step after the password. */
  MFA_CODE_INVALID: 'MFA_CODE_INVALID',
  MFA_CHALLENGE_EXPIRED: 'MFA_CHALLENGE_EXPIRED',
  MFA_NOT_ENROLLED: 'MFA_NOT_ENROLLED',
  MFA_ALREADY_ENROLLED: 'MFA_ALREADY_ENROLLED',
  /** 12 Area AB: outside the sign-in window, and not exempt. */
  ACCESS_WINDOW_CLOSED: 'ACCESS_WINDOW_CLOSED',
  /** 08 REQ-W-09: the party is over its credit limit; released only with sales.credit.override and a reason. */
  CREDIT_BLOCKED: 'CREDIT_BLOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  TOTP_REQUIRED: 'TOTP_REQUIRED',
  TOTP_INVALID: 'TOTP_INVALID',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INVITATION_ALREADY_ACCEPTED: 'INVITATION_ALREADY_ACCEPTED',
  PASSWORD_TOO_WEAK: 'PASSWORD_TOO_WEAK',
  /**
   * REQ-B-02: one living login per employee (`users_employee_uq`). Its own
   * code rather than a bare CONFLICT because the caller can act on it -- the
   * employee already has an account, so the answer is to reset or reactivate
   * that one, not to invite a second. The email collisions on the same
   * endpoint stay generic on purpose; those would confirm an address.
   */
  EMPLOYEE_ALREADY_LINKED: 'EMPLOYEE_ALREADY_LINKED',

  // Authorisation
  FORBIDDEN: 'FORBIDDEN',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  LAST_ROLES_MANAGE_HOLDER: 'LAST_ROLES_MANAGE_HOLDER',

  // Punch (REQ-D-01…D-13)
  PUNCH_OUT_OF_ORDER: 'PUNCH_OUT_OF_ORDER',
  PUNCH_OUTSIDE_WINDOW: 'PUNCH_OUTSIDE_WINDOW',
  PUNCH_OUTSIDE_GEOFENCE: 'PUNCH_OUTSIDE_GEOFENCE',
  /** The device gave no position; a punch cannot be placed without one. */
  PUNCH_LOCATION_REQUIRED: 'PUNCH_LOCATION_REQUIRED',
  /** The office has no coordinates yet, so no punch there can be checked. */
  PUNCH_GEOFENCE_NOT_CONFIGURED: 'PUNCH_GEOFENCE_NOT_CONFIGURED',
  PUNCH_MOCK_LOCATION: 'PUNCH_MOCK_LOCATION',
  PUNCH_IP_NOT_ALLOWED: 'PUNCH_IP_NOT_ALLOWED',
  PUNCH_REASON_REQUIRED: 'PUNCH_REASON_REQUIRED',
  PUNCH_OWNER_MISMATCH: 'PUNCH_OWNER_MISMATCH',
  PUNCH_PHOTO_REQUIRED: 'PUNCH_PHOTO_REQUIRED',
  PUNCH_PHOTO_INVALID: 'PUNCH_PHOTO_INVALID',
  PUNCH_DEVICE_NOT_BOUND: 'PUNCH_DEVICE_NOT_BOUND',
  PUNCH_EMPLOYEE_INACTIVE: 'PUNCH_EMPLOYEE_INACTIVE',
  PUNCH_QUEUED_TOO_OLD: 'PUNCH_QUEUED_TOO_OLD',
  /** REQ-M-03: no recorded acceptance and the body did not assert one. */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',

  // Attendance (REQ-E-09)
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  PERIOD_ALREADY_LOCKED: 'PERIOD_ALREADY_LOCKED',
  PERIOD_NOT_LOCKED: 'PERIOD_NOT_LOCKED',
  OVERRIDE_REASON_REQUIRED: 'OVERRIDE_REASON_REQUIRED',

  // Leave (REQ-G-07, G-08)
  LEAVE_INSUFFICIENT_BALANCE: 'LEAVE_INSUFFICIENT_BALANCE',
  LEAVE_NEGATIVE_LIMIT_EXCEEDED: 'LEAVE_NEGATIVE_LIMIT_EXCEEDED',
  LEAVE_OVERLAPS_EXISTING: 'LEAVE_OVERLAPS_EXISTING',
  LEAVE_NOTICE_PERIOD: 'LEAVE_NOTICE_PERIOD',
  LEAVE_ATTACHMENT_REQUIRED: 'LEAVE_ATTACHMENT_REQUIRED',

  // Approvals (REQ-I-05)
  APPROVER_IS_REQUESTER: 'APPROVER_IS_REQUESTER',
  APPROVAL_ALREADY_ACTIONED: 'APPROVAL_ALREADY_ACTIONED',

  // Master data (REQ-A-04, A-07)
  EMPLOYEE_CODE_IMMUTABLE: 'EMPLOYEE_CODE_IMMUTABLE',
  REPORTING_CYCLE: 'REPORTING_CYCLE',
  SHIFT_ASSIGNMENT_OVERLAP: 'SHIFT_ASSIGNMENT_OVERLAP',

  // Admin CRUD (REQ-B-09a, REQ-M-04)
  /** A soft delete was refused: live rows still point at the record. */
  RECORD_IN_USE: 'RECORD_IN_USE',
  /** A seeded role cannot be renamed or deleted; its permissions can be edited. */
  SYSTEM_ROLE_PROTECTED: 'SYSTEM_ROLE_PROTECTED',
  /** Restore was asked for a record that is not deleted. */
  RECORD_NOT_DELETED: 'RECORD_NOT_DELETED',

  // Append-only guarantees (REQ-B-09a, REQ-D-12, REQ-M-01)
  RECORD_IS_APPEND_ONLY: 'RECORD_IS_APPEND_ONLY',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** The single error envelope every endpoint returns (technical design §6). */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}
