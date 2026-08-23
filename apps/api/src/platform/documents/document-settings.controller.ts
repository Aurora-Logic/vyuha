import { Controller, Get, HttpCode, HttpStatus, Body, Param, ParseUUIDPipe, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ERROR_CODES, PERMISSIONS, documentSettingsSchema, type DocumentSettings } from '@vyuha/shared';

import { AppError } from '../common/errors.js';
import { createZodDto } from '../common/zod-validation.pipe.js';
import { FileService, type SignedFileUrl } from '../files/file.service.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { Authenticated, RequirePermission } from '../rbac/route-policy.js';
import { DocumentSettingsService } from './document-settings.service.js';

class DocumentSettingsDto extends createZodDto(documentSettingsSchema) {}

/** The files service refuses anything over this anyway (technical design §7); multer stops at the same line. */
const MAX_LOGO_BYTES = 3 * 1024 * 1024;

function uploadedBytes(value: unknown): Buffer | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { buffer?: unknown };
  return Buffer.isBuffer(candidate.buffer) ? candidate.buffer : null;
}

/**
 * The printed documents' identity and designs. Read by anyone signed in —
 * every document screen renders the paper — written under settings.manage,
 * since what the business calls itself on an invoice is the administrator's.
 * The channel-partner and brand logos along the foot of the page are files
 * under the ORG_LOGO purpose (an organisation logo is what they are),
 * uploaded once here and named by id in the profile.
 */
@Controller('documents')
export class DocumentSettingsController {
  constructor(
    private readonly settings: DocumentSettingsService,
    private readonly files: FileService,
  ) {}

  @Get('settings')
  @Authenticated()
  read(@CurrentUser() principal: Principal): Promise<DocumentSettings> {
    return this.settings.read(principal.orgId);
  }

  @Put('settings')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  write(@CurrentUser() principal: Principal, @Body() body: DocumentSettingsDto): Promise<DocumentSettings> {
    return this.settings.write(principal.orgId, principal.userId, body);
  }

  /** One footer logo in; the id goes into profile.footerLogoFileIds through PUT settings. */
  @Post('logos')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('logo', { limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 1 } }))
  async uploadLogo(@CurrentUser() principal: Principal, @UploadedFile() logo: unknown): Promise<{ fileId: string } & SignedFileUrl> {
    const bytes = uploadedBytes(logo);
    if (bytes === null) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'No image was uploaded. Send the file as a multipart part named "logo".');
    const stored = await this.files.storeImage({ orgId: principal.orgId, uploadedBy: principal.userId, purpose: 'ORG_LOGO', bytes });
    const signed = await this.files.signedUrlFor(principal, stored.id);
    return { fileId: stored.id, ...signed };
  }

  @Get('logos/:fileId/url')
  @Authenticated()
  logoUrl(@CurrentUser() principal: Principal, @Param('fileId', ParseUUIDPipe) fileId: string): Promise<SignedFileUrl> {
    // Logos only. This route is `@Authenticated()` because every reader of a
    // document sees its letterhead, and passing a bare file id to the general
    // signer let that breadth reach any file the purpose table happened to
    // allow -- a punch photograph, to anyone holding `attendance.view.team`.
    return this.files.signedUrlForPurpose(principal, fileId, 'ORG_LOGO');
  }
}
