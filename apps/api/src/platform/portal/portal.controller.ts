import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import type { PortalView } from '@vyuha/shared';
import type { Request } from 'express';

import { Public } from '../rbac/route-policy.js';
import { PortalService, type PortalRequestContext } from './portal.service.js';

/**
 * Area AL, the customer's side. Two routes, both read-only (REQ-AL-02):
 * the portal, and a short-lived link to one of its photographs.
 *
 * `@Public()` because there is no account here — the key in the path is
 * the credential, and it is checked in the service, which is also where
 * the throttle and the access log live.
 *
 * REQ-AL-09 (the portal is outside the office access window) needs no
 * decorator: `AccessGuard` answers a public route before it ever reads the
 * window, which is a rule about a *principal* and there is none here. A
 * `@WindowExempt()` was written first and then removed — it did nothing,
 * and a decorator that appears to enforce a rule it does not enforce is
 * worse than no decorator. The endpoints test closes the window and asks
 * the portal anyway, which is what actually holds the requirement.
 *
 * The key rides in the path rather than a header so that the whole link
 * can be pasted into a WhatsApp message, which is how REQ-AL-10 says most
 * of these will be opened.
 */
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get(':key')
  @Public()
  view(@Param('key') key: string, @Req() request: Request): Promise<PortalView> {
    return this.portal.view(key, contextOf(request));
  }

  @Get(':key/media/:fileId')
  @Public()
  media(@Param('key') key: string, @Param('fileId', ParseUUIDPipe) fileId: string, @Req() request: Request): Promise<{ url: string; expiresInSeconds: number }> {
    return this.portal.media(key, fileId, contextOf(request));
  }
}

function contextOf(request: Request): PortalRequestContext {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    // Bounded: a header is whatever the client says it is, and this one is
    // stored on every view.
    userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null,
  };
}
