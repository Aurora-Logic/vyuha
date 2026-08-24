import { Module } from '@nestjs/common';

import './constraint-messages.js';
import { IntegrationController } from './integration.controller.js';
import { IntegrationService } from './integration.service.js';

/**
 * The Tally seam (technical design §3 puts it at `platform/integration/`, and
 * §14 says what it is for).
 *
 * Platform rather than attendance: `integration_connections` and
 * `external_refs` will carry CRM and ERP mappings too, and the agent protocol
 * knows nothing about attendance. Nothing here imports a module, and no module
 * imports this.
 *
 * Exported because the Phase 6 sync will need to resolve a connection, and the
 * alternative — a second reader of the same table — is how the credential
 * column ends up in a select list.
 */
@Module({
  controllers: [IntegrationController],
  providers: [IntegrationService],
  exports: [IntegrationService],
})
export class IntegrationModule {}
