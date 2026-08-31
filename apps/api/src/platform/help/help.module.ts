import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';
import { HelpController } from './help.controller.js';
import { HelpService } from './help.service.js';

/**
 * The answer panel's corpus (REQ-AJ-01 to REQ-AJ-04, proposed; see
 * `OPEN-QUESTIONS.md` P-HELP-1).
 *
 * Platform rather than attendance, and it has to stay that way: the cards
 * already span punch, leave, approvals, reports, sales documents and the
 * Tally connector, so filing it under any one module would put a module's
 * copy inside another module's boundary. It reads nothing but its own
 * constant for reading; the one table it writes (help_questions, REQ-AJ-05)
 * is platform-owned, so the boundary still holds.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [HelpController],
  providers: [HelpService],
  exports: [HelpService],
})
export class HelpModule {}
