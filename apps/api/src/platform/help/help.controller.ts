import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';
import type { HelpCardsResponse } from '@vyuha/shared';

import { CurrentUser, type Principal } from '../rbac/principal.js';
import { Authenticated } from '../rbac/route-policy.js';
import { HelpService } from './help.service.js';

/**
 * `GET /help/cards` (REQ-AJ-01, proposed). Everything the Ctrl+F1 answer
 * panel can say to this caller.
 *
 * `@Authenticated()` rather than a permission key, for the reason
 * `GoToController` gives about search: there is no key that means "may ask a
 * question", and inventing one would either be granted to everybody — a check
 * that checks nothing — or become a second copy of the keys the cards already
 * name. Each card declares its own permission and `HelpService` filters on
 * those, so a caller holding almost nothing gets a small, well-formed corpus
 * rather than a 403.
 *
 * Not public. The cards name which controls are switched off, and
 * `docker/Caddyfile` leaves the static bundle unauthenticated — so this
 * endpoint is the boundary that keeps the corpus behind sign-in.
 *
 * No query parameter: the client takes the set once and ranks it locally.
 */
const askSchema = z.object({ question: z.string().trim().min(3).max(500) });
class AskDto extends createZodDto(askSchema) {}

@Controller('help')
export class HelpController {
  constructor(private readonly help: HelpService) {}

  @Get('cards')
  @Authenticated()
  cards(@CurrentUser() principal: Principal): HelpCardsResponse {
    return this.help.cardsFor(principal);
  }

  /** REQ-AJ-05: a question the panel had no card for, sent on deliberately. */
  @Post('questions')
  @Authenticated()
  @HttpCode(201)
  async ask(@CurrentUser() principal: Principal, @Body() body: AskDto): Promise<{ ok: true }> {
    await this.help.ask(principal, body.question);
    return { ok: true };
  }
}

