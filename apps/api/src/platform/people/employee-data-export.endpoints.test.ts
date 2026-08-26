import {
  PERMISSIONS,
  ROLE_PERMISSION_MATRIX,
  SYSTEM_ROLES,
  type ExportDownload,
  type ExportJobSummary,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { env } from '../common/env.js';
import { JobRunner } from '../jobs/job-runner.service.js';

/**
 * REQ-M-05 over real HTTP, guard, job and object storage included.
 *
 * The fixture is two employees on purpose. The single thing this feature must
 * never do is hand somebody another person's record, and a one-employee fixture
 * cannot fail that way: every string in the file belongs to the only person in
 * it. `OTHER_CODE` is a needle that exists in the database, is edited through
 * the API so it lands in the audit trail as well, and must not appear anywhere
 * in the subject's export.
 *
 * The tables the export reads are named in SQL rather than imported, because
 * `platform/` may not import `modules/` -- so this suite is also the guard on
 * those names. Every section runs against the real schema here; a column
 * renamed underneath the repository fails this file rather than shipping a
 * column of blanks.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d9';
const RUN = Date.now().toString(36).slice(-6);

const SUBJECT_CODE = `SA-${RUN}`;
const OTHER_CODE = `SX-${RUN}`;
const DEVICE_LABEL = `Bench phone ${RUN}`;
const FORMULA_REASON = '=HYPERLINK("http://evil.example","click")';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let started = false;
let runner: JobRunner;

let hrToken = '';
let opsToken = '';
let subjectId = '';
let otherId = '';
let subjectUserId = '';
let adminToken = '';

/**
 * Clears this organisation's export rows before the harness resets it.
 *
 * `export_jobs.requested_by` is `ON DELETE RESTRICT`, so a row left by a run
 * that crashed halfway pins the user it names, and `resetOrganisation` deletes
 * users. The constraint is right; it is the leftovers that have to go, and they
 * have to go before the harness exists.
 */
async function clearExportRowsBeforeStart(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await pool.query('DELETE FROM export_jobs WHERE org_id = $1', [ORG_ID]);
  } finally {
    await pool.end();
  }
}

async function requestExport(token: string, employeeId: string): Promise<ExportJobSummary> {
  const result = await harness.post<ExportJobSummary>(`/employees/${employeeId}/data-export`, {
    token,
  });
  expect(result.status, result.text).toBe(202);
  return result.body;
}

/** Waits on the tray's own view, which is what a reader actually sees. */
async function waitForExport(token: string, id: string): Promise<ExportJobSummary> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const result = await harness.get<ExportJobSummary>(`/exports/${id}`, { token });
    expect(result.status, result.text).toBe(200);
    if (result.body.status === 'DONE' || result.body.status === 'FAILED') return result.body;
    if (Date.now() >= deadline) {
      throw new Error(`Export ${id} never finished; last status ${result.body.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function downloadText(token: string, id: string): Promise<string> {
  const link = await harness.get<ExportDownload>(`/exports/${id}/download`, { token });
  expect(link.status, link.text).toBe(200);
  const response = await fetch(link.body.url);
  expect(response.status).toBe(200);
  return response.text();
}

beforeAll(async () => {
  await clearExportRowsBeforeStart();
  harness = await ApiHarness.start(ORG_ID, 'Subject Access Export Fixture Org', {
    preservePeople: true,
  });
  started = true;
  runner = harness.resolve(JobRunner);
  await harness.ensurePermissionCatalogue();

  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
  // Every section's governing key, so "holds every section" below is exercised
  // against a requester entitled to all of it. HR deliberately is not: it holds
  // `employee.manage` and not `audit.view`, which is the gap the section gate
  // closes and which `what the file may contain` covers separately.
  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);
  // `employee.view` without `employee.manage`: the refusal this feature has to
  // make is against somebody who may already read the record on screen.
  const viewerRoleId = await harness.createRole(`Employee viewer ${RUN}`, [
    PERMISSIONS.EMPLOYEE_VIEW,
    PERMISSIONS.REPORT_EXPORT,
  ]);

  const departmentId = await harness.createDepartment({
    code: `SA-DEP-${RUN}`,
    name: `Subject access ${RUN}`,
  });

  const managerId = await harness.createEmployee({
    code: `SM-${RUN}`,
    firstName: 'Anita',
    lastName: 'Rao',
    departmentId,
  });
  subjectId = await harness.createEmployee({
    code: SUBJECT_CODE,
    firstName: 'Meera',
    lastName: 'Nair',
    departmentId,
    reportingManagerId: managerId,
  });
  otherId = await harness.createEmployee({
    code: OTHER_CODE,
    firstName: 'Vikram',
    lastName: 'Deshpande',
    departmentId,
  });

  const hrUser = await harness.createUser({
    email: scopedEmail('sa-hr'),
    roleIds: [hrRoleId],
    employeeId: managerId,
  });
  const viewerUser = await harness.createUser({
    email: scopedEmail('sa-viewer'),
    roleIds: [viewerRoleId],
    employeeId: otherId,
  });
  const subjectUser = await harness.createUser({
    email: scopedEmail('sa-subject'),
    roleIds: [],
    employeeId: subjectId,
  });
  subjectUserId = subjectUser.id;

  const adminUser = await harness.createUser({
    email: scopedEmail('sa-admin-fixture'),
    roleIds: [adminRoleId],
    employeeId: null,
  });
  adminToken = (await harness.login(adminUser.email, adminUser.password)).token;
  hrToken = (await harness.login(hrUser.email, hrUser.password)).token;
  opsToken = (await harness.login(viewerUser.email, viewerUser.password)).token;

  // Rows the export must find, across the module tables it cannot import.
  await harness.db.execute(sql`
    INSERT INTO devices (org_id, employee_id, fingerprint, label, status)
    VALUES (${ORG_ID}, ${subjectId}, ${`fp-${RUN}`}, ${DEVICE_LABEL}, 'ACTIVE')
  `);
  await harness.db.execute(sql`
    INSERT INTO attendance_days (org_id, employee_id, date, status, worked_minutes, late_minutes)
    VALUES (${ORG_ID}, ${subjectId}, '2026-03-02', 'PRESENT', 480, 12)
  `);
  const leaveType = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO leave_types (org_id, code, name)
    VALUES (${ORG_ID}, ${`SA-CL-${RUN}`}, ${`Casual ${RUN}`})
    RETURNING id
  `);
  const leaveTypeId = leaveType.rows[0]?.id;
  if (leaveTypeId === undefined) throw new Error('Leave type fixture insert returned no row.');

  await harness.db.execute(sql`
    INSERT INTO leave_requests
      (org_id, employee_id, leave_type_id, from_date, to_date, total_days, reason, status)
    VALUES (${ORG_ID}, ${subjectId}, ${leaveTypeId}, '2026-03-10', '2026-03-11', 2,
            ${'Family function'}, 'APPROVED')
  `);
  await harness.db.execute(sql`
    INSERT INTO leave_ledger
      (org_id, employee_id, leave_type_id, leave_year, movement_type, days, note)
    VALUES (${ORG_ID}, ${subjectId}, ${leaveTypeId}, 2026, 'ACCRUAL', 1.5, ${'Monthly accrual'})
  `);

  // Free text somebody typed, shaped like a formula. Every reason field in this
  // export is a place an employee can put one (Security §15).
  await harness.db.execute(sql`
    INSERT INTO leave_requests
      (org_id, employee_id, leave_type_id, from_date, to_date, total_days, reason, status)
    VALUES (${ORG_ID}, ${subjectId}, ${leaveTypeId}, '2026-04-01', '2026-04-01', 1,
            ${FORMULA_REASON}, 'PENDING')
  `);

  /*
   * The subject decides somebody else's request.
   *
   * Without this the "holds nobody else" assertion below is vacuous: the
   * `approvals-decided` section is empty, so it cannot leak, and the test
   * passes while the section is free to print the other employee's name, leave
   * type, dates and the decision reason. It did exactly that, and this fixture
   * is what makes the assertion able to fail.
   *
   * `subject_summary` is written the way `subjectLineOf` writes it -- the other
   * employee's name first -- because that is the string that used to reach the
   * file.
   */
  const raised = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO approval_requests
      (org_id, type, requester_user_id, subject_type, subject_id, current_step, status,
       subject_summary, current_step_started_at, escalate_after_days)
    VALUES (${ORG_ID}, 'LEAVE', ${viewerUser.id}, 'leave_request', ${otherId}::uuid, 1, 'APPROVED',
            ${`Vikram Deshpande: Probe Leave, 2026-05-04 to 2026-05-05 (2 days)`}, now(), 3)
    RETURNING id
  `);
  const raisedId = raised.rows[0]?.id;
  if (raisedId === undefined) throw new Error('Approval request fixture returned no row.');
  await harness.db.execute(sql`
    INSERT INTO approval_steps
      (org_id, approval_request_id, step_no, approver_user_id, acted_by_user_id, action, reason, acted_at)
    VALUES (${ORG_ID}, ${raisedId}::uuid, 1, ${subjectUserId}, ${subjectUserId}, 'APPROVE',
            ${'Cover is arranged.'}, now())
  `);

  /*
   * A request the subject *raised* whose summary is somebody else's.
   *
   * `LeaveService.apply` resolves the requester as
   * `findUserIdForEmployee(employeeId) ?? principal.userId`, so when the
   * employee has no login -- REQ-B-02 allows it, REQ-A-06 imports create them
   * in bulk -- the row lands on the typist while `subject_summary` names the
   * colleague. Filtering `approvals-raised` on the requester therefore does not
   * make the summary theirs, and without this fixture that section could print
   * Vikram's leave into Meera's file with every assertion still green.
   */
  const onBehalf = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO approval_requests
      (org_id, type, requester_user_id, subject_type, subject_id, current_step, status,
       subject_summary, current_step_started_at, escalate_after_days)
    VALUES (${ORG_ID}, 'LEAVE', ${subjectUserId}, 'leave_request', ${otherId}::uuid, 1, 'PENDING',
            ${`Vikram Deshpande: Probe Leave, 2026-06-01 to 2026-06-02 (2 days)`}, now(), 3)
    RETURNING id
  `);
  if (onBehalf.rows[0] === undefined) throw new Error('On-behalf approval fixture returned no row.');

  // Both edits go through the API so the audit interceptor writes real rows --
  // one about the subject, one about somebody else. The second is the leak test.
  const patchedSubject = await harness.patch(`/employees/${subjectId}`, {
    token: hrToken,
    body: { mobile: '9800000001' },
  });
  expect(patchedSubject.status, patchedSubject.text).toBe(200);
  const patchedOther = await harness.patch(`/employees/${otherId}`, {
    token: hrToken,
    body: { mobile: '9800000002' },
  });
  expect(patchedOther.status, patchedOther.text).toBe(200);

  runner.startWorkers();
}, 120_000);

afterAll(async () => {
  if (started) await harness.close();
});

describe('POST /employees/:employeeId/data-export', () => {
  it('is refused to an account that may read an employee but not manage one', async () => {
    const denied = await harness.post<ErrorBody>(`/employees/${subjectId}/data-export`, {
      token: opsToken,
    });

    expect(denied.status).toBe(403);
    expect(denied.body.error.details?.requiredAnyOf).toEqual([PERMISSIONS.EMPLOYEE_MANAGE]);
  });

  it('is refused to an unauthenticated caller', async () => {
    const anonymous = await harness.post<ErrorBody>(`/employees/${subjectId}/data-export`);
    expect(anonymous.status).toBe(401);
  });

  it('answers 404 for an employee in another organisation, not 403', async () => {
    // A 403 would confirm the id names a real person somewhere.
    const missing = await harness.post<ErrorBody>(
      '/employees/01900000-0000-7000-8000-00000000ffff/data-export',
      { token: hrToken },
    );
    expect(missing.status).toBe(404);
  });

  it('rejects an id that is not a uuid before it reaches Postgres', async () => {
    const malformed = await harness.post<ErrorBody>('/employees/not-a-uuid/data-export', {
      token: hrToken,
    });
    expect(malformed.status).toBe(400);
  });

  it('queues a job and names the subject in the summary', async () => {
    const job = await requestExport(hrToken, subjectId);

    expect(job.status).toBe('QUEUED');
    expect(job.format).toBe('CSV');
    expect(job.filename).toContain(SUBJECT_CODE);
    expect(job.reportLabel).toContain('Meera Nair');
    expect(job.filters.employeeId).toBe(subjectId);
    expect(job.downloadable).toBe(false);
  }, 30_000);

  it('records who asked and about whom', async () => {
    await requestExport(hrToken, subjectId);

    expect(await harness.waitForAuditAction('employee.data_export.requested')).toBe(true);
    const rows = await harness.db.execute<{
      entity_id: string;
      entity_type: string;
      actor_user_id: string;
    }>(sql`
      SELECT entity_id, entity_type, actor_user_id FROM audit_logs
      WHERE org_id = ${ORG_ID} AND action = 'employee.data_export.requested'
      ORDER BY created_at DESC LIMIT 1
    `);

    const entry = rows.rows[0];
    expect(entry).toBeDefined();
    // Against the subject's record, not the requester's, so REQ-M-02's
    // per-record history answers "who has taken this person's file".
    expect(entry?.entity_type).toBe('employee');
    expect(entry?.entity_id).toBe(subjectId);
    expect(entry?.actor_user_id).not.toBe(subjectUserId);
  }, 30_000);
});

describe('the produced file', () => {
  let text = '';
  let finished: ExportJobSummary;

  beforeAll(async () => {
    const queued = await requestExport(adminToken, subjectId);
    finished = await waitForExport(adminToken, queued.id);
    expect(finished.status, finished.error ?? '').toBe('DONE');
    text = await downloadText(adminToken, queued.id);
  }, 120_000);

  it('holds every section, so an empty one is stated rather than inferred', () => {
    for (const heading of [
      'Identity and employment',
      'Roles held',
      'Devices',
      'Invitations',
      'Consent',
      'Shift assignments',
      'Attendance days',
      'Punches',
      'Leave requests',
      'Leave ledger',
      'Leave balances',
      'Comp-off credits',
      'Regularizations',
      'On-duty requests',
      'Attendance adjustments',
      'Approvals raised',
      'Approvals decided',
      'Audit entries about this person',
    ]) {
      expect(text, `section "${heading}" is missing`).toContain(`[ ${heading} ]`);
    }
  });

  it('holds the identity of the person it is about', () => {
    expect(text).toContain(SUBJECT_CODE);
    expect(text).toContain('Meera');
    expect(text).toContain('Nair');
    expect(text).toContain('9800000001');
  });

  it('holds the attendance, leave and device rows the database has for them', () => {
    expect(text).toContain(DEVICE_LABEL);
    expect(text).toContain('02-03-2026');
    expect(text).toContain('Family function');
    expect(text).toContain('Monthly accrual');
  });

  it('holds the audit trail about them', () => {
    expect(text).toContain('employee.updated');
  });

  it('renders every instant on the organisation wall clock, not raw UTC', async () => {
    // Drizzle keeps timestamps textual through a raw `execute`, so they arrive
    // as strings and slipped past the formatter in the first version of this
    // file: instants printed as `2026-08-12 10:38:06.891372+00` beside calendar
    // dates that had been converted, so one file carried two timezones.
    expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}/u);

    const timezone = await harness.orgTimezone();
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date());
    // The export ran just now, so its own audit entry carries today's date on
    // the organisation's clock.
    expect(text).toContain(local.replaceAll('/', '-'));
  });

  it('holds nobody else', () => {
    // The other employee exists, was edited through the same API in the same
    // organisation, and has an audit row of their own. None of it is this
    // person's data.
    expect(text).not.toContain(OTHER_CODE);
    expect(text).not.toContain('Vikram');
    expect(text).not.toContain('Deshpande');
    expect(text).not.toContain('9800000002');
  });

  it('neutralises free text a spreadsheet would run as a formula', () => {
    // The unit test proves `csvCell` does this; this proves the export actually
    // puts every value through it, which is the half that can silently regress.
    //
    // The payload carries a comma and quotes, so the cell is both prefixed and
    // RFC 4180 quoted, and its own quotes are doubled. Asserting on the raw
    // string would fail against a file that is correct.
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    // Nothing anywhere starts a cell with the live formula.
    expect(text).not.toMatch(/(?:^|,)"?=HYPERLINK/mu);
  });

  it('carries no credential', () => {
    // The likeliest catastrophic bug in a "give them everything" feature.
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('totp_secret');
    expect(text).not.toContain('refresh_token');
    expect(text).not.toMatch(/\$(argon2|scrypt|2[aby])\$/u);
  });

  it('names the requester and the subject in its header', () => {
    const head = text.split('\r\n').slice(0, 6).join('\n');
    expect(head).toContain('Employee data export');
    expect(head).toContain(`Meera Nair (${SUBJECT_CODE})`);
    expect(head).toContain('Requested by');
  });

  it('opens with the BOM Excel needs to read non-ASCII names', async () => {
    // Read as bytes, not as `text`: `fetch().text()` decodes through
    // TextDecoder, which strips the BOM -- so asserting on the string would
    // fail for a file that is correct, and pass for one written as UTF-16.
    const link = await harness.get<ExportDownload>(`/exports/${finished.id}/download`, {
      token: adminToken,
    });
    expect(link.status).toBe(200);
    const bytes = Buffer.from(await (await fetch(link.body.url)).arrayBuffer());

    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('appears in the Downloads tray as a finished, downloadable job', async () => {
    // The requester's own tray. `loadForRequester` pins `requestedBy`, so this
    // has to be the account that asked -- that pinning is the control which
    // keeps one person's subject-access file out of another's tray.
    const tray = await harness.get<{ data: ExportJobSummary[] }>('/exports', {
      token: adminToken,
    });
    expect(tray.status).toBe(200);

    const mine = tray.body.data.find((job) => job.id === finished.id);
    expect(mine).toBeDefined();
    expect(mine?.downloadable).toBe(true);
    expect(mine?.expiresAt).not.toBeNull();
    expect(mine?.rowCount).toBeGreaterThan(0);
  });

  it('records completion with what the file contained', async () => {
    expect(await harness.waitForAuditAction('employee.data_export.completed')).toBe(true);
  }, 30_000);
});

describe('an employee with no login account', () => {
  it('still produces a file, with the account-shaped sections empty', async () => {
    // REQ-B-02 allows an employee with no user. Every section keyed on the user
    // id has nothing to join to, and the export has to say so rather than fail.
    const accountlessId = await harness.createEmployee({
      code: `SN-${RUN}`,
      firstName: 'Ganesh',
      lastName: 'Patil',
    });

    const queued = await requestExport(hrToken, accountlessId);
    const finished = await waitForExport(hrToken, queued.id);
    expect(finished.status, finished.error ?? '').toBe('DONE');

    const file = await downloadText(hrToken, queued.id);
    expect(file).toContain('Ganesh');
    expect(file).toContain('[ Roles held ]');
    expect(file).toContain('[ Approvals raised ]');
    expect(file).toContain('[ Consent ]');
    expect(file).not.toContain(SUBJECT_CODE);
  }, 120_000);
});

/**
 * REQ-M-05's gate opens the endpoint; it does not decide what the file holds.
 *
 * Half the sections carry data another permission family owns -- punch
 * coordinates, the audit trail, leave. Without a second check the export is a
 * way around all of them, and this is reachable with no unusual configuration:
 * the seeded HR role holds `employee.manage` and not `audit.view`.
 */
describe('what the file may contain', () => {
  it('withholds the audit trail from a requester without audit.view, and says so', async () => {
    // The seeded HR permission set exactly -- employee.manage, no audit.view --
    // under its own name, because `beforeAll` already created the role called
    // "HR" and `roles_org_name_uq` allows one per organisation.
    const hrOnly = await harness.createRole(`HR again ${RUN}`, ROLE_PERMISSION_MATRIX.HR);
    const user = await harness.createUser({
      email: scopedEmail('sa-no-audit'),
      roleIds: [hrOnly],
      employeeId: null,
    });
    const token = (await harness.login(user.email, user.password)).token;

    const queued = await requestExport(token, subjectId);
    const finished = await waitForExport(token, queued.id);
    expect(finished.status, finished.error ?? '').toBe('DONE');

    const file = await downloadText(token, queued.id);

    // The heading stays -- an omitted section reads as "nothing held" -- but
    // the contents are replaced by the reason.
    expect(file).toContain('Audit entries about this person');
    expect(file).toContain('does not hold the permission that governs this data');

    // And the actual audit contents are absent. `curl/8.7.1` is a user agent
    // that only appears in an audit row; the actor emails are the identities
    // `audit.view` exists to protect.
    expect(file).not.toContain('sa-hr');
    expect(file).not.toContain('User agent');
  }, 120_000);

  it('withholds the sign-in account from a requester without roles.manage', async () => {
    /*
     * These fields used to ride along on the identity block, which renders
     * ahead of the gated loop, so their permission was never consulted.
     * `/employees/:id/access` gates the sign-in email, status and last sign-in
     * behind `roles.manage`; password-changed and locked-until are exposed by
     * no endpoint at all, which made an ungated export the only way to read
     * them.
     */
    const hrOnly = await harness.createRole(`HR no roles ${RUN}`, ROLE_PERMISSION_MATRIX.HR);
    const user = await harness.createUser({
      email: scopedEmail('sa-no-roles'),
      roleIds: [hrOnly],
      employeeId: null,
    });
    const token = (await harness.login(user.email, user.password)).token;

    const queued = await requestExport(token, subjectId);
    const finished = await waitForExport(token, queued.id);
    expect(finished.status, finished.error ?? '').toBe('DONE');

    const file = await downloadText(token, queued.id);
    expect(file).toContain('Sign-in account');
    expect(file).not.toContain('Password last changed');
    expect(file).not.toContain('Account locked until');
  }, 120_000);

  it('still gives an Admin the audit trail, so the gate is not simply off', async () => {
    // The falsification for the test above: if the gate withheld the section
    // from everybody, that test would pass while the feature was broken.
    const adminRole = await harness.createRole(`Admin again ${RUN}`, ROLE_PERMISSION_MATRIX.Admin);
    const user = await harness.createUser({
      email: scopedEmail('sa-admin'),
      roleIds: [adminRole],
      employeeId: null,
    });
    const token = (await harness.login(user.email, user.password)).token;

    const queued = await requestExport(token, subjectId);
    const finished = await waitForExport(token, queued.id);
    expect(finished.status, finished.error ?? '').toBe('DONE');

    const file = await downloadText(token, queued.id);
    expect(file).toContain('Audit entries about this person');
    expect(file).not.toContain('does not hold the permission that governs this data');
    expect(file).toContain('User agent');
  }, 120_000);
});

describe('the job', () => {
  it('refuses rather than retries when the requester loses the permission', async () => {
    const strippedRole = await harness.createRole(`Briefly HR ${RUN}`, [
      PERMISSIONS.EMPLOYEE_MANAGE,
      PERMISSIONS.REPORT_EXPORT,
    ]);
    const user = await harness.createUser({
      email: scopedEmail('sa-revoked'),
      roleIds: [strippedRole],
      employeeId: null,
    });
    const token = (await harness.login(user.email, user.password)).token;

    const queued = await requestExport(token, subjectId);
    // Suspending the account is the revocation the job has to notice: the
    // endpoint checked minutes ago, and an export of a whole record is exactly
    // what somebody about to lose access would race for.
    await harness.db.execute(sql`
      UPDATE users SET status = 'SUSPENDED' WHERE id = ${user.id}
    `);

    const deadline = Date.now() + 60_000;
    for (;;) {
      const rows = await harness.db.execute<{ status: string; error: string | null }>(sql`
        SELECT status, error FROM export_jobs WHERE id = ${queued.id}
      `);
      const row = rows.rows[0];
      if (row?.status === 'FAILED' || row?.status === 'DONE') {
        expect(row.status).toBe('FAILED');
        expect(row.error).toContain('no longer manage employees');
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Export ${queued.id} never settled; last status ${row?.status ?? '?'}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 120_000);
});
