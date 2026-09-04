import { REALTIME_RESOURCES } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import { drainFrames, invalidationsFor, presenceMapOf, presenceKey, retryDelayMs } from './realtime-store';

const CHANGE = {
  kind: 'change',
  resource: REALTIME_RESOURCES.CRM_DEAL,
  action: 'updated',
  recordId: '0192f3a1-0000-7000-8000-000000000001',
  actorUserId: '0192f3a1-0000-7000-8000-0000000000aa',
  actorName: 'Priya Kulkarni',
  at: '2026-08-31T08:00:00.000Z',
} as const;

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('drainFrames', () => {
  it('reads a whole message and keeps nothing back', () => {
    const { events, rest } = drainFrames(frame(CHANGE));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'change', recordId: CHANGE.recordId });
    expect(rest).toBe('');
  });

  it('holds a message that arrived in two pieces until the rest of it lands', () => {
    // This is the case that matters: `fetch` hands over whatever the network
    // chose, and a parser that read per chunk would drop this update with no
    // error anywhere.
    const whole = frame(CHANGE);
    const cut = Math.floor(whole.length / 2);

    const first = drainFrames(whole.slice(0, cut));
    expect(first.events).toEqual([]);
    expect(first.rest).toBe(whole.slice(0, cut));

    const second = drainFrames(first.rest + whole.slice(cut));
    expect(second.events).toHaveLength(1);
    expect(second.rest).toBe('');
  });

  it('reads several messages out of one chunk', () => {
    const { events } = drainFrames(frame(CHANGE) + frame({ kind: 'ready', heartbeatMs: 15_000 }));
    expect(events.map((event) => event.kind)).toEqual(['change', 'ready']);
  });

  it('ignores the keepalive comment without treating it as a message', () => {
    const { events, rest } = drainFrames(`: keepalive\n\n${frame(CHANGE)}`);
    expect(events).toHaveLength(1);
    expect(rest).toBe('');
  });

  it('skips a frame it cannot read rather than ending the stream', () => {
    // A server deployed ahead of this build can send a resource this client
    // has never heard of. Dropping the connection over it would stop every
    // update, including the ones it does understand.
    const { events } = drainFrames(
      'data: not json at all\n\n' +
        frame({ ...CHANGE, resource: 'erp.voucher' }) +
        frame(CHANGE),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resource: REALTIME_RESOURCES.CRM_DEAL });
  });
});

describe('presence', () => {
  it('keys viewers by resource and record', () => {
    const map = presenceMapOf([
      {
        resource: REALTIME_RESOURCES.TASK,
        recordId: CHANGE.recordId,
        viewers: [{ userId: CHANGE.actorUserId, name: 'Priya Kulkarni' }],
      },
    ]);
    expect(map.get(presenceKey(REALTIME_RESOURCES.TASK, CHANGE.recordId))).toHaveLength(1);
    // The same id under a different resource is a different record.
    expect(map.get(presenceKey(REALTIME_RESOURCES.CRM_DEAL, CHANGE.recordId))).toBeUndefined();
  });
});

describe('invalidationsFor', () => {
  it('covers every resource the contract declares', () => {
    // A resource added to the contract with no invalidation here would
    // publish changes that silently refresh nothing.
    for (const resource of Object.values(REALTIME_RESOURCES)) {
      expect(invalidationsFor(resource).length).toBeGreaterThan(0);
    }
  });

  it('refetches tasks for a task and CRM for a deal, not the other way round', () => {
    expect(invalidationsFor(REALTIME_RESOURCES.TASK)).toEqual([['tasks']]);
    expect(invalidationsFor(REALTIME_RESOURCES.CRM_DEAL)).toEqual([['crm']]);
  });
});

describe('retryDelayMs', () => {
  it('backs off and then stops growing', () => {
    // Highest random value, so this reads the ceiling rather than a sample.
    const top = (attempt: number) => retryDelayMs(attempt, () => 1);
    expect(top(1)).toBe(1_000);
    expect(top(2)).toBe(2_000);
    expect(top(3)).toBe(4_000);
    expect(top(20)).toBe(30_000);
  });

  it('spreads reconnections out instead of retrying in lockstep', () => {
    // Fifty browsers coming back from one closed lid must not arrive
    // together; the jitter is what stops that.
    expect(retryDelayMs(4, () => 0)).toBe(4_000);
    expect(retryDelayMs(4, () => 1)).toBe(8_000);
  });
});
