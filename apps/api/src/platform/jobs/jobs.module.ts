import { Global, Module } from '@nestjs/common';

import { FallbackJobRunner } from './fallback-job-runner.service.js';
import { PurgeExpiredFilesHandler } from './handlers/purge-expired-files.handler.js';
import { CleanupFileObjectsHandler } from './handlers/cleanup-file-objects.handler.js';
import { JobRegistry } from './job-handler.js';
import { JobMonitorService } from './job-monitor.service.js';
import { JobRunner } from './job-runner.service.js';
import { JobsController } from './jobs.controller.js';

/**
 * Global because anything may need to enqueue -- the punch endpoint, an export
 * request, the notification dispatcher.
 *
 * Note what is *not* here: no module that owns a job is imported. Handlers put
 * themselves into `JobRegistry` during `onModuleInit`, so this module never
 * grows an import for each new job and never forms a cycle with a module that
 * both handles a job and enqueues one. `PurgeExpiredFilesHandler` is provided
 * here only because the file service it drives is a platform concern with no
 * module of its own to live in.
 */
@Global()
@Module({
  controllers: [JobsController],
  providers: [
    JobRegistry,
    JobRunner,
    FallbackJobRunner,
    JobMonitorService,
    PurgeExpiredFilesHandler,
    CleanupFileObjectsHandler,
  ],
  exports: [JobRegistry, JobRunner],
})
export class JobsModule {}
