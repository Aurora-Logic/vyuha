import { Injectable } from '@nestjs/common';
import { NOTIFICATION_EVENTS, PERMISSIONS } from '@vyuha/shared';
import type { HelpCardsResponse } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';
import { hasPermission, type Principal } from '../rbac/principal.js';
import { HELP_CARDS } from './help.cards.js';

/**
 * REQ-AJ-03 (proposed): which cards this caller may be shown.
 *
 * The whole permitted set goes over the wire at once and the client searches
 * it locally. That is deliberate on three counts: the corpus is small enough
 * that ranking it in the browser is instant, an answer panel that asks the
 * server per keystroke feels slower than the question, and a set already in
 * hand still answers when the network is not there — which matters because
 * the punch screen is the one most likely to be used on a bad connection, and
 * the service worker already precaches for exactly that.
 *
 * Filtering is here rather than in the browser for the ordinary reason: the
 * client's copy of a permission decision is cosmetic. A card that names what
 * an administrator can do is not dangerous, but it is noise to someone who
 * cannot do it, and a corpus is a disclosure surface — `help.cards.ts` says
 * why the file is served rather than bundled.
 */
@Injectable()
export class HelpService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly notifications: NotificationDispatcher,
  ) {}

  cardsFor(principal: Principal): HelpCardsResponse {
    const cards = HELP_CARDS.filter(
      (card) => card.permission === null || hasPermission(principal, card.permission),
    );
    return { cards };
  }

  /**
   * REQ-AJ-05 (owner, 28 Aug 2026): the unanswered-question path. Explicit
   * send only -- the text is employee free text, so the panel offers a
   * "send to your administrator" action rather than logging misses silently.
   * The notification to settings.manage holders IS the delivery; the row is
   * the record behind it, and the trail knows who asked what and when.
   */
  async ask(principal: Principal, question: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO help_questions (org_id, user_id, question)
      VALUES (${principal.orgId}, ${principal.userId}, ${question})
    `);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'help.question_asked',
      entityType: 'help_question',
      entityId: principal.userId,
      before: null,
      after: { question },
    });
    await this.notifications.emitAfterCommit({
      orgId: principal.orgId,
      type: NOTIFICATION_EVENTS.HELP_QUESTION_ASKED,
      audience: { kind: 'permission', key: PERMISSIONS.SETTINGS_MANAGE },
      payload: { askedBy: principal.email, question: question.slice(0, 200) },
    });
  }
}
