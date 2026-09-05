import { MAX_OFFLINE_SYNC_BATCH } from '@vyuha/shared';
import { z } from 'zod';

import { ApiError } from '@/lib/api/client';

import { postMultipart } from './multipart';
import type { QueuedPunch } from './punch-queue';

/**
 * Draining the offline queue into `POST /punches/sync` (REQ-D-10).
 *
 * The endpoint always answers 200 and reports per entry, because a batch where
 * the third punch is two days old is not a failed request — it is four accepted
 * punches and one that needs a regularization. Everything in this file exists
 * to keep that distinction intact all the way to the screen:
 *
 * - `created` and `replayed` both mean the server holds it. The entry leaves.
 * - `rejected` means the server looked at it and said no. Retrying would ask
 *   the same question and get the same answer, so the entry stays, stops being
 *   retried, and carries the server's own code and message to the person.
 * - An entry the report does not mention stays queued and is tried again. A
 *   server that omits an entry has told us nothing about it, and "nothing" must
 *   never be read as "accepted".
 * - A transport failure is not an answer at all. Nothing is removed, nothing is
 *   marked refused, and the same idempotency keys go out again next time — which
 *   is safe precisely because they were generated once and stored (REQ-D-11).
 */

const syncResultSchema = z.object({
  idempotencyKey: z.string(),
  outcome: z.enum(['created', 'replayed', 'rejected']),
  // The full PunchRecord is not modelled here. This module needs to know which
  // entries the server holds, not what it made of them; the screen refetches
  // today's status afterwards and reads that from the server rather than from
  // an echo. Anything narrower than `unknown` would be a second copy of the
  // punch contract to keep in step for no gain.
  punch: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

const syncReportSchema = z.object({
  results: z.array(syncResultSchema),
  created: z.number(),
  replayed: z.number(),
  rejected: z.number(),
});

export type PunchSyncReport = z.infer<typeof syncReportSchema>;

export interface Refusal {
  readonly idempotencyKey: string;
  readonly code: string;
  readonly message: string;
}

export interface Reconciliation {
  /** The server holds these. Safe to delete from the queue. */
  readonly accepted: readonly string[];
  /** The server refused these, with its reason. */
  readonly refused: readonly Refusal[];
  /** Sent, but not mentioned in the report. Still queued, tried again later. */
  readonly unanswered: readonly string[];
}

/**
 * Maps a server report onto what should happen to the queue. Pure, so the rules
 * above are testable without a network, a database or a browser.
 */
export function reconcile(
  batch: readonly QueuedPunch[],
  report: PunchSyncReport,
): Reconciliation {
  const sent = new Set(batch.map((entry) => entry.idempotencyKey));
  const accepted: string[] = [];
  const refused: Refusal[] = [];
  const answered = new Set<string>();

  for (const result of report.results) {
    // A key we did not send is not ours to act on. Ignored rather than trusted,
    // because acting on it would mean deleting a queue entry on the say-so of a
    // response that was talking about something else.
    if (!sent.has(result.idempotencyKey)) continue;
    answered.add(result.idempotencyKey);

    if (result.outcome === 'rejected') {
      refused.push({
        idempotencyKey: result.idempotencyKey,
        // A rejection with no error object is a contract break. It still has to
        // produce something a person can read, and it must not be mistaken for
        // an acceptance.
        code: result.error?.code ?? 'PUNCH_REJECTED',
        message:
          result.error?.message ??
          'The server refused this punch without saying why. Raise a regularization for it.',
      });
      continue;
    }

    accepted.push(result.idempotencyKey);
  }

  return {
    accepted,
    refused,
    unanswered: [...sent].filter((key) => !answered.has(key)),
  };
}

/**
 * Builds the multipart body.
 *
 * `photoIndex` is the pairing between an entry and its file, because multipart
 * preserves order but not association. The files are appended in the same loop
 * that assigns the index, so the two cannot drift — a drift here would attach
 * one person's photograph to another person's punch.
 */
export function buildSyncBody(batch: readonly QueuedPunch[]): FormData {
  const form = new FormData();
  const punches = batch.map((entry, index) => {
    if (entry.owner === null) {
      throw new Error('A legacy queued punch without an owner cannot be synced safely.');
    }
    return {
      type: entry.type,
      clientTime: entry.clientTime,
      // Sent together or not at all; the server rejects one without the other.
      ...(entry.latitude !== null && entry.longitude !== null
        ? {
            latitude: entry.latitude,
            longitude: entry.longitude,
            ...(entry.gpsAccuracyM === null ? {} : { gpsAccuracyM: entry.gpsAccuracyM }),
          }
        : {}),
      isHalfDay: entry.isHalfDay,
      // Meaningful only alongside isHalfDay, and rejected otherwise.
      ...(entry.isHalfDay && entry.halfDayPart !== null ? { halfDayPart: entry.halfDayPart } : {}),
      ...(entry.reason === null || entry.reason === '' ? {} : { reason: entry.reason }),
      // REQ-M-03: the tick recorded when the punch was taken, so the server can
      // record the acceptance with the synced punch.
      consentAccepted: entry.consentAccepted,
      idempotencyKey: entry.idempotencyKey,
      // Required by the shared/server contract. Legacy ownerless rows are
      // routed to recovery UI before this boundary, never attributed by guess.
      ownerUserId: entry.owner.userId,
      photoIndex: index,
    };
  });

  form.set('payload', JSON.stringify({ punches }));
  for (const entry of batch) form.append('photos', entry.photo, 'punch.jpg');
  return form;
}

export async function postPunchSync(
  batch: readonly QueuedPunch[],
  signal?: AbortSignal,
): Promise<PunchSyncReport> {
  return postMultipart('/punches/sync', buildSyncBody(batch), (body) => {
    const parsed = syncReportSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    // A report this build cannot read is the one case where doing nothing is
    // right: the punches may or may not have landed, so nothing is deleted and
    // the same keys are sent again. The server answers `replayed` for anything
    // it already holds.
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: 'The sync report came back in a shape this app cannot read. Nothing was removed.',
      status: 0,
      details: { issues: z.treeifyError(parsed.error) },
    });
  }, {}, signal);
}

/**
 * How many entries go in one request.
 *
 * The server caps the batch, so exceeding it would fail the whole drain rather
 * than part of it. Read from the shared contract instead of written down here,
 * so raising it there does not silently leave this at the old number.
 */
export function nextBatch(waiting: readonly QueuedPunch[]): readonly QueuedPunch[] {
  return waiting.slice(0, MAX_OFFLINE_SYNC_BATCH);
}
