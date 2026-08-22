import { Injectable, type OnModuleInit } from '@nestjs/common';

import { FileService } from '../../files/file.service.js';
import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../job-handler.js';
import type { JobPayloads } from '../queue.registry.js';

/**
 * REQ-L-03's retention sweep.
 *
 * The idempotency this job needs is not a property of the handler -- it is a
 * property of the query underneath it. `FileService.purgeExpiredFiles` selects
 * on `purged_at IS NULL` and sets `purged_at` as the last thing it does to a
 * row, so a second run selects nothing and a run interrupted halfway leaves
 * exactly the unfinished rows selectable. Nothing here needs a lock, a
 * high-water mark, or a "has this already run today" flag, all of which are
 * ways of making a non-idempotent operation look idempotent.
 *
 * The payload carries only `requestedAt`, and the handler ignores it. A job
 * that sat in the queue through a retry must purge what is expired *now*, not
 * what was expired when someone asked.
 */
@Injectable()
export class PurgeExpiredFilesHandler
  implements JobHandler<'purge-expired-files'>, OnModuleInit
{
  readonly jobName = 'purge-expired-files' as const;

  constructor(
    private readonly files: FileService,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(
    _payload: JobPayloads['purge-expired-files'],
    _context: JobContext,
  ): Promise<JobResult> {
    const result = await this.files.purgeExpiredFiles();
    return {
      scanned: result.scanned,
      purged: result.purged,
      alreadyAbsent: result.alreadyAbsent,
      // Nought unless the run hit its own limit. A backlog that a weekly job
      // cannot clear is the thing REQ-L-03 fails on, so it is reported rather
      // than left to be inferred from a falling count.
      remaining: result.remaining,
    };
  }
}
