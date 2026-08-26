import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { type ExportDownload, type ExportJobSummary } from '@vyuha/shared';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { Authenticated } from '../rbac/route-policy.js';
import { DownloadsService } from './downloads.service.js';

const exportListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

class ExportListQueryDto extends createZodDto(exportListQuerySchema) {}

/**
 * The Downloads tray's three reads, at `/exports` now that `/reports` is
 * gone (owner, 26 Aug 2026). `@Authenticated()` rather than a permission:
 * every row the service answers with is the caller's own request -- the
 * requester scope is the access rule, and the one producer left (the
 * employee data export, REQ-M-05) already gated the *making* of the file
 * on `employee.manage`. A permission here would only stop people from
 * seeing files they themselves asked for.
 */
@Controller('exports')
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  /** The Downloads tray, the caller's own exports, newest first. */
  @Get()
  @Authenticated()
  async list(
    @CurrentUser() principal: Principal,
    @Query() query: ExportListQueryDto,
  ): Promise<{ data: ExportJobSummary[] }> {
    return { data: await this.downloads.listForRequester(principal, query.limit) };
  }

  @Get(':id')
  @Authenticated()
  findOne(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExportJobSummary> {
    return this.downloads.findOne(principal, id);
  }

  /** NFR-09: a short-lived signed URL, never a storage key. */
  @Get(':id/download')
  @Authenticated()
  download(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExportDownload> {
    return this.downloads.download(principal, id);
  }
}
