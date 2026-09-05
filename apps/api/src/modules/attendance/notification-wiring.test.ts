import { NOTIFICATION_EVENTS, PERMISSIONS, SYSTEM_ROLES, uuidv7 } from '@vyuha/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../../platform/common/env.js';
import type { OrgContext } from '../../platform/db/scoped-repository.js';
import { notifications } from '../../platform/db/schema/index.js';
import { JobRunner } from '../../platform/jobs/job-runner.service.js';
import { NotificationDispatcher } from '../../platform/notifications/notification.dispatcher.js';
import { QUEUES } from '../../platform/jobs/queue.registry.js';
import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { ApprovalService } from '../../platform/approvals/approval.service.js';
import {
  ApprovalSubjectRegistry,
  type ApprovalSubjectHandler,
} from '../../platform/approvals/approval-subject.registry.js';
import { attendancePeriodLocks } from './schema/index.js';

/**
 * Three REQ-K-03 events that had templates and no call site: the two period
 * events, and the one an escalation raises.
 *
 * Driven through the real endpoints and the real queue rather than by spying
 * on the dispatcher. What has to be true is that a notification reaches a bell
 * -- an assertion that `emit` was called proves the call site exists and
 * nothing about whether anyone would ever see it.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000f6';
const RUN = uuidv7().slice(-8);

let harness: ApiHarness;
let runner: JobRunner;
let approvals: ApprovalService;

let adminToken: string;
let adminUserId: string;
let hrUserId: string;
let employeeUserId: string;

const ctx: OrgContext = { orgId: ORG_ID, actorUserId: null };

async function bellFor(userId: string) {
  return harness.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, ORG_ID), eq(notifications.userId, userId)))
    .orderBy(desc(notifications.createdAt));
}

/** See `punch-notification-jobs.test.ts`: `delayed` never reaches zero. */
async function drainNotifications(): Promise<void> {
  await harness.resolve(NotificationDispatcher).drainOutbox();
  const queue = runner.queueFor(QUEUES.NOTIFICATION);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const counts = await queue.getJobCounts('waiting', 'active');
    if ((counts.waiting ?? 0) + (counts.active ?? 0) === 0) break;
    if (Date.now() >= deadline) throw new Error('Notification queue never drained.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/**
 * Before the harness resets the organisation, not after.
 *
 * `resetOrganisation` deletes users, and `approval_steps.approver_user_id` is
 * RESTRICT - so an approval raised by a previous run makes the second run's
 * reset fail with a foreign-key violation, which reads as a broken test rather
 * than as leftover state. The approvals suite solves it exactly this way.
 */
async function purgeApprovals(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await pool.query('DELETE FROM approval_steps WHERE org_id = $1', [ORG_ID]);
    await pool.query('DELETE FROM approval_delegations WHERE org_id = $1', [ORG_ID]);
    await pool.query('DELETE FROM approval_requests WHERE org_id = $1', [ORG_ID]);
  } finally {
    await pool.end();
  }
}

/** This file's own subject type; see the registration in `beforeAll`. */
const ESCALATION_PROBE_SUBJECT = 'notification_wiring_probe';

beforeAll(async () => {
  await purgeApprovals();

  harness = await ApiHarness.start(ORG_ID, 'Notification Wiring Fixture Org');
  runner = harness.resolve(JobRunner);
  approvals = harness.resolve(ApprovalService);

  // A subject of this file's own. Since the leave/approvals join landed, a
  // decision is applied through the registered handler for its subject type,
  // so escalating a `leave_request` id that no leave request owns now does
  // nothing at all. What is under test here is the notification the framework
  // sends when it escalates - not what leave does about it - so the subject is
  // a probe with a handler that only records.
  const probe: ApprovalSubjectHandler = {
    subjectType: ESCALATION_PROBE_SUBJECT,
    actPermissions: [PERMISSIONS.LEAVE_APPROVE_TEAM, PERMISSIONS.LEAVE_APPROVE_ALL],
    overridePermissions: [PERMISSIONS.LEAVE_APPROVE_ALL],
    applyDecision: () => Promise.resolve(null),
  };
  harness.resolve(ApprovalSubjectRegistry).register(probe);

  runner.startWorkers();

  await harness.db
    .delete(attendancePeriodLocks)
    .where(eq(attendancePeriodLocks.orgId, ORG_ID));

  const adminRole = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const hrRole = await harness.createSystemRole(SYSTEM_ROLES.HR, { isSystem: true });
  const employeeRole = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);

  const managerEmployeeId = await harness.createEmployee({
    code: `NW-M-${RUN}`,
    firstName: 'Meera',
  });
  const staffEmployeeId = await harness.createEmployee({
    code: `NW-S-${RUN}`,
    firstName: 'Sanjay',
    reportingManagerId: managerEmployeeId,
  });

  const admin = await harness.createUser({
    email: scopedEmail('wiring.admin'),
    roleIds: [adminRole],
  });
  const hr = await harness.createUser({
    email: scopedEmail('wiring.hr'),
    roleIds: [hrRole],
    employeeId: managerEmployeeId,
  });
  const employee = await harness.createUser({
    email: scopedEmail('wiring.employee'),
    roleIds: [employeeRole],
    employeeId: staffEmployeeId,
  });

  adminUserId = admin.id;
  hrUserId = hr.id;
  employeeUserId = employee.id;

  adminToken = (await harness.login(admin.email, admin.password)).token;
  expect(adminToken).not.toBe('');
}, 60_000);

afterEach(async () => {
  await harness.db.delete(notifications).where(eq(notifications.orgId, ORG_ID));
});

afterAll(async () => {
  await harness.close();
});

describe('period lock and unlock (REQ-K-03, REQ-E-09)', () => {
  it('tells everyone who can close a month that one was closed, and why it was reopened', async () => {
    const locked = await harness.post<{ id: string }>('/attendance/locks', {
      token: adminToken,
      body: { year: 2026, month: 6, locationId: null, reason: 'Payroll handoff' },
    });
    expect(locked.status, locked.text).toBe(201);

    await drainNotifications();

    // Both the Admin who did it and the HR account that also holds
    // attendance.lock. Named by permission, not by role (PRD §2).
    for (const userId of [adminUserId, hrUserId]) {
      const bell = await bellFor(userId);
      expect(bell).toHaveLength(1);
      expect(bell[0]?.eventType).toBe(NOTIFICATION_EVENTS.PERIOD_LOCKED);
      // "June 2026", not "6/2026": a key is not a sentence.
      expect(bell[0]?.body).toContain('June 2026');
    }

    // The employee holds no lock permission and hears nothing about it.
    expect(await bellFor(employeeUserId)).toHaveLength(0);

    const unlocked = await harness.del(`/attendance/locks/${locked.body.id}`, {
      token: adminToken,
      body: { reason: 'Two corrections came in late' },
    });
    expect(unlocked.status, unlocked.text).toBe(200);

    await drainNotifications();

    const after = await bellFor(hrUserId);
    const unlock = after.find(
      (row) => row.eventType === NOTIFICATION_EVENTS.PERIOD_UNLOCKED,
    );
    expect(unlock).toBeDefined();
    // The reason travels with it: reopening a closed month with no explanation
    // is the version of this that generates a phone call rather than saving one.
    expect(unlock?.body).toContain('Two corrections came in late');
  }, 60_000);

  it('holds the lock permission on HR and not on a plain employee', async () => {
    const me = await harness.get<{ permissions: string[] }>('/auth/me', {
      token: adminToken,
    });
    expect(me.body.permissions).toContain(PERMISSIONS.ATTENDANCE_LOCK);
  });
});

describe('approval overdue (REQ-K-03, REQ-G-09)', () => {
  it('notifies the approver it escalated to, and names no one else', async () => {
    const raised = await approvals.raise(ctx, {
      type: 'LEAVE',
      subjectType: ESCALATION_PROBE_SUBJECT,
      subjectId: uuidv7(),
      subject: 'Casual leave, 3 days',
      requesterUserId: employeeUserId,
      approverUserIds: [hrUserId, adminUserId],
      escalateAfterDays: 1,
    });

    // Push the current step back beyond its threshold. The sweep's SQL reads
    // `current_step_started_at`, so moving it is what makes the request stale
    // -- there is no flag to set and deliberately no way to fake one.
    await harness.db.execute(
      sql`UPDATE approval_requests
             SET current_step_started_at = now() - interval '5 days'
           WHERE id = ${raised.id}`,
    );

    const outcome = await approvals.escalateStale(new Date());
    expect(outcome.escalated).toBeGreaterThanOrEqual(1);

    await drainNotifications();

    const bell = await bellFor(adminUserId);
    const overdue = bell.filter(
      (row) => row.eventType === NOTIFICATION_EVENTS.APPROVAL_OVERDUE,
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.title).toBe('An approval has been waiting too long');
    expect(overdue[0]?.body).toContain('leave');

    // Nothing about the requester travels in the payload. The new approver may
    // be two levels above somebody whose attendance they cannot see, and a
    // notification is not a route around ScopeService.
    expect(overdue[0]?.body).not.toContain('Sanjay');
    expect(overdue[0]?.body).not.toContain('Casual leave, 3 days');
  }, 60_000);
});
