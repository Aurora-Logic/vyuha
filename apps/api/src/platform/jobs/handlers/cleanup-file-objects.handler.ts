import { Injectable, type OnModuleInit } from '@nestjs/common';

import { FileService } from '../../files/file.service.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../job-handler.js';
import type { JobPayloads } from '../queue.registry.js';

/** Drains durable object-removal intents left by interrupted file writes. */
@Injectable()
export class CleanupFileObjectsHandler
  implements JobHandler<'cleanup-file-objects'>, OnModuleInit
{
  readonly jobName = 'cleanup-file-objects' as const;

  constructor(
    private readonly files: FileService,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(
    _payload: JobPayloads['cleanup-file-objects'],
    _context: JobContext,
  ): Promise<JobResult> {
    const result = await this.files.cleanupPendingObjects();
    return { ...result };
  }
}
