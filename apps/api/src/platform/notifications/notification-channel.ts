import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel as NotificationChannelKey } from '@vyuha/shared';

import type { NotificationEventType, NotificationPayload } from './notification-events.js';

/**
 * Technical design §12, near enough verbatim:
 *
 * ```ts
 * interface NotificationChannel {
 *   key: 'in_app' | 'email' | 'whatsapp';
 *   send(to: Recipient, message: RenderedNotification): Promise<void>;
 * }
 * ```
 *
 * "Adding WhatsApp later must mean registering one new channel implementation
 * and nothing else." That is the property this file exists to protect, so it
 * is worth being explicit about what would break it and what does not:
 *
 * - A call site naming a channel would break it. None can: `dispatch` takes an
 *   event type and an audience, and there is no channel argument anywhere on
 *   the public surface.
 * - A template written per channel would break it. Templates render one
 *   neutral message; how it *looks* is the channel's business, which is why
 *   the email channel decides on a subject line and the in-app channel does
 *   not.
 * - Hard-coding the channel list in the dispatcher would break it. Channels
 *   register themselves, so a channel provided by any module joins the fan-out
 *   without the dispatcher learning its name.
 */

export interface Recipient {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}

export interface RenderedNotification {
  readonly eventType: NotificationEventType;
  readonly title: string;
  readonly body: string;
  /** Absolute, already prefixed with `WEB_BASE_URL`. Null when there is no destination. */
  readonly actionUrl: string | null;
  readonly payload: NotificationPayload;
}

/**
 * What the dispatcher knows and a channel might need.
 *
 * `channels` exists for the one channel that persists the notification record:
 * `notifications.channels_sent` is supposed to say where a notification
 * actually went, and only the dispatcher knows that. Channels that do not
 * persist anything ignore it.
 */
export interface DeliveryContext {
  readonly channels: readonly NotificationChannelKey[];
  readonly deliveryKey?: string;
}

export interface NotificationChannel {
  readonly key: NotificationChannelKey;
  /**
   * True for the channel that owns the durable record. Exactly one may set it,
   * and the dispatcher runs it last so it can record which other channels
   * succeeded rather than which ones were merely attempted.
   */
  readonly persistsRecord: boolean;
  reconcileReceipt?(to: Recipient, deliveryKey: string, channels: readonly NotificationChannelKey[]): Promise<void>;
  send(
    to: Recipient,
    message: RenderedNotification,
    context: DeliveryContext,
  ): Promise<void>;
}

/**
 * Channels announce themselves during `onModuleInit`, exactly as job handlers
 * do. The dispatcher reads the registry when it dispatches, so a channel
 * contributed by a module the platform has never heard of still participates.
 */
@Injectable()
export class ChannelRegistry {
  private readonly logger = new Logger(ChannelRegistry.name);
  private readonly channels = new Map<NotificationChannelKey, NotificationChannel>();

  register(channel: NotificationChannel): void {
    if (this.channels.has(channel.key)) {
      throw new Error(`Notification channel "${channel.key}" is already registered.`);
    }

    if (channel.persistsRecord) {
      const existing = [...this.channels.values()].find((other) => other.persistsRecord);
      if (existing !== undefined) {
        // Two record-keeping channels would each write a row, and the bell
        // count in REQ-K-05 would double.
        throw new Error(
          `Channel "${channel.key}" claims to persist the record, but "${existing.key}" already does.`,
        );
      }
    }

    this.channels.set(channel.key, channel);
    this.logger.log({ msg: `Notification channel registered: ${channel.key}` });
  }

  /** Record-keeping channel last, so it can be told what else went out. */
  all(): readonly NotificationChannel[] {
    return [...this.channels.values()].sort(
      (a, b) => Number(a.persistsRecord) - Number(b.persistsRecord),
    );
  }

  keys(): readonly NotificationChannelKey[] {
    return [...this.channels.keys()];
  }
}
