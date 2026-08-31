import {
  REALTIME_RESOURCES,
  type RealtimeResource,
  type RealtimeViewer,
  realtimeEventSchema,
  type RealtimeEvent,
} from '@vyuha/shared';

/**
 * The client half of the live channel: what to refetch when something
 * changes, and who is in a record right now.
 *
 * Kept out of React so it can be unit-tested without a renderer, and so the
 * one connection is owned by one place rather than by whichever component
 * happened to mount first.
 */

/**
 * Which cached queries a change invalidates.
 *
 * Prefixes, not exact keys. A deal moving stage changes the list, the board,
 * that one deal and the pipeline's counts, and enumerating those four would
 * be a list that goes stale the first time somebody adds a fifth screen.
 * Over-refetching a cached prefix costs one request; missing one shows a
 * colleague stale data, which is the bug this exists to fix.
 */
const INVALIDATES: Record<RealtimeResource, readonly (readonly string[])[]> = {
  [REALTIME_RESOURCES.CRM_DEAL]: [['crm']],
  [REALTIME_RESOURCES.CRM_PIPELINE]: [['crm']],
  [REALTIME_RESOURCES.CRM_CONTACT]: [['crm']],
  [REALTIME_RESOURCES.CRM_COMPANY]: [['crm']],
  [REALTIME_RESOURCES.CRM_ACTIVITY]: [['crm']],
  [REALTIME_RESOURCES.TASK]: [['tasks']],
};

export function invalidationsFor(resource: RealtimeResource): readonly (readonly string[])[] {
  return INVALIDATES[resource];
}

/** `resource:recordId`, the key presence is looked up by. */
export function presenceKey(resource: RealtimeResource, recordId: string): string {
  return `${resource}:${recordId}`;
}

export type PresenceMap = ReadonlyMap<string, readonly RealtimeViewer[]>;

export function presenceMapOf(
  records: readonly { resource: RealtimeResource; recordId: string; viewers: readonly RealtimeViewer[] }[],
): PresenceMap {
  const map = new Map<string, readonly RealtimeViewer[]>();
  for (const record of records) map.set(presenceKey(record.resource, record.recordId), record.viewers);
  return map;
}

/**
 * Split a stream chunk into whole SSE messages, returning what is left over.
 *
 * A `fetch` body arrives in whatever sizes the network chose, so a message
 * can be cut in half between two chunks. Parsing per chunk would drop those
 * halves silently -- an update that never arrives and no error anywhere.
 */
export function drainFrames(buffer: string): { events: RealtimeEvent[]; rest: string } {
  const events: RealtimeEvent[] = [];
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf('\n\n');

    const payload = frame
      .split('\n')
      // `:` opens a comment, which is what the keepalive is.
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (payload === '') continue;

    try {
      const parsed = realtimeEventSchema.safeParse(JSON.parse(payload) as unknown);
      // A server that has been deployed with a resource this build does not
      // know about must not take the stream down: skip the frame, keep the
      // connection.
      if (parsed.success) events.push(parsed.data);
    } catch {
      // Malformed JSON is the same case: one lost update, not a dead stream.
    }
  }
  return { events, rest };
}

/**
 * How long to wait before reconnecting after the stream drops, growing with
 * each consecutive failure.
 *
 * A laptop lid closing disconnects every user in the office at once, and they
 * all come back at once when it opens. Fixed-interval retries from fifty
 * browsers arrive as a stampede; the jitter spreads them out.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1_000 * 2 ** Math.max(attempt - 1, 0), 30_000);
  return Math.round(base * (0.5 + random() * 0.5));
}
