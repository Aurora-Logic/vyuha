import { Global, Module } from '@nestjs/common';

import { DealDocumentRegistry } from './deal-document.registry.js';

/**
 * The seam between a deal and the documents raised against it (REQ-U-12).
 *
 * Global for the same reason the other registries are: sales registers into
 * it during `onModuleInit` and CRM reads it on every deal query, and a
 * second instance would be one nobody registered with — a badge that is
 * simply never there, with nothing in the log to say why.
 *
 * The platform holds only the interface. It knows what a deal is (its id)
 * and nothing whatever about an invoice.
 */
@Global()
@Module({
  providers: [DealDocumentRegistry],
  exports: [DealDocumentRegistry],
})
export class DealsLinkModule {}
