import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import {
  PERMISSIONS,
  createPackRecordSchema,
  createPickRecordSchema,
  linkInvoiceSchema,
  packListQuerySchema,
  shortCloseSchema,
  type AwaitingInvoiceEntry,
  type PackRecordView,
  type Paginated,
  type PickQueueEntry,
  type PickRecordView,
  type SalesDocumentView,
  type UnlinkedInvoice,
} from '@vyuha/shared';
import type { Response } from 'express';

import { createZodDto } from '../../../platform/common/zod-validation.pipe.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { sendDocumentXlsx } from '../../../platform/documents/document-export.js';
import { DocumentSettingsService } from '../../../platform/documents/document-settings.service.js';
import { DocumentXlsxService } from '../../../platform/documents/document-xlsx.service.js';
import { CurrentUser, type Principal } from '../../../platform/rbac/principal.js';
import { RequirePermission } from '../../../platform/rbac/route-policy.js';
import { FulfilmentService } from './fulfilment.service.js';

class CreatePackRecordDto extends createZodDto(createPackRecordSchema) {}
class CreatePickRecordDto extends createZodDto(createPickRecordSchema) {}
class LinkInvoiceDto extends createZodDto(linkInvoiceSchema) {}
class ShortCloseDto extends createZodDto(shortCloseSchema) {}

class PackListQueryDto extends createZodDto(packListQuerySchema) {}

const VIEW = [PERMISSIONS.SALES_DOCUMENT_VIEW_SELF, PERMISSIONS.SALES_DOCUMENT_VIEW_ALL] as const;

/**
 * Pick queue, packing, and the billing handshake (12 §3.2, §3.3).
 *
 * P8-5 (owner, 28 Aug 2026): the floor's routes — the queue, picks and packs —
 * answer to `sales.fulfil` alone, so raising documents no longer implies
 * handling boxes. The billing handshake keeps the document keys: awaiting
 * invoice and the unlinked screen are the accountant's, not the bench's.
 */
@Controller('sales')
export class FulfilmentController {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly fulfilment: FulfilmentService,
    private readonly documentSettings: DocumentSettingsService,
    private readonly xlsx: DocumentXlsxService,
  ) {}

  @Get('pick-queue')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  pickQueue(@CurrentUser() principal: Principal): Promise<PickQueueEntry[]> {
    return this.fulfilment.pickQueue(principal);
  }

  @Get('awaiting-invoice')
  @RequirePermission(...VIEW)
  awaitingInvoice(@CurrentUser() principal: Principal): Promise<AwaitingInvoiceEntry[]> {
    return this.fulfilment.awaitingInvoice(principal);
  }

  @Get('invoices/unlinked')
  @RequirePermission(...VIEW)
  unlinked(@CurrentUser() principal: Principal): Promise<UnlinkedInvoice[]> {
    return this.fulfilment.unlinkedInvoices(principal);
  }

  /** D-47: the Packed screen — every pack across the orders this person may see. */
  @Get('packs')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  allPacks(@CurrentUser() principal: Principal, @Query() query: PackListQueryDto): Promise<Paginated<PackRecordView>> {
    return this.fulfilment.listAllPacks(principal, query);
  }

  /** D-48: every picking session against one order. */
  @Get('orders/:id/picks')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  picks(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PickRecordView[]> {
    return this.fulfilment.listPicks(principal, id);
  }

  @Get('orders/:id/packs')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  packs(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PackRecordView[]> {
    return this.fulfilment.listPacks(principal, id);
  }

  /** One pack record: the packing slip's page. */
  /** D-47: what a scanned slip resolves to. Declared before packs/:id so the literal wins. */
  @Get('packs/by-slip/:number')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  findPackBySlip(@CurrentUser() principal: Principal, @Param('number') number: string): Promise<PackRecordView> {
    return this.fulfilment.findPackBySlip(principal, decodeURIComponent(number));
  }

  @Get('packs/:id')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  findPack(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<PackRecordView> {
    return this.fulfilment.findPack(principal, id);
  }

  /** The packing slip as a workbook: quantities, no money. */
  @Get('packs/:id/export.xlsx')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  async packXlsx(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const pack = await this.fulfilment.findPack(principal, id);
    const order = await this.fulfilment.order(principal, pack.documentId);
    const units = new Map(order.lines.map((line) => [line.id, line.unit]));
    await sendDocumentXlsx(res, { db: this.db, settings: this.documentSettings, xlsx: this.xlsx }, principal.orgId, 'PACKING_SLIP', {
      number: `${order.number}/${pack.id.slice(-4).toUpperCase()}`,
      date: pack.packedAt.slice(0, 10),
      status: `${String(pack.boxCount)} box${pack.boxCount === 1 ? '' : 'es'}`,
      customerName: order.customerName,
      reference: `Against ${order.number}`,
      lines: pack.lines.map((line) => ({ description: line.comment ? `${line.description} — ${line.comment}` : line.description, quantity: line.quantity, unit: units.get(line.lineId) ?? null, rate: '0', discountPct: '0', taxPct: '0', amount: '0', taxAmount: '0' })),
      notes: pack.comment,
      terms: null,
    });
  }

  /** D-48: the picking step -- what came off the shelf; a line packs only what it has picked. */
  @Post('orders/:id/picks')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  @HttpCode(HttpStatus.CREATED)
  pick(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreatePickRecordDto): Promise<PickRecordView> {
    return this.fulfilment.pick(principal, id, body);
  }

  @Post('orders/:id/packs')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  @HttpCode(HttpStatus.CREATED)
  pack(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreatePackRecordDto): Promise<PackRecordView> {
    return this.fulfilment.pack(principal, id, body);
  }

  @Post('orders/:id/link-invoice')
  @RequirePermission(PERMISSIONS.SALES_DOCUMENT_CREATE)
  @HttpCode(HttpStatus.OK)
  linkInvoice(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: LinkInvoiceDto): Promise<SalesDocumentView> {
    return this.fulfilment.linkInvoice(principal, id, body.voucherId);
  }

  @Post('orders/:id/short-close')
  @RequirePermission(PERMISSIONS.SALES_DOCUMENT_ALTER)
  @HttpCode(HttpStatus.OK)
  shortClose(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: ShortCloseDto): Promise<SalesDocumentView> {
    return this.fulfilment.shortClose(principal, id, body.reason);
  }
}
