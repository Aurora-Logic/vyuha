import { PRESENCE_EXPIRY_MS, REALTIME_RESOURCES, type RealtimeEvent } from '@vyuha/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeService, type RealtimeSubscriber } from './realtime.service.js';

/**
 * What this pins: an event never crosses an organisation, a roster forgets a
 * person who stopped saying they were there, and a socket that has gone away
 * is dropped rather than retried for ever.
 */

const ORG_A = '01900000-0000-7000-8000-00000000ff01';
const ORG_B = '01900000-0000-7000-8000-00000000ff02';
const PRIYA = '01900000-0000-7000-8000-00000000aa01';
const RAVI = '01900000-0000-7000-8000-00000000aa02';
const DEAL = '01900000-0000-7000-8000-00000000bb01';

function recorder(userId: string, name: string): RealtimeSubscriber & { events: RealtimeEvent[] } {
  const events: RealtimeEvent[] = [];
  return {
    userId,
    name,
    events,
    send(event) {
      events.push(event);
      return true;
    },
  };
}

let realtime: RealtimeService;

beforeEach(() => {
  realtime = new RealtimeService();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an event never leaves its organisation', () => {
  it('reaches a subscriber in the same org and nobody in another', () => {
    const inside = recorder(PRIYA, 'Priya Kulkarni');
    const outside = recorder(RAVI, 'Ravi Kumar');
    realtime.subscribe(ORG_A, inside);
    realtime.subscribe(ORG_B, outside);

    realtime.publish(ORG_A, {
      resource: REALTIME_RESOURCES.CRM_DEAL,
      action: 'updated',
      recordId: DEAL,
      actorUserId: PRIYA,
    });

    expect(inside.events).toHaveLength(1);
    expect(outside.events).toEqual([]);
  });

  it('keeps one org out of another organisation roster', () => {
    const inside = recorder(PRIYA, 'Priya Kulkarni');
    const outside = recorder(RAVI, 'Ravi Kumar');
    realtime.subscribe(ORG_A, inside);
    realtime.subscribe(ORG_B, outside);

    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);

    expect(realtime.roster(ORG_B)).toEqual([]);
    expect(outside.events).toEqual([]);
  });
});

describe('the actor is named from their own stream', () => {
  it('uses the connected name and falls back when the actor has no stream', () => {
    const watcher = recorder(RAVI, 'Ravi Kumar');
    const actor = recorder(PRIYA, 'Priya Kulkarni');
    realtime.subscribe(ORG_A, watcher);
    realtime.subscribe(ORG_A, actor);

    realtime.publish(ORG_A, {
      resource: REALTIME_RESOURCES.TASK,
      action: 'created',
      recordId: DEAL,
      actorUserId: PRIYA,
    });
    expect(watcher.events[0]).toMatchObject({ kind: 'change', actorName: 'Priya Kulkarni' });

    // An action taken by a job, or by someone whose stream has just dropped:
    // still worth announcing, just without a name to put on it.
    realtime.publish(ORG_A, {
      resource: REALTIME_RESOURCES.TASK,
      action: 'created',
      recordId: DEAL,
      actorUserId: '01900000-0000-7000-8000-00000000aa09',
    });
    expect(watcher.events[1]).toMatchObject({ actorName: 'Someone' });
  });
});

describe('presence', () => {
  it('names who is in a record, and drops them when they leave it', () => {
    const watcher = recorder(RAVI, 'Ravi Kumar');
    realtime.subscribe(ORG_A, watcher);

    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);
    expect(realtime.roster(ORG_A)).toEqual([
      { resource: REALTIME_RESOURCES.CRM_DEAL, recordId: DEAL, viewers: [{ userId: PRIYA, name: 'Priya Kulkarni' }] },
    ]);

    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, null);
    expect(realtime.roster(ORG_A)).toEqual([]);
  });

  it('holds one entry per person however many times they say it', () => {
    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);
    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);
    expect(realtime.roster(ORG_A)[0]?.viewers).toHaveLength(1);
  });

  it('moves a person rather than leaving them in two records at once', () => {
    const second = '01900000-0000-7000-8000-00000000bb02';
    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);
    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, second);

    const roster = realtime.roster(ORG_A);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.recordId).toBe(second);
  });

  it('forgets a browser that stopped saying it was there', () => {
    // A laptop that closed sends nothing more; without expiry its owner
    // stays on a colleague's screen for ever.
    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);
    vi.advanceTimersByTime(PRESENCE_EXPIRY_MS + 1);
    expect(realtime.roster(ORG_A)).toEqual([]);
  });

  it('does not wake every browser for a repeat heartbeat', () => {
    const watcher = recorder(RAVI, 'Ravi Kumar');
    realtime.subscribe(ORG_A, watcher);

    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);
    const afterFirst = watcher.events.length;
    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);

    // Fifty people idling on records would otherwise be a broadcast storm
    // every fifteen seconds, carrying a roster that did not change.
    expect(watcher.events).toHaveLength(afterFirst);
  });

  it('empties the roster the moment a stream closes, without waiting out the expiry', () => {
    const priya = recorder(PRIYA, 'Priya Kulkarni');
    const unsubscribe = realtime.subscribe(ORG_A, priya);
    realtime.heartbeat(ORG_A, { userId: PRIYA, name: 'Priya Kulkarni' }, REALTIME_RESOURCES.CRM_DEAL, DEAL);

    unsubscribe();
    expect(realtime.roster(ORG_A)).toEqual([]);
  });
});

describe('a socket that has gone', () => {
  it('is dropped rather than written to again', () => {
    const dead: RealtimeSubscriber = { userId: PRIYA, name: 'Priya Kulkarni', send: () => false };
    const alive = recorder(RAVI, 'Ravi Kumar');
    realtime.subscribe(ORG_A, dead);
    realtime.subscribe(ORG_A, alive);

    realtime.publish(ORG_A, {
      resource: REALTIME_RESOURCES.TASK,
      action: 'updated',
      recordId: DEAL,
      actorUserId: RAVI,
    });
    expect(realtime.subscriberCount(ORG_A)).toBe(1);
    expect(alive.events).toHaveLength(1);
  });

  it('does not stop the others when writing to it throws', () => {
    const throwing: RealtimeSubscriber = {
      userId: PRIYA,
      name: 'Priya Kulkarni',
      send: () => {
        throw new Error('socket closed');
      },
    };
    const alive = recorder(RAVI, 'Ravi Kumar');
    realtime.subscribe(ORG_A, throwing);
    realtime.subscribe(ORG_A, alive);

    expect(() => {
      realtime.publish(ORG_A, {
        resource: REALTIME_RESOURCES.TASK,
        action: 'updated',
        recordId: DEAL,
        actorUserId: RAVI,
      });
    }).not.toThrow();
    expect(alive.events).toHaveLength(1);
  });
});
