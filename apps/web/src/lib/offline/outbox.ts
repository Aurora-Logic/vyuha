import { ApiError } from '@/lib/api/client';

import { currentIdentity } from '../session/use-session';

import { nextBatch, postPunchSync, reconcile } from './drain';
import {
  enqueuePunch,
  readQueue,
  removeQueued,
  updateQueued,
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
  /** Queued by another account, or by none; kept for them, never sent as this person. */
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

/** Re-reads IndexedDB and republishes. Every mutation ends here. */
export async function refreshOutbox(
  overrides: Partial<Pick<OutboxSnapshot, 'draining' | 'lastResult'>> = {},
): Promise<OutboxSnapshot> {
  const contents = await readQueue(currentIdentity());
  const next: OutboxSnapshot = {
    loaded: true,
    waiting: contents.waiting,
    refused: contents.refused,
    unreadable: contents.unreadable,
    locked: contents.locked,
    draining: overrides.draining ?? snapshot.draining,
    lastResult: overrides.lastResult ?? snapshot.lastResult,
    lastAttemptAt: latestAttempt([...contents.waiting, ...contents.refused]),
  };
  publish(next);
  return next;
}

export async function queuePunch(draft: Omit<NewQueuedPunch, 'owner'>): Promise<QueuedPunch> {
  // Stamped here, from the identity the app is showing, so the row can only
  // ever be sent by the person who recorded it (C-01).
  const owner = currentIdentity();
  if (owner === null) throw new Error('A punch cannot be queued with nobody signed in.');
  const entry = await enqueuePunch({ ...draft, owner });
  await refreshOutbox();
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
  await removeQueued(idempotencyKey);
  await refreshOutbox();
}

/** Serialises drains. Two triggers firing at once is normal, not exceptional. */
let inFlight: Promise<DrainResult | null> | null = null;

/**
 * Sends what is waiting, in the order it was taken, and reconciles the report.
 *
 * Returns null when there was nothing to send. Never throws: a drain failing is
 * an expected state of this feature, and the failure belongs on the screen
 * rather than in an unhandled rejection.
 */
export function drainOutbox(): Promise<DrainResult | null> {
  inFlight ??= runDrain().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runDrain(): Promise<DrainResult | null> {
  const start = await refreshOutbox({ draining: true });
  if (start.waiting.length === 0) {
    await refreshOutbox({ draining: false });
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
    const contents = await readQueue(currentIdentity());
    if (contents.waiting.length === 0) break;

    const batch = nextBatch(contents.waiting);

    let report;
    try {
      report = await postPunchSync(batch);
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : 'The queued punches could not be sent. They are still queued.';
      // Nothing is removed and nothing is marked refused: no answer is not an
      // answer. Only the attempt is recorded, so the screen can say when it
      // last tried.
      await recordAttempt(batch, at);
      break;
    }

    const outcome = reconcile(batch, report);

    for (const key of outcome.accepted) {
      await removeQueued(key);
    }
    for (const refusal of outcome.refused) {
      const entry = batch.find((candidate) => candidate.idempotencyKey === refusal.idempotencyKey);
      if (!entry) continue;
      await updateQueued({
        ...entry,
        attempts: entry.attempts + 1,
        lastAttemptAt: at,
        refusal: { code: refusal.code, message: refusal.message, at },
      });
    }
    await recordAttempt(
      batch.filter((entry) => outcome.unanswered.includes(entry.idempotencyKey)),
      at,
    );

    accepted += outcome.accepted.length;
    refused += outcome.refused.length;

    // No entry in this batch moved. Sending it again in the same drain would
    // ask an identical question and get an identical non-answer.
    if (outcome.accepted.length === 0 && outcome.refused.length === 0) break;
  }

  const result: DrainResult = { at, accepted, refused, error };
  await refreshOutbox({ draining: false, lastResult: result });
  return result;
}

async function recordAttempt(entries: readonly QueuedPunch[], at: string): Promise<void> {
  for (const entry of entries) {
    await updateQueued({ ...entry, attempts: entry.attempts + 1, lastAttemptAt: at });
  }
}
