import { Global, Module } from '@nestjs/common';

import { env } from '../common/env.js';
import { FileService } from './file.service.js';
import { RawFilesController } from './raw-files.controller.js';

/**
 * Global because the punch pipeline (Phase 1), the export worker (Phase 3),
 * and the retention job all store or read files, and a second instance would
 * be a second place the storage-key convention could drift.
 *
 * `RawFilesController` is mounted only for the driver that needs it. Under
 * `s3` -- the default, and what every environment file in this repository
 * leaves in place -- `ObjectStore.signedUrl` returns a presigned object-store
 * URL and nothing can ever mint a link to that route, so mounting it there
 * put an unauthenticated door onto the filesystem in front of every
 * deployment for the benefit of none of them.
 */
@Global()
@Module({
  controllers: env.STORAGE_DRIVER === 'disk' ? [RawFilesController] : [],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
