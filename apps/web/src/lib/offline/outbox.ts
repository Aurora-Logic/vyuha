import { ApiError } from '@/lib/api/client';

import {
  currentIdentity,
  subscribeToSessionIdentity,
  type SessionIdentity,
} from '../session/use-session';

import { nextBatch, postPunchSync, reconcile } from './drain';
import {
  enqueuePunch,
  readQueue,
  removeOwnedQueued,
  updateOwnedQueued,
  type NewQueuedPunch,
  type QueuedPunch,
} from './punch-queue';

/**
 * The offline queue as one observable thing (REQ-D-10).
 *
 * A module rather than an effect inside the punch screen, for two reasons that
 * are not style: the drain has to keep running while a screen re-renders or
 * unmounts, and CLAUDE.md keeps business logic out of components. The screen
 * subscribes and renders; every decision about what happens to a queued punch
 * is made here.
 *
 * `useSyncExternalStore` needs a snapshot whose identity only changes when the
 * data does, so the snapshot object is rebuilt in exactly one place.
 */

export interface DrainResult {
  /** ISO instant of the attempt, whether it worked or not. */
  readonly at: string;
  readonly accepted: number;
  readonly refused: number;
  /**
   * Set when the request never got an answer. The queue is untouched in that
   * case — nothing accepted, nothing refused — and it will be tried again.
   */
  readonly error: string | null;
}

export interface OutboxSnapshot {
  /** False until the first read of IndexedDB has come back. */
  readonly loaded: boolean;
  readonly waiting: readonly QueuedPunch[];
  readonly refused: readonly QueuedPunch[];
  readonly unreadable: number;
  /** Ownerless rows from an older build, counted without exposing details. */
  readonly legacy: number;
  /** Queued by another account; kept for them, never sent as this person. */
  readonly locked: number;
  readonly draining: boolean;
  /** This session's last drain. Null before one has been attempted. */
  readonly lastResult: DrainResult | null;
  /**
   * The most recent attempt against anything still in the queue, which unlike
   * `lastResult` survives a reload — it is stored on the entries themselves.
   */
  readonly lastAttemptAt: string | null;
}

const EMPTY: OutboxSnapshot = {
  loaded: false,
  waiting: [],
  refused: [],
  unreadable: 0,
  legacy: 0,
  locked: 0,
  draining: false,
  lastResult: null,
  lastAttemptAt: null,
};

let snapshot: OutboxSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: OutboxSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeToOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOutboxSnapshot(): OutboxSnapshot {
  return snapshot;
}

function latestAttempt(entries: readonly QueuedPunch[]): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (entry.lastAttemptAt !== null && (latest === null || entry.lastAttemptAt > latest)) {
      latest = entry.lastAttemptAt;
    }
  }
  return latest;
}

function sameOwner(a: SessionIdentity | null, b: SessionIdentity | null): boolean {
  return a?.userId === b?.userId && a?.employeeId === b?.employeeId;
}

async function refreshForOwner(
  owner: SessionIdentity | null,
  overrides: Partial<Pick<OutboxSnapshot, 'draining' | 'lastResult'>> = {},
): Promise<OutboxSnapshot> {
  const contents = await readQueue(owner);
  // IndexedDB is asynchronous. If an account change happened while it was
  // open, publishing this result would briefly show the previous person's
  // queue counts in the new session.
  if (!sameOwner(owner, currentIdentity())) return snapshot;
  const next: OutboxSnapshot = {
    loaded: true,
    waiting: contents.waiting,
    refused: contents.refused,
    unreadable: contents.unreadable,
    legacy: contents.legacy,
    locked: contents.locked,
    draining: overrides.draining ?? snapshot.draining,
    lastResult: overrides.lastResult ?? snapshot.lastResult,
    lastAttemptAt: latestAttempt([...contents.waiting, ...contents.refused]),
  };
  publish(next);
  return next;
}

/** Re-reads IndexedDB and republishes. Every mutation ends here. */
export async function refreshOutbox(
  overrides: Partial<Pick<OutboxSnapshot, 'draining' | 'lastResult'>> = {},
): Promise<OutboxSnapshot> {
  return refreshForOwner(currentIdentity(), overrides);
}

export async function queuePunch(draft: Omit<NewQueuedPunch, 'owner'>): Promise<QueuedPunch> {
  // Stamped here, from the identity the app is showing, so the row can only
  // ever be sent by the person who recorded it (C-01).
  const owner = currentIdentity();
  if (owner === null) throw new Error('A punch cannot be queued with nobody signed in.');
  const entry = await enqueuePunch({ ...draft, owner });
  await refreshForOwner(owner);
  return entry;
}

/**
 * Forgets a punch the server refused.
 *
 * The only deletion in this module that is not the server confirming it holds
 * the punch, and it is deliberately a decision a person makes rather than
 * something that happens to them: the screen states what the refusal was and
 * what to do instead (a regularization, REQ-D-10) next to this control.
 */
export async function dismissRefused(idempotencyKey: string): Promise<void> {
  const owner = currentIdentity();
  if (owner === null) return;
  await removeOwnedQueued(idempotencyKey, owner, true);
  await refreshForOwner(owner);
}

interface ActiveDrain {
  readonly owner: SessionIdentity;
  readonly controller: AbortController;
  readonly promise: Promise<DrainResult | null>;
}

/** Serialises drains for one identity. Two triggers at once are normal. */
let activeDrain: ActiveDrain | null = null;

subscribeToSessionIdentity(() => {
  // Logout and account switching invalidate every module-global value here.
  // Aborting leaves an ambiguous request in IndexedDB; its stable idempotency
  // key makes the original owner's later replay safe.
  activeDrain?.controller.abort();
  activeDrain = null;
  publish(EMPTY);
});

function drainStillBelongsTo(owner: SessionIdentity, signal: AbortSignal): boolean {
  return !signal.aborted && sameOwner(owner, currentIdentity());
}

/**
 * Sends what is waiting, in the order it was taken, and reconciles the report.
 *
 * Returns null when there was nothing to send. Never throws: a drain failing is
 * an expected state of this feature, and the failure belongs on the screen
 * rather than in an unhandled rejection.
 */
export function drainOutbox(): Promise<DrainResult | null> {
  const owner = currentIdentity();
  if (owner === null) return Promise.resolve(null);
  if (activeDrain !== null && sameOwner(activeDrain.owner, owner)) return activeDrain.promise;

  activeDrain?.controller.abort();
  const controller = new AbortController();
  const promise = runDrain(owner, controller.signal).finally(() => {
    if (activeDrain?.controller === controller) activeDrain = null;
  });
  const operation: ActiveDrain = { owner, controller, promise };
  activeDrain = operation;
  return operation.promise;
}

async function runDrain(
  owner: SessionIdentity,
  signal: AbortSignal,
): Promise<DrainResult | null> {
  const start = await refreshForOwner(owner, { draining: true });
  if (!drainStillBelongsTo(owner, signal)) return null;
  if (start.waiting.length === 0) {
    await refreshForOwner(owner, { draining: false });
    return null;
  }

  let accepted = 0;
  let refused = 0;
  let error: string | null = null;
  const at = new Date().toISOString();

  // Bounded rather than "until empty". A server that answers without ever
  // mentioning the entries it was sent would otherwise spin here for ever, and
  // a spin against a punch endpoint is worse than a queue that drains on the
  // next trigger.
  for (let round = 0; round < 10; round += 1) {
    const contents = await readQueue(owner);
    if (!drainStillBelongsTo(owner, signal)) return null;
    if (contents.waiting.length === 0) break;

    const batch = nextBatch(contents.waiting);

    let report;
    try {
      report = await postPunchSync(batch, signal);
    } catch (cause) {
      if (!drainStillBelongsTo(owner, signal)) return null;
      error =
        cause instanceof ApiError
          ? cause.message
          : 'The queued punches could not be sent. They are still queued.';
      // Nothing is removed and nothing is marked refused: no answer is not an
      // answer. Only the attempt is recorded, so the screen can say when it
      // last tried.
      await recordAttempt(batch, owner, at);
      break;
    }

    // The response can land after logout or another tab changes account. It
    // may even be a PUNCH_OWNER_MISMATCH from the new bearer. Neither is a
    // verdict the old account's rows should remember.
    if (!drainStillBelongsTo(owner, signal)) return null;

    const outcome = reconcile(batch, report);

    for (const key of outcome.accepted) {
      if (!drainStillBelongsTo(owner, signal)) return null;
      await removeOwnedQueued(key, owner);
    }
    for (const refusal of outcome.refused) {
      if (!drainStillBelongsTo(owner, signal)) return null;
      const entry = batch.find((candidate) => candidate.idempotencyKey === refusal.idempotencyKey);
      if (!entry) continue;
      await updateOwnedQueued(
        {
          ...entry,
          attempts: entry.attempts + 1,
          lastAttemptAt: at,
          refusal: { code: refusal.code, message: refusal.message, at },
        },
        owner,
      );
    }
    await recordAttempt(
      batch.filter((entry) => outcome.unanswered.includes(entry.idempotencyKey)),
      owner,
      at,
    );

    accepted += outcome.accepted.length;
    refused += outcome.refused.length;

    // No entry in this batch moved. Sending it again in the same drain would
    // ask an identical question and get an identical non-answer.
    if (outcome.accepted.length === 0 && outcome.refused.length === 0) break;
  }

  const result: DrainResult = { at, accepted, refused, error };
  if (!drainStillBelongsTo(owner, signal)) return null;
  await refreshForOwner(owner, { draining: false, lastResult: result });
  if (!drainStillBelongsTo(owner, signal)) return null;
  return result;
}

async function recordAttempt(
  entries: readonly QueuedPunch[],
  owner: SessionIdentity,
  at: string,
): Promise<void> {
  for (const entry of entries) {
    if (!sameOwner(owner, currentIdentity())) return;
    await updateOwnedQueued(
      { ...entry, attempts: entry.attempts + 1, lastAttemptAt: at },
      owner,
    );
  }
}
