import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS, issuePortalKeySchema, revokePortalKeySchema, type IssuedPortalKey, type PortalKeyView } from '@vyuha/shared';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { RequirePermission } from '../rbac/route-policy.js';
import { PortalService } from './portal.service.js';

/** Area AL, the staff side: issue a customer's link, see its state, withdraw it (REQ-AL-03/AL-07). */
class IssuePortalKeyDto extends createZodDto(issuePortalKeySchema) {}
class RevokePortalKeyDto extends createZodDto(revokePortalKeySchema) {}
class PortalKeyQueryDto extends createZodDto(z.object({ partyId: z.uuid().optional() })) {}

@Controller('portal-links')
export class PortalLinksController {
  constructor(private readonly portal: PortalService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PORTAL_MANAGE, PERMISSIONS.RECEIVABLES_VIEW)
  list(@CurrentUser() principal: Principal, @Query() query: PortalKeyQueryDto): Promise<PortalKeyView[]> {
    return this.portal.list(principal, query.partyId);
  }

  /** The one reply that carries the key in the clear; it is never readable again. */
  @Post()
  @RequirePermission(PERMISSIONS.PORTAL_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  issue(@CurrentUser() principal: Principal, @Body() body: IssuePortalKeyDto): Promise<IssuedPortalKey> {
    return this.portal.issue(principal, body);
  }

  @Post(':id/revoke')
  @RequirePermission(PERMISSIONS.PORTAL_MANAGE)
  @HttpCode(HttpStatus.OK)
  revoke(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: RevokePortalKeyDto): Promise<PortalKeyView> {
    return this.portal.revoke(principal, id, body.reason);
  }
}
