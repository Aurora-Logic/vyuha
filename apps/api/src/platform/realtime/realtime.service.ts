import { Injectable, Logger } from '@nestjs/common';
import {
  PRESENCE_EXPIRY_MS,
  type RealtimeChange,
  type RealtimeEvent,
  type RealtimeResource,
  type RealtimeViewer,
} from '@vyuha/shared';

/**
 * Who is connected, what they have open, and how a change reaches them.
 *
 * **This is deliberately in-memory, and that is a bounded decision, not an
 * oversight.** One API process holds every stream it serves, so a second
 * process would each hold half the org and neither would see the other's
 * changes. The product runs a single API process today (09 §2), and the
 * moment it does not, this class is the one place to swap for a Redis
 * pub/sub fan-out -- the publish and subscribe surface is already the shape
 * that needs. Nothing outside it knows how delivery works.
 *
 * Nothing here is persisted, and nothing here is authoritative. A dropped
 * connection costs a client one refetch on reconnect; a lost roster costs a
 * few seconds of a missing avatar. Neither is a correctness problem, which
 * is why an in-memory store is the right size for it.
 *
 * Everything is keyed by organisation first. A subscriber is only ever
 * handed events for its own org, so the fan-out cannot cross a tenant even
 * if a caller passes the wrong id -- the wrong id simply reaches nobody.
 */

/** One open stream. `send` returns false once the socket is gone. */
export interface RealtimeSubscriber {
  readonly userId: string;
  readonly name: string;
  send(event: RealtimeEvent): boolean;
}

interface PresenceHolder {
  readonly userId: string;
  readonly name: string;
  /** When the last heartbeat arrived; anything older than the expiry is gone. */
  at: number;
}

/** `resource:recordId`, the key a roster entry is filed under. */
type RecordKey = `${RealtimeResource}:${string}`;

function recordKeyOf(resource: RealtimeResource, recordId: string): RecordKey {
  return `${resource}:${recordId}`;
}

interface OrgChannel {
  readonly subscribers: Set<RealtimeSubscriber>;
  /** record key -> user id -> holder. Keyed by user so a second tab replaces rather than doubles. */
  readonly presence: Map<RecordKey, Map<string, PresenceHolder>>;
}

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly channels = new Map<string, OrgChannel>();

  private channel(orgId: string): OrgChannel {
    const existing = this.channels.get(orgId);
    if (existing !== undefined) return existing;
    const created: OrgChannel = { subscribers: new Set(), presence: new Map() };
    this.channels.set(orgId, created);
    return created;
  }

  /**
   * Open a stream. The returned function closes it, and closing also drops
   * whatever the person had open -- a browser that is gone cannot be
   * "working on" a record, and waiting out the expiry would leave their
   * avatar on a colleague's screen for the better part of a minute.
   */
  subscribe(orgId: string, subscriber: RealtimeSubscriber): () => void {
    const channel = this.channel(orgId);
    channel.subscribers.add(subscriber);
    return () => {
      channel.subscribers.delete(subscriber);
      if (this.forget(orgId, subscriber.userId)) this.broadcastPresence(orgId);
      if (channel.subscribers.size === 0 && channel.presence.size === 0) {
        // An org with nobody signed in should not hold a map for ever.
        this.channels.delete(orgId);
      }
    };
  }

  /**
   * Tell every open screen in the org that something changed.
   *
   * Best-effort by construction: a subscriber whose socket has closed between
   * the write and this call is dropped rather than thrown from. A caller has
   * already committed its work by the time it publishes, and a delivery
   * failure must never turn a saved record into a failed request -- the same
   * reasoning that put `emitAfterCommit` on the notification dispatcher.
   */
  publish(orgId: string, change: Omit<RealtimeChange, 'kind' | 'at' | 'actorName'>): void {
    const channel = this.channels.get(orgId);
    if (channel === undefined || channel.subscribers.size === 0) return;
    const event: RealtimeChange = {
      kind: 'change',
      at: new Date().toISOString(),
      // Read off the actor's own stream rather than the database. Whoever
      // just wrote a record is by definition using the app, so their name is
      // already here; a lookup would put a query on the write path of every
      // mutation in the product to render a word in a toast.
      actorName: this.nameOf(channel, change.actorUserId) ?? 'Someone',
      ...change,
    };
    this.fanOut(channel, event);
  }

  /** "I have this record open." A null `recordId` means they have left whatever they had. */
  heartbeat(
    orgId: string,
    viewer: RealtimeViewer,
    resource: RealtimeResource,
    recordId: string | null,
  ): void {
    const channel = this.channel(orgId);
    const now = Date.now();

    if (recordId !== null) {
      // The common case by a distance: the same person saying the same thing
      // every fifteen seconds. It renews a lease and changes nothing anyone
      // can see, so it must not wake every browser in the org. Only a holder
      // still inside its expiry counts -- one that lapsed was already dropped
      // from the rosters on screen, and coming back is news.
      const existing = channel.presence.get(recordKeyOf(resource, recordId))?.get(viewer.userId);
      if (existing !== undefined && existing.at >= now - PRESENCE_EXPIRY_MS) {
        existing.at = now;
        return;
      }
    }

    const removed = this.forget(orgId, viewer.userId);
    let added = false;
    if (recordId !== null) {
      const key = recordKeyOf(resource, recordId);
      const holders = channel.presence.get(key) ?? new Map<string, PresenceHolder>();
      holders.set(viewer.userId, { userId: viewer.userId, name: viewer.name, at: now });
      channel.presence.set(key, holders);
      added = true;
    }
    if (removed || added) this.broadcastPresence(orgId);
  }

  /**
   * The roster as the client sees it, with expired holders dropped.
   *
   * Expiry is applied on read rather than on a timer. A timer would have to
   * run per organisation for as long as the process lives, and would fire
   * hardest when nothing is happening; reading is only done when something
   * already is.
   */
  roster(orgId: string): { resource: RealtimeResource; recordId: string; viewers: RealtimeViewer[] }[] {
    const channel = this.channels.get(orgId);
    if (channel === undefined) return [];
    const cutoff = Date.now() - PRESENCE_EXPIRY_MS;
    const records: { resource: RealtimeResource; recordId: string; viewers: RealtimeViewer[] }[] = [];

    for (const [key, holders] of channel.presence) {
      for (const [userId, holder] of holders) {
        if (holder.at < cutoff) holders.delete(userId);
      }
      if (holders.size === 0) {
        channel.presence.delete(key);
        continue;
      }
      const separator = key.indexOf(':');
      const resource = key.slice(0, separator) as RealtimeResource;
      const recordId = key.slice(separator + 1);
      records.push({
        resource,
        recordId,
        viewers: [...holders.values()]
          .map(({ userId, name }) => ({ userId, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    return records;
  }

  broadcastPresence(orgId: string): void {
    const channel = this.channels.get(orgId);
    if (channel === undefined || channel.subscribers.size === 0) return;
    this.fanOut(channel, { kind: 'presence', records: this.roster(orgId) });
  }

  /** Test and diagnostic seam: how many streams this process is holding. */
  subscriberCount(orgId: string): number {
    return this.channels.get(orgId)?.subscribers.size ?? 0;
  }

  private nameOf(channel: OrgChannel, userId: string): string | null {
    for (const subscriber of channel.subscribers) {
      if (subscriber.userId === userId) return subscriber.name;
    }
    return null;
  }

  /** Drop every record this person held. Returns whether anything was actually removed. */
  private forget(orgId: string, userId: string): boolean {
    const channel = this.channels.get(orgId);
    if (channel === undefined) return false;
    let removed = false;
    for (const [key, holders] of channel.presence) {
      if (holders.delete(userId)) {
        removed = true;
        if (holders.size === 0) channel.presence.delete(key);
      }
    }
    return removed;
  }

  private fanOut(channel: OrgChannel, event: RealtimeEvent): void {
    for (const subscriber of channel.subscribers) {
      let delivered = false;
      try {
        delivered = subscriber.send(event);
      } catch (error) {
        this.logger.warn({
          msg: 'A live stream could not be written to and was dropped',
          userId: subscriber.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!delivered) channel.subscribers.delete(subscriber);
    }
  }
}
