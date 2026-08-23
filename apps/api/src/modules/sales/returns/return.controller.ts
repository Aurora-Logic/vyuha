import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  PERMISSIONS,
  createReturnSchema,
  decideReplacementSchema,
  linkCreditNoteSchema,
  returnListQuerySchema,
  setDispositionSchema,
  type Paginated,
  type ReturnReasonsPolicy,
  type SalesReturnSummary,
  type SalesReturnView,
  type UnlinkedCreditNote,
} from '@vyuha/shared';
import { z } from 'zod';

import { AppError } from '../../../platform/common/errors.js';
import { createZodDto } from '../../../platform/common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../../../platform/rbac/principal.js';
import { RequirePermission } from '../../../platform/rbac/route-policy.js';
import { ReturnService } from './return.service.js';

/**
 * Returns (15 Area AK). The receipt is a multipart form for the same reason
 * a dispatch is: the photographs travel with the words, so a record can
 * never exist without the evidence somebody meant to attach to it.
 */
class ReturnListQueryDto extends createZodDto(returnListQuerySchema) {}
class SetDispositionDto extends createZodDto(setDispositionSchema) {}
class DecideReplacementDto extends createZodDto(decideReplacementSchema) {}
class LinkCreditNoteDto extends createZodDto(linkCreditNoteSchema) {}
class CancelReturnDto extends createZodDto(z.object({ reason: z.string().trim().min(3).max(500) })) {}

/** The files service refuses anything over 3 MB; multer stops at the same line. */
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const uploadedPartSchema = z.object({ buffer: z.instanceof(Buffer) });

function buffersOf(parts: unknown): Buffer[] {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => uploadedPartSchema.parse(part)).map((part) => part.buffer);
}

function payloadOf(body: { payload?: unknown }): unknown {
  const raw = body.payload;
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    throw AppError.validation('payload must be JSON.', { fields: [{ path: 'payload', message: 'not JSON' }] });
  }
}

@Controller('sales/returns')
export class ReturnController {
  constructor(private readonly returns: ReturnService) {}

  @Get()
  @RequirePermission(PERMISSIONS.RETURNS_VIEW)
  list(@CurrentUser() principal: Principal, @Query() query: ReturnListQueryDto): Promise<Paginated<SalesReturnSummary>> {
    return this.returns.list(principal, query);
  }

  /** REQ-AK-02: what the receipt screen offers. */
  @Get('reasons')
  @RequirePermission(PERMISSIONS.RETURNS_VIEW)
  reasons(@CurrentUser() principal: Principal): Promise<ReturnReasonsPolicy> {
    return this.returns.reasons(principal.orgId);
  }

  /** REQ-AK-05: the accountant's queue. */
  @Get('awaiting-credit-note')
  @RequirePermission(PERMISSIONS.RETURNS_VIEW)
  awaiting(@CurrentUser() principal: Principal): Promise<Paginated<SalesReturnSummary>> {
    return this.returns.awaitingCreditNote(principal);
  }

  /** REQ-AK-06: credit notes that name no return, with the party's open ones beside each. */
  @Get('unlinked-credit-notes')
  @RequirePermission(PERMISSIONS.RETURNS_MANAGE)
  unlinked(@CurrentUser() principal: Principal): Promise<UnlinkedCreditNote[]> {
    return this.returns.unlinkedCreditNotes(principal);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.RETURNS_VIEW)
  find(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<SalesReturnView> {
    return this.returns.find(principal, id);
  }

  @Get(':id/attachments/:fileId/url')
  @RequirePermission(PERMISSIONS.RETURNS_VIEW)
  attachmentUrl(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.returns.attachmentUrl(principal, id, fileId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.RETURNS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'goods', maxCount: 6 }, { name: 'packaging', maxCount: 3 }, { name: 'document', maxCount: 3 }], {
      limits: { fileSize: MAX_PHOTO_BYTES, files: 12, fields: 4 },
    }),
  )
  create(
    @CurrentUser() principal: Principal,
    @Body() body: { payload?: unknown },
    @UploadedFiles() files: { goods?: unknown; packaging?: unknown; document?: unknown } | undefined,
  ): Promise<SalesReturnView> {
    const input = createReturnSchema.parse(payloadOf(body));
    return this.returns.create(principal, input, { goods: buffersOf(files?.goods), packaging: buffersOf(files?.packaging), document: buffersOf(files?.document) });
  }

  @Post(':id/disposition')
  @RequirePermission(PERMISSIONS.RETURNS_DISPOSITION)
  @HttpCode(HttpStatus.OK)
  setDisposition(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetDispositionDto): Promise<SalesReturnView> {
    return this.returns.setDisposition(principal, id, body);
  }

  @Post(':id/replacement')
  // The multi-key form is OR; raising the order needs both keys, and the
  // second is asserted in the service where the sentence can name it.
  @RequirePermission(PERMISSIONS.RETURNS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  replacement(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: DecideReplacementDto): Promise<SalesReturnView> {
    return this.returns.decideReplacement(principal, id, body);
  }

  @Post(':id/credit-note')
  @RequirePermission(PERMISSIONS.RETURNS_MANAGE)
  @HttpCode(HttpStatus.OK)
  linkCreditNote(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: LinkCreditNoteDto): Promise<SalesReturnView> {
    return this.returns.linkCreditNote(principal, id, body.voucherId);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.RETURNS_MANAGE)
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: CancelReturnDto): Promise<SalesReturnView> {
    return this.returns.cancel(principal, id, body.reason);
  }
}
