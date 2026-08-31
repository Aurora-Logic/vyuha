import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type ApprovalDelegation,
  type ApprovalRequestDetail,
  type ApprovalRequestSummary,
  type BulkApprovalResult,
  type Paginated,
  type PermissionKey,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrgContext } from '../db/scoped-repository.js';
import { JobRegistry } from '../jobs/job-handler.js';
import { JOB_QUEUE, QUEUES, SCHEDULED_JOBS } from '../jobs/queue.registry.js';
import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import {
  ApprovalSubjectRegistry,
  type ApprovalSubjectHandler,
} from './approval-subject.registry.js';
import { ApprovalService } from './approval.service.js';
import { EscalateStaleApprovalsHandler } from './escalate-stale-approvals.handler.js';

/**
 * The approval endpoints (REQ-I-01 … REQ-I-05) over real HTTP against the real
 * application: the global guard, the Zod pipe, the audit interceptor, the
 * scope predicates, and the SQL that reaches Postgres.
 *
 * There is no endpoint that raises a request, by design -- REQ-I-01's whole
 * point is that a slice raises one in process and the framework knows nothing
 * about the subject. So the fixtures call `ApprovalService.raise` on the
 * container's own instance, and everything after that is HTTP.
 *
 * The subjects below are this file's own, registered with
 * `ApprovalSubjectRegistry` in `beforeAll` and backed by no table at all. That
 * is deliberate: the framework may not know what a leave request is, and a
 * suite that reached for the real one to exercise routing, delegation and
 * escalation would be asserting leave's behaviour through the framework's
 * endpoints. The counter is `leave.endpoints.test.ts`, which drives the real
 * subject end to end.
 *
 * The refusal REQ-I-05 names lives in exactly two tests here, so removing the
 * server-side check fails exactly those two by name and not a dozen unrelated
 * ones.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000a8';

/**
 * The subject types this file raises against, none of which name a real table.
 *
 * `ApprovalService` refuses to raise or decide a subject type nothing has
 * registered a handler for -- an approved request whose subject never moved is
 * the failure the registry exists to prevent -- so a framework test needs
 * subjects of its own rather than borrowing another slice's.
 */
const PROBE_SUBJECT = 'framework_probe';
const OTHER_PROBE_SUBJECT = 'comp_off_request';
/** Registered by nothing, so the guard has something to refuse. */
const UNHANDLED_SUBJECT = 'unregistered_probe';
/**
 * A subject whose handler declares a key none of this file's approvers hold.
 *
 * One inbox decides several kinds of request and they do not share a permission
 * key. This is the framework half of that rule -- the real one is exercised on
 * a real subject in `regularization.endpoints.test.ts`.
 */
const NARROW_SUBJECT = 'device';

/** Every decision this file's subjects were told about, in order. */
const decisionsSeen: { subjectType: string; subjectId: string; status: string }[] = [];

function probeHandler(
  subjectType: string,
  actPermissions: readonly PermissionKey[] = [
    PERMISSIONS.LEAVE_APPROVE_TEAM,
    PERMISSIONS.LEAVE_APPROVE_ALL,
  ],
): ApprovalSubjectHandler {
  return {
    subjectType,
    // The keys the framework narrows a decision to. Defaulted to the leave pair
    // so every test below reads as it did before the handler started declaring
    // them; `NARROW_SUBJECT` is the one that declares something else.
    actPermissions,
    overridePermissions: [PERMISSIONS.LEAVE_APPROVE_ALL],
    applyDecision: (_ctx, decision) => {
      decisionsSeen.push({ subjectType, subjectId: decision.subjectId, status: decision.status });
      return Promise.resolve(null);
    },
  };
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let approvals: ApprovalService;

let empUserId = '';
let mgrUserId = '';
let hrUserId = '';
let delegateUserId = '';
let outsiderUserId = '';

let empToken = '';
let mgrToken = '';
let hrToken = '';
let delegateToken = '';
let outsiderToken = '';

let subjectSeq = 0;

/** A fresh, plausible subject id per request; nothing dereferences it. */
function nextSubjectId(): string {
  subjectSeq += 1;
  return `01900000-0000-7000-8000-0000009${String(subjectSeq).padStart(5, '0')}`;
}

function ctxOf(userId: string): OrgContext {
  return { orgId: ORG_ID, actorUserId: userId };
}

async function raise(options: {
  requesterUserId: string;
  approverUserIds?: readonly string[];
  subject?: string;
  escalateAfterDays?: number;
  subjectType?: string;
}): Promise<ApprovalRequestDetail> {
  return approvals.raise(ctxOf(options.requesterUserId), {
    type: 'LEAVE',
    subjectType: options.subjectType ?? PROBE_SUBJECT,
    subjectId: nextSubjectId(),
    subject: options.subject ?? 'Casual Leave, 24-08-2026 to 25-08-2026, 2 days',
    requesterUserId: options.requesterUserId,
    ...(options.approverUserIds === undefined
      ? {}
      : { approverUserIds: options.approverUserIds }),
    ...(options.escalateAfterDays === undefined
      ? {}
      : { escalateAfterDays: options.escalateAfterDays }),
  });
}

beforeAll(async () => {
  // Last run's approval rows are cleared by `resetOrganisation`, which has to
  // do it anyway now that applying for leave raises one: every approval table
  // points at `users` with RESTRICT, and the harness deletes users.
  harness = await ApiHarness.start(ORG_ID, 'Approvals Endpoints Fixture Org');
  approvals = harness.resolve(ApprovalService);

  // Registered on the container's own registry, exactly as a slice does on
  // init. Nothing here dereferences a subject id, which is the point: the
  // framework's contract with a subject is a (type, id) pair and a callback.
  const subjects = harness.resolve(ApprovalSubjectRegistry);
  subjects.register(probeHandler(PROBE_SUBJECT));
  subjects.register(probeHandler(OTHER_PROBE_SUBJECT));
  subjects.register(probeHandler(NARROW_SUBJECT, [PERMISSIONS.SETTINGS_MANAGE]));

  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
  const operationsRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);

  // A three-level reporting line, so the default route has somewhere to go and
  // the escalation job has a level above the first approver.
  const hrEmployeeId = await harness.createEmployee({ code: 'AP-HR', firstName: 'Hema' });
  const mgrEmployeeId = await harness.createEmployee({
    code: 'AP-MGR',
    firstName: 'Manoj',
    reportingManagerId: hrEmployeeId,
  });
  const empEmployeeId = await harness.createEmployee({
    code: 'AP-EMP',
    firstName: 'Esha',
    lastName: 'Rao',
    reportingManagerId: mgrEmployeeId,
  });
  const delegateEmployeeId = await harness.createEmployee({
    code: 'AP-DEL',
    firstName: 'Deepa',
  });
  const outsiderEmployeeId = await harness.createEmployee({
    code: 'AP-OUT',
    firstName: 'Omkar',
  });

  const emp = await harness.createUser({
    email: scopedEmail('ap-emp'),
    roleIds: [employeeRoleId],
    employeeId: empEmployeeId,
  });
  const mgr = await harness.createUser({
    email: scopedEmail('ap-mgr'),
    roleIds: [operationsRoleId],
    employeeId: mgrEmployeeId,
  });
  const hr = await harness.createUser({
    email: scopedEmail('ap-hr'),
    roleIds: [hrRoleId],
    employeeId: hrEmployeeId,
  });
  const delegate = await harness.createUser({
    email: scopedEmail('ap-delegate'),
    roleIds: [operationsRoleId],
    employeeId: delegateEmployeeId,
  });
  // Holds leave.apply.self and nothing else, and is nobody's report -- so the
  // scope tests refuse for the right reason rather than for having no keys.
  const outsider = await harness.createUser({
    email: scopedEmail('ap-outsider'),
    roleIds: [employeeRoleId],
    employeeId: outsiderEmployeeId,
  });

  empUserId = emp.id;
  mgrUserId = mgr.id;
  hrUserId = hr.id;
  delegateUserId = delegate.id;
  outsiderUserId = outsider.id;

  empToken = (await harness.login(emp.email, emp.password)).token;
  mgrToken = (await harness.login(mgr.email, mgr.password)).token;
  hrToken = (await harness.login(hr.email, hr.password)).token;
  delegateToken = (await harness.login(delegate.email, delegate.password)).token;
  outsiderToken = (await harness.login(outsider.email, outsider.password)).token;

  expect(
    [empToken, mgrToken, hrToken, delegateToken, outsiderToken].every((t) => t !== ''),
  ).toBe(true);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('raising a request (REQ-I-01, REQ-I-02)', () => {
  it('writes the whole route up front and starts at step one', async () => {
    const detail = await raise({ requesterUserId: empUserId });

    expect(detail.status).toBe('PENDING');
    expect(detail.currentStep).toBe(1);
    expect(detail.subjectType).toBe(PROBE_SUBJECT);
    // The default route is the reporting line, then org-wide approvers.
    expect(detail.steps.map((step) => step.approver.id)).toEqual([mgrUserId, hrUserId]);
    expect(detail.steps.every((step) => step.action === null)).toBe(true);
    expect(detail.awaiting?.id).toBe(mgrUserId);
    expect(detail.escalateAfterDays).toBe(3);
  });

  it('P2-2: the org setting decides the default escalation window', async () => {
    await harness.db.execute(sql`
      INSERT INTO settings (org_id, scope, scope_id, key, value, created_by, updated_by)
      VALUES (${ORG_ID}, 'ORG', NULL, 'attendance.auto_escalation_days', '7'::jsonb, NULL, NULL)
      ON CONFLICT (org_id, scope, (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)), key) WHERE deleted_at IS NULL
      DO UPDATE SET value = EXCLUDED.value
    `);
    try {
      const detail = await raise({ requesterUserId: empUserId });
      expect(detail.escalateAfterDays).toBe(7);
      // An explicit choice from the raising slice still wins over the setting.
      const explicit = await raise({ requesterUserId: empUserId, escalateAfterDays: 2 });
      expect(explicit.escalateAfterDays).toBe(2);
    } finally {
      await harness.db.execute(sql`DELETE FROM settings WHERE org_id = ${ORG_ID} AND key = 'attendance.auto_escalation_days'`);
    }
  });

  it('names the requester from their employee record, not their email', async () => {
    const detail = await raise({ requesterUserId: empUserId });
    expect(detail.requester.name).toBe('Esha Rao');
  });

  // REQ-I-05, applied before the request exists: the route starts above the
  // requester rather than in their own inbox.
  it('drops the requester from their own route', async () => {
    const detail = await raise({
      requesterUserId: mgrUserId,
      approverUserIds: [mgrUserId, hrUserId],
    });
    expect(detail.steps.map((step) => step.approver.id)).toEqual([hrUserId]);
    expect(detail.awaiting?.id).toBe(hrUserId);
  });

  it('refuses to raise a request nobody can approve', async () => {
    await expect(
      raise({ requesterUserId: hrUserId, approverUserIds: [hrUserId] }),
    ).rejects.toThrow(/nobody to approve/u);
  });

  // The in-process seam has no Zod pipe in front of it, so the limits the
  // shared contract publishes are checked here or nowhere.
  it('refuses a subject line that is empty or absurdly long', async () => {
    await expect(
      raise({ requesterUserId: empUserId, subject: '   ' }),
    ).rejects.toThrow(/subject line/u);
    await expect(
      raise({ requesterUserId: empUserId, subject: 'x'.repeat(301) }),
    ).rejects.toThrow(/subject line/u);
  });

  it('refuses an escalation threshold outside the published range', async () => {
    await expect(
      raise({ requesterUserId: empUserId, escalateAfterDays: -1 }),
    ).rejects.toThrow(/Escalation must be between/u);
    await expect(
      raise({ requesterUserId: empUserId, escalateAfterDays: 61 }),
    ).rejects.toThrow(/Escalation must be between/u);
  });
});

describe('the inbox (REQ-I-03)', () => {
  it('shows an approver what has been routed to them', async () => {
    const detail = await raise({ requesterUserId: empUserId, subject: 'Inbox probe' });

    const result = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals', {
      token: mgrToken,
    });

    expect(result.status).toBe(200);
    const row = result.body.data.find((item) => item.id === detail.id);
    expect(row).toBeDefined();
    expect(row?.subject).toBe('Inbox probe');
    expect(row?.requester.name).toBe('Esha Rao');
  });

  it('does not put a requester their own request under "inbox"', async () => {
    const detail = await raise({ requesterUserId: empUserId });

    const inbox = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals', {
      token: empToken,
    });
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.some((item) => item.id === detail.id)).toBe(false);

    // REQ-I-02: but they can always see it.
    const raised = await harness.get<Paginated<ApprovalRequestSummary>>(
      '/approvals?view=raised',
      { token: empToken },
    );
    expect(raised.body.data.some((item) => item.id === detail.id)).toBe(true);
  });

  it('shows an unrelated employee nothing, even asking for everything', async () => {
    const detail = await raise({ requesterUserId: empUserId });

    const result = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals?view=all', {
      token: outsiderToken,
    });
    expect(result.status).toBe(200);
    expect(result.body.data.some((item) => item.id === detail.id)).toBe(false);
  });

  it('shows an org-wide approver the whole organisation under "all"', async () => {
    const detail = await raise({ requesterUserId: empUserId });

    const result = await harness.get<Paginated<ApprovalRequestSummary>>('/approvals?view=all', {
      token: hrToken,
    });
    expect(result.body.data.some((item) => item.id === detail.id)).toBe(true);
  });

  it('filters by subject type without knowing what a subject is', async () => {
    const detail = await raise({
      requesterUserId: empUserId,
      subjectType: OTHER_PROBE_SUBJECT,
    });

    const matching = await harness.get<Paginated<ApprovalRequestSummary>>(
      `/approvals?subjectType=${OTHER_PROBE_SUBJECT}`,
      { token: mgrToken },
    );
    expect(matching.body.data.some((item) => item.id === detail.id)).toBe(true);

    const other = await harness.get<Paginated<ApprovalRequestSummary>>(
      '/approvals?subjectType=regularization',
      { token: mgrToken },
    );
    expect(other.body.data.some((item) => item.id === detail.id)).toBe(false);
  });

  it('rejects a subject type that is not lower snake_case', async () => {
    const result = await harness.get<ErrorBody>('/approvals?subjectType=Leave%20Request', {
      token: mgrToken,
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a caller with no token', async () => {
    const result = await harness.get<ErrorBody>('/approvals');
    expect(result.status).toBe(401);
  });
});

describe('the detail view (REQ-I-02)', () => {
  it('returns the history with every identity resolved', async () => {
    const created = await raise({ requesterUserId: empUserId });

    const result = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: mgrToken,
    });

    expect(result.status).toBe(200);
    expect(result.body.steps).toHaveLength(2);
    expect(result.body.steps[0]?.approver.name).toBe('Manoj');
    expect(result.body.steps[0]?.actedBy).toBeNull();
    expect(result.body.awaiting?.name).toBe('Manoj');
  });

  it('answers 404, not 403, for a request outside the caller', async () => {
    const created = await raise({ requesterUserId: empUserId });
    const result = await harness.get<ErrorBody>(`/approvals/${created.id}`, {
      token: outsiderToken,
    });
    expect(result.status).toBe(404);
  });

  it('lets the requester read their own', async () => {
    const created = await raise({ requesterUserId: empUserId });
    const result = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: empToken,
    });
    expect(result.status).toBe(200);
    expect(result.body.id).toBe(created.id);
  });
});

describe('deciding (REQ-I-03, REQ-F-05)', () => {
  it('advances to the next level and records who decided', async () => {
    const created = await raise({ requesterUserId: empUserId });

    const result = await harness.post<ApprovalRequestDetail>(
      `/approvals/${created.id}/approve`,
      { token: mgrToken, body: { reason: 'Cover arranged.' } },
    );

    expect(result.status).toBe(201);
    expect(result.body.status).toBe('PENDING');
    expect(result.body.currentStep).toBe(2);
    expect(result.body.awaiting?.id).toBe(hrUserId);

    const step = result.body.steps[0];
    expect(step?.action).toBe('APPROVE');
    expect(step?.actedBy?.id).toBe(mgrUserId);
    expect(step?.delegatedFrom).toBeNull();
    expect(step?.reason).toBe('Cover arranged.');
    expect(step?.actedAt).not.toBeNull();

    expect(await harness.waitForAuditAction('approval.approved')).toBe(true);
  });

  it('closes the request when the last level approves', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId],
    });

    const result = await harness.post<ApprovalRequestDetail>(
      `/approvals/${created.id}/approve`,
      { token: mgrToken, body: {} },
    );
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('APPROVED');
    expect(result.body.awaiting).toBeNull();
  });

  it('refuses a second decision on a closed request', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId],
    });
    await harness.post(`/approvals/${created.id}/approve`, { token: mgrToken, body: {} });

    const again = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: mgrToken,
      body: {},
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('APPROVAL_ALREADY_ACTIONED');
  });

  it('ends the request on a rejection at any level', async () => {
    const created = await raise({ requesterUserId: empUserId });

    const result = await harness.post<ApprovalRequestDetail>(
      `/approvals/${created.id}/reject`,
      { token: mgrToken, body: { reason: 'Team is short that week.' } },
    );

    expect(result.status).toBe(201);
    expect(result.body.status).toBe('REJECTED');
    expect(result.body.steps[0]?.reason).toBe('Team is short that week.');
    expect(await harness.waitForAuditAction('approval.rejected')).toBe(true);
  });

  // REQ-F-05. Enforced by the shared schema, so it cannot be true on one verb
  // and not the other.
  it('refuses a rejection with no reason', async () => {
    const created = await raise({ requesterUserId: empUserId });
    const result = await harness.post<ErrorBody>(`/approvals/${created.id}/reject`, {
      token: mgrToken,
      body: {},
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a caller holding no approval permission', async () => {
    const created = await raise({ requesterUserId: outsiderUserId, approverUserIds: [mgrUserId] });
    const result = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: empToken,
      body: {},
    });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses an approver the request was never routed to', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId],
    });
    const result = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: delegateToken,
      body: {},
    });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('FORBIDDEN');
  });
});

/**
 * REQ-I-05, at the endpoint. Both tests fail if the server-side check is
 * removed, and the second one is the one that matters: `leave.approve.all` is
 * the widest grant in the product, and without the ordering in
 * `evaluateDecision` it would swallow the refusal.
 */
describe('an approver cannot approve their own request (REQ-I-05)', () => {
  it('refuses the requester who is also an approver', async () => {
    const created = await raise({
      requesterUserId: mgrUserId,
      approverUserIds: [hrUserId, mgrUserId],
    });

    const result = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: mgrToken,
      body: {},
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('APPROVER_IS_REQUESTER');

    // And nothing moved.
    const after = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: hrToken,
    });
    expect(after.body.status).toBe('PENDING');
    expect(after.body.steps.every((step) => step.action === null)).toBe(true);
  });

  it('refuses a requester who holds leave.approve.all', async () => {
    const created = await raise({
      requesterUserId: hrUserId,
      approverUserIds: [mgrUserId],
    });

    const result = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: hrToken,
      body: {},
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('APPROVER_IS_REQUESTER');
  });

  it('refuses their own request inside a bulk action too', async () => {
    const own = await raise({ requesterUserId: hrUserId, approverUserIds: [mgrUserId] });
    const other = await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] });

    const result = await harness.post<BulkApprovalResult>('/approvals/bulk', {
      token: hrToken,
      body: { ids: [own.id, other.id], action: 'APPROVE' },
    });

    expect(result.status).toBe(201);
    expect(result.body.applied).toEqual([other.id]);
    expect(result.body.skipped).toEqual([
      { id: own.id, code: 'APPROVER_IS_REQUESTER', message: expect.any(String) },
    ]);
  });
});

describe('bulk decisions (REQ-I-03)', () => {
  it('applies what it can and names what it skipped', async () => {
    const first = await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] });
    const second = await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] });

    // Somebody decided one of them a moment earlier.
    await harness.post(`/approvals/${first.id}/approve`, { token: mgrToken, body: {} });

    const result = await harness.post<BulkApprovalResult>('/approvals/bulk', {
      token: mgrToken,
      body: { ids: [first.id, second.id], action: 'APPROVE' },
    });

    expect(result.status).toBe(201);
    expect(result.body.applied).toEqual([second.id]);
    expect(result.body.skipped[0]?.code).toBe('APPROVAL_ALREADY_ACTIONED');
  });

  it('refuses a bulk rejection with no reason', async () => {
    const created = await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] });
    const result = await harness.post<ErrorBody>('/approvals/bulk', {
      token: mgrToken,
      body: { ids: [created.id], action: 'REJECT' },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a batch of one type in one call', async () => {
    const ids = [
      (await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] })).id,
      (await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] })).id,
    ];

    const result = await harness.post<BulkApprovalResult>('/approvals/bulk', {
      token: mgrToken,
      body: { ids, action: 'REJECT', reason: 'Blackout period.' },
    });

    expect(result.status).toBe(201);
    expect(result.body.applied).toHaveLength(2);
    expect(result.body.skipped).toHaveLength(0);
  });

  it('refuses an empty batch', async () => {
    const result = await harness.post<ErrorBody>('/approvals/bulk', {
      token: mgrToken,
      body: { ids: [], action: 'APPROVE' },
    });
    expect(result.status).toBe(400);
  });
});

describe('delegation (REQ-I-04)', () => {
  // The organisation's date, not UTC's.
  //
  // The server decides whether a delegation is live with
  // `(now() AT TIME ZONE <the org's timezone>)::date`, which is the right
  // question -- a delegation covering "today" means the day the office is
  // having. `toISOString()` answers a different one, and between midnight and
  // 05:30 in an Asia/Kolkata organisation the two disagree: the delegation was
  // created for a day that had already ended, so the delegate was refused and
  // the code was right. Five and a half hours a night in which this test failed
  // for a reason that had nothing to do with delegation.
  // Resolved in beforeAll because the organisation has to be asked, and a
  // describe body cannot await.
  let today = '';
  beforeAll(async () => {
    const orgTimezone = await harness.orgTimezone();
    today = new Intl.DateTimeFormat('en-CA', { timeZone: orgTimezone }).format(new Date());
  });

  it('refuses a delegation to somebody who cannot approve anything', async () => {
    const result = await harness.post<ErrorBody>('/approvals/delegations', {
      token: mgrToken,
      body: { toUserId: empUserId, fromDate: today, toDate: today },
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('CONFLICT');
  });

  it('refuses a delegation to yourself', async () => {
    const result = await harness.post<ErrorBody>('/approvals/delegations', {
      token: mgrToken,
      body: { toUserId: mgrUserId, fromDate: today, toDate: today },
    });
    expect(result.status).toBe(400);
  });

  it('refuses a range that ends before it starts', async () => {
    const result = await harness.post<ErrorBody>('/approvals/delegations', {
      token: mgrToken,
      body: { toUserId: delegateUserId, fromDate: '2026-09-10', toDate: '2026-09-01' },
    });
    expect(result.status).toBe(400);
  });

  it('lets the delegate decide, and records both identities', async () => {
    const created = await harness.post<ApprovalDelegation>('/approvals/delegations', {
      token: mgrToken,
      body: { toUserId: delegateUserId, fromDate: today, toDate: today, reason: 'On leave.' },
    });
    expect(created.status).toBe(201);
    expect(created.body.from.id).toBe(mgrUserId);
    expect(created.body.to.id).toBe(delegateUserId);
    expect(await harness.waitForAuditAction('approval.delegated')).toBe(true);

    const request = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId],
    });

    const decided = await harness.post<ApprovalRequestDetail>(
      `/approvals/${request.id}/approve`,
      { token: delegateToken, body: { reason: 'Covering for Manoj.' } },
    );

    expect(decided.status).toBe(201);
    expect(decided.body.status).toBe('APPROVED');
    // REQ-I-04: "Delegated actions record both identities."
    expect(decided.body.steps[0]?.approver.id).toBe(mgrUserId);
    expect(decided.body.steps[0]?.actedBy?.id).toBe(delegateUserId);
    expect(decided.body.steps[0]?.delegatedFrom?.id).toBe(mgrUserId);

    // A duplicate covering the same day is refused by the database, not by a
    // pre-flight check that two concurrent requests could both pass.
    const duplicate = await harness.post<ErrorBody>('/approvals/delegations', {
      token: mgrToken,
      body: { toUserId: delegateUserId, fromDate: today, toDate: today },
    });
    expect(duplicate.status).toBe(409);

    const listed = await harness.get<ApprovalDelegation[]>('/approvals/delegations', {
      token: delegateToken,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.some((row) => row.id === created.body.id)).toBe(true);

    // Withdrawing it takes effect at once, not at the end of the range.
    const revoked = await harness.request<ApprovalDelegation>(
      'DELETE',
      `/approvals/delegations/${created.body.id}`,
      { token: mgrToken },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();
    expect(await harness.waitForAuditAction('approval.delegation_revoked')).toBe(true);

    const afterRevoke = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId],
    });
    const refused = await harness.post<ErrorBody>(`/approvals/${afterRevoke.id}/approve`, {
      token: delegateToken,
      body: {},
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
  });

  it('does not let a delegation outside today stand in', async () => {
    const created = await harness.post<ApprovalDelegation>('/approvals/delegations', {
      token: hrToken,
      body: { toUserId: delegateUserId, fromDate: '2027-01-01', toDate: '2027-01-31' },
    });
    expect(created.status).toBe(201);

    const request = await raise({ requesterUserId: empUserId, approverUserIds: [hrUserId] });
    const refused = await harness.post<ErrorBody>(`/approvals/${request.id}/approve`, {
      token: delegateToken,
      body: {},
    });
    expect(refused.status).toBe(403);
  });

  it('refuses a caller with no approval permission', async () => {
    const result = await harness.post<ErrorBody>('/approvals/delegations', {
      token: empToken,
      body: { toUserId: delegateUserId, fromDate: today, toDate: today },
    });
    expect(result.status).toBe(403);
  });
});

describe('escalation (REQ-G-09)', () => {
  /** Pushes the current step back in time so the sweep sees it as stale. */
  async function backdate(requestId: string, days: number): Promise<void> {
    await harness.db.execute(
      sql`UPDATE approval_requests
             SET current_step_started_at = now() - make_interval(days => ${days})
           WHERE id = ${requestId}`,
    );
  }

  it('moves an untouched request up a level and says so in the history', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId, hrUserId],
      escalateAfterDays: 3,
    });
    await backdate(created.id, 4);

    const outcome = await approvals.escalateStale(new Date());
    expect(outcome.escalated).toBeGreaterThanOrEqual(1);

    const after = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: hrToken,
    });
    expect(after.body.status).toBe('ESCALATED');
    expect(after.body.currentStep).toBe(2);
    expect(after.body.awaiting?.id).toBe(hrUserId);
    expect(after.body.steps[0]?.action).toBe('ESCALATE');
    expect(after.body.steps[0]?.actedBy).toBeNull();
    expect(after.body.escalatedAt).not.toBeNull();

    expect(await harness.waitForAuditAction('approval.escalated')).toBe(true);
  });

  it('is a no-op on a second run, with no flag to make it one', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId, hrUserId],
      escalateAfterDays: 1,
    });
    await backdate(created.id, 2);

    const first = await approvals.escalateStale(new Date());
    expect(first.escalated).toBeGreaterThanOrEqual(1);

    const second = await approvals.escalateStale(new Date());
    expect(second.escalated).toBe(0);
  });

  it('leaves an escalated request decidable rather than closing it', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId, hrUserId],
      escalateAfterDays: 1,
    });
    await backdate(created.id, 3);
    await approvals.escalateStale(new Date());

    const decided = await harness.post<ApprovalRequestDetail>(
      `/approvals/${created.id}/approve`,
      { token: hrToken, body: {} },
    );
    expect(decided.status).toBe(201);
    expect(decided.body.status).toBe('APPROVED');
  });

  it('counts a request with nobody above it rather than closing it', async () => {
    // Raised by the top of the reporting line and routed to their own report,
    // so the chain above the current approver is empty.
    const created = await raise({
      requesterUserId: hrUserId,
      approverUserIds: [mgrUserId],
      escalateAfterDays: 1,
    });
    await backdate(created.id, 5);

    const outcome = await approvals.escalateStale(new Date());
    expect(outcome.exhausted).toBeGreaterThanOrEqual(1);

    const after = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: mgrToken,
    });
    expect(after.body.status).toBe('PENDING');
    expect(after.body.currentStep).toBe(1);
  });

  it('never escalates a request whose threshold is zero', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId, hrUserId],
      escalateAfterDays: 0,
    });
    await backdate(created.id, 400);

    await approvals.escalateStale(new Date());

    const after = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: mgrToken,
    });
    expect(after.body.status).toBe('PENDING');
    expect(after.body.currentStep).toBe(1);
  });
});

describe('the escalation job', () => {
  it('is registered with the platform job registry, not run by a timer of its own', () => {
    const registry = harness.resolve(JobRegistry);
    expect(registry.registeredJobNames()).toContain('escalate-stale-approvals');
    expect(registry.get('escalate-stale-approvals')).toBeInstanceOf(EscalateStaleApprovalsHandler);
  });

  it('is on the schedule, at a pattern that fires more often than the threshold', () => {
    const scheduled = SCHEDULED_JOBS.find(
      (job) => job.jobName === 'escalate-stale-approvals',
    );
    expect(scheduled).toBeDefined();
    expect(scheduled?.pattern).toBe('0 2 * * *');
    expect(JOB_QUEUE['escalate-stale-approvals']).toBe(QUEUES.NOTIFICATION);
  });

  it('reports what it moved in the result shape the runner records', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId, hrUserId],
      escalateAfterDays: 1,
    });
    await harness.db.execute(
      sql`UPDATE approval_requests
             SET current_step_started_at = now() - make_interval(days => 3)
           WHERE id = ${created.id}`,
    );

    const handler = harness.resolve(EscalateStaleApprovalsHandler);
    const result = await handler.run(
      { requestedAt: new Date().toISOString() },
      { jobId: 'test', attempt: 1 },
    );

    expect(result.escalated).toBeGreaterThanOrEqual(1);
    expect(result).toHaveProperty('scanned');
    expect(result).toHaveProperty('exhausted');
  });
});

/**
 * The registry is what lets the framework act on records it must not import
 * (REQ-I-01). These tests are the guard rail described in
 * `ApprovalSubjectRegistry`: without them, a slice could raise a request that
 * an approver marks approved while the record it was about never moved, and
 * nothing anywhere would report an error.
 */
describe('the subject handler registry (REQ-I-01)', () => {
  it('refuses to raise a subject type nothing can carry out', async () => {
    await expect(
      raise({ requesterUserId: empUserId, subjectType: UNHANDLED_SUBJECT }),
    ).rejects.toThrow(/Nothing is registered/u);
  });

  it('refuses to decide a request whose handler has gone', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId],
    });

    // The row as it would look if it had been raised before its slice
    // registered, or after that slice was removed: a subject type the registry
    // has never heard of. Written directly, because `raise` now refuses it.
    await harness.db.execute(
      sql`UPDATE approval_requests SET subject_type = ${UNHANDLED_SUBJECT} WHERE id = ${created.id}`,
    );

    const refused = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: mgrToken,
      body: {},
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/Nothing is registered/u);

    // And nothing moved: the step is unanswered and the request still open.
    const after = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: hrToken,
    });
    expect(after.body.status).toBe('PENDING');
    expect(after.body.steps.every((step) => step.action === null)).toBe(true);
  });

  it('tells the handler once, and only on a status the subject has to mirror', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId, hrUserId],
    });
    const seen = (): typeof decisionsSeen =>
      decisionsSeen.filter((entry) => entry.subjectId === created.subjectId);

    // Step one of two. The request is still pending, so the subject is not
    // told: it has nothing to mirror yet.
    const first = await harness.post<ApprovalRequestDetail>(`/approvals/${created.id}/approve`, {
      token: mgrToken,
      body: {},
    });
    expect(first.body.status).toBe('PENDING');
    expect(seen()).toHaveLength(0);

    const second = await harness.post<ApprovalRequestDetail>(`/approvals/${created.id}/approve`, {
      token: hrToken,
      body: {},
    });
    expect(second.body.status).toBe('APPROVED');
    expect(seen()).toEqual([
      { subjectType: PROBE_SUBJECT, subjectId: created.subjectId, status: 'APPROVED' },
    ]);

    // A second attempt is refused by the compare-and-swap and never reaches
    // the handler -- which is the whole exactly-once guarantee.
    const again = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: hrToken,
      body: {},
    });
    expect(again.status).toBe(409);
    expect(seen()).toHaveLength(1);
  });

  it('tells the handler when the escalation job moves a request (REQ-G-09)', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId, hrUserId],
      escalateAfterDays: 1,
    });
    await harness.db.execute(
      sql`UPDATE approval_requests
             SET current_step_started_at = now() - make_interval(days => 3)
           WHERE id = ${created.id}`,
    );

    await approvals.escalateStale(new Date());

    expect(decisionsSeen.filter((entry) => entry.subjectId === created.subjectId)).toEqual([
      { subjectType: PROBE_SUBJECT, subjectId: created.subjectId, status: 'ESCALATED' },
    ]);
  });

  /**
   * The narrowing that lets one inbox carry more than one kind of request.
   *
   * The route guard on `/approvals/:id/approve` holds the union of every
   * approval key, because a guard sees an id and a token and never a subject
   * type. Without the handler naming its own key, routing a second kind of
   * request into this inbox would silently make every approver an approver of
   * it -- which is precisely what happened to `regularization.approve` the
   * moment corrections started arriving here.
   */
  it('refuses an approver who holds no key this subject type accepts', async () => {
    const created = await raise({
      requesterUserId: empUserId,
      approverUserIds: [mgrUserId],
      subjectType: NARROW_SUBJECT,
    });

    // The routed approver, and holder of both leave keys -- so this is refused
    // on the subject type alone, not on whose turn it is.
    const refused = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: mgrToken,
      body: {},
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/permission that decides this kind/u);

    // Nothing moved, and the handler was never told.
    expect(decisionsSeen.filter((entry) => entry.subjectId === created.subjectId)).toHaveLength(0);
    const after = await harness.get<ApprovalRequestDetail>(`/approvals/${created.id}`, {
      token: hrToken,
    });
    expect(after.body.status).toBe('PENDING');
    expect(after.body.steps.every((step) => step.action === null)).toBe(true);
  });

  it('refuses a second handler for one subject type', () => {
    const subjects = harness.resolve(ApprovalSubjectRegistry);
    expect(() => {
      subjects.register(probeHandler(PROBE_SUBJECT));
    }).toThrow(/already has a handler/u);
    expect(subjects.registeredSubjectTypes()).toContain(PROBE_SUBJECT);
  });
});

describe('the in-process seam other slices use (REQ-I-01)', () => {
  it('finds the approval attached to a subject', async () => {
    const created = await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] });
    const found = await approvals.findForSubject(
      ctxOf(empUserId),
      created.subjectType,
      created.subjectId,
    );
    expect(found?.id).toBe(created.id);
  });

  it('cancels an open approval when its subject is withdrawn', async () => {
    const created = await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] });

    const cancelled = await approvals.cancelForSubject(
      ctxOf(empUserId),
      created.subjectType,
      created.subjectId,
      'Withdrawn by the employee.',
    );
    expect(cancelled?.status).toBe('CANCELLED');

    const refused = await harness.post<ErrorBody>(`/approvals/${created.id}/approve`, {
      token: mgrToken,
      body: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('APPROVAL_ALREADY_ACTIONED');
  });

  it('says nothing to cancel rather than failing on a decided request', async () => {
    const created = await raise({ requesterUserId: empUserId, approverUserIds: [mgrUserId] });
    await harness.post(`/approvals/${created.id}/approve`, { token: mgrToken, body: {} });

    const cancelled = await approvals.cancelForSubject(
      ctxOf(empUserId),
      created.subjectType,
      created.subjectId,
      'Too late.',
    );
    expect(cancelled).toBeNull();
  });
});
