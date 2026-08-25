import type { Abstract, INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ROLE_PERMISSION_MATRIX,
  uuidv7,
  type EmployeeStatus,
  type EmploymentType,
  type PermissionKey,
  type SystemRoleName,
} from '@vyuha/shared';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { expect } from 'vitest';

import type { Redis } from 'ioredis';

import { AppModule } from '../app.module.js';
import { loginRateLimitKey } from '../platform/auth/login-rate-limit.service.js';
import { passwordResetIpKey } from '../platform/auth/password-reset-rate-limit.service.js';
import { hashPassword } from '../platform/auth/password.js';
import { API_PREFIX_PATH } from '../platform/common/constants.js';
import { env } from '../platform/common/env.js';
import { DRIZZLE, type Database } from '../platform/db/db.provider.js';
import { Mailer, type OutboundMail } from '../platform/mail/mailer.js';
import { REDIS_CLIENT } from '../platform/redis/redis.provider.js';
import { SessionService } from '../platform/auth/session.service.js';
import {
  consentAcceptances,
  departments,
  designations,
  employees,
  invitations,
  locations,
  organizations,
  passwordResets,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
} from '../platform/db/schema/index.js';
import { RecordingMailer } from './recording-mailer.js';

/**
 * Boots the real application and talks to it over real HTTP.
 *
 * Not a mocked controller and not `createTestingModule` with the guard
 * overridden. The things this phase has to prove -- deny by default, refresh
 * reuse revoking a family, a lockout that survives the correct password -- are
 * properties of the whole stack: the global guard, the exception filter, the
 * audit interceptor, and the SQL that reaches Postgres. Any of those replaced
 * by a stub is one of the places the guarantee could actually break.
 *
 * One application per test file, on its own port.
 *
 * The per-IP login limiter (REQ-B-10) now lives in Redis rather than in
 * process memory, which means every test file shares one budget for the
 * loopback address -- and several files spend it deliberately, proving the
 * lockout works. `start` therefore clears that address the way it truncates
 * tables: resetting state the previous run created, not relaxing the control.
 * The limit itself is never changed for tests.
 */

const TEST_PASSWORD_HASHES = new Map<string, string>();

export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
  readonly text: string;
}

export interface RequestOptions {
  readonly token?: string | null;
  readonly body?: unknown;
  /** Sends the jar's cookies, and stores whatever comes back. */
  readonly withCookies?: boolean;
  readonly cookieOverride?: string | null;
  readonly headers?: Record<string, string>;
}

export class CookieJar {
  private readonly values = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const first = raw.split(';')[0] ?? '';
      const separator = first.indexOf('=');
      if (separator < 0) continue;
      const name = first.slice(0, separator).trim();
      const value = first.slice(separator + 1).trim();
      if (value.length === 0) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  header(): string | null {
    if (this.values.size === 0) return null;
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [name, value] of this.values) copy.values.set(name, value);
    return copy;
  }
}

export interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly employeeId: string | null;
}

export interface HarnessOptions {
  /**
   * Skips the employee/master-data wipe in `resetOrganisation`.
   *
   * Required by any fixture that records a punch: `punches` is append-only
   * (REQ-D-12, enforced by trigger), `punches.employee_id` is RESTRICT, so an
   * employee who has ever punched can never be deleted. A file using this must
   * create its people with per-run unique codes instead -- reusing a code
   * would reuse an employee whose punch state from the previous run is still
   * standing, and "already punched in" failures would depend on which run came
   * before.
   */
  readonly preservePeople?: boolean;
}

export class ApiHarness {
  private constructor(
    private readonly app: INestApplication,
    readonly baseUrl: string,
    readonly db: Database,
    readonly orgId: string,
    private readonly recorded: RecordingMailer | null,
  ) {}

  /**
   * Everything the application tried to send.
   *
   * Throws rather than returning an empty recorder for a harness started with
   * `startWithRealMailer`, where by design nothing is captured: silently
   * answering "no mail" there would let a test assert an absence that was never
   * observed.
   */
  get mail(): RecordingMailer {
    if (this.recorded === null) {
      throw new Error(
        'This harness booted the application\'s own mailer, so nothing was recorded. Use ApiHarness.start for tests that read messages.',
      );
    }
    return this.recorded;
  }

  /**
   * `orgId` is fixed per test file rather than random, so a re-run reuses the
   * same organisation row. It has to: `audit_logs.org_id` is a restricted
   * foreign key and the table is append-only, so once a test has produced an
   * audit row its organisation can never be deleted. A random id per run would
   * leave a permanent new orphan behind every time the suite ran.
   */
  static async start(
    orgId: string,
    orgName: string,
    options: HarnessOptions = {},
  ): Promise<ApiHarness> {
    // Guards against a Homebrew Postgres answering on the default port: the
    // whole suite would pass against an empty, wrong database.
    expect(new URL(env.DATABASE_URL).port).toBe('55432');

    // The real AppModule, with exactly one provider replaced: see
    // `RecordingMailer` for why, and why it changes nothing under test.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Mailer)
      .useClass(RecordingMailer)
      .compile();

    // VYUHA_TEST_LOGS=1 surfaces the errors a 500 hides; silent otherwise so a run reads clean.
    const app = moduleRef.createNestApplication({ logger: process.env.VYUHA_TEST_LOGS === '1' ? (['error', 'warn'] as const) : false, rawBody: true });
    app.setGlobalPrefix(API_PREFIX_PATH.slice(1));
    await app.listen(0);

    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const db = app.get<Database>(DRIZZLE);
    const mail = app.get(Mailer);
    if (!(mail instanceof RecordingMailer)) {
      throw new Error('Harness failed to install the recording mailer.');
    }

    const harness = new ApiHarness(app, `${url}${API_PREFIX_PATH}`, db, orgId, mail);
    await harness.resetOrganisation(orgName, options.preservePeople ?? false);
    await harness.clearLoginRateLimit();
    await harness.clearPasswordResetRateLimit();
    return harness;
  }

  /**
   * The same application with **no provider replaced at all**, so `MailModule`
   * binds whichever transport `MAIL_TRANSPORT` selects.
   *
   * `start` swaps in `RecordingMailer`, which always succeeds -- which is
   * exactly what a test of "this works without a mail server" must not rely on.
   * A build that still needed SMTP would pass against a recorder and fail on
   * the first real deployment. Here the mailer is the one the shipped default
   * chooses, and the caller asserts which class arrived.
   */
  static async startWithRealMailer(orgId: string, orgName: string): Promise<ApiHarness> {
    expect(new URL(env.DATABASE_URL).port).toBe('55432');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    // VYUHA_TEST_LOGS=1 surfaces the errors a 500 hides; silent otherwise so a run reads clean.
    const app = moduleRef.createNestApplication({ logger: process.env.VYUHA_TEST_LOGS === '1' ? (['error', 'warn'] as const) : false, rawBody: true });
    app.setGlobalPrefix(API_PREFIX_PATH.slice(1));
    await app.listen(0);

    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const harness = new ApiHarness(
      app,
      `${url}${API_PREFIX_PATH}`,
      app.get<Database>(DRIZZLE),
      orgId,
      null,
    );
    await harness.resetOrganisation(orgName, false);
    await harness.clearLoginRateLimit();
    await harness.clearPasswordResetRateLimit();
    return harness;
  }

  /**
   * Frees the per-IP login budget for the loopback address.
   *
   * Every form the local stack can report: Express sees `::1` over IPv6 and
   * `::ffff:127.0.0.1` when IPv6 accepts an IPv4 connection, and neither is
   * the address the test dialled.
   *
   * The agent scope is cleared alongside, and became necessary the day a
   * successful agent resolve stopped clearing its address (it releases only
   * its own slot now): every deliberate bad-token probe across the sync
   * suites leaves a recorded failure for loopback, and twenty of them inside
   * fifteen minutes would 429 the next suite's honest fixture.
   */
  async clearLoginRateLimit(): Promise<void> {
    const redis = this.app.get<Redis>(REDIS_CLIENT);
    await redis.del(
      ...['::1', '127.0.0.1', '::ffff:127.0.0.1'].flatMap((ip) => [
        loginRateLimitKey(ip),
        loginRateLimitKey(ip, 'agent'),
        loginRateLimitKey(ip, 'webhook'),
        // 15 REQ-AL-05: the portal's window is fifteen minutes long and
        // loopback is one address, so a suite run twice within it inherits
        // the first run's refusals and starts already throttled.
        loginRateLimitKey(ip, 'portal'),
      ]),
    );
  }

  /**
   * Frees the per-IP password-reset budget for the same loopback addresses.
   * The per-address budget needs no clearing: `scopedEmail` mints a unique
   * address per run, so no run can inherit another's spend.
   */
  async clearPasswordResetRateLimit(): Promise<void> {
    const redis = this.app.get<Redis>(REDIS_CLIENT);
    await redis.del(
      ...['::1', '127.0.0.1', '::ffff:127.0.0.1'].map((ip) => passwordResetIpKey(ip)),
    );
  }

  /**
   * Closes the refresh rotation tolerance window for one token.
   *
   * REQ-B-05 accepts a repeat of the same refresh token for a few seconds and
   * returns the same replacement, so two tabs booting together do not look
   * like theft. A test about *reuse* therefore has to put itself outside that
   * window, and the honest way to do that without sleeping is to drop the
   * entry the window is made of -- which is exactly what its expiry does a
   * moment later.
   *
   * Takes the token, not the key, so the test never has to know how the key is
   * built; hashing it the way the service does is the point.
   */
  async expireRefreshReplayWindow(refreshToken: string): Promise<void> {
    const redis = this.app.get<Redis>(REDIS_CLIENT);
    const service = this.app.get(SessionService);
    await redis.del(service.replayKeyForTest(refreshToken));
  }

  /**
   * The organisation's IANA timezone.
   *
   * Anything a test computes as "today" has to be computed in this zone,
   * because that is the zone the server reduces `now()` in. A test that uses
   * `toISOString()` instead agrees with the server for most of the day and
   * disagrees for the offset -- five and a half hours a night for an Indian
   * organisation -- which reads as a broken feature rather than a broken
   * fixture.
   */
  async orgTimezone(): Promise<string> {
    const rows = await this.db.execute<{ timezone: string }>(
      sql`SELECT timezone FROM organizations WHERE id = ${this.orgId}`,
    );
    const timezone = rows.rows[0]?.timezone;
    if (timezone === undefined) throw new Error(`No organisation ${this.orgId}`);
    return timezone;
  }

  async close(): Promise<void> {
    await this.app.close();
  }

  /**
   * Pulls a provider out of the running container.
   *
   * For the services that have no HTTP surface of their own -- `FileService`
   * is the one today -- so a test can exercise the real, fully injected
   * instance rather than constructing one with hand-made collaborators and
   * proving only that the constructor works.
   */
  resolve<T>(token: Type<T> | Abstract<T> | string | symbol): T {
    return this.app.get<T>(token);
  }

  // ------------------------------------------------------------------ http

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
    jar?: CookieJar,
  ): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token != null) headers.authorization = `Bearer ${options.token}`;

    const cookie =
      options.cookieOverride !== undefined
        ? options.cookieOverride
        : options.withCookies === true && jar !== undefined
          ? jar.header()
          : null;
    if (cookie !== null) headers.cookie = cookie;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (jar !== undefined && options.withCookies === true) jar.absorb(response);

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // A non-JSON body is a failure worth seeing in the assertion rather
        // than a parse error thrown from the harness.
        body = { raw: text };
      }
    }

    return { status: response.status, body: body as T, headers: response.headers, text };
  }

  post<T = unknown>(path: string, options?: RequestOptions, jar?: CookieJar): Promise<HttpResult<T>> {
    return this.request<T>('POST', path, options, jar);
  }

  get<T = unknown>(path: string, options?: RequestOptions, jar?: CookieJar): Promise<HttpResult<T>> {
    return this.request<T>('GET', path, options, jar);
  }

  /** A binary GET — an export, a photograph — with the body as bytes rather than parsed JSON. */
  async getRaw(path: string, options: RequestOptions = {}): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token != null) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(`${this.baseUrl}${path}`, { method: 'GET', headers });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  }

  patch<T = unknown>(path: string, options?: RequestOptions, jar?: CookieJar): Promise<HttpResult<T>> {
    return this.request<T>('PATCH', path, options, jar);
  }

  put<T = unknown>(path: string, options?: RequestOptions, jar?: CookieJar): Promise<HttpResult<T>> {
    return this.request<T>('PUT', path, options, jar);
  }

  /**
   * `del` rather than `delete`, which is a reserved word as a bare method name
   * in some call positions. The body is not optional in practice: every DELETE
   * this API exposes takes a reason (technical design §6).
   */
  del<T = unknown>(path: string, options?: RequestOptions, jar?: CookieJar): Promise<HttpResult<T>> {
    return this.request<T>('DELETE', path, options, jar);
  }

  // -------------------------------------------------------------- fixtures

  /**
   * Removes everything this organisation owns except the organisation row and
   * its audit trail, both of which cannot be deleted (see `start`).
   *
   * With `preservePeople`, employees and the masters they point at survive
   * too -- see `HarnessOptions` for why a punch fixture has no other choice.
   */
  async resetOrganisation(name: string, preservePeople = false): Promise<void> {
    await this.db
      .insert(organizations)
      .values({ id: this.orgId, name })
      .onConflictDoUpdate({ target: organizations.id, set: { name, deletedAt: null } });

    const ownUsers = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.orgId, this.orgId));
    const userIds = ownUsers.map((row) => row.id);

    // Before `users`, and before anything else that points at them.
    //
    // Applying for leave raises an approval request (REQ-I-01), and all three
    // approval tables reference `users` with RESTRICT -- so from the leave /
    // approvals join onwards, any fixture whose people ever applied for leave
    // makes the `users` delete below fail with a foreign key violation on the
    // *second* run of that file. Raw SQL rather than the Drizzle tables so this
    // platform-facing helper does not import a module's schema.
    //
    // `leave_requests.approval_request_id` is ON DELETE SET NULL, so leave
    // requests that outlive their approvals simply lose the link.
    await this.db.execute(sql`DELETE FROM approval_steps WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM approval_delegations WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM approval_requests WHERE org_id = ${this.orgId}`);

    if (userIds.length > 0) {
      await this.db.delete(sessions).where(inArray(sessions.userId, userIds));
      await this.db.delete(passwordResets).where(inArray(passwordResets.userId, userIds));
      await this.db.delete(userRoles).where(inArray(userRoles.userId, userIds));
      // Before `users`: consent references them with RESTRICT (REQ-M-03).
      await this.db
        .delete(consentAcceptances)
        .where(inArray(consentAcceptances.userId, userIds));
    }

    // Claimed notification keys are durable on purpose (audit 20), so a file
    // that emits with a fixed key would find it already claimed on its second
    // run and see the notice suppressed.
    await this.db.execute(sql`DELETE FROM notification_idempotency WHERE org_id = ${this.orgId}`);
    await this.db.delete(invitations).where(eq(invitations.orgId, this.orgId));
    await this.db.delete(users).where(eq(users.orgId, this.orgId));

    const ownRoles = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.orgId, this.orgId));
    if (ownRoles.length > 0) {
      await this.db.delete(rolePermissions).where(
        inArray(
          rolePermissions.roleId,
          ownRoles.map((row) => row.id),
        ),
      );
      await this.db.delete(roles).where(eq(roles.orgId, this.orgId));
    }

    // Holiday calendars, which nothing cleared. They accumulated run after
    // run -- 467 of them in one fixture organisation -- and a suite that
    // lists them a page at a time eventually found its own fixture past the
    // end of the first page and failed on an undefined. Safe to delete
    // outright: holidays cascade, and the employee and location references
    // are ON DELETE SET NULL.
    await this.db.execute(sql`DELETE FROM holiday_calendars WHERE org_id = ${this.orgId}`);

    if (preservePeople) return;

    // Requests that reference an employee with RESTRICT, cleared before the
    // employees they point at.
    //
    // These were absent while nothing wrote them, and the day that changed the
    // symptom was a foreign-key violation inside `beforeAll` of two unrelated
    // suites that happened to share an org id with the one that did. Deleting
    // them here does not make sharing an id safe -- `punches` is append-only
    // and can never be cleared, so a punch-writing suite still needs an id of
    // its own -- but it removes one silent way for two files to break each
    // other, and the failure that remains names `punches` and points straight
    // at the cause. Raw SQL because these tables live in `modules/attendance`
    // and this file is test support for the whole application.
    await this.db.execute(
      sql`DELETE FROM attendance_adjustments WHERE org_id = ${this.orgId}`,
    );
    await this.db.execute(sql`DELETE FROM regularizations WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM on_duty_requests WHERE org_id = ${this.orgId}`);
    // CRM records own an employee (`owner_id`, RESTRICT), so they go before
    // the employees do — same reasoning, same raw SQL.
    // Fulfilment and procurement rows point at documents, lines and stock items.
    // 15 Area AJ: a collector assignment holds an employee (RESTRICT) and a
    // party, and a promise holds both; all three go before either does.
    await this.db.execute(sql`DELETE FROM reminder_notices WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM promises_to_pay WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM collector_assignments WHERE org_id = ${this.orgId}`);
    // 15 Area AL: a portal key holds a party (RESTRICT), and the access log
    // holds the key, so both go before anything clears the projection.
    await this.db.execute(sql`DELETE FROM portal_access_log WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM portal_link_keys WHERE org_id = ${this.orgId}`);
    // 15 Area AK: a return holds an employee (RESTRICT), a dispatch and the
    // document lines it came off, so it goes before every one of them.
    // D-23: the receivable snapshot holds parties RESTRICT, and the nightly
    // job writes it for every organisation -- this fixture's included. Same
    // story as the interest snapshots below: cleared before the party
    // delete, or rows a job wrote between runs block it.
    await this.db.execute(sql`DELETE FROM fact_receivable_snapshot WHERE org_id = ${this.orgId}`);
    // The interest snapshots reference parties and stock items RESTRICT, and
    // the nightly build (or a hand-triggered one) writes them for every
    // organisation -- including this fixture's. Cleared first, or the party
    // and stock deletes below die on rows a job wrote between runs.
    await this.db.execute(sql`DELETE FROM interest_daily_party WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM interest_daily_stock WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM interest_party_settings WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM interest_build_state WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_return_credit_notes WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_return_attachments WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_return_lines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_returns WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM dispatch_notifications WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM dispatch_attachments WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM dispatch_lines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM dispatches WHERE org_id = ${this.orgId}`);
    // D-48: the pick tables reference the lines too, so they go first.
    await this.db.execute(sql`DELETE FROM pick_record_lines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM pick_records WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM pack_record_lines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM pack_records WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_order_invoices WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM grn_lines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM grns WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM po_line_requirements WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM purchase_order_notifications WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM purchase_order_lines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM purchase_orders WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM item_vendors WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM procurement_requirements WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM item_settings WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM document_sequences WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_document_lines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_documents WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM sales_document_sequences WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM crm_deals WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM crm_pipeline_stages WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM crm_pipelines WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM crm_contacts WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM crm_companies WHERE org_id = ${this.orgId}`);
    // Tasks point at employees twice (assignee, owner) and at their column.
    await this.db.execute(sql`DELETE FROM tasks WHERE org_id = ${this.orgId}`);
    await this.db.execute(sql`DELETE FROM task_board_columns WHERE org_id = ${this.orgId}`);

    // Employees reference each other through reporting_manager_id and
    // departments through head_employee_id, so the links are cut before the
    // rows go, rather than relying on a delete order that happens to work.
    await this.db
      .update(employees)
      .set({ reportingManagerId: null, departmentId: null })
      .where(eq(employees.orgId, this.orgId));
    await this.db
      .update(departments)
      .set({ headEmployeeId: null, parentId: null })
      .where(eq(departments.orgId, this.orgId));
    await this.db.delete(employees).where(eq(employees.orgId, this.orgId));
    await this.db.delete(departments).where(eq(departments.orgId, this.orgId));
    // After the employees that point at them, so the foreign keys have nothing
    // left to cascade to null.
    await this.db.delete(designations).where(eq(designations.orgId, this.orgId));
    await this.db.delete(locations).where(eq(locations.orgId, this.orgId));
    this.fixtureOfficeId = null;
  }

  /** Ensures the global permission catalogue exists, without running the seed. */
  async ensurePermissionCatalogue(): Promise<Map<PermissionKey, string>> {
    const { ALL_PERMISSIONS, PERMISSION_DESCRIPTIONS } = await import('@vyuha/shared');
    await this.db
      .insert(permissions)
      .values(ALL_PERMISSIONS.map((key) => ({ key, description: PERMISSION_DESCRIPTIONS[key] })))
      .onConflictDoNothing({ target: permissions.key });

    const rows = await this.db.select({ id: permissions.id, key: permissions.key }).from(permissions);
    return new Map(rows.map((row) => [row.key as PermissionKey, row.id]));
  }

  /**
   * `isSystem` defaults to false, which is *not* what the seed does for the
   * four named roles. A test asserting the seeded-role protection has to opt
   * in, or it passes because there is nothing to protect.
   */
  async createRole(
    name: string,
    keys: readonly PermissionKey[],
    options: { isSystem?: boolean } = {},
  ): Promise<string> {
    const catalogue = await this.ensurePermissionCatalogue();
    const inserted = await this.db
      .insert(roles)
      .values({ orgId: this.orgId, name, isSystem: options.isSystem ?? false })
      .returning({ id: roles.id });

    const role = inserted[0];
    if (role === undefined) throw new Error('Role fixture insert returned no row.');

    if (keys.length > 0) {
      await this.db.insert(rolePermissions).values(
        keys.map((key) => {
          const permissionId = catalogue.get(key);
          if (permissionId === undefined) throw new Error(`Permission "${key}" is not seeded.`);
          return { roleId: role.id, permissionId };
        }),
      );
    }

    return role.id;
  }

  createSystemRole(name: SystemRoleName, options: { isSystem?: boolean } = {}): Promise<string> {
    return this.createRole(name, ROLE_PERMISSION_MATRIX[name], options);
  }

  /**
   * Hashing is memoised across fixtures because scrypt is deliberately slow
   * and a suite that hashes the same fixture password thirty times spends most
   * of its wall clock proving that scrypt works.
   */
  private async fixtureHash(password: string): Promise<string> {
    const cached = TEST_PASSWORD_HASHES.get(password);
    if (cached !== undefined) return cached;
    const hash = await hashPassword(password);
    TEST_PASSWORD_HASHES.set(password, hash);
    return hash;
  }

  async createUser(input: {
    email: string;
    password?: string;
    roleIds?: readonly string[];
    status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
    employeeId?: string | null;
  }): Promise<SeededUser> {
    const password = input.password ?? 'fixture-passphrase-2026';
    const status = input.status ?? 'ACTIVE';

    const inserted = await this.db
      .insert(users)
      .values({
        orgId: this.orgId,
        email: input.email.toLowerCase(),
        passwordHash: status === 'INVITED' ? null : await this.fixtureHash(password),
        status,
        employeeId: input.employeeId ?? null,
        passwordChangedAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: users.id, email: users.email });

    const row = inserted[0];
    if (row === undefined) throw new Error('User fixture insert returned no row.');

    for (const roleId of input.roleIds ?? []) {
      await this.db.insert(userRoles).values({ userId: row.id, roleId });
    }

    return { id: row.id, email: row.email, password, employeeId: input.employeeId ?? null };
  }

  async createEmployee(input: {
    code: string;
    firstName: string;
    lastName?: string | null;
    reportingManagerId?: string | null;
    departmentId?: string | null;
    designationId?: string | null;
    locationId?: string | null;
    status?: EmployeeStatus;
    dateOfJoining?: string;
    dateOfLeaving?: string | null;
    employmentType?: EmploymentType;
  }): Promise<string> {
    const inserted = await this.db
      .insert(employees)
      .values({
        orgId: this.orgId,
        employeeCode: input.code,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        dateOfJoining: input.dateOfJoining ?? '2026-01-01',
        dateOfLeaving: input.dateOfLeaving ?? null,
        status: input.status ?? 'ACTIVE',
        employmentType: input.employmentType ?? 'PERMANENT',
        reportingManagerId: input.reportingManagerId ?? null,
        departmentId: input.departmentId ?? null,
        designationId: input.designationId ?? null,
        // Undefined means "an ordinary employee", and an ordinary employee
        // works at an office with coordinates - a punch from nowhere is
        // refused (owner, 21 Aug 2026). An explicit null keeps them placeless.
        locationId: input.locationId === undefined ? await this.fixtureOffice() : input.locationId,
      })
      .returning({ id: employees.id });

    const row = inserted[0];
    if (row === undefined) throw new Error('Employee fixture insert returned no row.');
    return row.id;
  }

  private fixtureOfficeId: string | null = null;

  /** The one office every placeless fixture employee is put at, created on first use. */
  async fixtureOffice(): Promise<string> {
    if (this.fixtureOfficeId === null) {
      // Idempotent across harness instances on the same organisation: the
      // cache is per instance, the row is per org.
      const existing = await this.db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.orgId, this.orgId), eq(locations.code, 'FIXTURE-HQ'), isNull(locations.deletedAt)))
        .limit(1);
      this.fixtureOfficeId =
        existing[0]?.id ?? (await this.createLocation({ code: 'FIXTURE-HQ', name: 'Fixture office' }));
    }
    return this.fixtureOfficeId;
  }

  async createDesignation(input: { code: string; name: string; grade?: string }): Promise<string> {
    const inserted = await this.db
      .insert(designations)
      .values({
        orgId: this.orgId,
        code: input.code,
        name: input.name,
        grade: input.grade ?? null,
      })
      .returning({ id: designations.id });

    const row = inserted[0];
    if (row === undefined) throw new Error('Designation fixture insert returned no row.');
    return row.id;
  }

  /**
   * Every fixture office has coordinates unless a test says `geofence: null`,
   * because a punch at an office without them is refused (owner, 21 Aug
   * 2026) and almost no test is about that refusal.
   */
  async createLocation(input: {
    code: string;
    name: string;
    geofence?: { latitude: number; longitude: number; radiusM?: number } | null;
  }): Promise<string> {
    const geofence = input.geofence === undefined ? FIXTURE_OFFICE : input.geofence;
    const inserted = await this.db
      .insert(locations)
      .values({
        orgId: this.orgId,
        code: input.code,
        name: input.name,
        geofenceLat: geofence?.latitude ?? null,
        geofenceLng: geofence?.longitude ?? null,
        geofenceRadiusM: geofence?.radiusM ?? 100,
      })
      .returning({ id: locations.id });

    const row = inserted[0];
    if (row === undefined) throw new Error('Location fixture insert returned no row.');
    return row.id;
  }

  async createDepartment(input: {
    code: string;
    name: string;
    headEmployeeId?: string | null;
  }): Promise<string> {
    const inserted = await this.db
      .insert(departments)
      .values({
        orgId: this.orgId,
        code: input.code,
        name: input.name,
        headEmployeeId: input.headEmployeeId ?? null,
      })
      .returning({ id: departments.id });

    const row = inserted[0];
    if (row === undefined) throw new Error('Department fixture insert returned no row.');
    return row.id;
  }

  async setDepartmentHead(departmentId: string, employeeId: string): Promise<void> {
    await this.db
      .update(departments)
      .set({ headEmployeeId: employeeId })
      .where(eq(departments.id, departmentId));
  }

  // ----------------------------------------------------------- convenience

  /** Signs in over HTTP and returns the access token plus a populated jar. */
  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; jar: CookieJar; status: number }> {
    const jar = new CookieJar();
    const result = await this.post<{ accessToken?: string }>(
      '/auth/login',
      { body: { email, password }, withCookies: true },
      jar,
    );
    return { token: result.body.accessToken ?? '', jar, status: result.status };
  }

  /** The most recent actions recorded for this organisation. */
  async lastAuditActions(limit = 10): Promise<string[]> {
    const rows = await this.db.execute<{ action: string }>(
      sql`SELECT action FROM audit_logs WHERE org_id = ${this.orgId} ORDER BY created_at DESC LIMIT ${limit}`,
    );
    return rows.rows.map((row) => row.action);
  }

  /**
   * Polls until the row appears, or gives up.
   *
   * `AuditInterceptor` deliberately does not make the response wait on the
   * insert -- an audit write must never be what makes a punch slow, or what
   * makes it fail. The consequence is that a query issued the instant a
   * request returns can legitimately find nothing, and asserting straight
   * after the response produced exactly that flake twice while this suite was
   * being written. Waiting is the correct assertion, not a workaround.
   */
  async waitForAuditAction(action: string, timeoutMs = 3_000): Promise<boolean> {
    return this.pollAudit(
      sql`SELECT 1 FROM audit_logs WHERE org_id = ${this.orgId} AND action = ${action} LIMIT 1`,
      timeoutMs,
    );
  }

  /**
   * The precise row: this action, on this record. `waitForAuditAction` alone
   * can be satisfied by a row an earlier run of the same file left behind --
   * the audit trail is append-only and outlives `resetOrganisation` -- and
   * `waitForAuditEntity` by any action on the record, including the one that
   * created it.
   */
  async waitForAuditEntityAction(entityId: string, action: string, timeoutMs = 3_000): Promise<boolean> {
    return this.pollAudit(
      sql`SELECT 1 FROM audit_logs WHERE org_id = ${this.orgId} AND entity_id = ${entityId} AND action = ${action} LIMIT 1`,
      timeoutMs,
    );
  }

  async waitForAuditEntity(entityId: string, timeoutMs = 3_000): Promise<boolean> {
    return this.pollAudit(
      sql`SELECT 1 FROM audit_logs WHERE org_id = ${this.orgId} AND entity_id = ${entityId} LIMIT 1`,
      timeoutMs,
    );
  }

  private async pollAudit(query: SQL, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await this.db.execute(query);
      if (rows.rows.length > 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Polls the recording mailer until a message to `email` appears, or gives up
   * and returns null.
   *
   * For the sends that no longer happen on the request path: the password-reset
   * mail is queued and delivered by a worker (REQ-B-04), so a request returning
   * 202 says the job was accepted, not that the message exists yet. A caller
   * must have started the workers -- `JobRunner.startWorkers()` -- or this can
   * only ever time out.
   */
  async waitForMailTo(email: string, timeoutMs = 10_000): Promise<OutboundMail | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.mail.lastTo(email);
      if (found !== null) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** A unique-enough email so a re-run does not collide on the unique index. */
/** Where every fixture office stands, and where every fixture punch is taken from. */
export const FIXTURE_OFFICE = { latitude: 19.076, longitude: 72.8777, radiusM: 100 } as const;

export function scopedEmail(label: string): string {
  return `${label}.${uuidv7().slice(-12)}@vyuha.test`;
}
