import { z } from 'zod';

import {
  ATTENDANCE_FLAGS,
  ATTENDANCE_STATUSES,
  HALF_DAY_PARTS,
  PUNCH_TYPES,
  PUNCH_FLAG_REVIEW_ACTIONS,
  type AttendanceFlag,
  type AttendanceStatus,
  type HalfDayPart,
  type PunchSource,
  type PunchType,
  type PunchFlagReviewAction,
} from './enums.js';
import type { ErrorCode } from './errors.js';
import { calendarDateSchema } from './holidays.js';
import { cursorQuerySchema, pageQuerySchema } from './pagination.js';
import type { NamedRef } from './people.js';
import { PERMISSIONS, type PermissionKey } from './permissions.js';

/**
 * The punch and attendance-day contract (REQ-D-01 … REQ-D-13, REQ-E-01 …
 * REQ-E-05).
 *
 * Here rather than in the API for the reason the employee contract gives: the
 * server parses requests with these schemas and the web client builds its
 * screens against the same types, so the two cannot drift into a field one end
 * sends and the other silently discards.
 */

// ---------------------------------------------------------------- flags

/**
 * What a *punch* recorded about itself, as opposed to what the day derived
 * (`ATTENDANCE_FLAGS`, REQ-E-04).
 *
 * The two vocabularies overlap but are not the same list, and merging them
 * would be wrong in both directions: `late` is a property of a day and not of
 * a punch, while `no_location` and `low_gps_accuracy` (REQ-D-08, REQ-D-08a)
 * are properties of one reading that the day has no way to re-derive.
 *
 * `geofence_disabled` and `ip_allowlist_disabled` exist because the office
 * coordinates and the office addresses are still unanswered (docs
 * OPEN-QUESTIONS items 1 and 3). A punch taken while a control is unconfigured
 * must not be indistinguishable from one that passed the control — the flag is
 * what keeps "we could not check" from reading as "we checked and it was fine".
 */
export const PUNCH_FLAGS = [
  'outside_window',
  'outside_geofence',
  'low_gps_accuracy',
  'no_location',
  'geofence_disabled',
  'ip_allowlist_disabled',
  'field_staff_exempt',
  'device_mismatch',
  'clock_skew',
  'offline_sync',
  /**
   * REQ-D-10 against REQ-D-05: the instant this punch was judged on came from
   * the queue rather than from the server's clock.
   *
   * Only a queued punch can carry it. A whole shift drained in one request is
   * received in one instant, so a day computed from the moment of arrival is a
   * day of zero length; the punch is therefore attributed to the time the
   * device recorded, clamped so it can neither be in the future nor older than
   * the queue's own 48-hour limit. This flag is what keeps that from being
   * silent -- a reader of the muster or the audit trail can see that the
   * server did not witness this time, it was told it.
   */
  'derived_time',
] as const;

export type PunchFlag = (typeof PUNCH_FLAGS)[number];

// ----------------------------------------------------------- submission

/** REQ-D-11: client-generated, and the same key must never create two punches. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u, 'may contain letters, digits, dot, underscore, colon and hyphen');

/** REQ-D-06 and REQ-D-08a both make a typed reason the price of an exception. */
const reasonField = z.string().trim().min(3).max(500);

/**
 * Everything a client asserts about a punch except which channel it arrived
 * through. Split out so the offline queue (REQ-D-10) reuses it without being
 * able to claim `source`, which the server decides.
 */
const punchFactsShape = {
  type: z.enum(PUNCH_TYPES),
  /**
   * REQ-D-04: recorded as evidence. REQ-D-05: never used for a policy
   * decision, and a difference over five minutes flags the punch.
   */
  clientTime: z.iso.datetime({ offset: true }),

  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  /** Metres of horizontal uncertainty, as the device reports it. */
  gpsAccuracyM: z.number().nonnegative().max(100_000).nullish(),
  /** REQ-D-08: Android `isFromMockProvider`, or an iOS plausibility failure. */
  isMockLocation: z.boolean().default(false),

  /** REQ-D-07: chosen at the moment of punching, and only on the IN. */
  isHalfDay: z.boolean().default(false),
  halfDayPart: z.enum(HALF_DAY_PARTS).nullish(),

  reason: reasonField.nullish(),
  deviceFingerprint: z.string().trim().min(8).max(128).nullish(),
  appVersion: z.string().trim().max(40).nullish(),

  /**
   * REQ-M-03: the tick on the photo-and-location notice, travelling with the
   * punch so an offline first punch carries its acceptance to sync time. The
   * server ignores it once an acceptance row exists; without one it either
   * records the acceptance with the punch (true) or refuses the punch with
   * CONSENT_REQUIRED (false). Defaulted rather than required so a queue
   * written by an older build still parses -- its entries simply carry no
   * assertion, which is the honest reading of them.
   */
  consentAccepted: z.boolean().default(false),
} as const;

/**
 * Shape rules only. Whether a reason is *required* depends on the org's window
 * behaviour and on where the employee was standing, neither of which a schema
 * can see — the server decides that and answers PUNCH_REASON_REQUIRED.
 */
function checkPunchFacts(
  value: {
    type: PunchType;
    latitude?: number | null | undefined;
    longitude?: number | null | undefined;
    isHalfDay: boolean;
    halfDayPart?: HalfDayPart | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const hasLatitude = value.latitude !== null && value.latitude !== undefined;
  const hasLongitude = value.longitude !== null && value.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    ctx.addIssue({
      code: 'custom',
      path: [hasLatitude ? 'longitude' : 'latitude'],
      message: 'latitude and longitude must be sent together',
    });
  }

  // REQ-D-07 puts the choice on the IN punch. Accepting it on an OUT would let
  // the same day be marked half on the way out and full on the way in.
  if (value.isHalfDay && value.type !== 'IN') {
    ctx.addIssue({
      code: 'custom',
      path: ['isHalfDay'],
      message: 'a half day is chosen on the IN punch, not the OUT',
    });
  }

  const hasPart = value.halfDayPart !== null && value.halfDayPart !== undefined;
  if (hasPart && !value.isHalfDay) {
    ctx.addIssue({
      code: 'custom',
      path: ['halfDayPart'],
      message: 'only meaningful when isHalfDay is true',
    });
  }
  if (value.isHalfDay && !hasPart) {
    ctx.addIssue({
      code: 'custom',
      path: ['halfDayPart'],
      message: 'required when isHalfDay is true',
    });
  }
}

/**
 * The JSON half of the `POST /punches` multipart body. The photo is the other
 * half and is mandatory (REQ-D-02); there is no field here that could stand in
 * for it.
 */
export const punchSubmissionSchema = z
  .object({
    ...punchFactsShape,
    /** `OFFLINE_SYNC` is not offerable: only `POST /punches/sync` produces it. */
    source: z.enum(['WEB', 'MOBILE']),
  })
  .superRefine(checkPunchFacts);

export type PunchSubmission = z.infer<typeof punchSubmissionSchema>;

/** Technical design §8: one queued punch, carrying its own key and its photo. */
export const punchSyncItemSchema = z
  .object({
    ...punchFactsShape,
    idempotencyKey: idempotencyKeySchema,
    /**
     * Which file in the `photos` part belongs to this entry. An index rather
     * than a field name because multipart preserves order but not pairing, and
     * a mismatched pairing would attach one employee's photograph to another
     * employee's punch.
     */
    photoIndex: z.number().int().min(0),
    /**
     * The account that queued the punch, stamped when it was queued. The
     * server records against the signed-in principal regardless; this lets
     * it refuse a row queued by somebody else on a shared browser rather than
     * file their photograph under this person's name (C-01).
     */
    ownerUserId: z.uuid().optional(),
  })
  .superRefine(checkPunchFacts);

export type PunchSyncItem = z.infer<typeof punchSyncItemSchema>;

/**
 * Bounded so one drain cannot hold a connection open re-encoding two hundred
 * photographs. A longer queue drains over several requests.
 */
export const MAX_OFFLINE_SYNC_BATCH = 25;

export const punchSyncSchema = z.object({
  punches: z.array(punchSyncItemSchema).min(1).max(MAX_OFFLINE_SYNC_BATCH),
});

export type PunchSyncRequest = z.infer<typeof punchSyncSchema>;

/**
 * Technical design §8: "reject queued punches older than 48 hours; they must
 * go through regularization instead."
 */
export const OFFLINE_SYNC_MAX_AGE_HOURS = 48;

/** REQ-D-05: "If client and server time differ by more than 5 minutes." */
export const CLOCK_SKEW_FLAG_SECONDS = 300;

// -------------------------------------------------------------- read models

export interface PunchPhotoRef {
  readonly fileId: string;
  /** REQ-D-03a: lists and tables load this one, never the full image. */
  readonly thumbnailFileId: string;
}

export interface PunchLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM: number | null;
  /** Null when no geofence centre is configured, so nothing was measured. */
  readonly distanceFromGeofenceM: number | null;
}

export interface PunchRecord {
  readonly id: string;
  readonly employee: NamedRef;
  readonly employeeCode: string;
  /** REQ-C-02: the shift start date, which a night shift's OUT does not share. */
  readonly attendanceDate: string;
  readonly type: PunchType;
  /** Authoritative (REQ-D-05). ISO-8601 instant. */
  readonly serverTime: string;
  readonly clientTime: string | null;
  readonly clockSkewSeconds: number | null;
  /** REQ-D-10: how long the punch sat in the offline queue. */
  readonly syncDelaySeconds: number | null;
  readonly source: PunchSource;
  /** Null only for an ADMIN_ENTRY: an admin's record carries no photograph. */
  readonly photo: PunchPhotoRef | null;
  readonly location: PunchLocation | null;
  /** Owner, 21 Aug 2026: the admin who recorded an ADMIN_ENTRY; null otherwise. */
  readonly recordedBy: NamedRef | null;
  readonly isHalfDayMarked: boolean;
  readonly halfDayPart: HalfDayPart | null;
  readonly reason: string | null;
  readonly flags: readonly PunchFlag[];
  /** The admin's last decisive word on this punch's flags; null while unreviewed. */
  readonly flagReview: PunchFlagReview | null;
}

/** Owner, 21 Aug 2026: an admin's action on a flagged punch, taken from Approvals. */
export interface PunchFlagReview {
  readonly action: PunchFlagReviewAction;
  readonly note: string | null;
  readonly decidedBy: NamedRef | null;
  readonly decidedAt: string;
}

export const PUNCH_FLAG_REVIEW_LABELS: Record<PunchFlagReviewAction, string> = {
  ACCEPT: 'Accepted',
  KEEP: 'Kept flagged',
  HALF_DAY: 'Marked half day',
  NOTE: 'Note added',
};

/**
 * Owner, 21 Aug 2026: an admin records an IN or OUT for an employee (or for
 * themselves). A separate event beside the employee's own punches, never a
 * replacement; the reason is what the audit trail and the day record show.
 */
export const adminPunchSchema = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(PUNCH_TYPES),
  /** The instant the punch counts at. ISO-8601. */
  at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(10, 'a reason of at least 10 characters is required').max(500),
});
export type AdminPunchInput = z.infer<typeof adminPunchSchema>;

export const punchFlagReviewSchema = z
  .object({
    action: z.enum(PUNCH_FLAG_REVIEW_ACTIONS),
    note: z.string().trim().min(10, 'a note of at least 10 characters is required').max(500).optional(),
    halfDayPart: z.enum(HALF_DAY_PARTS).optional(),
  })
  .superRefine((value, ctx) => {
    // Keeping a flag and adding a note both say something to the employee;
    // an empty message is not a decision anyone can read later.
    if ((value.action === 'KEEP' || value.action === 'NOTE') && value.note === undefined) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'a note is required for this action' });
    }
    if (value.action === 'HALF_DAY' && value.halfDayPart === undefined) {
      ctx.addIssue({ code: 'custom', path: ['halfDayPart'], message: 'say which half of the day counts' });
    }
  });
export type PunchFlagReviewInput = z.infer<typeof punchFlagReviewSchema>;

export interface AttendanceDaySummary {
  readonly id: string;
  readonly employee: NamedRef;
  readonly employeeCode: string;
  readonly date: string;
  readonly status: AttendanceStatus;
  readonly shift: NamedRef | null;
  readonly scheduledIn: string | null;
  readonly scheduledOut: string | null;
  readonly firstInAt: string | null;
  readonly lastOutAt: string | null;
  readonly workedMinutes: number;
  readonly breakMinutes: number;
  /**
   * REQ-E-05, and the one field on this row that is not sent to everybody.
   *
   * Absent — not zero — for a viewer who may see only their own attendance.
   * Optional rather than nullable because absence is the honest wire shape:
   * `null` would still be a value the row carries, and a client reading it as
   * "no overtime" would be wrong in exactly the case that matters. See
   * `canViewOvertime`; the server omits the key, so hiding it in the client is
   * a courtesy rather than the control.
   */
  readonly otMinutes?: number;
  readonly lateMinutes: number;
  readonly earlyExitMinutes: number;
  /** Owner, 21 Aug 2026: minutes before shift start the first IN landed; 0 when not early or absent. */
  readonly earlyArrivalMinutes: number;
  /** True when the first IN beat shift start by the configured threshold on a working day. */
  readonly earlyArrival: boolean;
  /** Consecutive early working days up to and including this one; non-working days carry it forward. */
  readonly earlyStreak: number;
  readonly flags: readonly AttendanceFlag[];
  /** REQ-E-08: HR set this status by hand, and it survives recomputation. */
  readonly isManualOverride: boolean;
  readonly locked: boolean;
}

export interface AttendanceDayDetail extends AttendanceDaySummary {
  readonly punches: readonly PunchRecord[];
}

/**
 * Who may see `otMinutes` on an attendance day.
 *
 * No new permission key: overtime is a management figure, and the keys that
 * already say "you are looking at this as a manager rather than as the person
 * it is about" are the two breadth keys. An account holding only
 * `attendance.view.self` sees its own hours and not its own overtime.
 *
 * The consequence worth stating plainly, because it looks like a bug and is
 * not: a manager holds the team key, so a manager sees overtime on every row
 * they can see -- including their own.
 *
 * Here rather than in either app so the server's omission and the client's
 * hidden column are one rule. The server is the control; the client reads the
 * same predicate only to avoid rendering a column that will always be empty.
 */
export const OVERTIME_VIEW_PERMISSIONS = [
  PERMISSIONS.ATTENDANCE_VIEW_TEAM,
  PERMISSIONS.ATTENDANCE_VIEW_ALL,
] as const satisfies readonly PermissionKey[];

export function canViewOvertime(permissions: ReadonlySet<PermissionKey>): boolean {
  return OVERTIME_VIEW_PERMISSIONS.some((key) => permissions.has(key));
}

/** REQ-D-11: a replayed key returns the original punch rather than a new one. */
export interface PunchReceipt {
  readonly punch: PunchRecord;
  /**
   * Technical design §5: the day engine runs inline on punch creation "so the
   * employee sees immediate status". Null when the period is locked
   * (REQ-E-09), because then nothing was recomputed.
   */
  readonly day: AttendanceDaySummary | null;
  readonly replayed: boolean;
}

export type PunchSyncOutcome = 'created' | 'replayed' | 'rejected';

export interface PunchSyncResult {
  readonly idempotencyKey: string;
  readonly outcome: PunchSyncOutcome;
  readonly punch: PunchRecord | null;
  /** Populated only for `rejected`; the code is the contract, not the message. */
  readonly error: { readonly code: ErrorCode; readonly message: string } | null;
}

export interface PunchSyncReport {
  readonly results: readonly PunchSyncResult[];
  readonly created: number;
  readonly replayed: number;
  readonly rejected: number;
}

export interface PunchWindowView {
  readonly opensAt: string;
  readonly closesAt: string;
  readonly isOpenNow: boolean;
}

/**
 * REQ-D-13: everything the punch screen has to show *before* anyone punches —
 * server time, today's shift and window, the current status, and the last
 * punch.
 *
 * The geofence centre is deliberately absent. A client that knows the exact
 * coordinates it must appear to be standing on is a client that can be lied to
 * with three lines of JavaScript, and the check is server-side anyway
 * (REQ-D-08). The radius and whether a centre exists at all are enough to
 * render an honest message.
 */
export interface PunchContext {
  readonly serverTime: string;
  readonly timezone: string;
  readonly attendanceDate: string;
  readonly employee: {
    readonly id: string;
    readonly name: string;
    readonly employeeCode: string;
    readonly isFieldStaff: boolean;
  } | null;
  readonly canPunch: boolean;
  /** REQ-D-01: what the next punch must be, given what is already recorded. */
  readonly nextPunchType: PunchType | null;
  readonly shift: {
    readonly id: string;
    readonly name: string;
    readonly code: string;
    readonly scheduledIn: string;
    readonly scheduledOut: string;
    readonly breakMinutes: number;
    readonly inWindow: PunchWindowView;
    readonly outWindow: PunchWindowView;
  } | null;
  readonly photoRequired: true;
  readonly geofence: {
    readonly enforced: boolean;
    readonly radiusM: number;
    /** REQ-D-08: field staff are exempt and are told so. */
    readonly exempt: boolean;
  };
  readonly ipAllowlist: {
    readonly enforced: boolean;
    readonly allowed: boolean;
  };
  readonly lastPunch: PunchRecord | null;
  readonly day: AttendanceDaySummary | null;
  /**
   * REQ-M-03: whether this account has accepted the punch-capture consent
   * notice ('attendance.punch_capture'). The screen shows the notice until
   * this is true, and `POST /me/consent` is how it becomes true.
   */
  readonly consentAccepted: boolean;
  /**
   * REQ-L-03 / REQ-M-03: how many months a punch photo is kept, from the
   * organisation's retention setting. The consent notice quotes this, and it
   * is server-sent so the notice can never promise a number nothing enforces.
   */
  readonly photoRetentionMonths: number;
  /** Set when punching is impossible right now, whatever the employee does. */
  readonly blockedReason: { readonly code: ErrorCode; readonly message: string } | null;
}

export interface SignedPhotoUrl {
  readonly url: string;
  readonly expiresInSeconds: number;
}

// ------------------------------------------------------------------ queries

/** Technical design §6: cursor pagination for the punch feed. */
export const punchFeedQuerySchema = cursorQuerySchema.extend({
  employeeId: z.uuid().optional(),
  date: z.iso.date().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export type PunchFeedQuery = z.infer<typeof punchFeedQuerySchema>;

export const PHOTO_VARIANTS = ['full', 'thumbnail'] as const;
export type PhotoVariant = (typeof PHOTO_VARIANTS)[number];

export const punchPhotoQuerySchema = z.object({
  variant: z.enum(PHOTO_VARIANTS).default('thumbnail'),
});

export type PunchPhotoQuery = z.infer<typeof punchPhotoQuerySchema>;

export const ATTENDANCE_DAY_SORT_FIELDS = [
  'date',
  'employeeCode',
  'status',
  'workedMinutes',
] as const;

export type AttendanceDaySortField = (typeof ATTENDANCE_DAY_SORT_FIELDS)[number];

export const DEFAULT_ATTENDANCE_DAY_SORT = '-date,employeeCode';

export const attendanceDayQuerySchema = pageQuerySchema.extend({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  employeeId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  /** Comma-separated `ATTENDANCE_FLAGS`; a day matching any of them is kept. */
  flags: z.string().max(200).optional(),
  sort: z.string().max(200).optional(),
});

export type AttendanceDayQuery = z.infer<typeof attendanceDayQuerySchema>;

/**
 * Unknown names are dropped rather than rejected, matching `parseSort`: a
 * filter the server does not understand must narrow nothing, and a 400 for a
 * stale bookmark helps nobody.
 */
export function parseAttendanceFlags(input: string | undefined): AttendanceFlag[] {
  if (input === undefined) return [];
  const known = new Set<string>(ATTENDANCE_FLAGS);
  const chosen = new Set<AttendanceFlag>();
  for (const raw of input.split(',')) {
    const token = raw.trim();
    if (known.has(token)) chosen.add(token as AttendanceFlag);
  }
  return ATTENDANCE_FLAGS.filter((flag) => chosen.has(flag));
}




/**
 * REQ-E-02, backfill: run the nightly absent sweep over dates that have
 * already passed.
 *
 * The sweep itself has run every night since Phase 2; what did not exist was
 * a way to run it over history, so days from before it shipped -- or from any
 * night the worker was down -- are blank rather than ABSENT.
 *
 * The range is capped because this enqueues one job per date and somebody
 * typing 2020 by accident should get an error rather than eighteen hundred
 * jobs. A longer history is two runs, which is a small price for not being
 * able to do that by mistyping.
 */
export const MAX_ABSENT_BACKFILL_DAYS = 400;

export const markAbsentBackfillSchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
  })
  .refine((value) => value.from <= value.to, {
    message: 'The start of the range must not be after its end.',
    path: ['from'],
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <
      MAX_ABSENT_BACKFILL_DAYS,
    { message: `A backfill covers at most ${String(MAX_ABSENT_BACKFILL_DAYS)} days at a time.`, path: ['to'] },
  );

export type MarkAbsentBackfill = z.infer<typeof markAbsentBackfillSchema>;

/**
 * Every date in the range, inclusive, as `YYYY-MM-DD`.
 *
 * Shared rather than inlined in the controller so it can be tested without a
 * queue behind it: an earlier attempt exercised the expansion through the real
 * endpoint, which enqueued real sweeps, which the test suite's own workers
 * then ran against every organisation in the database. The expansion is the
 * only thing here worth asserting, and it is arithmetic.
 *
 * UTC throughout: these are calendar dates, not instants, and stepping them in
 * local time puts a day either side of a DST change an hour out.
 */
export function backfillDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86_400_000) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

export interface MarkAbsentBackfillResult {
  /** How many dates were queued; the sweep decides what each one writes. */
  readonly dates: number;
  readonly from: string;
  readonly to: string;
}
