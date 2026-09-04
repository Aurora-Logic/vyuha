import { describe, expect, it } from 'vitest';

import { partitionQueue, type QueuedPunch } from './punch-queue';

/**
 * C-01. The queue is origin-wide -- one IndexedDB for every account that
 * signs in on this browser -- and a row carried no owner, so whoever signed
 * in next drained everybody's punches, photographs included, under their own
 * name. Now a row is only ever the recorder's to send.
 */
function row(overrides: Partial<QueuedPunch> & { idempotencyKey: string }): QueuedPunch {
  return {
    type: 'IN',
    clientTime: '2026-08-14T04:00:00.000Z',
    queuedAt: '2026-08-14T04:00:01.000Z',
    photo: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    latitude: null,
    longitude: null,
    gpsAccuracyM: null,
    isHalfDay: false,
    halfDayPart: null,
    reason: null,
    consentAccepted: true,
    attempts: 0,
    lastAttemptAt: null,
    refusal: null,
    owner: { userId: 'user-a', employeeId: 'emp-a' },
    ...overrides,
  };
}

const A = { userId: 'user-a', employeeId: 'emp-a' };
const B = { userId: 'user-b', employeeId: 'emp-b' };

const rows: unknown[] = [
  row({ idempotencyKey: 'a-waiting' }),
  row({ idempotencyKey: 'a-refused', refusal: { code: 'PUNCH_OUT_OF_ORDER', message: 'no', at: '2026-08-14T05:00:00.000Z' } }),
  row({ idempotencyKey: 'b-waiting', owner: B }),
  (() => {
    // Written by a build that recorded no owner.
    const legacy: Record<string, unknown> = { ...row({ idempotencyKey: 'legacy-0000-0001' }) };
    delete legacy['owner'];
    return legacy;
  })(),
  { garbage: true },
];

describe('partitionQueue', () => {


  it('gives a person only the rows they queued, and counts the rest as locked', () => {
    const forA = partitionQueue(rows, A);
    expect(forA.waiting.map((r) => r.idempotencyKey)).toEqual(['a-waiting']);
    expect(forA.refused.map((r) => r.idempotencyKey)).toEqual(['a-refused']);
    expect(forA.locked).toBe(2);
    expect(forA.unreadable).toBe(1);
  });

  it('never hands one account another account\'s rows', () => {
    const forB = partitionQueue(rows, B);
    expect(forB.waiting.map((r) => r.idempotencyKey)).toEqual(['b-waiting']);
    expect(forB.refused).toEqual([]);
    expect(forB.locked).toBe(3);
  });

  it('treats a row with no owner as nobody\'s, whoever is signed in', () => {
    for (const who of [A, B]) {
      expect(partitionQueue(rows, who).waiting.map((r) => r.idempotencyKey)).not.toContain('legacy-0000-0001');
    }
  });

  it('locks everything when nobody is signed in', () => {
    const nobody = partitionQueue(rows, null);
    expect(nobody.waiting).toEqual([]);
    expect(nobody.refused).toEqual([]);
    expect(nobody.locked).toBe(4);
  });
});
