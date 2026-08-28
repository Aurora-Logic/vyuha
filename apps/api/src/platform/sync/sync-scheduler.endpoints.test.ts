import { PERMISSIONS, SYSTEM_ROLES } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import {
  NotificationDispatcher,
  type NotificationEvent,
} from '../notifications/notification.dispatcher.js';
import { SyncSchedulerService } from './sync-scheduler.service.js';

/**
 * REQ-R-07: pull work exists on a schedule and on demand — and never piles
 * up. The property under test is the one-open-job invariant: however many
 * sweeps run and however many times the button is pressed, a connection
 * holds at most one open pull job per entity type, because the schema says
 * so and the enqueue only ever tries.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000be';

let harness: ApiHarness;
let scheduler: SyncSchedulerService;
let adminToken: string;
let employeeToken: string;

/** Bound + token issued: the sweep should enqueue for this one. */
let eligibleId = '';
/** No company GUID: enqueuing would create work whose refusal is known. */
let unboundId = '';

async function openJobCount(connectionId: string): Promise<number> {
  const rows = await harness.db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM sync_jobs
     WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Sync Scheduler Fixture Org');
  scheduler = harness.resolve(SyncSchedulerService);

  // Same reasoning as the agent suite: jobs and cursors are this file's own
  // to delete; connections soft-delete so a future journal row cannot wedge
  // the cleanup.
  await harness.db.execute(sql`DELETE FROM sync_jobs WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_cursors WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('sched-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({
    email: scopedEmail('sched-employee'),
    roleIds: [employeeRoleId],
  });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const inserted = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid, agent_token_hash)
    VALUES (${ORG_ID}, 'TALLY', 'Eligible Co', 'guid-eligible', 'hash-of-a-token')
    RETURNING id
  `);
  eligibleId = inserted.rows[0]?.id ?? '';

  const unbound = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, agent_token_hash)
    VALUES (${ORG_ID}, 'TALLY', 'Unbound Co', 'hash-of-another-token')
    RETURNING id
  `);
  unboundId = unbound.rows[0]?.id ?? '';
});

afterAll(async () => {
  await harness.close();
});

// One open job per writable entity type: party, stock_item, price_list,
// bill_allocation.
const WRITABLE_TYPES = 4;

describe('the fifteen-minute sweep (REQ-R-07)', () => {
  it('enqueues one pull per entity type per eligible connection, skips the ineligible', async () => {
    await scheduler.enqueueDuePulls();

    expect(await openJobCount(eligibleId)).toBe(WRITABLE_TYPES);
    // Unbound: the claim path would refuse this connection's jobs anyway,
    // so the sweep does not create them.
    expect(await openJobCount(unboundId)).toBe(0);
  });

  it('a second sweep adds nothing while the jobs are open', async () => {
    const outcome = await scheduler.enqueueDuePulls();
    // Other tenants' connections may legitimately be enqueued by this sweep;
    // what must hold is this connection's count, guarded by the schema.
    expect(outcome.enqueued).toBeGreaterThanOrEqual(0);
    expect(await openJobCount(eligibleId)).toBe(WRITABLE_TYPES);
  });

  it('requeues a claim whose agent went silent, and fails one past the attempt cap', async () => {
    // A stale claim wedges the queue forever without this: CLAIMED counts as
    // open, so the sweep could never replace it. Older than the takeover
    // threshold means the claiming agent has been silent past the point a
    // rival may seize its lease.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'CLAIMED', claimed_by = 'dead-instance',
             claimed_at = now() - interval '6 minutes', attempts = 1
       WHERE connection_id = ${eligibleId} AND state = 'QUEUED'
    `);
    const outcome = await scheduler.enqueueDuePulls();
    expect(outcome.requeued).toBeGreaterThanOrEqual(WRITABLE_TYPES);
    const requeued = await harness.db.execute<{ state: string; claimed_by: string | null }>(sql`
      SELECT state, claimed_by FROM sync_jobs
       WHERE connection_id = ${eligibleId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    expect(requeued.rows.every((row) => row.state === 'QUEUED')).toBe(true);
    expect(requeued.rows.every((row) => row.claimed_by === null)).toBe(true);

    // Five failed claims is a diagnosis, not bad luck: the job fails
    // visibly instead of cycling.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'CLAIMED', claimed_by = 'dead-instance',
             claimed_at = now() - interval '6 minutes', attempts = 5
       WHERE connection_id = ${eligibleId} AND state = 'QUEUED'
    `);
    const second = await scheduler.enqueueDuePulls();
    expect(second.failed).toBeGreaterThanOrEqual(WRITABLE_TYPES);
    // And the freed slots are refilled in the same sweep.
    expect(await openJobCount(eligibleId)).toBe(WRITABLE_TYPES);
  });

  it('a completed job makes room for the next sweep', async () => {
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${eligibleId} AND state = 'QUEUED'
    `);
    await scheduler.enqueueDuePulls();
    expect(await openJobCount(eligibleId)).toBe(WRITABLE_TYPES);
  });
});

describe('the manual pull (POST /integrations/:id/pull)', () => {
  it('is admin-only', async () => {
    const refused = await harness.post(`/integrations/${eligibleId}/pull`, {
      token: employeeToken,
      body: { entityType: 'party' },
    });
    expect(refused.status).toBe(403);
  });

  it('answers the open job rather than erroring on a second press', async () => {
    const first = await harness.post<{ jobId: string; alreadyQueued: boolean }>(
      `/integrations/${eligibleId}/pull`,
      { token: adminToken, body: { entityType: 'party' } },
    );
    expect(first.status).toBe(202);
    // The sweep above already has one open; the press finds it.
    expect(first.body.alreadyQueued).toBe(true);

    const second = await harness.post<{ jobId: string; alreadyQueued: boolean }>(
      `/integrations/${eligibleId}/pull`,
      { token: adminToken, body: { entityType: 'party' } },
    );
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(await openJobCount(eligibleId)).toBe(WRITABLE_TYPES);
  });

  it('queues the newly writable types too — stock items stopped being refusable', async () => {
    // This asserted a 400 while stock_item had no writer; REQ-R-02 gave it
    // one, so the press now finds the sweep's open job like any other type.
    const response = await harness.post<{ jobId: string; alreadyQueued: boolean }>(
      `/integrations/${eligibleId}/pull`,
      { token: adminToken, body: { entityType: 'stock_item' } },
    );
    expect(response.status).toBe(202);
  });

  it('a full re-pull stamps the payload and deletes the cursor (REQ-R-05)', async () => {
    // A cursor to prove the reset against, and a clean queue so the press
    // creates rather than finds.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${eligibleId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_cursors (org_id, connection_id, entity_type, last_alter_id)
      VALUES (${ORG_ID}, ${eligibleId}, 'party', 500)
      ON CONFLICT (connection_id, entity_type)
      DO UPDATE SET last_alter_id = 500
    `);

    const response = await harness.post<{ jobId: string; alreadyQueued: boolean }>(
      `/integrations/${eligibleId}/pull`,
      { token: adminToken, body: { entityType: 'party', full: true } },
    );
    expect(response.status).toBe(202);
    expect(response.body.alreadyQueued).toBe(false);

    const job = await harness.db.execute<{ payload: { full?: boolean } | null }>(sql`
      SELECT payload FROM sync_jobs WHERE id = ${response.body.jobId}
    `);
    expect(job.rows[0]?.payload?.full).toBe(true);
    const cursor = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM sync_cursors WHERE connection_id = ${eligibleId} AND entity_type = 'party'
    `);
    // Deleting the cursor IS the re-pull: the next claim asks from zero.
    expect(cursor.rows.length).toBe(0);
  });

  it('upgrades a QUEUED job to full, but refuses to rewrite one already claimed', async () => {
    // The full job above is still QUEUED; an incremental press finds it.
    const found = await harness.post<{ jobId: string; alreadyQueued: boolean }>(
      `/integrations/${eligibleId}/pull`,
      { token: adminToken, body: { entityType: 'party' } },
    );
    expect(found.body.alreadyQueued).toBe(true);

    // Claimed mid-flight: the agent is working incremental semantics, and
    // rewriting the meaning of work in an agent's hands is refused.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'CLAIMED', claimed_by = 'mid-flight', claimed_at = now()
       WHERE id = ${found.body.jobId}
    `);
    const refused = await harness.post<{ error: { message: string } }>(
      `/integrations/${eligibleId}/pull`,
      { token: adminToken, body: { entityType: 'party', full: true } },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('already running');

    // Back to QUEUED: the upgrade is answerable before any agent has read it.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'QUEUED', claimed_by = NULL, claimed_at = NULL, payload = NULL
       WHERE id = ${found.body.jobId}
    `);
    const upgraded = await harness.post<{ jobId: string; alreadyQueued: boolean }>(
      `/integrations/${eligibleId}/pull`,
      { token: adminToken, body: { entityType: 'party', full: true } },
    );
    expect(upgraded.status).toBe(202);
    expect(upgraded.body.jobId).toBe(found.body.jobId);
    const job = await harness.db.execute<{ payload: { full?: boolean } | null }>(sql`
      SELECT payload FROM sync_jobs WHERE id = ${found.body.jobId}
    `);
    expect(job.rows[0]?.payload?.full).toBe(true);
  });

  it('refuses an entity type outside the contract vocabulary', async () => {
    const response = await harness.post(`/integrations/${eligibleId}/pull`, {
      token: adminToken,
      body: { entityType: 'voucher' },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a connection that could never be claimed', async () => {
    const response = await harness.post<{ error: { message: string } }>(
      `/integrations/${unboundId}/pull`,
      { token: adminToken, body: { entityType: 'party' } },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('bound to a Tally company');
  });
});

describe('the journal body sweep (D-20)', () => {
  let oldRowId = '';
  let freshRowId = '';

  beforeAll(async () => {
    // One row past the window, one inside it, both carrying bodies. INSERT
    // may set created_at freely — only UPDATE is guarded — so the age is
    // real, not mocked.
    const old = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO sync_journal
        (org_id, connection_id, direction, entity_type, request_hash, request_body, response_body, result, created_at)
      VALUES (${ORG_ID}, ${eligibleId}, 'PULL', 'party', 'sha256:old-hash', 'old request xml', 'old response xml', 'ok',
              now() - interval '40 days')
      RETURNING id
    `);
    oldRowId = old.rows[0]?.id ?? '';
    const fresh = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO sync_journal
        (org_id, connection_id, direction, entity_type, request_hash, request_body, response_body, result)
      VALUES (${ORG_ID}, ${eligibleId}, 'PULL', 'party', 'sha256:fresh-hash', 'fresh request xml', 'fresh response xml', 'ok')
      RETURNING id
    `);
    freshRowId = fresh.rows[0]?.id ?? '';
  });

  it('clears bodies past the window, keeps the hash, leaves fresh rows alone', async () => {
    const outcome = await scheduler.sweepJournalBodies();
    // Other orgs' aged rows may legitimately sweep too; ours must be among them.
    expect(outcome.cleared).toBeGreaterThanOrEqual(1);

    const swept = await harness.db.execute<{
      request_hash: string;
      request_body: string | null;
      response_body: string | null;
    }>(sql`
      SELECT request_hash, request_body, response_body FROM sync_journal WHERE id = ${oldRowId}
    `);
    expect(swept.rows[0]?.request_body).toBeNull();
    expect(swept.rows[0]?.response_body).toBeNull();
    // The evidence does not expire.
    expect(swept.rows[0]?.request_hash).toBe('sha256:old-hash');

    const kept = await harness.db.execute<{ request_body: string | null }>(sql`
      SELECT request_body FROM sync_journal WHERE id = ${freshRowId}
    `);
    expect(kept.rows[0]?.request_body).toBe('fresh request xml');
  });

  it('a second sweep finds nothing — already-swept rows leave the predicate', async () => {
    const outcome = await scheduler.sweepJournalBodies();
    // Scoped to this fixture's rows: both are now outside the predicate, so
    // a repeat clears neither (other suites' aging rows are their business).
    const ours = await harness.db.execute<{ request_body: string | null }>(sql`
      SELECT request_body FROM sync_journal WHERE id IN (${oldRowId}, ${freshRowId})
       AND request_body IS NULL AND created_at < now() - interval '30 days'
    `);
    expect(outcome.cleared).toBeGreaterThanOrEqual(0);
    expect(ours.rows.length).toBe(1);
  });
});

describe('the heartbeat staleness alert (REQ-Q-04)', () => {
  let staleId = '';
  const emitted: NotificationEvent[] = [];

  const staleEmits = () =>
    emitted.filter(
      (e) => e.type === 'sync.agent_stale' && e.payload?.connectionName === 'Stale Co',
    );

  beforeAll(async () => {
    // The spy replaces the BullMQ enqueue: what this suite owns is the edge
    // detection and who is addressed, not delivery — `notifications.test.ts`
    // owns that. Workers are disabled under vitest, so nothing else consumes
    // the transitions this fixture creates.
    const dispatcher = harness.resolve(NotificationDispatcher);
    vi.spyOn(dispatcher, 'emit').mockImplementation((event) => {
      emitted.push(event);
      return Promise.resolve('spied');
    });

    const inserted = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO integration_connections
        (org_id, system, name, company_guid, agent_token_hash, last_heartbeat_at)
      VALUES (${ORG_ID}, 'TALLY', 'Stale Co', 'guid-stale', 'hash-of-stale-token',
              now() - interval '10 minutes')
      RETURNING id
    `);
    staleId = inserted.rows[0]?.id ?? '';
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('alerts on the transition to stale — once, however often the sweep runs', async () => {
    const first = await scheduler.checkHeartbeatStaleness();
    expect(first.wentStale).toBeGreaterThanOrEqual(1);
    expect(staleEmits().length).toBe(1);
    // The audience is the permission that guards the screen the alert opens.
    expect(staleEmits()[0]?.audience).toEqual({
      kind: 'permission',
      key: PERMISSIONS.INTEGRATION_MANAGE,
    });

    await scheduler.checkHeartbeatStaleness();
    expect(staleEmits().length).toBe(1);

    const row = await harness.db.execute<{ stale_notified_at: Date | null }>(sql`
      SELECT stale_notified_at FROM integration_connections WHERE id = ${staleId}
    `);
    expect(row.rows[0]?.stale_notified_at).not.toBeNull();
  });

  it('announces recovery, re-arms, and treats the next silence as a new fact', async () => {
    await harness.db.execute(sql`
      UPDATE integration_connections SET last_heartbeat_at = now() WHERE id = ${staleId}
    `);
    const outcome = await scheduler.checkHeartbeatStaleness();
    expect(outcome.recovered).toBeGreaterThanOrEqual(1);
    const recoveries = emitted.filter(
      (e) => e.type === 'sync.agent_recovered' && e.payload?.connectionName === 'Stale Co',
    );
    expect(recoveries.length).toBe(1);

    await harness.db.execute(sql`
      UPDATE integration_connections SET last_heartbeat_at = now() - interval '10 minutes'
       WHERE id = ${staleId}
    `);
    await scheduler.checkHeartbeatStaleness();
    expect(staleEmits().length).toBe(2);
  });

  it('says nothing about a connection that never heartbeated', () => {
    // DISCONNECTED-from-birth is the Integrations screen's business; the
    // sweep is about an agent that was alive and stopped. The eligible and
    // unbound fixtures above have never beaten and must never be named.
    expect(
      emitted.some(
        (e) => e.payload?.connectionName === 'Eligible Co' || e.payload?.connectionName === 'Unbound Co',
      ),
    ).toBe(false);
  });
});
