import { SYSTEM_ROLES, type IntegrationListResponse } from '@vyuha/shared';
import { inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { integrationConnections, organizations } from '../db/schema/index.js';
import { STALE_AFTER_MINUTES } from './integration.service.js';

/**
 * `GET /integrations` (technical design §14), over real HTTP.
 *
 * The screen has been calling this since it was built and nothing answered, so
 * it fell back to a sample connection in development and showed an error in
 * production. What is tested here is mostly that the endpoint tells the truth:
 * a connection that has never heartbeated says so whatever its status column
 * claims, and the agent token hash never appears in a response.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000c3';
/** A second organisation, so the scoping predicate has something to exclude. */
const OTHER_ORG_ID = '01900000-0000-7000-8000-0000000000c4';

interface ErrorBody {
  error: { code: string; message: string };
}

let harness: ApiHarness;
let adminToken: string;
let hrToken: string;

const MINUTE = 60_000;

async function seedConnection(input: {
  name: string;
  status?: 'DISCONNECTED' | 'CONNECTED' | 'STALE' | 'ERROR';
  lastHeartbeatAt?: Date | null;
  agentTokenHash?: string | null;
}): Promise<string> {
  const rows = await harness.db
    .insert(integrationConnections)
    .values({
      orgId: ORG_ID,
      system: 'TALLY',
      name: input.name,
      status: input.status ?? 'DISCONNECTED',
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      agentTokenHash: input.agentTokenHash ?? null,
    })
    .returning({ id: integrationConnections.id });

  const row = rows[0];
  if (row === undefined) throw new Error('Connection fixture insert returned no row.');
  return row.id;
}

function list(token = adminToken) {
  return harness.get<IntegrationListResponse>('/integrations', { token });
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Integration Fixture Org');
  // `resetOrganisation` does not clear this table; nothing else writes to it,
  // so this file clears its own rows and a re-run starts from the same place.
  // Both organisations, because the scoping test below seeds the second one and
  // the unique index on (org_id, system, name) would otherwise make a second
  // run fail on a row the first run left behind.
  await harness.db
    .delete(integrationConnections)
    .where(inArray(integrationConnections.orgId, [ORG_ID, OTHER_ORG_ID]));

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);

  const admin = await harness.createUser({
    email: scopedEmail('integration-admin'),
    roleIds: [adminRoleId],
  });
  const hr = await harness.createUser({
    email: scopedEmail('integration-hr'),
    roleIds: [hrRoleId],
  });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  hrToken = (await harness.login(hr.email, hr.password)).token;
  expect(adminToken).not.toBe('');
  expect(hrToken).not.toBe('');
}, 30_000);

afterAll(async () => {
  await harness.close();
});

describe('GET /integrations', () => {
  it('answers an empty list rather than 404, which is the state of a fresh deployment', async () => {
    const empty = await list();

    expect(empty.status, empty.text).toBe(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.staleAfterMinutes).toBe(STALE_AFTER_MINUTES);
  });

  it('refuses a caller without integration.manage', async () => {
    const refused = await harness.get<ErrorBody>('/integrations', { token: hrToken });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses an unauthenticated caller', async () => {
    const refused = await harness.get<ErrorBody>('/integrations');
    expect(refused.status).toBe(401);
  });
});

describe('what a connection is reported as', () => {
  it('says a connection that has never heartbeated is not connected', async () => {
    await seedConnection({ name: 'TallyPrime (head office)' });

    const listed = await list();
    const row = listed.body.data.find((item) => item.name === 'TallyPrime (head office)');

    expect(row?.status).toBe('DISCONNECTED');
    expect(row?.lastHeartbeatAt).toBeNull();
    expect(row?.tokenIssued).toBe(false);
  });

  it('still says not connected when the stored column claims otherwise', async () => {
    // The shape a restored backup leaves behind, or a writer that set the
    // column before an agent existed. The heartbeat is the fact; the column is
    // a claim about it, and a screen reporting a healthy Tally link that does
    // not exist is the one outcome worth avoiding here.
    await seedConnection({ name: 'Optimistic column', status: 'CONNECTED' });

    const listed = await list();
    const row = listed.body.data.find((item) => item.name === 'Optimistic column');
    expect(row?.status).toBe('DISCONNECTED');
  });

  it('calls a recent heartbeat connected', async () => {
    await seedConnection({
      name: 'Recently heard from',
      status: 'CONNECTED',
      lastHeartbeatAt: new Date(Date.now() - MINUTE),
    });

    const listed = await list();
    expect(listed.body.data.find((item) => item.name === 'Recently heard from')?.status).toBe(
      'CONNECTED',
    );
  });

  it('calls a silence longer than the window stale', async () => {
    await seedConnection({
      name: 'Gone quiet',
      status: 'CONNECTED',
      lastHeartbeatAt: new Date(Date.now() - (STALE_AFTER_MINUTES + 1) * MINUTE),
    });

    const listed = await list();
    expect(listed.body.data.find((item) => item.name === 'Gone quiet')?.status).toBe('STALE');
  });

  it('keeps a reported error rather than downgrading it to a stale heartbeat', async () => {
    // An error the agent reported is a diagnosis; going quiet afterwards does
    // not undo it, and replacing it with "heartbeat overdue" would send
    // somebody looking at the network instead of the message.
    await seedConnection({
      name: 'Failed and went quiet',
      status: 'ERROR',
      lastHeartbeatAt: new Date(Date.now() - (STALE_AFTER_MINUTES + 30) * MINUTE),
    });

    const listed = await list();
    expect(listed.body.data.find((item) => item.name === 'Failed and went quiet')?.status).toBe(
      'ERROR',
    );
  });

  it('reports that a token exists without ever returning it', async () => {
    await seedConnection({
      name: 'Has a token',
      agentTokenHash: 'a-hash-that-must-never-leave-the-database',
    });

    const listed = await list();
    const row = listed.body.data.find((item) => item.name === 'Has a token');
    expect(row?.tokenIssued).toBe(true);

    // The whole response body, not just the row: a serializer that grew a
    // field, or a nested object added later, would be caught here.
    expect(listed.text).not.toContain('a-hash-that-must-never-leave-the-database');
    expect(listed.text).not.toContain('agentTokenHash');
    expect(listed.text).not.toContain('agent_token_hash');
  });

  it('does not show one organisation another organisation’s connections', async () => {
    // The `ScopedRepository` predicate, exercised rather than assumed: a row in
    // a different organisation is not found rather than refused, so it never
    // enters this process at all.
    await harness.db
      .insert(organizations)
      .values({ id: OTHER_ORG_ID, name: 'Somebody Else Ltd' })
      .onConflictDoNothing({ target: organizations.id });
    await harness.db.insert(integrationConnections).values({
      orgId: OTHER_ORG_ID,
      system: 'TALLY',
      name: 'Belongs elsewhere',
      agentTokenHash: 'another-organisations-secret',
    });

    const listed = await list();
    expect(listed.body.data.every((item) => item.name !== 'Belongs elsewhere')).toBe(true);
    expect(listed.text).not.toContain('another-organisations-secret');
  });

  it('returns the same order on two reads, so the list does not reshuffle', async () => {
    // Ordered in SQL rather than left to the heap: a list that rearranges
    // itself between refreshes is unreadable, and the collation is Postgres's
    // business rather than something to re-derive here.
    const first = await list();
    const second = await list();

    expect(second.body.data.map((item) => item.name)).toEqual(
      first.body.data.map((item) => item.name),
    );
    expect(first.body.data.length).toBeGreaterThan(1);
  });
});

describe('one company, one connection, one door (audit 11)', () => {
  /**
   * A connection's transport is the agent token or the webhook secret, never
   * both -- the schema has said so in prose since it was written. The service
   * checked it by reading the row first, outside any lock, so two
   * administrators acting at once both read "no other credential" and both
   * wrote. Which transport the connection then used depended on which lookup
   * ran. The database keeps the rule now, so the loser of the race is told
   * rather than obeyed.
   */
  it('refuses a second credential on the same connection', async () => {
    const connection = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO integration_connections (org_id, system, name, company_guid, agent_token_hash)
      VALUES (${ORG_ID}, 'TALLY', 'One Door Co', 'guid-one-door', 'hash-one-door')
      RETURNING id
    `);
    const id = connection.rows[0]?.id ?? '';

    await expect(
      harness.db.execute(sql`UPDATE integration_connections SET webhook_secret_enc = 'sealed' WHERE id = ${id}`),
    ).rejects.toThrow();

    // The row is untouched, and either credential alone is still allowed.
    const after = await harness.db.execute<{ webhook_secret_enc: string | null }>(sql`
      SELECT webhook_secret_enc FROM integration_connections WHERE id = ${id}
    `);
    expect(after.rows[0]?.webhook_secret_enc).toBeNull();

    await harness.db.execute(sql`UPDATE integration_connections SET agent_token_hash = NULL, webhook_secret_enc = 'sealed' WHERE id = ${id}`);
    const swapped = await harness.db.execute<{ agent_token_hash: string | null; webhook_secret_enc: string | null }>(sql`
      SELECT agent_token_hash, webhook_secret_enc FROM integration_connections WHERE id = ${id}
    `);
    expect(swapped.rows[0]?.agent_token_hash).toBeNull();
    expect(swapped.rows[0]?.webhook_secret_enc).toBe('sealed');

    await harness.db.execute(sql`DELETE FROM integration_connections WHERE id = ${id}`);
  });
});
