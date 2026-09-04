import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@vyuha/shared';

/**
 * Technical design §6: one error envelope, always. The code is the contract —
 * the web client maps codes to messages and never string-matches on `message`.
 */

/**
 * The HTTP status for every error code, in one place.
 *
 * `Record<ErrorCode, number>` is the point of this table: adding a code to
 * `packages/shared` without deciding its status is a type error here, so the
 * same code can never come back as 400 from one endpoint and 422 from another.
 */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  // 503 rather than 500 or 429: nothing about the caller was wrong and nothing
  // about the server is broken, so the honest answer is "not now, try again",
  // and a proxy or an offline outbox already knows what to do with it.
  SERVICE_UNAVAILABLE: 503,

  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  MFA_CODE_INVALID: 401,
  MFA_CHALLENGE_EXPIRED: 401,
  MFA_NOT_ENROLLED: 409,
  MFA_ALREADY_ENROLLED: 409,
  ACCESS_WINDOW_CLOSED: 403,
  CREDIT_BLOCKED: 409,
  ACCOUNT_INACTIVE: 403,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  REFRESH_TOKEN_REUSED: 401,
  TOTP_REQUIRED: 401,
  TOTP_INVALID: 401,
  INVITATION_EXPIRED: 410,
  INVITATION_ALREADY_ACCEPTED: 409,
  PASSWORD_TOO_WEAK: 400,
  EMPLOYEE_ALREADY_LINKED: 409,

  FORBIDDEN: 403,
  OUT_OF_SCOPE: 403,
  LAST_ROLES_MANAGE_HOLDER: 409,

  // 422 rather than 400 throughout the punch family: the request was
  // well-formed, and a policy refused it. The web client needs that
  // distinction to decide between "fix your input" and "here is why".
  PUNCH_OUT_OF_ORDER: 409,
  PUNCH_OUTSIDE_WINDOW: 422,
  PUNCH_OUTSIDE_GEOFENCE: 422,
  PUNCH_LOCATION_REQUIRED: 422,
  PUNCH_GEOFENCE_NOT_CONFIGURED: 422,
  PUNCH_MOCK_LOCATION: 422,
  PUNCH_IP_NOT_ALLOWED: 403,
  PUNCH_REASON_REQUIRED: 422,
  PUNCH_PHOTO_REQUIRED: 422,
  PUNCH_PHOTO_INVALID: 422,
  PUNCH_DEVICE_NOT_BOUND: 403,
  PUNCH_EMPLOYEE_INACTIVE: 403,
  PUNCH_QUEUED_TOO_OLD: 422,
  CONSENT_REQUIRED: 422,

  PERIOD_LOCKED: 409,
  PERIOD_ALREADY_LOCKED: 409,
  PERIOD_NOT_LOCKED: 409,
  OVERRIDE_REASON_REQUIRED: 422,

  LEAVE_INSUFFICIENT_BALANCE: 422,
  LEAVE_NEGATIVE_LIMIT_EXCEEDED: 422,
  LEAVE_OVERLAPS_EXISTING: 409,
  LEAVE_NOTICE_PERIOD: 422,
  LEAVE_ATTACHMENT_REQUIRED: 422,

  APPROVER_IS_REQUESTER: 403,
  APPROVAL_ALREADY_ACTIONED: 409,

  EMPLOYEE_CODE_IMMUTABLE: 422,
  REPORTING_CYCLE: 422,
  SHIFT_ASSIGNMENT_OVERLAP: 409,

  RECORD_IN_USE: 409,
  SYSTEM_ROLE_PROTECTED: 403,
  RECORD_NOT_DELETED: 409,

  RECORD_IS_APPEND_ONLY: 409,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export interface AppErrorOptions {
  /** Machine-readable context for the client. Never put a secret in here. */
  details?: Record<string, unknown>;
  /** Preserved for the log; never serialised into the response. */
  cause?: unknown;
  /** Overrides the table above. Needed almost never. */
  status?: number;
}

/**
 * The only error type application code should throw deliberately. Anything
 * else reaching the filter is treated as a bug and reported as INTERNAL_ERROR
 * with its message withheld.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
  }

  static notFound(entity: string, id?: string): AppError {
    return new AppError(ERROR_CODES.NOT_FOUND, `${entity} not found.`, {
      details: id === undefined ? { entity } : { entity, id },
    });
  }

  static forbidden(message = 'You do not have permission to do that.'): AppError {
    return new AppError(ERROR_CODES.FORBIDDEN, message);
  }

  static conflict(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ERROR_CODES.CONFLICT, message, details ? { details } : {});
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ERROR_CODES.VALIDATION_FAILED, message, details ? { details } : {});
  }
}

/**
 * A human-readable one-liner for anything that was thrown, including the parts
 * a plain `.message` leaves out.
 *
 * Two shapes make `.message` alone misleading, and both turn up on the paths
 * this codebase cares most about:
 *
 * - Node reports a failed TCP connect as an `AggregateError` -- one attempt per
 *   resolved address -- whose own message is the empty string, with the reason
 *   only in `errors`. A readiness check that reads `.message` reports "" for
 *   "connection refused".
 * - Drizzle wraps a driver failure in an error whose message is the SQL, and
 *   puts the actual database error in `cause`. Without following the chain, a
 *   dead database reads as "Failed query: select 1".
 */
export function describeError(value: unknown, depth = 0): string {
  // Guards against a cause chain that loops back on itself.
  const MAX_DEPTH = 4;
  if (depth > MAX_DEPTH) return '...';

  if (value instanceof AggregateError) {
    const inner = (value.errors as unknown[])
      .map((item) => describeError(item, depth + 1))
      .filter((part) => part.length > 0);
    const summary = inner.length > 0 ? inner.join('; ') : 'no further detail';
    return collapse(value.message.length > 0 ? `${value.message}: ${summary}` : summary);
  }

  if (value instanceof Error) {
    const head = value.message.length > 0 ? value.message : value.name;
    if (value.cause === undefined || value.cause === null) return collapse(head);
    const tail = describeError(value.cause, depth + 1);
    return collapse(tail.length === 0 || head.includes(tail) ? head : `${head}: ${tail}`);
  }

  return collapse(String(value));
}

/** Keeps a multi-line driver message readable on one log line. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Builds the §6 envelope. The single place a response body is shaped. */
export function toErrorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  const error: ApiErrorBody['error'] = { code, message, requestId };
  if (details !== undefined) error.details = details;
  return { error };
}
