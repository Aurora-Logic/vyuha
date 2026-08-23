import {
  ERROR_CODES,
  type EmployeeStatus,
  type HalfDayPart,
  PUNCH_FLAG_REVIEW_ACTIONS,
  type PunchFlag,
  type PunchFlagReview,
  type PunchRecord,
  type PunchSource,
  type PunchType,
  employeeDisplayName,
} from '@vyuha/shared';
import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';

import { AppError, describeError } from '../../../platform/common/errors.js';
import type { Database } from '../../../platform/db/db.provider.js';
import { devices, employees, locations, organizations, settings } from '../../../platform/db/schema/index.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { punches, shifts } from '../schema/index.js';
import { resolvePunchSettings, type PunchSettings } from './punch-settings.js';

/**
 * Everything the punch endpoints read and the single row they write.
 *
 * `ScopedRepository` is not the base class for the same reason the day engine
 * gives: `punches` carries no soft-delete columns (REQ-D-12), so it does not
 * satisfy `ScopedTable` at all. The rule that base class enforces still holds
 * here -- every statement starts from `orgScoped`, which cannot be called
 * without an org predicate -- and `punch.schema.ts` already names this file as
 * the one place that filters `org_id` by hand.
 */

/**
 * The `punches` columns plus the employee the row is about.
 *
 * Exported, with `PunchRow` and `toPunchRecord`, so the punch audit report can
 * page the same table without a second copy of the mapping. `composeFlags` is
 * the reason that matters: it reassembles a verdict from three storage
 * locations, and a report that reimplemented it would silently disagree with
 * the feed about which punches are flagged.
 */
export const PUNCH_COLUMNS = {
  id: punches.id,
  employeeId: punches.employeeId,
  employeeCode: employees.employeeCode,
  employeeFirstName: employees.firstName,
  employeeLastName: employees.lastName,
  attendanceDate: punches.attendanceDate,
  punchType: punches.punchType,
  serverTime: punches.serverTime,
  clientTime: punches.clientTime,
  clockSkewSeconds: punches.clockSkewSeconds,
  syncDelaySeconds: punches.syncDelaySeconds,
  source: punches.source,
  photoFileId: punches.photoFileId,
  thumbnailFileId: punches.thumbnailFileId,
  latitude: punches.latitude,
  longitude: punches.longitude,
  gpsAccuracyM: punches.gpsAccuracyM,
  distanceFromGeofenceM: punches.distanceFromGeofenceM,
  isHalfDayMarked: punches.isHalfDayMarked,
  halfDayPart: punches.halfDayPart,
  outsideWindow: punches.outsideWindow,
  outsideGeofence: punches.outsideGeofence,
  deviceMismatch: punches.deviceMismatch,
  reason: punches.reason,
  flags: punches.flags,
  recordedByUserId: punches.recordedByUserId,
  // Each correlated read names the punch's own org_id as well as its id. The
  // id alone would be enough today, because it came from a scoped read -- but
  // that is an argument about the caller, and these subqueries are written
  // once and read by everyone. Naming org_id makes each of them true on its
  // own terms.
  recordedByName: sql<string | null>`(select trim(concat(e.first_name, ' ', coalesce(e.last_name, ''))) from users u left join employees e on e.id = u.employee_id and e.org_id = ${punches.orgId} where u.id = ${punches.recordedByUserId} and u.org_id = ${punches.orgId})`,
  // The latest decisive review (a NOTE decides nothing), three correlated
  // reads per row; a page of punches is fifty rows, not fifty thousand.
  reviewAction: sql<string | null>`(select r.action::text from punch_flag_reviews r where r.punch_id = ${punches.id} and r.org_id = ${punches.orgId} and r.action <> 'NOTE' order by r.created_at desc limit 1)`,
  reviewNote: sql<string | null>`(select r.note from punch_flag_reviews r where r.punch_id = ${punches.id} and r.org_id = ${punches.orgId} and r.action <> 'NOTE' order by r.created_at desc limit 1)`,
  reviewAt: sql<Date | null>`(select r.created_at from punch_flag_reviews r where r.punch_id = ${punches.id} and r.org_id = ${punches.orgId} and r.action <> 'NOTE' order by r.created_at desc limit 1)`,
  reviewByName: sql<string | null>`(select trim(concat(e.first_name, ' ', coalesce(e.last_name, ''))) from punch_flag_reviews r join users u on u.id = r.decided_by and u.org_id = ${punches.orgId} left join employees e on e.id = u.employee_id and e.org_id = ${punches.orgId} where r.punch_id = ${punches.id} and r.org_id = ${punches.orgId} and r.action <> 'NOTE' order by r.created_at desc limit 1)`,
  reviewById: sql<string | null>`(select r.decided_by from punch_flag_reviews r where r.punch_id = ${punches.id} and r.org_id = ${punches.orgId} and r.action <> 'NOTE' order by r.created_at desc limit 1)`,
} as const;

export interface PunchRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeFirstName: string;
  employeeLastName: string | null;
  attendanceDate: string;
  punchType: PunchType;
  serverTime: Date;
  clientTime: Date | null;
  clockSkewSeconds: number | null;
  syncDelaySeconds: number | null;
  source: PunchSource;
  photoFileId: string | null;
  thumbnailFileId: string | null;
  latitude: number | null;
  longitude: number | null;
  gpsAccuracyM: number | null;
  distanceFromGeofenceM: number | null;
  isHalfDayMarked: boolean;
  halfDayPart: HalfDayPart | null;
  outsideWindow: boolean;
  outsideGeofence: boolean;
  deviceMismatch: boolean;
  reason: string | null;
  flags: PunchFlag[];
  recordedByUserId: string | null;
  recordedByName: string | null;
  reviewAction: string | null;
  reviewNote: string | null;
  reviewAt: Date | string | null;
  reviewByName: string | null;
  reviewById: string | null;
}

/**
 * The complete flag list the API serves, assembled from the three places a
 * punch verdict is stored.
 *
 * `punch.schema.ts` explains the split: the day engine reads
 * `outside_window`, `outside_geofence` and `device_mismatch` as typed
 * booleans, `source` already says whether a punch came off the offline queue,
 * and the rest live in the array. A reader of the API should not have to know
 * any of that, so the seam is closed here, once.
 */
function composeFlags(row: PunchRow): PunchFlag[] {
  const present = new Set<PunchFlag>(row.flags);
  if (row.outsideWindow) present.add('outside_window');
  if (row.outsideGeofence) present.add('outside_geofence');
  if (row.deviceMismatch) present.add('device_mismatch');
  if (row.source === 'OFFLINE_SYNC') present.add('offline_sync');
  // Canonical order, so two reads of the same row cannot differ by arrangement.
  return PUNCH_FLAG_ORDER.filter((flag) => present.has(flag));
}

const PUNCH_FLAG_ORDER: readonly PunchFlag[] = [
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
  'derived_time',
];

export function toPunchRecord(row: PunchRow): PunchRecord {
  return {
    id: row.id,
    employee: {
      id: row.employeeId,
      name: employeeDisplayName(row.employeeFirstName, row.employeeLastName),
    },
    employeeCode: row.employeeCode,
    attendanceDate: row.attendanceDate,
    type: row.punchType,
    serverTime: row.serverTime.toISOString(),
    clientTime: row.clientTime === null ? null : row.clientTime.toISOString(),
    clockSkewSeconds: row.clockSkewSeconds,
    syncDelaySeconds: row.syncDelaySeconds,
    source: row.source,
    photo:
      row.photoFileId === null || row.thumbnailFileId === null
        ? null
        : { fileId: row.photoFileId, thumbnailFileId: row.thumbnailFileId },
    recordedBy:
      row.recordedByUserId === null
        ? null
        : { id: row.recordedByUserId, name: row.recordedByName === null || row.recordedByName === '' ? 'Administrator' : row.recordedByName },
    location:
      row.latitude === null || row.longitude === null
        ? null
        : {
            latitude: row.latitude,
            longitude: row.longitude,
            accuracyM: row.gpsAccuracyM,
            distanceFromGeofenceM: row.distanceFromGeofenceM,
          },
    isHalfDayMarked: row.isHalfDayMarked,
    halfDayPart: row.halfDayPart,
    reason: row.reason,
    flags: composeFlags(row),
    flagReview: flagReviewOf(row),
  };
}

function flagReviewOf(row: PunchRow): PunchFlagReview | null {
  if (row.reviewAction === null || row.reviewAt === null) return null;
  const action = PUNCH_FLAG_REVIEW_ACTIONS.find((candidate) => candidate === row.reviewAction);
  if (action === undefined) return null;
  const at = row.reviewAt instanceof Date ? row.reviewAt : new Date(row.reviewAt);
  return {
    action,
    note: row.reviewNote,
    decidedBy:
      row.reviewById === null ? null : { id: row.reviewById, name: row.reviewByName === null || row.reviewByName === '' ? 'Administrator' : row.reviewByName },
    decidedAt: at.toISOString(),
  };
}

/** Who is punching, and everything the policy checks need about them. */
export interface PunchEmployee {
  readonly id: string;
  readonly employeeCode: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly status: EmployeeStatus;
  readonly dateOfLeaving: string | null;
  /** REQ-D-08: exempt from the geofence. */
  readonly isFieldStaff: boolean;
  readonly locationId: string | null;
  readonly defaultShiftId: string | null;
  readonly weeklyOffPatternId: string | null;
  readonly holidayCalendarId: string | null;
  readonly timezone: string;
  /** REQ-D-08: null until the office coordinates are supplied. */
  readonly geofenceLat: number | null;
  readonly geofenceLng: number | null;
  readonly geofenceRadiusM: number;
  /** REQ-D-09: empty until the office addresses are supplied. */
  readonly ipAllowlist: readonly string[];
}

export interface NewPunch {
  readonly employeeId: string;
  readonly attendanceDate: string;
  readonly punchType: PunchType;
  readonly serverTime: Date;
  /** Migration 0014: set only when the punch is judged at another instant. */
  readonly effectiveTime: Date | null;
  readonly clientTime: Date | null;
  readonly clockSkewSeconds: number | null;
  readonly syncDelaySeconds: number | null;
  readonly photoFileId: string | null;
  readonly thumbnailFileId: string | null;
  readonly recordedByUserId: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly gpsAccuracyM: number | null;
  readonly distanceFromGeofenceM: number | null;
  readonly ip: string | null;
  readonly deviceFingerprint: string | null;
  readonly source: PunchSource;
  readonly userAgent: string | null;
  readonly appVersion: string | null;
  readonly isHalfDayMarked: boolean;
  readonly halfDayPart: HalfDayPart | null;
  readonly outsideWindow: boolean;
  readonly outsideGeofence: boolean;
  readonly deviceMismatch: boolean;
  readonly reason: string | null;
  readonly flags: readonly PunchFlag[];
  readonly idempotencyKey: string;
}

export interface PunchFeedFilters {
  /** Resolved by `ScopeService`; never built here and never optional. */
  readonly scope: SQL;
  readonly employeeId?: string | undefined;
  readonly date?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Exclusive: rows strictly older than this point in the ordering. */
  readonly after?: { readonly serverTime: Date; readonly id: string } | undefined;
  readonly limit: number;
}

export interface DayPunchState {
  readonly date: string;
  readonly hasOpenIn: boolean;
  readonly lastType: PunchType | null;
}

/**
 * The `classid` half of the punch-ordering advisory lock.
 *
 * Two-argument `pg_advisory_xact_lock` splits one 64-bit lock space into a
 * namespace and a key, so the employee hash below can only ever collide with
 * another punch-ordering lock -- never with a lock some future feature takes
 * on the same database. The number itself is arbitrary and only has to stay
 * stable: changing it while a deployment is half upgraded would put the two
 * versions in different lock spaces, which is the one way this could silently
 * stop working.
 */
export const PUNCH_ORDERING_LOCK_NAMESPACE = 4001;

/**
 * How hard a punch tries for its employee's key before giving up, and how long
 * it waits between tries.
 *
 * Twelve attempts twenty-five milliseconds apart is about a third of a second,
 * which is an eternity next to the handful of indexed statements the lock
 * actually covers, and far short of anything a person would notice. The
 * numbers are a bound on *waiting*, not on the work: whoever holds the key is
 * inserting one row.
 */
const LOCK_ATTEMPTS = 12;
const LOCK_RETRY_MS = 25;

/**
 * What node-postgres says when the pool has no connection to give. Matched on
 * the text because `pg-pool` throws a plain `Error` with no code, and the
 * alternative is reporting a pool that is merely busy as a bug in the punch
 * path.
 */
const POOL_TIMEOUT_TEXT = 'timeout exceeded when trying to connect';

const busyError = (reason: string): AppError =>
  new AppError(
    ERROR_CODES.SERVICE_UNAVAILABLE,
    'That punch could not be recorded just now. It is safe to send it again.',
    { details: { retryable: true, reason } },
  );

/** Drizzle's transaction handle; the same idiom `AuthService` uses. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

type LockOutcome<T> = { readonly acquired: false } | { readonly acquired: true; readonly value: T };

export class PunchRepository {
  constructor(
    private readonly db: Database | Transaction,
    private readonly ctx: OrgContext,
  ) {}

  /** Mirrors `ScopedRepository.scoped()`; see the class comment for why. */
  private orgScoped(orgPredicate: SQL, ...extra: (SQL | undefined)[]): SQL {
    const predicate = and(orgPredicate, ...extra);
    if (predicate === undefined) {
      throw new Error('Scope predicate collapsed to undefined; refusing to run an unscoped query.');
    }
    return predicate;
  }

  private baseSelect() {
    return this.db
      .select(PUNCH_COLUMNS)
      .from(punches)
      .innerJoin(
        employees,
        and(
          eq(employees.id, punches.employeeId),
          eq(employees.orgId, this.ctx.orgId),
          isNull(employees.deletedAt),
        ),
      );
  }

  // ------------------------------------------------------------------ reads

  /**
   * The employee plus the premises rules that apply to them. One statement
   * rather than three because every punch needs all of it, and three round
   * trips on the hottest endpoint in the product is three chances to be slow.
   */
  async findPunchEmployee(employeeId: string): Promise<PunchEmployee | null> {
    const rows = await this.db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        firstName: employees.firstName,
        lastName: employees.lastName,
        status: employees.status,
        dateOfLeaving: employees.dateOfLeaving,
        isFieldStaff: employees.isFieldStaff,
        locationId: employees.locationId,
        defaultShiftId: employees.defaultShiftId,
        weeklyOffPatternId: employees.weeklyOffPatternId,
        holidayCalendarId: sql<
          string | null
        >`coalesce(${employees.holidayCalendarId}, ${locations.holidayCalendarId})`,
        timezone: sql<string>`coalesce(${locations.timezone}, ${organizations.timezone})`,
        geofenceLat: locations.geofenceLat,
        geofenceLng: locations.geofenceLng,
        geofenceRadiusM: sql<number>`coalesce(${locations.geofenceRadiusM}, 100)`,
        ipAllowlist: sql<string[]>`coalesce(${locations.ipAllowlist}, '{}'::text[])`,
      })
      .from(employees)
      .innerJoin(organizations, eq(organizations.id, employees.orgId))
      .leftJoin(locations, and(eq(locations.id, employees.locationId), isNull(locations.deletedAt)))
      .where(
        this.orgScoped(
          eq(employees.orgId, this.ctx.orgId),
          eq(employees.id, employeeId),
          isNull(employees.deletedAt),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /** REQ-D-11. The unique index is what actually enforces this; see `insert`. */
  async findByIdempotencyKey(employeeId: string, key: string): Promise<PunchRecord | null> {
    const rows = await this.baseSelect()
      .where(
        this.orgScoped(
          eq(punches.orgId, this.ctx.orgId),
          eq(punches.employeeId, employeeId),
          eq(punches.idempotencyKey, key),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toPunchRecord(row);
  }

  /**
   * REQ-D-01's "alternating and strictly ordered per attendance day", as the
   * state of each candidate date.
   *
   * `DISTINCT ON` rather than loading every punch: the ordering question only
   * needs the latest row per date, and a long day of punches should not be
   * read in full on every punch.
   */
  async punchStateFor(employeeId: string, dates: readonly string[]): Promise<DayPunchState[]> {
    if (dates.length === 0) return [];

    const rows = await this.db.execute<{ attendance_date: string; punch_type: PunchType }>(sql`
      SELECT DISTINCT ON (attendance_date) attendance_date, punch_type
        FROM punches
       WHERE org_id = ${this.ctx.orgId}
         AND employee_id = ${employeeId}
         AND attendance_date = ANY(${sql.param(dates)}::date[])
       ORDER BY attendance_date, server_time DESC, id DESC
    `);

    const latest = new Map(rows.rows.map((row) => [row.attendance_date, row.punch_type]));
    return dates.map((date) => {
      const lastType = latest.get(date) ?? null;
      return { date, hasOpenIn: lastType === 'IN', lastType };
    });
  }

  async findById(punchId: string, scope: SQL): Promise<PunchRecord | null> {
    const rows = await this.baseSelect()
      .where(this.orgScoped(eq(punches.orgId, this.ctx.orgId), eq(punches.id, punchId), scope))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toPunchRecord(row);
  }

  /** The punches of one attendance day, oldest first, for the day detail. */
  async findForDay(employeeId: string, date: string): Promise<PunchRecord[]> {
    const rows = await this.baseSelect()
      .where(
        this.orgScoped(
          eq(punches.orgId, this.ctx.orgId),
          eq(punches.employeeId, employeeId),
          eq(punches.attendanceDate, date),
        ),
      )
      .orderBy(asc(punches.serverTime), asc(punches.id));

    return rows.map(toPunchRecord);
  }

  /** The employee's most recent punch overall, for REQ-D-13's "last punch". */
  async findLatestFor(employeeId: string): Promise<PunchRecord | null> {
    const rows = await this.baseSelect()
      .where(
        this.orgScoped(eq(punches.orgId, this.ctx.orgId), eq(punches.employeeId, employeeId)),
      )
      .orderBy(desc(punches.serverTime), desc(punches.id))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toPunchRecord(row);
  }

  /**
   * The audit feed, newest first. One row more than asked for, so the caller
   * can tell "this is the last page" from "there is more" without a second
   * count query over a table that only grows.
   */
  async feed(filters: PunchFeedFilters): Promise<PunchRecord[]> {
    const predicates: (SQL | undefined)[] = [
      filters.scope,
      filters.employeeId === undefined ? undefined : eq(punches.employeeId, filters.employeeId),
      filters.date === undefined ? undefined : eq(punches.attendanceDate, filters.date),
      filters.from === undefined ? undefined : gte(punches.attendanceDate, filters.from),
      filters.to === undefined ? undefined : lte(punches.attendanceDate, filters.to),
    ];

    if (filters.after !== undefined) {
      // A row comparison rather than `server_time < cursor`: two punches can
      // share a millisecond -- a double tap produces exactly that -- and
      // comparing on time alone would silently drop one of them at a page
      // boundary. The casts are explicit because an untyped parameter on the
      // right of a row comparison is resolved by Postgres from the left, and
      // relying on that inference is how a cursor starts throwing after a
      // column type changes.
      predicates.push(
        sql`(${punches.serverTime}, ${punches.id}) < (${filters.after.serverTime}::timestamptz, ${filters.after.id}::uuid)`,
      );
    }

    const rows = await this.baseSelect()
      .where(this.orgScoped(eq(punches.orgId, this.ctx.orgId), ...predicates))
      .orderBy(desc(punches.serverTime), desc(punches.id))
      .limit(filters.limit);

    return rows.map(toPunchRecord);
  }

  /**
   * REQ-D-08a: "Repeated `no_location` punches by the same employee raise a
   * notification to HR." Counted over a window rather than for all time, so a
   * single bad week two years ago does not keep the alarm ringing.
   */
  async countFlagged(employeeId: string, flag: PunchFlag, sinceDate: string): Promise<number> {
    const rows = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(punches)
      .where(
        this.orgScoped(
          eq(punches.orgId, this.ctx.orgId),
          eq(punches.employeeId, employeeId),
          gte(punches.attendanceDate, sinceDate),
          sql`${punches.flags} @> ARRAY[${flag}]::text[]`,
        ),
      );

    return rows[0]?.value ?? 0;
  }

  /** Display name and code for a shift, for REQ-D-13's "today's shift". */
  async shiftLabel(shiftId: string): Promise<{ name: string; code: string } | null> {
    const rows = await this.db
      .select({ name: shifts.name, code: shifts.code })
      .from(shifts)
      .where(
        this.orgScoped(
          eq(shifts.orgId, this.ctx.orgId),
          eq(shifts.id, shiftId),
          isNull(shifts.deletedAt),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * REQ-B-08. Whether this employee has *any* enrolled device, and whether this
   * fingerprint is one of them.
   *
   * Both halves are needed because there is no enrolment path yet: with no
   * registered devices, every punch would otherwise be a "mismatch" and the
   * flag would mean nothing. An employee with no device on file is not
   * mismatched, they are simply not enrolled.
   */
  async deviceState(
    employeeId: string,
    fingerprint: string | null,
  ): Promise<{ enrolled: boolean; known: boolean }> {
    const rows = await this.db
      .select({
        fingerprint: devices.fingerprint,
      })
      .from(devices)
      .where(
        this.orgScoped(
          eq(devices.orgId, this.ctx.orgId),
          eq(devices.employeeId, employeeId),
          eq(devices.status, 'ACTIVE'),
          isNull(devices.deletedAt),
        ),
      );

    if (rows.length === 0) return { enrolled: false, known: false };
    return {
      enrolled: true,
      known: fingerprint !== null && rows.some((row) => row.fingerprint === fingerprint),
    };
  }

  /** REQ-L-02: punch policy lives in rows, so it changes without a deploy. */
  async readSettings(): Promise<PunchSettings> {
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        this.orgScoped(
          eq(settings.orgId, this.ctx.orgId),
          eq(settings.scope, 'ORG'),
          isNull(settings.scopeId),
          isNull(settings.deletedAt),
        ),
      );

    return resolvePunchSettings(new Map(rows.map((row) => [row.key, row.value])));
  }

  // ------------------------------------------------------------------ write

  /**
   * Runs `work` in a transaction holding this employee's punch-ordering lock.
   *
   * REQ-D-01 says punches alternate per attendance day, and "does an IN stand
   * open?" is a question about the *latest* row for a day. Reading it, deciding
   * on it, and then inserting is a read-modify-write, and it was neither atomic
   * nor guarded: two requests arriving together both read "nothing open" and
   * both wrote an IN. The idempotency index cannot catch that -- the keys
   * genuinely differ -- and the append-only trigger will not either, because
   * both statements are inserts and both are legal on their own.
   *
   * A partial unique index was the first thing considered and does not work:
   * an index predicate can only see the columns of the row being written, and
   * "an IN is open" is a property of the ordering of every row for that day.
   * There is no expression over one `punches` row that evaluates to it, and
   * `punches` has no state column to maintain because REQ-D-12 forbids the
   * UPDATE that would maintain it. An EXCLUDE constraint founders on the same
   * point. `SELECT ... FOR UPDATE` on the employee row would work, but it puts
   * a lock on master data in the hottest path in the product, so an HR edit
   * and a punch would start blocking each other for no reason either of them
   * could see.
   *
   * So: an advisory lock, keyed on the employee, held for the transaction
   * rather than the session -- `_xact_` means a rollback or a dropped
   * connection releases it, which is the failure mode that turns a lock into an
   * outage. `hashtext` narrows the uuid to 32 bits, so two employees can share
   * a key; the cost of that collision is that two people occasionally take each
   * other's turn for the length of one insert, and never a wrong answer.
   *
   * Per employee, deliberately. One key for the organisation would serialise
   * the entire workforce at 09:00, which is the one minute of the day this
   * product has to survive.
   *
   * `pg_try_advisory_xact_lock` and a retry loop, rather than the blocking
   * `pg_advisory_xact_lock` this started as. The blocking call waits *inside*
   * an open transaction, which means it waits holding one of the pool's ten
   * connections and for as long as the other side takes. One employee whose
   * key was stuck -- an operator's forgotten psql session, a hung transaction,
   * two employees colliding on `hashtext` while one of them was slow -- was
   * therefore enough to park the whole pool: twelve punches for that one
   * employee left 10/10 backends waiting, and unrelated traffic answered 503
   * on `/ready` and 500 on `/me/today` after five seconds each. A lock that
   * protects one employee's ordering must not be able to answer for everybody
   * else's requests.
   *
   * The try-and-retry keeps the wait outside the transaction: each attempt is
   * one instant statement, the connection goes straight back to the pool if
   * the key is taken, and the sleep happens holding nothing. A caller that
   * cannot get the key inside the budget is told so, retryably -- see
   * `busyError`; REQ-D-11's idempotency key is what makes that safe to act on.
   */
  async withPunchOrderingLock<T>(
    employeeId: string,
    work: (locked: PunchRepository, tx: Transaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }

      let outcome: LockOutcome<T>;
      try {
        outcome = await this.db.transaction(async (tx): Promise<LockOutcome<T>> => {
          const rows = await tx.execute<{ taken: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(${PUNCH_ORDERING_LOCK_NAMESPACE}, hashtext(${employeeId})) AS taken`,
          );
          if (rows.rows[0]?.taken !== true) return { acquired: false };
          return { acquired: true, value: await work(new PunchRepository(tx, this.ctx), tx) };
        });
      } catch (error: unknown) {
        // A pool with nothing to give is the same answer as a key that is
        // taken, and it must not surface as an unhandled fault -- that is the
        // 500 an outbox cannot act on. Anything else is a real failure and is
        // rethrown untouched, including every AppError `work` raises.
        if (describeError(error).includes(POOL_TIMEOUT_TEXT)) {
          throw busyError('connection pool exhausted');
        }
        throw error;
      }

      if (outcome.acquired) return outcome.value;
    }

    throw busyError('another punch for this employee is still being recorded');
  }

  /**
   * The only write in the punch path, and the only one there will ever be:
   * REQ-D-12 makes the row immutable, and migration 0004's trigger refuses an
   * UPDATE or DELETE regardless of what any service believes.
   *
   * `onConflictDoNothing` on the idempotency index rather than a pre-flight
   * check alone. The check in the service answers for the instant it ran; two
   * requests carrying the same key can both pass it, and only the index
   * decides. A null return here means the other request won, and the caller
   * reads the row it wrote.
   */
  async insert(values: NewPunch): Promise<PunchRecord | null> {
    const inserted = await this.db
      .insert(punches)
      .values({
        orgId: this.ctx.orgId,
        employeeId: values.employeeId,
        attendanceDate: values.attendanceDate,
        punchType: values.punchType,
        serverTime: values.serverTime,
        effectiveTime: values.effectiveTime,
        clientTime: values.clientTime,
        clockSkewSeconds: values.clockSkewSeconds,
        syncDelaySeconds: values.syncDelaySeconds,
        photoFileId: values.photoFileId,
        thumbnailFileId: values.thumbnailFileId,
        recordedByUserId: values.recordedByUserId,
        latitude: values.latitude,
        longitude: values.longitude,
        gpsAccuracyM: values.gpsAccuracyM,
        distanceFromGeofenceM: values.distanceFromGeofenceM,
        ip: values.ip,
        deviceFingerprint: values.deviceFingerprint,
        source: values.source,
        userAgent: values.userAgent,
        appVersion: values.appVersion,
        isHalfDayMarked: values.isHalfDayMarked,
        halfDayPart: values.halfDayPart,
        outsideWindow: values.outsideWindow,
        outsideGeofence: values.outsideGeofence,
        deviceMismatch: values.deviceMismatch,
        reason: values.reason,
        flags: [...values.flags],
        idempotencyKey: values.idempotencyKey,
        createdAt: values.serverTime,
        createdBy: this.ctx.actorUserId,
      })
      .onConflictDoNothing({ target: [punches.employeeId, punches.idempotencyKey] })
      .returning({ id: punches.id });

    const id = inserted[0]?.id;
    if (id === undefined) return null;

    const rows = await this.baseSelect()
      .where(this.orgScoped(eq(punches.orgId, this.ctx.orgId), eq(punches.id, id)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Punch ${id} was written but could not be read back.`);
    }
    return toPunchRecord(row);
  }
}
