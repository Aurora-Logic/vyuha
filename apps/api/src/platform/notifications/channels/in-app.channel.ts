import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { NotificationChannel as NotificationChannelKey } from '@vyuha/shared';
import { and, eq } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../../db/db.provider.js';
import { notifications } from '../../db/schema/index.js';
import {
  ChannelRegistry,
  type DeliveryContext,
  type NotificationChannel,
  type Recipient,
  type RenderedNotification,
} from '../notification-channel.js';

/**
 * REQ-K-05's bell. One row per recipient per event.
 *
 * This is the channel that owns the durable record, so it runs last and is
 * told which other channels succeeded -- `channels_sent` then says what
 * actually happened rather than what was intended.
 */
@Injectable()
export class InAppChannel implements NotificationChannel, OnModuleInit {
  readonly key: NotificationChannelKey = 'in_app';
  readonly persistsRecord = true;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: ChannelRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async reconcileReceipt(to: Recipient, deliveryKey: string, channels: readonly NotificationChannelKey[]): Promise<void> {
    await this.db.update(notifications).set({ channelsSent: [...channels] })
      .where(and(eq(notifications.orgId, to.orgId), eq(notifications.userId, to.userId), eq(notifications.deliveryKey, deliveryKey)));
  }

  async send(
    to: Recipient,
    message: RenderedNotification,
    context: DeliveryContext,
  ): Promise<void> {
    await this.db.insert(notifications).values({
      orgId: to.orgId,
      userId: to.userId,
      eventType: message.eventType,
      title: message.title,
      body: message.body,
      // The payload rides along so the bell can deep-link and a future screen
      // can render richer content without a schema change.
      payload: { ...message.payload, actionUrl: message.actionUrl },
      channelsSent: [...context.channels],
      deliveryKey: context.deliveryKey ?? null,
    }).onConflictDoNothing({ target: [notifications.orgId, notifications.deliveryKey] });
  }
}
