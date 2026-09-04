import {
  HALF_DAY_PARTS,
  PUNCH_TYPES,
  idempotencyKeySchema,
  type HalfDayPart,
  type PunchType,
} from '@vyuha/shared';
import { z } from 'zod';

import { idbAdd, idbDelete, idbGetAll, idbPut, inTransaction, openDatabase } from './idb';

/**
 * The offline punch queue (REQ-D-10, technical design section 8).
 *
 * One IndexedDB store holding what a punch asserted about itself plus the photo
 * Blob, surviving a reload, a tab close and a browser restart.
 *
 * Three properties this has to keep, in order of how badly they hurt when
 * broken:
 *
 * 1. **A punch is never lost.** Nothing is deleted except an entry the server
 *    has confirmed it holds, or one a person has explicitly dismissed after
 *    being told what to do instead. An entry that cannot be read back is kept
 *    and counted rather than swept away.
 * 2. **A punch is never submitted twice.** The idempotency key is generated
 *    once, at the moment of the attempt, and stored with the entry. It is the
 *    primary key here, so the store itself refuses a duplicate, and it is what
 *    the server matches on, so a retry of a request whose response was lost
 *    returns the original punch rather than making a second one (REQ-D-11).
 * 3. **A queued punch never looks like a recorded one.** This module is the
 *    source of truth the screen reads to say so.
 *
 * The schema is applied on the way *out* as well as in. A queue written by an
 * older build of this app is untrusted input in exactly the way CLAUDE.md
 * means: same origin, different code, arbitrary age.
 */

const DB_NAME = 'vyuha-offline';
const DB_VERSION = 1;
const STORE = 'punch-queue';

/** Mirrors `OFFLINE_SYNC_MAX_AGE_HOURS` on the server; used only to warn early. */
const MAX_AGE_HOURS = 48;
const WARN_AGE_HOURS = 36;

const refusalSchema = z.object({
  code: z.string(),
  message: z.string(),
  at: z.string(),
});

export const queuedPunchSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  type: z.enum(PUNCH_TYPES),
  /** REQ-D-04: what the device believed the time was when the button was pressed. */
  clientTime: z.iso.datetime({ offset: true }),
  /** When it entered the queue, which is what the 48-hour rule is measured from. */
  queuedAt: z.iso.datetime({ offset: true }),
  photo: z.instanceof(Blob),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  gpsAccuracyM: z.number().nullable(),
  isHalfDay: z.boolean(),
  halfDayPart: z.enum(HALF_DAY_PARTS).nullable(),
  reason: z.string().nullable(),
  /**
   * REQ-M-03: the tick on the consent notice, carried with the punch so a
   * first punch taken offline records its acceptance at sync time. Defaulted
   * so a queue written by an older build still parses -- those entries simply
   * carry no assertion, and the server says CONSENT_REQUIRED if none is on
   * record, which lands in `refusal` like any other server answer.
   */
  consentAccepted: z.boolean().default(false),
  attempts: z.number().int().nonnegative(),
  lastAttemptAt: z.string().nullable(),
  /** Set when the server looked at this entry and said no. Never retried after. */
  refusal: refusalSchema.nullable(),
});

export type QueuedPunch = z.infer<typeof queuedPunchSchema>;

export interface NewQueuedPunch {
  type: PunchType;
  photo: Blob;
  idempotencyKey: string;
  clientTime: string;
  coords: { latitude: number; longitude: number; accuracyM: number } | null;
  halfDay: HalfDayPart | null;
  reason: string | null;
  /** REQ-M-03: see `queuedPunchSchema`. */
  consentAccepted: boolean;
}

let database: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  database ??= openDatabase(
    DB_NAME,
    DB_VERSION,
    (instance) => {
      if (!instance.objectStoreNames.contains(STORE)) {
        // Keyed by the idempotency key so the store itself cannot hold the same
        // punch twice, whatever the calling code does.
        instance.createObjectStore(STORE, { keyPath: 'idempotencyKey' });
      }
    },
    () => {
      database = null;
    },
  ).catch((cause: unknown) => {
    // A cached rejected promise would make one bad open permanent.
    database = null;
    throw cause;
  });
  return database;
}

/**
 * One transaction, with a single reopen if the connection had gone.
 *
 * A connection closes out from under this tab whenever another tab upgrades the
 * schema — `onversionchange` closes it, and it must, or the other tab blocks
 * for ever. The cached handle is then dead, and every later call throws
 * `InvalidStateError: The database connection is closing`. Left alone, that
 * means a second tab doing something ordinary permanently stops this one from
 * queueing a punch, which is the exact failure this queue exists to prevent.
 * Found by deleting the database from under a live page.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  try {
    return await inTransaction(await db(), STORE, mode, work);
  } catch (cause) {
    if (!(cause instanceof DOMException) || cause.name !== 'InvalidStateError') throw cause;
    database = null;
    return inTransaction(await db(), STORE, mode, work);
  }
}

export interface QueueContents {
  /** Waiting to be sent, oldest first — the order they were taken in. */
  readonly waiting: readonly QueuedPunch[];
  /** The server refused these. They stay until a person dismisses them. */
  readonly refused: readonly QueuedPunch[];
  /**
   * Rows this build cannot parse. Never deleted, because a row we cannot read
   * may still be somebody's punch; counted, because a silent one is worse.
   */
  readonly unreadable: number;
}

export async function readQueue(): Promise<QueueContents> {
  const rows = await withStore('readonly', idbGetAll);

  const waiting: QueuedPunch[] = [];
  const refused: QueuedPunch[] = [];
  let unreadable = 0;

  for (const row of rows) {
    const parsed = queuedPunchSchema.safeParse(row);
    if (!parsed.success) {
      unreadable += 1;
      continue;
    }
    (parsed.data.refusal === null ? waiting : refused).push(parsed.data);
  }

  const byQueuedAt = (a: QueuedPunch, b: QueuedPunch): number =>
    a.queuedAt.localeCompare(b.queuedAt);

  return {
    waiting: waiting.sort(byQueuedAt),
    refused: refused.sort(byQueuedAt),
    unreadable,
  };
}

export async function enqueuePunch(draft: NewQueuedPunch): Promise<QueuedPunch> {
  const entry: QueuedPunch = {
    idempotencyKey: draft.idempotencyKey,
    type: draft.type,
    clientTime: draft.clientTime,
    queuedAt: new Date().toISOString(),
    photo: draft.photo,
    latitude: draft.coords?.latitude ?? null,
    longitude: draft.coords?.longitude ?? null,
    gpsAccuracyM: draft.coords?.accuracyM ?? null,
    isHalfDay: draft.halfDay !== null,
    halfDayPart: draft.halfDay,
    reason: draft.reason,
    consentAccepted: draft.consentAccepted,
    attempts: 0,
    lastAttemptAt: null,
    refusal: null,
  };

  // Validated before it is written, not only after it is read. A row that the
  // schema would reject on the way out is a row that can never be sent, and
  // finding that out two days later is finding out too late.
  const parsed = queuedPunchSchema.parse(entry);
  await withStore('readwrite', (store) => idbAdd(store, parsed));
  return parsed;
}

export async function removeQueued(idempotencyKey: string): Promise<void> {
  await withStore('readwrite', (store) => idbDelete(store, idempotencyKey));
}

export async function updateQueued(entry: QueuedPunch): Promise<void> {
  await withStore('readwrite', (store) => idbPut(store, entry));
}

/** Hours this entry has been waiting, against the server's 48-hour limit. */
export function queuedHours(entry: QueuedPunch, now: number = Date.now()): number {
  return (now - Date.parse(entry.queuedAt)) / 3_600_000;
}

/**
 * True while there is still time to fix it. Warning at 36 hours rather than at
 * 48 is the difference between "get online today" and "raise a regularization",
 * and only one of those is something a person can act on.
 */
export function isNearingSyncDeadline(entry: QueuedPunch, now: number = Date.now()): boolean {
  const hours = queuedHours(entry, now);
  return hours >= WARN_AGE_HOURS && hours < MAX_AGE_HOURS;
}

export { MAX_AGE_HOURS as OFFLINE_QUEUE_MAX_AGE_HOURS };
