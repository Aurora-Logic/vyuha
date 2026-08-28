import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  DISPATCH_MODE_LABELS,
  PERMISSIONS,
  createDispatchSchema,
  deliverDispatchSchema,
  dispatchListQuerySchema,
  markNotificationSentSchema,
  type DispatchView,
  type Paginated,
} from '@vyuha/shared';
import type { Response } from 'express';
import { z } from 'zod';

import { AppError } from '../../../platform/common/errors.js';
import { createZodDto } from '../../../platform/common/zod-validation.pipe.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { sendDocumentXlsx } from '../../../platform/documents/document-export.js';
import { DocumentSettingsService } from '../../../platform/documents/document-settings.service.js';
import { DocumentXlsxService } from '../../../platform/documents/document-xlsx.service.js';
import { CurrentUser, type Principal } from '../../../platform/rbac/principal.js';
import { RequirePermission } from '../../../platform/rbac/route-policy.js';
import { DispatchService } from './dispatch.service.js';

/** Owner, 22 Aug 2026: the board's Dispatched and Delivered tabs are this one filter. Local to the route rather than the shared schema, which another hand is in. */
class DispatchListQueryDto extends createZodDto(dispatchListQuerySchema.extend({ delivered: z.enum(['yes', 'no']).optional() })) {}
class MarkNotificationDto extends createZodDto(markNotificationSentSchema) {}

// P8-5 (owner, 28 Aug 2026): dispatch is the floor's work, behind sales.fulfil
// alone — raising documents no longer implies shipping them.
/**
 * The files service refuses anything over 3 MB (technical design §7), so
 * multer stops at the same line: an 8 MB ceiling here only let a large
 * photograph through to be refused later, after the whole body had been
 * read. The client re-encodes gallery photographs to fit before sending.
 */
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

interface UploadedPart {
  readonly buffer: Buffer;
}
const uploadedPartSchema = z.object({ buffer: z.instanceof(Buffer) });

function buffersOf(parts: unknown): Buffer[] {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => uploadedPartSchema.parse(part)).map((part: UploadedPart) => part.buffer);
}

/** Dispatches (12 §3.4): the multipart form carries the JSON as `payload` and the photographs as `box` and `lr` parts. */
@Controller('sales')
export class DispatchController {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly dispatches: DispatchService,
    private readonly documentSettings: DocumentSettingsService,
    private readonly xlsx: DocumentXlsxService,
  ) {}

  @Get('dispatches')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  list(@CurrentUser() principal: Principal, @Query() query: DispatchListQueryDto): Promise<Paginated<DispatchView>> {
    return this.dispatches.list(principal, query);
  }

  @Get('dispatches/:id')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  find(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<DispatchView> {
    return this.dispatches.find(principal, id);
  }

  /** The delivery note as a workbook: what left, in quantities. */
  @Get('dispatches/:id/export.xlsx')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  async exportXlsx(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const dispatch = await this.dispatches.find(principal, id);
    await sendDocumentXlsx(res, { db: this.db, settings: this.documentSettings, xlsx: this.xlsx }, principal.orgId, 'DELIVERY_NOTE', {
      number: dispatch.number,
      date: dispatch.dispatchedAt.slice(0, 10),
      status: DISPATCH_MODE_LABELS[dispatch.mode],
      customerName: dispatch.customerName,
      reference: [`Against ${dispatch.orderNumber}`, dispatch.lrNumber ? `LR ${dispatch.lrNumber}` : null, dispatch.vehicleNumber ? `Vehicle ${dispatch.vehicleNumber}` : null].filter(Boolean).join(' · '),
      lines: dispatch.lines.map((line) => ({ description: line.description, quantity: line.quantity, unit: line.unit, rate: '0', discountPct: '0', taxPct: '0', amount: '0', taxAmount: '0' })),
      notes: dispatch.notes,
      terms: null,
    });
  }

  @Get('dispatches/:id/attachments/:fileId/url')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  attachmentUrl(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.dispatches.attachmentUrl(principal, id, fileId);
  }

  @Post('orders/:id/dispatches')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'box', maxCount: 6 }, { name: 'lr', maxCount: 3 }], { limits: { fileSize: MAX_PHOTO_BYTES, files: 9, fields: 4 } }),
  )
  create(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { payload?: unknown },
    @UploadedFiles() files: { box?: unknown; lr?: unknown } | undefined,
  ): Promise<DispatchView> {
    // The JSON rides as a form field beside the photographs; parsed here for
    // the same reason the punch controller parses its own part.
    let raw: unknown = body.payload;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw AppError.validation('payload must be JSON.', { fields: [{ path: 'payload', message: 'not JSON' }] });
      }
    }
    const input = createDispatchSchema.parse(raw ?? {});
    return this.dispatches.create(principal, id, input, { box: buffersOf(files?.box), lr: buffersOf(files?.lr) });
  }

  /** D-47: the door step — who received it, with the photograph taken there. */
  @Post('dispatches/:id/deliver')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'photo', maxCount: 3 }], { limits: { fileSize: MAX_PHOTO_BYTES, files: 3, fields: 4 } }))
  deliver(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { payload?: unknown },
    @UploadedFiles() files: { photo?: unknown } | undefined,
  ): Promise<DispatchView> {
    let raw: unknown = body.payload;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw AppError.validation('payload must be JSON.', { fields: [{ path: 'payload', message: 'not JSON' }] });
      }
    }
    const input = deliverDispatchSchema.parse(raw ?? {});
    return this.dispatches.deliver(principal, id, input, buffersOf(files?.photo));
  }

  @Post('dispatches/:id/notifications/:notificationId')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  @HttpCode(HttpStatus.OK)
  markNotification(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @Body() body: MarkNotificationDto,
  ): Promise<DispatchView> {
    return this.dispatches.markNotification(principal, id, notificationId, body.status, body.error ?? null);
  }

  @Post('dispatches/:id/push')
  @RequirePermission(PERMISSIONS.SALES_FULFIL)
  @HttpCode(HttpStatus.OK)
  push(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<DispatchView> {
    return this.dispatches.push(principal, id);
  }
}
