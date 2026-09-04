import { describe, expect, it } from 'vitest';

import { buildSyncBody, reconcile, type PunchSyncReport } from './drain';
import type { QueuedPunch } from './punch-queue';

/**
 * The rules that decide whether a queued punch is deleted.
 *
 * Worth testing in isolation because every one of them is a way to lose
 * somebody's attendance: delete on the wrong signal and the punch is gone with
 * no record; keep on the wrong signal and it is sent for ever.
 */

function entry(overrides: Partial<QueuedPunch> = {}): QueuedPunch {
  return {
    idempotencyKey: 'key-0000-0001',
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
    owner: { userId: 'user-a', employeeId: 'emp-a' },
    attempts: 0,
    lastAttemptAt: null,
    refusal: null,
    ...overrides,
  };
}

function report(results: PunchSyncReport['results']): PunchSyncReport {
  return {
    results,
    created: results.filter((r) => r.outcome === 'created').length,
    replayed: results.filter((r) => r.outcome === 'replayed').length,
    rejected: results.filter((r) => r.outcome === 'rejected').length,
  };
}

describe('reconcile', () => {
  it('accepts a created punch', () => {
    const batch = [entry()];
    const outcome = reconcile(
      batch,
      report([{ idempotencyKey: 'key-0000-0001', outcome: 'created', punch: {}, error: null }]),
    );

    expect(outcome.accepted).toEqual(['key-0000-0001']);
    expect(outcome.refused).toEqual([]);
    expect(outcome.unanswered).toEqual([]);
  });

  it('accepts a replayed punch, because the server already holds it', () => {
    // REQ-D-11. A retry after a lost response must clear the queue, not sit in
    // it for ever asking a question that has already been answered.
    const batch = [entry()];
    const outcome = reconcile(
      batch,
      report([{ idempotencyKey: 'key-0000-0001', outcome: 'replayed', punch: {}, error: null }]),
    );

    expect(outcome.accepted).toEqual(['key-0000-0001']);
  });

  it('keeps a refused punch and carries the server reason', () => {
    const batch = [entry()];
    const outcome = reconcile(
      batch,
      report([
        {
          idempotencyKey: 'key-0000-0001',
          outcome: 'rejected',
          punch: null,
          error: {
            code: 'PUNCH_QUEUED_TOO_OLD',
            message: 'This punch was queued more than 48 hours ago.',
          },
        },
      ]),
    );

    expect(outcome.accepted).toEqual([]);
    expect(outcome.refused).toEqual([
      {
        idempotencyKey: 'key-0000-0001',
        code: 'PUNCH_QUEUED_TOO_OLD',
        message: 'This punch was queued more than 48 hours ago.',
      },
    ]);
  });

  it('still produces a readable refusal when the server sends none', () => {
    const outcome = reconcile(
      [entry()],
      report([{ idempotencyKey: 'key-0000-0001', outcome: 'rejected', punch: null, error: null }]),
    );

    expect(outcome.accepted).toEqual([]);
    expect(outcome.refused[0]?.code).toBe('PUNCH_REJECTED');
    expect(outcome.refused[0]?.message).toMatch(/regularization/i);
  });

  it('leaves an entry the report does not mention queued', () => {
    const batch = [entry(), entry({ idempotencyKey: 'key-0000-0002' })];
    const outcome = reconcile(
      batch,
      report([{ idempotencyKey: 'key-0000-0001', outcome: 'created', punch: {}, error: null }]),
    );

    expect(outcome.accepted).toEqual(['key-0000-0001']);
    expect(outcome.unanswered).toEqual(['key-0000-0002']);
  });

  it('ignores a result for a key it did not send', () => {
    const outcome = reconcile(
      [entry()],
      report([
        { idempotencyKey: 'key-0000-0001', outcome: 'created', punch: {}, error: null },
        { idempotencyKey: 'somebody-elses-key', outcome: 'created', punch: {}, error: null },
      ]),
    );

    expect(outcome.accepted).toEqual(['key-0000-0001']);
  });

  it('reports an empty batch against an empty report as nothing to do', () => {
    const outcome = reconcile([], report([]));
    expect(outcome).toEqual({ accepted: [], refused: [], unanswered: [] });
  });

  it('splits a mixed batch the way the endpoint answers it', () => {
    const batch = [
      entry(),
      entry({ idempotencyKey: 'key-0000-0002' }),
      entry({ idempotencyKey: 'key-0000-0003' }),
    ];
    const outcome = reconcile(
      batch,
      report([
        { idempotencyKey: 'key-0000-0001', outcome: 'created', punch: {}, error: null },
        {
          idempotencyKey: 'key-0000-0002',
          outcome: 'rejected',
          punch: null,
          error: { code: 'PUNCH_QUEUED_TOO_OLD', message: 'Too old.' },
        },
        { idempotencyKey: 'key-0000-0003', outcome: 'replayed', punch: {}, error: null },
      ]),
    );

    expect(outcome.accepted).toEqual(['key-0000-0001', 'key-0000-0003']);
    expect(outcome.refused.map((r) => r.idempotencyKey)).toEqual(['key-0000-0002']);
    expect(outcome.unanswered).toEqual([]);
  });
});

describe('buildSyncBody', () => {
  function payloadOf(form: FormData): { punches: Record<string, unknown>[] } {
    const raw = form.get('payload');
    if (typeof raw !== 'string') throw new Error('payload is not a string field');
    return JSON.parse(raw) as { punches: Record<string, unknown>[] };
  }

  it('pairs every entry with its own photo by index', () => {
    const first = entry({ idempotencyKey: 'key-0000-0001' });
    const second = entry({
      idempotencyKey: 'key-0000-0002',
      photo: new Blob([new Uint8Array([9, 9, 9, 9])], { type: 'image/jpeg' }),
    });

    const form = buildSyncBody([first, second]);
    const photos = form.getAll('photos');

    expect(payloadOf(form).punches.map((p) => p.photoIndex)).toEqual([0, 1]);
    expect(photos).toHaveLength(2);
    expect((photos[0] as File).size).toBe(3);
    expect((photos[1] as File).size).toBe(4);
  });

  it('names the account that queued each punch, and nothing for a row that has none (C-01)', () => {
    const mine = entry({ idempotencyKey: 'key-0000-0001' });
    const legacy = entry({ idempotencyKey: 'key-0000-0002', owner: null });
    const punches = payloadOf(buildSyncBody([mine, legacy])).punches;
    expect(punches[0]?.ownerUserId).toBe('user-a');
    expect(punches[1]).not.toHaveProperty('ownerUserId');
  });

  it('sends the stored idempotency key, never a fresh one', () => {
    // REQ-D-11. Generating a key at drain time would turn every retry into a
    // second punch, which is the exact failure the key exists to prevent.
    const form = buildSyncBody([entry({ idempotencyKey: 'generated-once-at-capture' })]);
    expect(payloadOf(form).punches[0]?.idempotencyKey).toBe('generated-once-at-capture');
  });

  it('carries the consent tick recorded at capture (REQ-M-03)', () => {
    // The server refuses a first punch without it, so a tick given offline
    // must survive the queue and reach the sync body unchanged.
    const ticked = payloadOf(buildSyncBody([entry({ consentAccepted: true })])).punches[0] ?? {};
    expect(ticked.consentAccepted).toBe(true);

    const unticked =
      payloadOf(buildSyncBody([entry({ consentAccepted: false })])).punches[0] ?? {};
    expect(unticked.consentAccepted).toBe(false);
  });

  it('omits location entirely when there is none', () => {
    const punch = payloadOf(buildSyncBody([entry()])).punches[0] ?? {};
    expect('latitude' in punch).toBe(false);
    expect('longitude' in punch).toBe(false);
    expect('gpsAccuracyM' in punch).toBe(false);
  });

  it('sends latitude and longitude together', () => {
    const punch =
      payloadOf(buildSyncBody([entry({ latitude: 12.9, longitude: 77.6, gpsAccuracyM: 18 })]))
        .punches[0] ?? {};
    expect(punch.latitude).toBe(12.9);
    expect(punch.longitude).toBe(77.6);
    expect(punch.gpsAccuracyM).toBe(18);
  });

  it('sends halfDayPart only alongside isHalfDay', () => {
    const marked =
      payloadOf(buildSyncBody([entry({ isHalfDay: true, halfDayPart: 'FIRST_HALF' })]))
        .punches[0] ?? {};
    expect(marked.isHalfDay).toBe(true);
    expect(marked.halfDayPart).toBe('FIRST_HALF');

    // The server rejects a part without the flag, so a stale part must not leak.
    const unmarked =
      payloadOf(buildSyncBody([entry({ isHalfDay: false, halfDayPart: 'FIRST_HALF' })]))
        .punches[0] ?? {};
    expect('halfDayPart' in unmarked).toBe(false);
  });

  it('omits an empty reason rather than sending one the server will refuse', () => {
    const punch = payloadOf(buildSyncBody([entry({ reason: '' })])).punches[0] ?? {};
    expect('reason' in punch).toBe(false);
  });
});
