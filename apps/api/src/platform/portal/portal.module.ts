import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { PortalLinksController } from './portal-links.controller.js';
import { PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';

/**
 * Area AL. Platform rather than a module: the portal reads across sales,
 * the Tally projection and collections, and the platform may not import a
 * module (technical design §1). It reads them the way the report sources
 * do — raw SQL with the organisation in every WHERE — through one
 * repository that also carries the party (REQ-AL-04).
 */
@Global()
@Module({
  // REQ-AL-05: the portal is throttled by the same limiter the sign-in uses,
  // under its own scope, so a spray of invalid keys cannot spend the
  // office's sign-in budget and vice versa.
  imports: [AuthModule],
  controllers: [PortalController, PortalLinksController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
