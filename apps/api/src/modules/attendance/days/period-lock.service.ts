import { Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { ScopedRepository } from '../../../platform/db/scoped-repository.js';
import { locations } from '../../../platform/db/schema/index.js';
import { NOTIFICATION_EVENTS } from '../../../platform/notifications/notification-events.js';
import { NotificationDispatcher } from '../../../platform/notifications/notification.dispatcher.js';
import { orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import type { LockPeriodInput, PeriodLockQuery } from './period-lock.dto.js';
import { PeriodLockRepository, type PeriodLockRow } from './period-lock.repository.js';

/** "8/2026" is a key, not a sentence. The notification says August 2026. */
const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function periodLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? String(month)} ${String(year)}`;
}

/**
 * REQ-E-09: "HR locks a month. After locking: no punches, leave,
 * regularizations, overrides, or recomputes affect locked days. Unlocking
 * requires Admin and a reason, and both actions are audited."
 *
 * The refusal itself is not implemented here and was not added by this slice.
 * `DayEngineRepository.isPeriodLocked` has read this table since the engine
 * landed, and step 2 of the engine returns `outcome: 'locked'` before it reads
 * anything else. What was missing was any way to *create* a row for it to find.
 * Everything below writes the rows that code already respects — which is why
 * the lock takes effect on the punch path, the leave path and the nightly
 * recompute without any of them being touched.
 *
 * Both actions take a reason, and they are stored in separate columns
 * (migration 0011). One column cannot hold two: an unlock would otherwise
 * overwrite the reason the month was closed for, which is the half an auditor
 * is more likely to want.
 */
@Injectable()
export class PeriodLockService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly notifications: NotificationDispatcher,
  ) {}

  async list(principal: Principal, query: PeriodLockQuery): Promise<{ data: PeriodLockRow[] }> {
    // Not paginated: one row per locked month per scope is a handful a year,
    // and a page envelope on a list nobody will page is a case the client has
    // to handle that cannot happen.
    const data = await this.repository(principal).list({
      year: query.year,
      liveOnly: query.liveOnly,
    });
    return { data };
  }

  async lock(principal: Principal, input: LockPeriodInput): Promise<PeriodLockRow> {
    return this.db.transaction((tx) => this.lockInTransaction(principal, input, tx));
  }

  private async lockInTransaction(principal: Principal, input: LockPeriodInput, executor: Database): Promise<PeriodLockRow> {
    const repository = new PeriodLockRepository(executor, orgContextOf(principal));
    const locationId = input.locationId ?? null;

    if (locationId !== null) {
      const exists = await new ScopedRepository(executor, locations, orgContextOf(principal)).exists(
        locationId,
      );
      if (!exists) throw AppError.notFound('Location', locationId);
    }

    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${principal.orgId} || '.period.' || ${String(input.year)} || '.' || ${String(input.month)}, 0))`);

    const already = await repository.findLive(locationId, input.year, input.month);
    if (already !== null) {
      // A partial unique index enforces this too, but a unique violation
      // surfaces as a 500 naming an index. Answering first turns a duplicate
      // press of a Lock button into a sentence.
      throw new AppError(
        ERROR_CODES.PERIOD_ALREADY_LOCKED,
        `${String(input.month)}/${String(input.year)} is already locked for this scope.`,
        { details: { lockId: already.id, year: input.year, month: input.month, locationId } },
      );
    }

    const now = new Date();
    const id = await repository.insert({
      locationId,
      year: input.year,
      month: input.month,
      reason: input.reason,
      at: now,
    });
    const daysMarked = await repository.syncDaysLocked(input.year, input.month, now);

    const row = await this.readBack(repository, id);

    await this.auditContext.recordInTransaction({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'attendance.period.locked',
      entityType: 'attendance_period_lock',
      entityId: id,
      before: null,
      after: {
        year: input.year,
        month: input.month,
        locationId,
        reason: input.reason,
        attendanceDaysMarked: daysMarked,
      },
    }, executor);

    // REQ-K-03. Everyone who can close or reopen a month, which is the set
    // whose exports and corrections the lock has just changed. Named by
    // permission rather than by role (PRD §2), and it deliberately includes
    // whoever pressed the button: a second administrator watching the same
    // month must not learn about it later than the first.
    await this.notifications.stageInTransaction({
      orgId: principal.orgId,
      type: NOTIFICATION_EVENTS.PERIOD_LOCKED,
      audience: { kind: 'permission', key: PERMISSIONS.ATTENDANCE_LOCK },
      payload: { period: periodLabel(input.year, input.month), actorName: principal.email },
    }, executor);

    return row;
  }

  async unlock(principal: Principal, id: string, reason: string): Promise<PeriodLockRow> {
    return this.db.transaction((tx) => this.unlockInTransaction(principal, id, reason, tx));
  }

  private async unlockInTransaction(principal: Principal, id: string, reason: string, executor: Database): Promise<PeriodLockRow> {
    const repository = new PeriodLockRepository(executor, orgContextOf(principal));

    const existing = await repository.findById(id);
    if (existing === null) throw AppError.notFound('Period lock', id);

    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${principal.orgId} || '.period.' || ${String(existing.year)} || '.' || ${String(existing.month)}, 0))`);

    if (existing.unlockedAt !== null) {
      throw new AppError(
        ERROR_CODES.PERIOD_NOT_LOCKED,
        `${String(existing.month)}/${String(existing.year)} was already unlocked on ${existing.unlockedAt}.`,
        { details: { lockId: id, unlockedAt: existing.unlockedAt } },
      );
    }

    const now = new Date();
    const unlocked = await repository.markUnlocked(id, reason, now);
    if (!unlocked) {
      // Lost the race with another unlock. Reporting the conflict rather than
      // claiming success: two administrators must not both be told they were
      // the one who reopened the month.
      throw new AppError(
        ERROR_CODES.PERIOD_NOT_LOCKED,
        'That period was unlocked by somebody else a moment ago.',
        { details: { lockId: id } },
      );
    }

    const daysMarked = await repository.syncDaysLocked(existing.year, existing.month, now);
    const row = await this.readBack(repository, id);

    await this.auditContext.recordInTransaction({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'attendance.period.unlocked',
      entityType: 'attendance_period_lock',
      entityId: id,
      before: { year: existing.year, month: existing.month, locked: true },
      after: {
        year: existing.year,
        month: existing.month,
        locked: false,
        reason,
        attendanceDaysMarked: daysMarked,
      },
    }, executor);

    // The reason travels with it. Reopening a closed month is the action most
    // likely to surprise somebody who has already exported it, and "unlocked"
    // with no explanation is the version of this notification that generates a
    // phone call rather than saving one.
    await this.notifications.stageInTransaction({
      orgId: principal.orgId,
      type: NOTIFICATION_EVENTS.PERIOD_UNLOCKED,
      audience: { kind: 'permission', key: PERMISSIONS.ATTENDANCE_LOCK },
      payload: {
        period: periodLabel(existing.year, existing.month),
        actorName: principal.email,
        reason,
      },
    }, executor);

    return row;
  }

  // ------------------------------------------------------------- internals

  private repository(principal: Principal): PeriodLockRepository {
    return new PeriodLockRepository(this.db, orgContextOf(principal));
  }

  private async readBack(repository: PeriodLockRepository, id: string): Promise<PeriodLockRow> {
    const row = await repository.findById(id);
    if (row === null) throw new Error(`Period lock ${id} was written but could not be read back.`);
    return row;
  }
}
