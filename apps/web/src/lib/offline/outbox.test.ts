import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PunchSyncReport } from './drain';
import type { QueueOwner, QueuedPunch } from './punch-queue';

const mocks = vi.hoisted(() => ({
  identity: { userId: 'user-a', employeeId: 'employee-a' },
  identityListener: null as ((identity: QueueOwner | null) => void) | null,
  waiting: [] as QueuedPunch[],
  post: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../session/use-session', () => ({
  currentIdentity: () => mocks.identity,
  subscribeToSessionIdentity: (listener: (identity: QueueOwner | null) => void) => {
    mocks.identityListener = listener;
    return () => {
      mocks.identityListener = null;
    };
  },
}));

vi.mock('./punch-queue', () => ({
  enqueuePunch: vi.fn(),
  readQueue: (owner: QueueOwner | null) =>
    Promise.resolve({
      waiting:
        owner === null
          ? []
          : mocks.waiting.filter((entry) => entry.owner?.userId === owner.userId),
      refused: [],
      unreadable: 0,
      legacy: 0,
      locked: 0,
    }),
  removeOwnedQueued: mocks.remove,
  updateOwnedQueued: mocks.update,
}));

vi.mock('./drain', () => ({
  nextBatch: (entries: readonly QueuedPunch[]) => entries,
  postPunchSync: mocks.post,
  reconcile: (_batch: readonly QueuedPunch[], report: PunchSyncReport) => ({
    accepted: report.results
      .filter((entry) => entry.outcome !== 'rejected')
      .map((entry) => entry.idempotencyKey),
    refused: report.results
      .filter((entry) => entry.outcome === 'rejected')
      .map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        code: entry.error?.code ?? 'PUNCH_REJECTED',
        message: entry.error?.message ?? 'Refused',
      })),
    unanswered: [],
  }),
}));

import { dismissRefused, drainOutbox, getOutboxSnapshot } from './outbox';

function queued(): QueuedPunch {
  return {
    idempotencyKey: 'key-account-a',
    type: 'IN',
    clientTime: '2026-08-14T04:00:00.000Z',
    queuedAt: '2026-08-14T04:00:01.000Z',
    photo: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
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
    owner: { userId: 'user-a', employeeId: 'employee-a' },
  };
}

function deferredReport(): {
  readonly promise: Promise<PunchSyncReport>;
  readonly resolve: (report: PunchSyncReport) => void;
} {
  let resolve!: (report: PunchSyncReport) => void;
  const promise = new Promise<PunchSyncReport>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('the outbox is bound to the active account', () => {
  beforeEach(() => {
    mocks.identity = { userId: 'user-a', employeeId: 'employee-a' };
    mocks.waiting = [queued()];
    mocks.identityListener?.(mocks.identity);
    vi.clearAllMocks();
    mocks.remove.mockResolvedValue(false);
    mocks.update.mockResolvedValue(true);
  });

  it('aborts and ignores a drain response that lands after an account switch', async () => {
    const deferred = deferredReport();
    mocks.post.mockReturnValueOnce(deferred.promise);

    const drain = drainOutbox();
    await vi.waitFor(() => {
      expect(mocks.post).toHaveBeenCalledTimes(1);
    });
    const signal = mocks.post.mock.calls[0]?.[1] as AbortSignal | undefined;

    mocks.identity = { userId: 'user-b', employeeId: 'employee-b' };
    mocks.identityListener?.(mocks.identity);
    expect(signal?.aborted).toBe(true);

    deferred.resolve({
      results: [
        {
          idempotencyKey: 'key-account-a',
          outcome: 'rejected',
          punch: null,
          error: { code: 'PUNCH_OWNER_MISMATCH', message: 'wrong account' },
        },
      ],
      created: 0,
      replayed: 0,
      rejected: 1,
    });

    await expect(drain).resolves.toBeNull();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(getOutboxSnapshot()).toMatchObject({ loaded: false, waiting: [], refused: [] });
  });

  it('rechecks dismissal against the identity at the moment of the action', async () => {
    mocks.identity = { userId: 'user-b', employeeId: 'employee-b' };
    mocks.identityListener?.(mocks.identity);

    await dismissRefused('key-account-a');

    expect(mocks.remove).toHaveBeenCalledWith(
      'key-account-a',
      { userId: 'user-b', employeeId: 'employee-b' },
      true,
    );
  });
});
