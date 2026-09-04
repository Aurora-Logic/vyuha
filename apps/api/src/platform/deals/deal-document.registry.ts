import { Injectable, Logger } from '@nestjs/common';

/**
 * REQ-U-12: what paperwork a deal has behind it, answered by whoever owns
 * the paperwork.
 *
 * A deal is "invoiced" when an invoice exists against it. That fact lives in
 * `sales_documents`, which the sales module owns, and technical design §1
 * forbids `modules/crm` from importing `modules/sales` — so the platform
 * defines this interface, sales implements it, and CRM asks. The same
 * inversion as `TaskSubjectRegistry` and `GoToSourceRegistry`, for the same
 * reason.
 *
 * **Batched, deliberately.** A register draws fifty deals; a summariser that
 * answered one deal at a time would be fifty round trips to paint one
 * screen, and the first person to notice would be the salesperson whose
 * board took four seconds.
 *
 * Nothing here is authoritative and nothing is cached: it is read alongside
 * the deals it decorates, so it cannot disagree with the documents screen.
 */

export interface DealPaperwork {
  /** A sales order exists against the deal. */
  readonly hasOrder: boolean;
  /** An invoice exists against the deal — what "Invoiced" means. */
  readonly hasInvoice: boolean;
}

export interface DealDocumentSummariser {
  summarise(orgId: string, dealIds: readonly string[]): Promise<Map<string, DealPaperwork>>;
}

@Injectable()
export class DealDocumentRegistry {
  private readonly logger = new Logger(DealDocumentRegistry.name);
  private summariser: DealDocumentSummariser | null = null;

  register(summariser: DealDocumentSummariser): void {
    if (this.summariser !== null) {
      throw new Error('A deal document summariser is already registered.');
    }
    this.summariser = summariser;
    this.logger.log({ msg: 'Deal document summariser registered' });
  }

  /**
   * An empty map when nothing has registered, which is the honest answer for
   * a deployment without the sales module rather than a crash: the deal
   * screens lose a badge and keep working.
   */
  async summarise(orgId: string, dealIds: readonly string[]): Promise<Map<string, DealPaperwork>> {
    if (this.summariser === null || dealIds.length === 0) return new Map();
    return this.summariser.summarise(orgId, dealIds);
  }
}
