import { randomUUID } from 'node:crypto';

import {
  SYSTEM_ROLES,
  type AgentClaimResponse,
  type AgentHeartbeatAck,
  type AgentResultsAck,
  type IntegrationListResponse,
  type IssuedAgentToken,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { SyncWriterService } from './sync-writer.service.js';

/**
 * The agent surface, over real HTTP (REQ-Q-02 … Q-05, 09 §3.4 and §5).
 *
 * The assertions that matter most are the crossings that must fail: a user
 * JWT on an agent route, an agent token on a user route, a second agent on a
 * held lease, a claim for a company Tally does not have open, and one
 * connection's credential reaching another connection's queue. The 6b exit
 * gate says an agent credential must not read anything beyond its own
 * connection; this file is where that is exercised from the refusing side.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000bd';

let harness: ApiHarness;
let adminToken: string;
let employeeToken: string;

let connectionId = '';
let agentToken = '';

const AGENT_A = 'agent-instance-aaaa';
const AGENT_B = 'agent-instance-bbbb';
const COMPANY_GUID = 'guid-gcc-2026-27';

function agentPost<T>(path: string, token: string, body: Record<string, unknown>) {
  // The harness's own token option, so agent requests wear credentials the
  // same way every other suite's do.
  return harness.post<T>(path, { token, body });
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Sync Agent Fixture Org');

  // The harness resets people and roles; the sync fixtures are this file's
  // own to reset, or the unique connection name refuses on every run after
  // the first and everything downstream cascades. Jobs and cursors are
  // deletable; connections are soft-deleted, not removed -- the journal is
  // append-only and references them RESTRICT, so the first journal row this
  // org ever gains would make a hard DELETE here fail forever. The partial
  // unique indexes only bind living rows, so soft-deleting frees the names
  // and company GUIDs for the next run.
  await harness.db.execute(sql`DELETE FROM sync_jobs WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_cursors WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM pending_bill_allocation_sets WHERE org_id = ${ORG_ID}`);
  // The projection and its mappings must go too, and hard: a previous run's
  // parties would satisfy this run's list assertions with the wrong rows, and
  // its orphaned external_refs (owned by connections the line below buried)
  // would be adopted by this run's writer -- correctly, that is the writer's
  // replaced-connection rule -- carrying stale names into the count.
  await harness.db.execute(sql`DELETE FROM external_refs WHERE org_id = ${ORG_ID}`);
  // Allocations cascade with their vouchers; deleting vouchers clears both.
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM price_list_entries WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM stock_items WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });

  const admin = await harness.createUser({
    email: scopedEmail('sync-admin'),
    roleIds: [adminRoleId],
  });
  const employee = await harness.createUser({
    email: scopedEmail('sync-employee'),
    roleIds: [employeeRoleId],
  });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;
});

afterAll(async () => {
  await harness.close();
});

describe('connection creation and token issuance', () => {
  it('creates a connection, admin-only', async () => {
    const refused = await harness.post('/integrations', {
      token: employeeToken,
      body: { name: 'GCC 2026-27' },
    });
    expect(refused.status).toBe(403);

    const created = await harness.post<{ id: string; tokenIssued: boolean }>('/integrations', {
      token: adminToken,
      body: { name: 'GCC 2026-27', companyName: 'G C Communication 2026-27' },
    });
    expect(created.status).toBe(201);
    expect(created.body.tokenIssued).toBe(false);
    connectionId = created.body.id;
  });

  it('issues the token once, in the response and nowhere else', async () => {
    const issued = await harness.post<IssuedAgentToken>(`/integrations/${connectionId}/token`, {
      token: adminToken,
    });
    expect(issued.status).toBe(200);
    expect(issued.body.token.startsWith('vyagt_')).toBe(true);
    agentToken = issued.body.token;

    const list = await harness.get<IntegrationListResponse>('/integrations', {
      token: adminToken,
    });
    const row = list.body.data.find((c) => c.id === connectionId);
    expect(row?.tokenIssued).toBe(true);
    // The credential must not appear anywhere in any user-facing payload.
    expect(JSON.stringify(list.body)).not.toContain(agentToken.slice(6));
  });
});

describe('the two credential worlds never meet', () => {
  it('refuses a user JWT on an agent route', async () => {
    const response = await agentPost('/sync/agent/heartbeat', adminToken, {
      agentInstanceId: AGENT_A,
      agentVersion: '0.1.0',
    });
    expect(response.status).toBe(401);
  });

  it('refuses an agent token on a user route', async () => {
    const response = await harness.get('/integrations', { token: agentToken });
    expect(response.status).toBe(401);
  });

  it('refuses a token nobody issued', async () => {
    const response = await agentPost('/sync/agent/heartbeat', `vyagt_${'0'.repeat(48)}`, {
      agentInstanceId: AGENT_A,
      agentVersion: '0.1.0',
    });
    expect(response.status).toBe(401);
  });
});

describe('heartbeat and the lease (REQ-Q-04, 09 §3.4)', () => {
  it('first heartbeat takes the lease and the connection reports CONNECTED', async () => {
    const response = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', agentToken, {
      agentInstanceId: AGENT_A,
      agentVersion: '0.1.0',
      tallyVersion: 'TallyPrime 5.0',
    });
    expect(response.status).toBe(200);
    expect(response.body.condition).toBe('OK');

    const list = await harness.get<IntegrationListResponse>('/integrations', {
      token: adminToken,
    });
    expect(list.body.data.find((c) => c.id === connectionId)?.status).toBe('CONNECTED');
  });

  it('refuses a second instance while the lease is warm', async () => {
    const response = await agentPost('/sync/agent/heartbeat', agentToken, {
      agentInstanceId: AGENT_B,
      agentVersion: '0.1.0',
    });
    expect(response.status).toBe(409);
  });

  it('lets a rival take over once the holder has been silent past the threshold', async () => {
    await harness.db.execute(sql`
      UPDATE integration_connections
         SET last_heartbeat_at = now() - interval '6 minutes'
       WHERE id = ${connectionId}
    `);

    const takeover = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', agentToken, {
      agentInstanceId: AGENT_B,
      agentVersion: '0.1.0',
    });
    expect(takeover.status).toBe(200);
    expect(takeover.body.condition).toBe('OK');

    // A takes it back the same way for the claim tests below.
    await harness.db.execute(sql`
      UPDATE integration_connections
         SET last_heartbeat_at = now() - interval '6 minutes'
       WHERE id = ${connectionId}
    `);
    const back = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', agentToken, {
      agentInstanceId: AGENT_A,
      agentVersion: '0.1.0',
    });
    expect(back.status).toBe(200);
  });
});

describe('claiming work (REQ-Q-02, 09 §7)', () => {
  it('refuses a claim from an instance that does not hold the lease', async () => {
    const response = await agentPost('/sync/agent/jobs/claim', agentToken, {
      agentInstanceId: AGENT_B,
      openCompanyGuid: COMPANY_GUID,
    });
    expect(response.status).toBe(409);
  });

  it('refuses every claim until the connection is bound to a company', async () => {
    const response = await agentPost<{ error: { message: string } }>(
      '/sync/agent/jobs/claim',
      agentToken,
      { agentInstanceId: AGENT_A, openCompanyGuid: COMPANY_GUID },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('not yet bound');
  });

  it('refuses a claim when Tally has the wrong company open, naming the rule', async () => {
    await harness.db.execute(sql`
      UPDATE integration_connections SET company_guid = ${COMPANY_GUID} WHERE id = ${connectionId}
    `);

    const response = await agentPost<{ error: { message: string } }>(
      '/sync/agent/jobs/claim',
      agentToken,
      { agentInstanceId: AGENT_A, openCompanyGuid: 'guid-some-other-company' },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('wrong books');
  });

  it('answers an empty queue with null, not an error', async () => {
    const response = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', agentToken, {
      agentInstanceId: AGENT_A,
      openCompanyGuid: COMPANY_GUID,
    });
    expect(response.status).toBe(200);
    expect(response.body.job).toBeNull();
  });

  it('claims the oldest queued job exactly once', async () => {
    // Close whatever is open first: the one-open-job index (0022) refuses a
    // second open pull per entity type, and the sweep may legitimately have
    // enqueued one for this connection already.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, payload)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'party', '{"sinceAlterId": 0}'::jsonb)
    `);

    const first = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', agentToken, {
      agentInstanceId: AGENT_A,
      openCompanyGuid: COMPANY_GUID,
    });
    expect(first.body.job?.entityType).toBe('party');
    expect(first.body.job?.attempts).toBe(1);

    const second = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', agentToken, {
      agentInstanceId: AGENT_A,
      openCompanyGuid: COMPANY_GUID,
    });
    expect(second.body.job).toBeNull();
  });

  it("cannot reach another connection's queue with this connection's credential", async () => {
    // A second connection with its own queued job. The credential resolves to
    // connection A, so B's job must be invisible however the request is
    // shaped -- the connection id never travels in the body at all.
    const otherId = randomUUID();
    // Its own company GUID: REQ-Q-03 is now held by a unique index, so two
    // live connections cannot share one company at all.
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, org_id, system, name, company_guid)
      VALUES (${otherId}, ${ORG_ID}, 'TALLY', 'Other Company', 'guid-other-company')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${otherId}, 'PULL', 'stock_item')
    `);

    const response = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', agentToken, {
      agentInstanceId: AGENT_A,
      openCompanyGuid: COMPANY_GUID,
    });
    expect(response.body.job).toBeNull();
  });
});

describe('the server derives the wrong-company condition (REQ-Q-05)', () => {
  it('a confused agent reporting OK with the wrong books open is recorded as WRONG_COMPANY_OPEN', async () => {
    const response = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', agentToken, {
      agentInstanceId: AGENT_A,
      agentVersion: '0.1.0',
      condition: 'OK',
      openCompanyGuid: 'guid-not-the-bound-one',
    });
    expect(response.status).toBe(200);
    expect(response.body.condition).toBe('WRONG_COMPANY_OPEN');

    const list = await harness.get<IntegrationListResponse>('/integrations', {
      token: adminToken,
    });
    const row = list.body.data.find((c) => c.id === connectionId);
    expect(row?.status).toBe('ERROR');
    expect(row?.lastCondition).toBe('WRONG_COMPANY_OPEN');

    // A correct heartbeat clears it, so the screen tracks the live truth.
    const recovered = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', agentToken, {
      agentInstanceId: AGENT_A,
      agentVersion: '0.1.0',
      openCompanyGuid: COMPANY_GUID,
    });
    expect(recovered.body.condition).toBe('OK');
  });
});

describe('rotation revokes', () => {
  it('the old token dies, and the lease dies with it', async () => {
    const reissued = await harness.post<IssuedAgentToken>(
      `/integrations/${connectionId}/token`,
      { token: adminToken },
    );
    expect(reissued.status).toBe(200);
    expect(reissued.body.token).not.toBe(agentToken);

    const stale = await agentPost('/sync/agent/heartbeat', agentToken, {
      agentInstanceId: AGENT_A,
      agentVersion: '0.1.0',
    });
    expect(stale.status).toBe(401);

    // A brand-new instance with the new credential connects immediately: the
    // deposed holder's lease must not block its replacement for the takeover
    // window, because rotation exists precisely to move the agent.
    const fresh = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', reissued.body.token, {
      agentInstanceId: 'agent-instance-cccc',
      agentVersion: '0.2.0',
    });
    expect(fresh.status).toBe(200);
  });
});

describe('pull results become the projection (09 §3.2, REQ-R-01, REQ-T-03)', () => {
  // The rotation test above retired the old credential and freed the lease,
  // so this block starts its own epoch: fresh token, fresh instance, fresh
  // queued job. That independence is deliberate — these tests must not
  // depend on which instance happened to win earlier scuffles.
  const AGENT_D = 'agent-instance-dddd';
  let epochToken = '';
  let resultsJobId = '';

  const chunk = (final: boolean, rows: unknown[], hashes = 'sha256:req1|sha256:res1') => ({
    agentInstanceId: AGENT_D,
    openCompanyGuid: COMPANY_GUID,
    jobId: resultsJobId,
    entityType: 'party',
    rows,
    requestHash: hashes.split('|')[0],
    responseHash: hashes.split('|')[1],
    final,
  });

  const ashaRow = {
    guid: 'party-guid-asha',
    alterId: 101,
    name: 'Asha Traders',
    parentGroup: 'Sundry Debtors',
    gstin: '27AAAPL1234C1ZV',
    creditLimit: '250000.00',
    creditDays: 30,
    openingBalance: '-12345.67',
  };
  const beharRow = {
    guid: 'party-guid-behar',
    alterId: 99,
    name: 'Behar Supply Co',
    parentGroup: 'Sundry Creditors',
  };

  it('sets up its epoch: rotated token, fresh lease, one queued job', async () => {
    const reissued = await harness.post<IssuedAgentToken>(
      `/integrations/${connectionId}/token`,
      { token: adminToken },
    );
    epochToken = reissued.body.token;

    const hb = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', epochToken, {
      agentInstanceId: AGENT_D,
      agentVersion: '0.1.0',
      openCompanyGuid: COMPANY_GUID,
    });
    expect(hb.status).toBe(200);

    // Same closing move as the claim tests: the epoch owns its queue.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'party')
    `);
    const claim = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', epochToken, {
      agentInstanceId: AGENT_D,
      openCompanyGuid: COMPANY_GUID,
    });
    expect(claim.body.job?.entityType).toBe('party');
    resultsJobId = claim.body.job?.id ?? '';
    expect(resultsJobId).not.toBe('');
  });

  it('ingests a chunk: rows land to the paisa, cursor advances, job stays claimed', async () => {
    const response = await agentPost<AgentResultsAck>('/sync/agent/results', epochToken, chunk(false, [ashaRow, beharRow]));
    expect(response.status).toBe(200);
    expect(response.body.written).toBe(2);
    expect(response.body.lastAlterId).toBe(101);
    expect(response.body.jobState).toBe('CLAIMED');

    const stored = await harness.db.execute<{ name: string; credit_limit: string | null; opening_balance: string | null }>(sql`
      SELECT name, credit_limit, opening_balance FROM parties
       WHERE org_id = ${ORG_ID} ORDER BY name
    `);
    expect(stored.rows.map((r) => r.name)).toEqual(['Asha Traders', 'Behar Supply Co']);
    // numeric, not float: the projection holds Tally's figure exactly (D-01).
    expect(stored.rows[0]?.credit_limit).toBe('250000.00');
    expect(stored.rows[0]?.opening_balance).toBe('-12345.67');
  });

  it('a re-posted chunk upserts the same GUIDs — the retry is safe by construction', async () => {
    const response = await agentPost<AgentResultsAck>('/sync/agent/results', epochToken, chunk(false, [ashaRow, beharRow]));
    expect(response.status).toBe(200);

    const count = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM parties WHERE org_id = ${ORG_ID}
    `);
    expect(Number(count.rows[0]?.count)).toBe(2);
  });

  it('Tally wins on the final chunk: rename lands, cursor is the new max, job completes', async () => {
    const renamed = { ...ashaRow, alterId: 150, name: 'Asha Trading Company' };
    const response = await agentPost<AgentResultsAck>('/sync/agent/results', epochToken, chunk(true, [renamed], 'sha256:req2|sha256:res2'));
    expect(response.status).toBe(200);
    expect(response.body.lastAlterId).toBe(150);
    expect(response.body.jobState).toBe('DONE');

    const stored = await harness.db.execute<{ name: string }>(sql`
      SELECT p.name FROM parties p
       JOIN external_refs x ON x.internal_id = p.id AND x.entity_type = 'party'
       WHERE x.external_guid = 'party-guid-asha'
    `);
    expect(stored.rows[0]?.name).toBe('Asha Trading Company');
  });

  it('refuses results for a job that is already done', async () => {
    const response = await agentPost('/sync/agent/results', epochToken, chunk(false, [beharRow]));
    expect(response.status).toBe(409);
  });

  it('refuses results claiming to come from the wrong books', async () => {
    const response = await agentPost('/sync/agent/results', epochToken, {
      ...chunk(false, [beharRow]),
      openCompanyGuid: 'guid-not-ours',
    });
    expect(response.status).toBe(409);
  });

  it("cannot absorb another connection's GUID mapping (6b exit gate)", async () => {
    const other = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM integration_connections
       WHERE org_id = ${ORG_ID} AND name = 'Other Company' AND deleted_at IS NULL LIMIT 1
    `);
    const otherId = other.rows[0]?.id ?? '';
    const party = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group)
      VALUES (${ORG_ID}, ${otherId}, 'Their Party', 'Sundry Debtors') RETURNING id
    `);
    const theirPartyId = party.rows[0]?.id ?? '';
    await harness.db.execute(sql`
      INSERT INTO external_refs (org_id, system, entity_type, external_guid, internal_type, internal_id, connection_id)
      VALUES (${ORG_ID}, 'TALLY', 'party', 'guid-owned-elsewhere', 'party', ${theirPartyId}, ${otherId})
      ON CONFLICT DO NOTHING
    `);

    // A fresh claimed job for OUR connection posting THEIR GUID: the
    // connection-scoped lookup finds nothing, the insert hits the org-wide
    // unique mapping, and the refusal names the rule instead of absorbing
    // the row.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'party')
    `);
    const reclaim = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', epochToken, {
      agentInstanceId: AGENT_D,
      openCompanyGuid: COMPANY_GUID,
    });
    const forged = await agentPost<{ error: { message: string } }>('/sync/agent/results', epochToken, {
      agentInstanceId: AGENT_D,
      openCompanyGuid: COMPANY_GUID,
      jobId: reclaim.body.job?.id ?? '',
      entityType: 'party',
      rows: [{ guid: 'guid-owned-elsewhere', alterId: 999, name: 'Hijacked Name', parentGroup: 'Sundry Debtors' }],
      requestHash: 'sha256:forge',
      responseHash: 'sha256:forge',
      final: true,
    });
    expect(forged.status).toBe(409);
    expect(forged.body.error.message).toContain('different connection');

    const victim = await harness.db.execute<{ name: string }>(sql`
      SELECT name FROM parties WHERE id = ${theirPartyId}
    `);
    expect(victim.rows[0]?.name).toBe('Their Party');
  });

  it('journalled every exchange with its hashes', async () => {
    const rows = await harness.db.execute<{ request_hash: string; result: string }>(sql`
      SELECT request_hash, result FROM sync_journal
       WHERE connection_id = ${connectionId} ORDER BY created_at
    `);
    expect(rows.rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.rows.map((r) => r.request_hash)).toContain('sha256:req2');
    expect(rows.rows.every((r) => r.result.startsWith('ok:'))).toBe(true);
  });
});

describe('stock items and price lists repeat the pattern (REQ-R-02, REQ-R-03)', () => {
  // Its own epoch, same reasoning as the party block above.
  const AGENT_E = 'agent-instance-eeee';
  let epochToken = '';
  let itemJobId = '';
  let priceJobId = '';

  const post = (jobId: string, entityType: string, rows: unknown[], final: boolean) =>
    agentPost<AgentResultsAck>('/sync/agent/results', epochToken, {
      agentInstanceId: AGENT_E,
      openCompanyGuid: COMPANY_GUID,
      jobId,
      entityType,
      rows,
      requestHash: `sha256:${entityType}-req`,
      responseHash: `sha256:${entityType}-res`,
      final,
    });

  const claimNext = async () => {
    const claim = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', epochToken, {
      agentInstanceId: AGENT_E,
      openCompanyGuid: COMPANY_GUID,
    });
    return claim.body.job;
  };

  it('sets up its epoch and receives jobs in dependency order: items before prices', async () => {
    const reissued = await harness.post<IssuedAgentToken>(`/integrations/${connectionId}/token`, {
      token: adminToken,
    });
    epochToken = reissued.body.token;
    const hb = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', epochToken, {
      agentInstanceId: AGENT_E,
      agentVersion: '0.1.0',
      openCompanyGuid: COMPANY_GUID,
    });
    expect(hb.status).toBe(200);

    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    // The order the sweep enqueues is the order the queue hands out
    // (created_at ascending), which is what lets prices resolve their items.
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'stock_item')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'price_list')
    `);

    const first = await claimNext();
    expect(first?.entityType).toBe('stock_item');
    // Nothing pulled yet for this type: the server's watermark rides on the
    // claim, and it starts at zero.
    expect(first?.fromAlterId).toBe(0);
    itemJobId = first?.id ?? '';
  });

  it('ingests stock items: unit and GST rate land exactly (REQ-R-02)', async () => {
    const response = await post(
      itemJobId,
      'stock_item',
      [
        {
          guid: 'item-guid-cable',
          alterId: 210,
          name: 'Cat6 Cable Box',
          alias: 'CAT6',
          unit: 'Nos',
          parentGroup: 'Networking',
          gstRate: '18',
        },
        {
          guid: 'item-guid-conduit',
          alterId: 205,
          name: 'PVC Conduit 20mm',
          unit: 'Mtr',
          parentGroup: 'Electrical',
          gstRate: '2.5',
        },
      ],
      true,
    );
    expect(response.status).toBe(200);
    expect(response.body.written).toBe(2);
    expect(response.body.lastAlterId).toBe(210);

    const stored = await harness.db.execute<{ name: string; unit: string; gst_rate: string }>(sql`
      SELECT name, unit, gst_rate FROM stock_items WHERE org_id = ${ORG_ID} ORDER BY name
    `);
    expect(stored.rows.map((r) => r.name)).toEqual(['Cat6 Cable Box', 'PVC Conduit 20mm']);
    // numeric held exactly: 2.5 percent stays 2.5, never 2.50000000001.
    expect(stored.rows[1]?.gst_rate).toBe('2.5');
  });

  it('a chunk of items claiming to be parties fails validation at the door', async () => {
    const response = await agentPost('/sync/agent/results', epochToken, {
      agentInstanceId: AGENT_E,
      openCompanyGuid: COMPANY_GUID,
      jobId: itemJobId,
      entityType: 'party',
      // A stock-item shape: no parentGroup, which the party arm requires.
      // Zod strips the unknown `unit` key, so the omission is what trips it.
      rows: [{ guid: 'item-guid-cable', alterId: 1, name: 'X', unit: 'Nos' }],
      requestHash: 'sha256:x',
      responseHash: 'sha256:x',
      final: false,
    });
    // The union's party arm requires party columns; the job check would also
    // 409, but validation refuses first and that is the right door.
    expect(response.status).toBe(400);
  });

  it('ingests price list entries keyed on (item, level), and re-posts overwrite (REQ-R-03)', async () => {
    const next = await claimNext();
    expect(next?.entityType).toBe('price_list');
    priceJobId = next?.id ?? '';

    const rate = {
      alterId: 220,
      stockItemGuid: 'item-guid-cable',
      priceLevel: 'Wholesale',
      rate: '4200.50',
      unit: 'Nos',
    };
    const first = await post(priceJobId, 'price_list', [rate], false);
    expect(first.status).toBe(200);

    // Tally wins on the re-post: same key, new figure, one row.
    const second = await post(priceJobId, 'price_list', [{ ...rate, rate: '4150.00' }], true);
    expect(second.status).toBe(200);

    const stored = await harness.db.execute<{ price_level: string; rate: string }>(sql`
      SELECT e.price_level, e.rate FROM price_list_entries e
       JOIN stock_items i ON i.id = e.stock_item_id
       WHERE e.org_id = ${ORG_ID} AND i.name = 'Cat6 Cable Box'
    `);
    expect(stored.rows).toEqual([{ price_level: 'Wholesale', rate: '4150.00' }]);
  });

  it('a full pull marks what did not arrive, and only a full pull may (REQ-R-06)', async () => {
    // Both items exist from the ingestion above. A FULL stock_item job whose
    // final chunk carries only the cable: the conduit is gone from Tally.
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, payload)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'stock_item', '{"full": true}'::jsonb)
    `);
    const fullJob = await claimNext();
    const cableOnly = {
      guid: 'item-guid-cable',
      alterId: 300,
      name: 'Cat6 Cable Box',
      unit: 'Nos',
      parentGroup: 'Networking',
    };
    const response = await post(fullJob?.id ?? '', 'stock_item', [cableOnly], true);
    expect(response.status).toBe(200);

    const after = await harness.db.execute<{ name: string; absent_in_tally: boolean }>(sql`
      SELECT name, absent_in_tally FROM stock_items WHERE org_id = ${ORG_ID} ORDER BY name
    `);
    expect(after.rows).toEqual([
      { name: 'Cat6 Cable Box', absent_in_tally: false },
      { name: 'PVC Conduit 20mm', absent_in_tally: true },
    ]);

    // Marked, never deleted: the row and its price entry keep resolving.
    const rates = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM price_list_entries WHERE org_id = ${ORG_ID}
    `);
    expect(Number(rates.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('reappearing in a later full pull clears the mark — Tally wins both ways', async () => {
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, payload)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'stock_item', '{"full": true}'::jsonb)
    `);
    const job = await claimNext();
    const both = [
      { guid: 'item-guid-cable', alterId: 301, name: 'Cat6 Cable Box', unit: 'Nos', parentGroup: 'Networking' },
      { guid: 'item-guid-conduit', alterId: 302, name: 'PVC Conduit 20mm', unit: 'Mtr', parentGroup: 'Electrical' },
    ];
    const response = await post(job?.id ?? '', 'stock_item', both, true);
    expect(response.status).toBe(200);

    const after = await harness.db.execute<{ absent_in_tally: boolean }>(sql`
      SELECT absent_in_tally FROM stock_items WHERE org_id = ${ORG_ID}
    `);
    expect(after.rows.every((row) => !row.absent_in_tally)).toBe(true);
  });

  it('a full pull reads from zero even when a cursor is already committed (audit 10)', async () => {
    // The cursor is committed per chunk, so an interrupted full pull leaves it
    // partway through. The retry used to claim whatever the cursor said and
    // pull only above it -- then markAbsentees marked rows absent on the
    // strength of a pull that had not seen everything, which is the one
    // premise it cannot do without. A job that asks for a full pull now reads
    // from zero whatever the cursor holds.
    const cursor = await harness.db.execute<{ last_alter_id: string }>(sql`
      SELECT last_alter_id::text FROM sync_cursors WHERE connection_id = ${connectionId} AND entity_type = 'stock_item'
    `);
    const committed = Number(cursor.rows[0]?.last_alter_id ?? 0);
    expect(committed).toBeGreaterThan(0);

    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, payload)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'stock_item', '{"full": true}'::jsonb)
    `);
    const full = await claimNext();
    expect(full?.fromAlterId).toBe(0);
    // Closed before the next is queued: only one job per connection and
    // entity type may be open at a time.
    await harness.db.execute(sql`UPDATE sync_jobs SET state = 'DONE' WHERE id = ${full?.id ?? ''}`);

    // And an ordinary job still starts where the cursor left off.
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'stock_item')
    `);
    const incremental = await claimNext();
    expect(incremental?.fromAlterId).toBe(committed);
    await harness.db.execute(sql`UPDATE sync_jobs SET state = 'DONE' WHERE id = ${incremental?.id ?? ''}`);
  });

  it('an incremental pull never marks: absence from a window proves nothing', async () => {
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'stock_item')
    `);
    const job = await claimNext();
    // The committed cursor from the full pull above (302) rides on the claim.
    expect(job?.fromAlterId).toBe(302);
    const cableOnly = {
      guid: 'item-guid-cable',
      alterId: 310,
      name: 'Cat6 Cable Box',
      unit: 'Nos',
      parentGroup: 'Networking',
    };
    const response = await post(job?.id ?? '', 'stock_item', [cableOnly], true);
    expect(response.status).toBe(200);

    const conduit = await harness.db.execute<{ absent_in_tally: boolean }>(sql`
      SELECT absent_in_tally FROM stock_items
       WHERE org_id = ${ORG_ID} AND name = 'PVC Conduit 20mm'
    `);
    expect(conduit.rows[0]?.absent_in_tally).toBe(false);
  });

  it('refuses a rate for an item that has not arrived, naming the ordering', async () => {
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'price_list')
    `);
    const job = await claimNext();
    const response = await agentPost<{ error: { message: string } }>(
      '/sync/agent/results',
      epochToken,
      {
        agentInstanceId: AGENT_E,
        openCompanyGuid: COMPANY_GUID,
        jobId: job?.id ?? '',
        entityType: 'price_list',
        rows: [
          { alterId: 1, stockItemGuid: 'item-guid-never-pulled', priceLevel: 'Retail', rate: '10' },
        ],
        requestHash: 'sha256:orphan',
        responseHash: 'sha256:orphan',
        final: true,
      },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('before the item itself');
  });
});

describe('bill allocations enter the projection (REQ-AJ-02)', () => {
  // Its own epoch, same reasoning as the blocks above.
  const AGENT_F = 'agent-instance-ffff';
  let epochToken = '';
  let chetakId = '';
  let salesVoucherId = '';
  let receiptVoucherId = '';

  const post = (jobId: string, rows: unknown[], final: boolean) =>
    agentPost<AgentResultsAck>('/sync/agent/results', epochToken, {
      agentInstanceId: AGENT_F,
      openCompanyGuid: COMPANY_GUID,
      jobId,
      entityType: 'bill_allocation',
      rows,
      requestHash: 'sha256:alloc-req',
      responseHash: 'sha256:alloc-res',
      final,
    });

  const claimNext = async () => {
    const claim = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', epochToken, {
      agentInstanceId: AGENT_F,
      openCompanyGuid: COMPANY_GUID,
    });
    return claim.body.job;
  };

  /** Projects a voucher with its GUID mapping, the way the webhook door does. */
  const projectVoucher = async (guid: string, voucherType: string, amount: string) => {
    const inserted = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO vouchers
        (org_id, connection_id, voucher_date, voucher_type, party_name, amount)
      VALUES (${ORG_ID}, ${connectionId}, '2026-08-01', ${voucherType}, 'Chetak Distributors', ${amount})
      RETURNING id
    `);
    const id = inserted.rows[0]?.id ?? '';
    await harness.db.execute(sql`
      INSERT INTO external_refs
        (org_id, system, entity_type, external_guid, internal_type, internal_id, connection_id)
      VALUES (${ORG_ID}, 'TALLY', 'voucher', ${guid}, 'voucher', ${id}, ${connectionId})
    `);
    return id;
  };

  const invoiceRow = {
    alterId: 400,
    voucherGuid: 'vch-guid-inv-001',
    partyName: 'Chetak Distributors',
    billName: 'INV-001',
    refType: 'new',
    billDate: '2026-08-01',
    dueDate: '2026-08-31',
    amount: '5000.00',
  };
  const receiptRow = {
    alterId: 410,
    voucherGuid: 'vch-guid-rcpt-009',
    partyName: 'Chetak Distributors',
    billName: 'INV-001',
    refType: 'against',
    billDate: '2026-08-01',
    amount: '-2000.00',
  };

  it('sets up its epoch: projected vouchers with GUID mappings, a party to resolve', async () => {
    const reissued = await harness.post<IssuedAgentToken>(`/integrations/${connectionId}/token`, {
      token: adminToken,
    });
    epochToken = reissued.body.token;
    const hb = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', epochToken, {
      agentInstanceId: AGENT_F,
      agentVersion: '0.1.0',
      openCompanyGuid: COMPANY_GUID,
    });
    expect(hb.status).toBe(200);

    // Vouchers reach Vyuha through the webhook door; allocations only anchor
    // to ones already projected, so the fixture projects them directly.
    const party = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group)
      VALUES (${ORG_ID}, ${connectionId}, 'Chetak Distributors', 'Sundry Debtors')
      RETURNING id
    `);
    chetakId = party.rows[0]?.id ?? '';
    salesVoucherId = await projectVoucher('vch-guid-inv-001', 'Sales', '5000.00');
    receiptVoucherId = await projectVoucher('vch-guid-rcpt-009', 'Receipt', '2000.00');
    expect(salesVoucherId).not.toBe('');
    expect(receiptVoucherId).not.toBe('');
  });

  it('ingests a batch: rows anchor to their vouchers, the party resolves by name', async () => {
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'bill_allocation')
    `);
    const job = await claimNext();
    expect(job?.entityType).toBe('bill_allocation');

    const response = await post(job?.id ?? '', [invoiceRow, receiptRow], false);
    expect(response.status).toBe(200);
    expect(response.body.written).toBe(2);
    expect(response.body.skipped).toBeUndefined();
    expect(response.body.lastAlterId).toBe(410);
    expect(response.body.jobState).toBe('CLAIMED');

    const stored = await harness.db.execute<{
      voucher_id: string;
      party_id: string | null;
      ref_type: string;
      bill_date: string | null;
      due_date: string | null;
      amount: string;
    }>(sql`
      SELECT voucher_id, party_id, ref_type, bill_date::text, due_date::text, amount
        FROM bill_allocations WHERE org_id = ${ORG_ID} ORDER BY ref_type
    `);
    expect(stored.rows).toEqual([
      {
        voucher_id: receiptVoucherId,
        party_id: chetakId,
        ref_type: 'against',
        bill_date: '2026-08-01',
        due_date: null,
        // numeric, not float: signed to the paisa, exactly as Tally said.
        amount: '-2000.00',
      },
      {
        voucher_id: salesVoucherId,
        party_id: chetakId,
        ref_type: 'new',
        bill_date: '2026-08-01',
        due_date: '2026-08-31',
        amount: '5000.00',
      },
    ]);
  });

  it('a replayed chunk rewrites each voucher’s set — one set, not two', async () => {
    const open = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM sync_jobs
       WHERE connection_id = ${connectionId} AND entity_type = 'bill_allocation' AND state = 'CLAIMED'
       LIMIT 1
    `);
    const response = await post(open.rows[0]?.id ?? '', [invoiceRow, receiptRow], false);
    expect(response.status).toBe(200);

    const count = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM bill_allocations WHERE org_id = ${ORG_ID}
    `);
    expect(Number(count.rows[0]?.count)).toBe(2);
  });

  it('durably defers an allocation until its voucher arrives, without holding the cursor back', async () => {
    const open = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM sync_jobs
       WHERE connection_id = ${connectionId} AND entity_type = 'bill_allocation' AND state = 'CLAIMED'
       LIMIT 1
    `);
    // One row the projection cannot anchor, one revision it can: the receipt
    // was altered in Tally and its set re-arrives whole.
    const orphan = {
      alterId: 415,
      voucherGuid: 'vch-guid-never-pulled',
      partyName: 'Chetak Distributors',
      billName: 'GHOST-1',
      refType: 'new',
      billDate: '2026-08-15',
      amount: '100.00',
    };
    const revised = { ...receiptRow, alterId: 420, amount: '-2500.00' };
    const response = await post(open.rows[0]?.id ?? '', [orphan, revised], true);
    expect(response.status).toBe(200);
    expect(response.body.written).toBe(2);
    expect(response.body.skipped).toBeUndefined();
    expect(response.body.lastAlterId).toBe(420);
    expect(response.body.jobState).toBe('DONE');

    // The revision replaced the receipt's set. The unresolved set is durable,
    // but cannot enter bill_allocations before its voucher exists.
    const stored = await harness.db.execute<{ bill_name: string; amount: string }>(sql`
      SELECT bill_name, amount FROM bill_allocations
       WHERE org_id = ${ORG_ID} AND voucher_id = ${receiptVoucherId}
    `);
    expect(stored.rows).toEqual([{ bill_name: 'INV-001', amount: '-2500.00' }]);
    const ghosts = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM bill_allocations
       WHERE org_id = ${ORG_ID} AND bill_name = 'GHOST-1'
    `);
    expect(Number(ghosts.rows[0]?.count)).toBe(0);
    const pending = await harness.db.execute<{ source_alter_id: string; rows: unknown }>(sql`
      SELECT source_alter_id, rows FROM pending_bill_allocation_sets
       WHERE connection_id = ${connectionId} AND voucher_guid = 'vch-guid-never-pulled'
    `);
    expect(Number(pending.rows[0]?.source_alter_id)).toBe(415);
    expect(pending.rows[0]?.rows).toEqual([orphan]);

    // The journal keeps the deferral visible beside the exchange it happened in.
    const journal = await harness.db.execute<{ result: string }>(sql`
      SELECT result FROM sync_journal
       WHERE connection_id = ${connectionId} AND entity_type = 'bill_allocation'
       ORDER BY created_at DESC LIMIT 1
    `);
    expect(journal.rows[0]?.result).toBe('ok: 2 rows, 1 deferred: voucher not yet pulled');

    // The allocation is not sent again. Projecting only its voucher drains the
    // staged set in the voucher transaction, which is the eventual-completeness
    // invariant the old skip lost once cursor 420 committed.
    const writer = harness.resolve(SyncWriterService);
    await harness.db.transaction(async (tx) => {
      await writer.applyRows(tx, { orgId: ORG_ID, connectionId }, {
        entityType: 'voucher',
        rows: [{
          guid: orphan.voucherGuid,
          alterId: orphan.alterId,
          date: '2026-08-15',
          voucherType: 'Sales',
          voucherNumber: orphan.billName,
          partyName: orphan.partyName,
          isCancelled: false,
          amount: orphan.amount,
          lines: [],
        }],
      });
    });

    const materialized = await harness.db.execute<{ bill_name: string; amount: string }>(sql`
      SELECT a.bill_name, a.amount
        FROM bill_allocations a JOIN external_refs x ON x.internal_id = a.voucher_id
       WHERE x.connection_id = ${connectionId} AND x.entity_type = 'voucher'
         AND x.external_guid = ${orphan.voucherGuid}
    `);
    expect(materialized.rows).toEqual([{ bill_name: 'GHOST-1', amount: '100.00' }]);
    const left = await harness.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM pending_bill_allocation_sets
       WHERE connection_id = ${connectionId} AND voucher_guid = ${orphan.voucherGuid}
    `);
    expect(Number(left.rows[0]?.count)).toBe(0);
  });
});

describe('a full price_list re-pull deletes what stopped arriving (P6b-1)', () => {
  // Its own epoch, same reasoning as the blocks above.
  const AGENT_G = 'agent-instance-gggg';
  let epochToken = '';

  const post = (jobId: string, rows: unknown[], final: boolean) =>
    agentPost<AgentResultsAck>('/sync/agent/results', epochToken, {
      agentInstanceId: AGENT_G,
      openCompanyGuid: COMPANY_GUID,
      jobId,
      entityType: 'price_list',
      rows,
      requestHash: 'sha256:price-req',
      responseHash: 'sha256:price-res',
      final,
    });

  const claimNext = async () => {
    const claim = await agentPost<AgentClaimResponse>('/sync/agent/jobs/claim', epochToken, {
      agentInstanceId: AGENT_G,
      openCompanyGuid: COMPANY_GUID,
    });
    return claim.body.job;
  };

  const enqueue = async (full: boolean) => {
    await harness.db.execute(sql`
      UPDATE sync_jobs SET state = 'DONE', updated_at = now()
       WHERE connection_id = ${connectionId} AND state IN ('QUEUED', 'CLAIMED')
    `);
    await harness.db.execute(sql`
      INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, payload)
      VALUES (${ORG_ID}, ${connectionId}, 'PULL', 'price_list',
              ${full ? '{"full": true}' : null}::jsonb)
    `);
    return claimNext();
  };

  const cableRate = (priceLevel: string, rate: string, alterId: number) => ({
    alterId,
    stockItemGuid: 'item-guid-cable',
    priceLevel,
    rate,
  });

  const ourRates = async () => {
    const rows = await harness.db.execute<{ price_level: string; rate: string }>(sql`
      SELECT price_level, rate FROM price_list_entries
       WHERE connection_id = ${connectionId} ORDER BY price_level
    `);
    return rows.rows;
  };

  it('sets up its epoch: a second rate beside the Wholesale one', async () => {
    const reissued = await harness.post<IssuedAgentToken>(`/integrations/${connectionId}/token`, {
      token: adminToken,
    });
    epochToken = reissued.body.token;
    const hb = await agentPost<AgentHeartbeatAck>('/sync/agent/heartbeat', epochToken, {
      agentInstanceId: AGENT_G,
      agentVersion: '0.1.0',
      openCompanyGuid: COMPANY_GUID,
    });
    expect(hb.status).toBe(200);

    const job = await enqueue(false);
    const response = await post(job?.id ?? '', [cableRate('Retail', '4500.00', 320)], true);
    expect(response.status).toBe(200);
    expect(await ourRates()).toEqual([
      { price_level: 'Retail', rate: '4500.00' },
      { price_level: 'Wholesale', rate: '4150.00' },
    ]);
  });

  it('an incremental pull never deletes: absence from a window proves nothing', async () => {
    const job = await enqueue(false);
    const response = await post(job?.id ?? '', [cableRate('Wholesale', '4100.00', 330)], true);
    expect(response.status).toBe(200);

    // Retail did not arrive in this window, and stands untouched.
    expect(await ourRates()).toEqual([
      { price_level: 'Retail', rate: '4500.00' },
      { price_level: 'Wholesale', rate: '4100.00' },
    ]);
  });

  it('rows an earlier chunk of the same full pull touched survive its final sweep', async () => {
    const job = await enqueue(true);
    expect(job?.fromAlterId).toBe(0);
    const first = await post(job?.id ?? '', [cableRate('Retail', '4600.00', 340)], false);
    expect(first.status).toBe(200);
    // The watermark is the job's created_at, so the final chunk must not
    // reap what its own job's earlier chunk wrote.
    const second = await post(job?.id ?? '', [cableRate('Wholesale', '4050.00', 350)], true);
    expect(second.status).toBe(200);

    expect(await ourRates()).toEqual([
      { price_level: 'Retail', rate: '4600.00' },
      { price_level: 'Wholesale', rate: '4050.00' },
    ]);
  });

  it('the final chunk of a full pull deletes rates the pull did not carry', async () => {
    // Another connection's rate, older than any watermark this test creates:
    // the delete is scoped to the pulling connection or it is a crossing.
    const other = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM integration_connections
       WHERE org_id = ${ORG_ID} AND name = 'Other Company' AND deleted_at IS NULL LIMIT 1
    `);
    const otherId = other.rows[0]?.id ?? '';
    const theirItem = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO stock_items (org_id, connection_id, name, unit, parent_group)
      VALUES (${ORG_ID}, ${otherId}, 'Their Item', 'Nos', 'Primary')
      RETURNING id
    `);
    await harness.db.execute(sql`
      INSERT INTO price_list_entries
        (org_id, connection_id, stock_item_id, price_level, rate, last_pulled_at)
      VALUES (${ORG_ID}, ${otherId}, ${theirItem.rows[0]?.id ?? ''}, 'Wholesale', '9.99',
              now() - interval '1 day')
    `);

    // Retail stopped arriving: the full pull's final chunk carries only
    // Wholesale, and the vanished rate dies rather than posing as current.
    const job = await enqueue(true);
    const response = await post(job?.id ?? '', [cableRate('Wholesale', '4000.00', 360)], true);
    expect(response.status).toBe(200);

    expect(await ourRates()).toEqual([{ price_level: 'Wholesale', rate: '4000.00' }]);
    const theirs = await harness.db.execute<{ rate: string }>(sql`
      SELECT rate FROM price_list_entries WHERE connection_id = ${otherId}
    `);
    expect(theirs.rows).toEqual([{ rate: '9.99' }]);
  });
});
