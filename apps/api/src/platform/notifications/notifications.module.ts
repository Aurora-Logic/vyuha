import { Global, Module } from '@nestjs/common';

import { EmailChannel } from './channels/email.channel.js';
import { InAppChannel } from './channels/in-app.channel.js';
import { SendNotificationHandler } from './handlers/send-notification.handler.js';
import { DrainNotificationOutboxHandler } from './handlers/drain-notification-outbox.handler.js';
import { ChannelRegistry } from './notification-channel.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationService } from './notification.service.js';
import { NotificationsController } from './notifications.controller.js';
import { RecipientResolver } from './recipient-resolver.service.js';

/**
 * Global: every module that will ever exist emits notifications, and only
 * `NotificationDispatcher` is exported. The channels, the resolver, and the
 * preference reader are internal on purpose -- exporting a channel would make
 * it possible for a feature to send on one directly, which technical design
 * §12 rules out.
 *
 * **Adding WhatsApp is one line here plus one file in `channels/`.** No call
 * site changes, no template changes, no dispatcher change: the class registers
 * itself with `ChannelRegistry` on init and joins the fan-out.
 *
 * `NotificationsController` is the read side (REQ-K-05's bell) and the
 * preference writes (REQ-K-04). It is not exported and nothing else may reach
 * `NotificationService`: it acts only on the caller's own account, so a second
 * consumer of it would be a consumer with somebody else's principal.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    ChannelRegistry,
    RecipientResolver,
    NotificationPreferencesService,
    NotificationDispatcher,
    NotificationService,
    InAppChannel,
    EmailChannel,
    SendNotificationHandler,
    DrainNotificationOutboxHandler,
  ],
  exports: [NotificationDispatcher],
})
export class NotificationsModule {}
