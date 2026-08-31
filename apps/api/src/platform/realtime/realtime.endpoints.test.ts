import { PERMISSIONS, REALTIME_RESOURCES, SYSTEM_ROLES, type RealtimeEvent, type TaskView } from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * The live channel over a real socket (REQ-U-08, REQ-U-09).
 *
 * Driven through `fetch` against the harness's own server rather than a
 * stubbed response, because everything that makes this endpoint different
 * from the rest of the API is in the parts a stub would replace: that the
 * headers say `text/event-stream`, that the body arrives in pieces before
 * the request has finished, and that a write reaches a reader who connected
 * earlier. A stubbed `Response` passes all of those while the real thing
 * buffers to the end and delivers nothing.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f1c4';

let harness: ApiHarness;
let priyaToken = '';
let raviToken = '';

/** Reads events off an open stream until enough have arrived or time runs out. */
async function collect(
  token: string,
  want: (events: RealtimeEvent[]) => boolean,
  act?: () => Promise<unknown>,
  timeoutMs = 8_000,
): Promise<RealtimeEvent[]> {
  const abort = new AbortController();
  const response = await fetch(`${harness.baseUrl}/realtime/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.body).not.toBeNull();

  const reader = (response.body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  const events: RealtimeEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  // Only once the stream is open, so the write cannot land before anyone is
  // listening -- the race that would make this test pass or fail by timing.
  let acted = false;

  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => {
            resolve({ done: true, value: undefined });
          }, Math.max(deadline - Date.now(), 0)),
        ),
      ]);
      if (chunk.done) break;
      buffer += chunk.value ?? '';

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim())
          .join('\n');
        if (data !== '') events.push(JSON.parse(data) as RealtimeEvent);
      }

      if (!acted && act !== undefined) {
        acted = true;
        await act();
      }
      if (want(events)) break;
    }
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
  return events;
}


/**
 * A second person with the app open, held open for the duration of a test.
 * Their name reaches everyone else off this stream (the server reads it from
 * the actor's own connection rather than querying for it on every write), so
 * a test that wants to see "Ravi Kumar" has to have Ravi connected -- which
 * is the only situation the feature is for.
 */
async function openStream(token: string): Promise<() => void> {
  const abort = new AbortController();
  const response = await fetch(`${harness.baseUrl}/realtime/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: abort.signal,
  });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  // Wait for the first frame, so the subscription is registered before the
  // caller does anything that has to reach it.
  await reader.read();
  void (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Aborted by the caller; nothing to report.
    }
  })();
  return () => {
    abort.abort();
  };
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Realtime Fixture Org');
  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const salesRoleId = await harness.createRole('Realtime sales', [
    PERMISSIONS.PUNCH_SELF,
    PERMISSIONS.CRM_TASK_VIEW_SELF,
    PERMISSIONS.CRM_TASK_MANAGE,
  ]);

  const priyaEmployeeId = await harness.createEmployee({ code: 'RT-001', firstName: 'Priya', lastName: 'Kulkarni' });
  const raviEmployeeId = await harness.createEmployee({ code: 'RT-002', firstName: 'Ravi', lastName: 'Kumar' });

  const priya = await harness.createUser({
    email: scopedEmail('rt-priya'),
    roleIds: [adminRoleId],
    employeeId: priyaEmployeeId,
  });
  const ravi = await harness.createUser({
    email: scopedEmail('rt-ravi'),
    roleIds: [salesRoleId],
    employeeId: raviEmployeeId,
  });
  priyaToken = (await harness.login(priya.email, priya.password)).token;
  raviToken = (await harness.login(ravi.email, ravi.password)).token;
});

afterAll(async () => {
  await harness.close();
});

describe('the stream', () => {
  it('refuses an unauthenticated reader', async () => {
    const response = await fetch(`${harness.baseUrl}/realtime/stream`, { headers: { accept: 'text/event-stream' } });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it('opens with the heartbeat interval and the roster as it stands', async () => {
    const events = await collect(priyaToken, (all) => all.some((event) => event.kind === 'ready'));
    const ready = events.find((event) => event.kind === 'ready');
    expect(ready).toBeDefined();
    // A client that had to guess the interval would either spam the server
    // or let its own presence lapse.
    expect(ready).toMatchObject({ heartbeatMs: expect.any(Number) });
    expect(events.some((event) => event.kind === 'presence')).toBe(true);
  });

  it("carries someone else's write to an already-open reader, naming who did it", async () => {
    // Both colleagues have the app open, which is the whole premise.
    const closeRavi = await openStream(raviToken);
    let created: TaskView | undefined;
    const events = await collect(
      priyaToken,
      (all) => all.some((event) => event.kind === 'change' && event.resource === REALTIME_RESOURCES.TASK),
      async () => {
        const response = await harness.post<TaskView>('/tasks', {
          body: { title: 'Call the site engineer', priority: 'MEDIUM' },
          token: raviToken,
        });
        expect(response.status).toBe(201);
        created = response.body;
      },
    );

    closeRavi();
    const change = events.find((event) => event.kind === 'change');
    expect(change).toBeDefined();
    expect(change).toMatchObject({
      resource: REALTIME_RESOURCES.TASK,
      action: 'created',
      recordId: created?.id,
      actorName: 'Ravi Kumar',
    });
  });

  it('says who is in a record, by name', async () => {
    const dealId = '01900000-0000-7000-8000-00000000cc01';
    const events = await collect(
      priyaToken,
      (all) =>
        all.some(
          (event) =>
            event.kind === 'presence' &&
            event.records.some((record) => record.viewers.some((viewer) => viewer.name === 'Ravi Kumar')),
        ),
      async () => {
        const response = await harness.post('/realtime/presence', {
          body: { resource: REALTIME_RESOURCES.CRM_DEAL, recordId: dealId },
          token: raviToken,
        });
        expect(response.status).toBe(204);
      },
    );

    const roster = events.filter((event) => event.kind === 'presence').at(-1);
    expect(roster).toMatchObject({
      records: [
        {
          resource: REALTIME_RESOURCES.CRM_DEAL,
          recordId: dealId,
          // The employee's name, never the email: the rest of the screen
          // says "Ravi Kumar", and an address here reads as someone else.
          viewers: [{ name: 'Ravi Kumar' }],
        },
      ],
    });
  });
});

describe('presence heartbeats', () => {
  it('leaves no audit row behind', async () => {
    await harness.post('/realtime/presence', {
      body: { resource: REALTIME_RESOURCES.CRM_DEAL, recordId: '01900000-0000-7000-8000-00000000cc02' },
      token: raviToken,
    });
    const actions = await harness.lastAuditActions(5);
    // One row per person per fifteen seconds would bury the trail that
    // matters under noise nobody would ever read.
    expect(actions.some((action) => action.includes('realtime') || action.includes('presence'))).toBe(false);
  });

  it('refuses a record id that is not one', async () => {
    const response = await harness.post('/realtime/presence', {
      body: { resource: REALTIME_RESOURCES.CRM_DEAL, recordId: 'not-a-uuid' },
      token: raviToken,
    });
    expect(response.status).toBe(400);
  });

  it('refuses an unauthenticated heartbeat', async () => {
    const response = await harness.post('/realtime/presence', {
      body: { resource: REALTIME_RESOURCES.CRM_DEAL, recordId: '01900000-0000-7000-8000-00000000cc03' },
    });
    expect(response.status).toBe(401);
  });
});
