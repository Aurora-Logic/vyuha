import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import {
  DealDocumentRegistry,
  type DealDocumentSummariser,
  type DealPaperwork,
} from '../../../platform/deals/deal-document.registry.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { salesDocuments } from '../schema/index.js';

/**
 * REQ-U-12: sales answering the platform's question about a deal.
 *
 * The arrow points this way round on purpose (technical design §1). CRM
 * never learns that `sales_documents` exists; it holds a registry handle and
 * gets back two booleans per deal.
 *
 * Deliberately not scoped to the caller's documents. A deal's own scope has
 * already decided whether this person may see the deal at all, and the
 * answer here is a property of the deal — "this has been invoiced" — not a
 * window onto a document. Withholding the badge from a salesperson who may
 * read the deal but not the invoice would tell them the deal is not invoiced,
 * which is worse than telling them nothing: it is telling them something
 * false.
 */
@Injectable()
export class DealPaperworkSummariser implements DealDocumentSummariser, OnModuleInit {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly registry: DealDocumentRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async summarise(orgId: string, dealIds: readonly string[]): Promise<Map<string, DealPaperwork>> {
    const rows = await this.db
      .select({
        dealId: salesDocuments.dealId,
        // One pass over the deal's documents rather than one query per type.
        hasOrder: sql<boolean>`bool_or(${salesDocuments.docType} = 'SALES_ORDER')`,
        hasInvoice: sql<boolean>`bool_or(${salesDocuments.docType} = 'INVOICE')`,
      })
      .from(salesDocuments)
      .where(
        and(
          eq(salesDocuments.orgId, orgId),
          isNull(salesDocuments.deletedAt),
          isNotNull(salesDocuments.dealId),
          inArray(salesDocuments.dealId, [...dealIds]),
        ),
      )
      .groupBy(salesDocuments.dealId);

    const byDeal = new Map<string, DealPaperwork>();
    for (const row of rows) {
      if (row.dealId === null) continue;
      byDeal.set(row.dealId, { hasOrder: row.hasOrder, hasInvoice: row.hasInvoice });
    }
    return byDeal;
  }
}
