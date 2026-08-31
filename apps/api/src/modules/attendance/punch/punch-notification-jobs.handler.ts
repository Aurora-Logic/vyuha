import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import {
  JobRegistry,
  type JobContext,
  type JobHandler,
  type JobResult,
} from '../../../platform/jobs/job-handler.js';
import type { JobPayloads } from '../../../platform/jobs/queue.registry.js';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_TEMPLATES,
} from '../../../platform/notifications/notification-events.js';
import { NotificationDispatcher } from '../../../platform/notifications/notification.dispatcher.js';
import { addDays, localDateIn } from '../day-engine/calendar-date.js';
import { DayEngineRepository } from '../day-engine/day-engine.repository.js';
import { DayEngineService } from '../day-engine/day-engine.service.js';
import { PunchNotificationRepository } from './punch-notification.repository.js';

/**
 * The two REQ-K-03 punch events that nothing was firing: the reminder before a
 * shift starts, and the missing-OUT closeout REQ-E-07 asks for by name.
 *
 * Both are handlers registering themselves with `JobRegistry` on init, exactly
 * as the leave and escalation jobs do, so `JobsModule` never imports the
 * attendance module and the dependency arrow keeps pointing one way.
 *
 * Neither uses a "has this run" flag. Idempotency is a property of the emit:
 * `NotificationDispatcher.emit` takes an idempotency key that becomes the
 * BullMQ job id, so a sweep that runs twice in the same day enqueues the same
 * job id twice and the queue keeps one. That is why the keys below are per
 * employee per date rather than per run.
 */

/**
 * How far ahead of the shift a reminder goes out, and how often the sweep runs.
 *
 * The lead has to be at least the interval or a shift starting between two
 * sweeps gets no reminder at all; it is exactly twice it, so every shift start
 * is inside the window of two consecutive sweeps and the idempotency key is
 * what makes that one notification rather than two.
 */
const REMINDER_LEAD_MINUTES = 30;
const MS_PER_MINUTE = 60_000;

/**
 * REQ-K-03 marks the punch reminder opt-in, and `NOTIFICATION_TEMPLATES` says
 * so with an empty `defaultChannels`. The sweep depends on that: it builds its
 * candidate list from the accounts that have switched the event *on*, which is
 * only the complete set while nothing is delivered by default.
 *
 * Asserted at boot rather than commented, because the failure is silent -- give
 * the reminder a default channel and every employee who never expressed a
 * preference would quietly stop being reminded, with no error anywhere.
 */
function assertReminderIsOptIn(): void {
  const defaults = NOTIFICATION_TEMPLATES[NOTIFICATION_EVENTS.PUNCH_REMINDER].defaultChannels;
  if (defaults.length > 0) {
    throw new Error(
      'The punch reminder template now has default channels, so opted-in accounts are no ' +
        'longer the whole audience. `PunchReminderHandler` must widen its candidate query ' +
        'before that default can ship.',
    );
  }
}

@Injectable()
export class PunchReminderHandler implements JobHandler<'send-punch-reminders'>, OnModuleInit {
  readonly jobName = 'send-punch-reminders' as const;
  private readonly logger = new Logger(PunchReminderHandler.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly notifications: NotificationDispatcher,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    assertReminderIsOptIn();
    this.registry.register(this);
  }

  async run(
    _payload: JobPayloads['send-punch-reminders'],
    _context: JobContext,
  ): Promise<JobResult> {
    // The payload's `requestedAt` is only for the trail. A job that sat in the
    // queue through a retry must remind about the shift starting *now*.
    const now = new Date();
    let considered = 0;
    let reminded = 0;

    for (const org of await PunchNotificationRepository.listOrganisations(this.db)) {
      const optedIn = await this.notifications.usersOptedIn(
        org.id,
        NOTIFICATION_EVENTS.PUNCH_REMINDER,
      );
      if (optedIn.length === 0) continue;

      const repository = new PunchNotificationRepository(this.db, org.id);
      const candidates = await repository.employeesForUsers(optedIn);
      // Null actor: `columns.ts` says the audit trail is authoritative for who,
      // and a job has no user to name.
      const ctx: OrgContext = { orgId: org.id, actorUserId: null };
      const days = new DayEngineRepository(this.db, ctx);

      for (const candidate of candidates) {
        considered += 1;
        if (await this.remindOne(org.id, days, candidate.employeeId, now)) reminded += 1;
      }
    }

    this.logger.log({ msg: 'Punch reminder sweep complete', considered, reminded });
    return { considered, reminded };
  }

  private async remindOne(
    orgId: string,
    days: DayEngineRepository,
    employeeId: string,
    now: Date,
  ): Promise<boolean> {
    const employee = await days.findEmployee(employeeId);
    if (employee === null) return false;

    // NFR-05: "today" is where the employee is standing, not where the server
    // is. An employee in a zone ahead of the server would otherwise be
    // reminded about yesterday's shift.
    const today = localDateIn(now, employee.timezone);

    // Today *and* tomorrow, because a shift starting just after local midnight
    // has its start on tomorrow's date while the sweep that should catch it
    // runs today. Looking only at today meant a 00:15 shift could never be
    // reminded about: at 23:55 the resolver returns today's 00:15, which is
    // twenty-three hours in the past.
    //
    // Tomorrow's start for an ordinary day shift is a day away, so it can
    // never fall inside a thirty-minute window and cannot double-fire.
    for (const date of [today, addDays(today, 1)]) {
      // A misconfigured employee with no roster and no default shift throws
      // from the engine; here it is simply nobody to remind, and a sweep must
      // not stop for one of them.
      const shift = await days.resolveShift(employee, date);
      if (shift === null) return false;

      const minutesAway = (shift.scheduledIn.getTime() - now.getTime()) / MS_PER_MINUTE;
      if (minutesAway <= 0 || minutesAway > REMINDER_LEAD_MINUTES) continue;

      // Somebody already at their desk does not need telling their shift is
      // about to start. REQ-D-01 makes IN the first punch of the day, so its
      // presence is the whole test.
      const punches = await days.findPunches(employeeId, date);
      if (punches.some((punch) => punch.punchType === 'IN')) return false;

      return this.send(orgId, employeeId, date, shift.scheduledIn, employee.timezone);
    }

    return false;
  }

  private async send(
    orgId: string,
    employeeId: string,
    date: string,
    scheduledIn: Date,
    timezone: string,
  ): Promise<boolean> {
    await this.notifications.emit({
      orgId,
      type: NOTIFICATION_EVENTS.PUNCH_REMINDER,
      audience: { kind: 'employees', employeeIds: [employeeId] },
      payload: {
        // The shift's local start time, rendered where the employee is
        // standing rather than where the server is (NFR-05).
        startsAt: new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: timezone,
        }).format(scheduledIn),
      },
      // One reminder per employee per date, whatever the sweep interval is.
      idempotencyKey: `punch-reminder.${employeeId}.${date}`,
    });

    return true;
  }
}

/**
 * REQ-E-07: "A nightly job closes out days with a missing OUT punch: status
 * `PENDING`, flag `missing_punch`, notification to the employee and their
 * manager."
 *
 * The closing out is the recompute. The row was last written at the moment of
 * the IN punch, when the shift window had not closed yet, so it says whatever
 * was true then -- `compute-day.ts` only raises `missing_punch` once the window
 * is shut. Running the engine over the day is what makes the requirement's
 * first two clauses true, and reading the flag off the result is what decides
 * the third. A sweep that only notified would leave the muster claiming the day
 * was still in progress.
 */
@Injectable()
export class MissingOutSweepHandler implements JobHandler<'sweep-missing-out'>, OnModuleInit {
  readonly jobName = 'sweep-missing-out' as const;
  private readonly logger = new Logger(MissingOutSweepHandler.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly engine: DayEngineService,
    private readonly notifications: NotificationDispatcher,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['sweep-missing-out'], _context: JobContext): Promise<JobResult> {
    const now = new Date();
    let scanned = 0;
    let recomputed = 0;
    let notified = 0;

    for (const org of await PunchNotificationRepository.listOrganisations(this.db)) {
      // Yesterday in the organisation's own zone. A UTC-derived date would be
      // five and a half hours wrong for an Indian organisation, which for a
      // job that runs at 01:00 means sweeping the wrong day entirely.
      const date = payload.date ?? addDays(localDateIn(now, org.timezone), -1);

      const repository = new PunchNotificationRepository(this.db, org.id);
      const candidates = await repository.missingOutCandidates(date);
      if (candidates.length === 0) continue;

      const ctx: OrgContext = { orgId: org.id, actorUserId: null };
      const engine = this.engine.forOrg(ctx);

      for (const candidate of candidates) {
        scanned += 1;

        let missing: boolean;
        try {
          const outcome = await engine.computeDay(candidate.employeeId, date, { now });
          if (outcome.outcome === 'locked') continue;
          if (outcome.outcome === 'written') recomputed += 1;
          missing = outcome.day.flags.includes('missing_punch');
        } catch (error: unknown) {
          // One misconfigured employee -- no roster and no default shift -- must
          // not stop the sweep, and a swallowed failure must not look like a
          // clean run, so it is logged with its id and counted as unscanned.
          this.logger.error({
            msg: 'Recomputing one day for the missing-OUT sweep failed; the sweep continued.',
            employeeId: candidate.employeeId,
            orgId: org.id,
            date,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        if (!missing) continue;

        // Two dispatches, one event. The employee's copy renders in the second
        // person and carries no name; the manager's names the employee it is
        // about. One dispatch to both would have told a manager "you did not
        // punch out" about somebody else's day.
        await this.notifications.emit({
          orgId: org.id,
          type: NOTIFICATION_EVENTS.PUNCH_MISSING_OUT,
          audience: { kind: 'employees', employeeIds: [candidate.employeeId] },
          payload: { date },
          idempotencyKey: `missing-out.${candidate.employeeId}.${date}`,
        });
        notified += 1;

        if (candidate.managerEmployeeId !== null) {
          await this.notifications.emit({
            orgId: org.id,
            type: NOTIFICATION_EVENTS.PUNCH_MISSING_OUT,
            audience: { kind: 'employees', employeeIds: [candidate.managerEmployeeId] },
            payload: { date, employeeName: candidate.employeeName },
            idempotencyKey: `missing-out-manager.${candidate.employeeId}.${date}`,
          });
          notified += 1;
        }
      }
    }

    this.logger.log({ msg: 'Missing-OUT sweep complete', scanned, recomputed, notified });
    return { scanned, recomputed, notified };
  }
}

/**
 * Mark absent: the day after, the employees who never punched.
 *
 * The closeout above only touches days that already carry an IN. An employee
 * who did not punch in or out has no attendance day at all, so nothing has ever
 * called them absent -- the muster simply has a gap where they should be. This
 * runs the same engine over each such employee for the closed day; the engine
 * resolves their shift and, finding no punch and no leave, holiday or weekly
 * off, writes ABSENT (REQ-E-02's last arm). A non-rostered account resolves to
 * no shift and the engine throws, which here is simply nobody who was expected.
 *
 * Idempotent by construction: once a day is written the candidate query no
 * longer returns that employee, so a second run the same night does nothing.
 */
@Injectable()
export class MarkAbsentSweepHandler implements JobHandler<'mark-absent'>, OnModuleInit {
  readonly jobName = 'mark-absent' as const;
  private readonly logger = new Logger(MarkAbsentSweepHandler.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly engine: DayEngineService,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['mark-absent'], _context: JobContext): Promise<JobResult> {
    const now = new Date();
    let scanned = 0;
    let written = 0;
    let absent = 0;

    for (const org of await PunchNotificationRepository.listOrganisations(this.db)) {
      // Yesterday in the organisation's own zone, exactly as the closeout does.
      const date = payload.date ?? addDays(localDateIn(now, org.timezone), -1);

      const repository = new PunchNotificationRepository(this.db, org.id);
      const candidates = await repository.absentCandidates(date);
      if (candidates.length === 0) continue;

      const engine = this.engine.forOrg({ orgId: org.id, actorUserId: null });

      for (const employeeId of candidates) {
        scanned += 1;
        try {
          // ponytail: writes rest-day rows too (reusing the engine); filter to ABSENT here if that ever costs.
          const outcome = await engine.computeDay(employeeId, date, { now });
          if (outcome.outcome === 'written') {
            written += 1;
            if (outcome.day.status === 'ABSENT') absent += 1;
          }
        } catch (error: unknown) {
          // No roster and no default shift: nobody who was expected to work, so
          // there is nothing to mark. Logged at debug because it is the normal
          // shape of an account without a shift, not a failure of the sweep.
          this.logger.debug({
            msg: 'Skipped an employee with no resolvable shift in the mark-absent sweep.',
            employeeId,
            orgId: org.id,
            date,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
    }

    this.logger.log({ msg: 'Mark-absent sweep complete', scanned, written, absent });
    return { scanned, written, absent };
  }
}
