import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DUPLICATE_ENTITY_TYPES } from '@vyuha/shared';

import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../jobs/job-handler.js';
import type { JobPayloads } from '../jobs/queue.registry.js';
import { DuplicatesService } from './duplicates.service.js';

/**
 * REQ-AO-13: detection runs as a job after each masters pull, never on a
 * list render. The sync writer enqueues it when a pull's final chunk
 * lands, deduplicated per organisation and entity type, so a burst of
 * chunks is one detection.
 */
@Injectable()
export class DuplicateDetectorHandler implements JobHandler<'detect-duplicates'>, OnModuleInit {
  readonly jobName = 'detect-duplicates' as const;

  constructor(
    private readonly registry: JobRegistry,
    private readonly duplicates: DuplicatesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(payload: JobPayloads['detect-duplicates'], _context: JobContext): Promise<JobResult> {
    const types = payload.entityType === undefined ? DUPLICATE_ENTITY_TYPES : [payload.entityType];
    const out: Record<string, number> = {};
    for (const entityType of types) {
      const result = await this.duplicates.detect(payload.orgId, entityType);
      out[`${entityType}Scanned`] = result.scanned;
      out[`${entityType}Clusters`] = result.clusters;
      out[`${entityType}Opened`] = result.opened;
      out[`${entityType}Resolved`] = result.resolved;
    }
    return out;
  }
}
