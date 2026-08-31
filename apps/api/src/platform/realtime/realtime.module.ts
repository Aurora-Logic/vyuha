import { Global, Module } from '@nestjs/common';

import { ActorNameService } from '../people/actor-name.service.js';
import { RealtimeController } from './realtime.controller.js';
import { RealtimeService } from './realtime.service.js';

/**
 * The live channel (REQ-U-09, REQ-U-10).
 *
 * Global for the same reason `AuditModule` is: any module that writes a
 * record may want to say so, and `RealtimeService` holds the connected
 * sockets in its own fields -- a second instance would be a second set of
 * subscribers that nobody publishes to, and the only symptom would be
 * screens that quietly stop updating for half the users.
 *
 * Platform, not CRM, although CRM is what asked for it. Nothing here knows
 * what a deal is; the resource names come from the shared contract and every
 * module publishes onto the same channel. Tasks already do.
 *
 * `ActorNameService` is provided here rather than imported from
 * `PeopleModule`, which is not global; it is a stateless read and a second
 * instance costs nothing.
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService, ActorNameService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
