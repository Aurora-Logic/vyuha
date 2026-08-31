import { Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { AppError } from '../common/errors.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { MastersModule } from '../masters/masters.module.js';
import { MastersService } from '../masters/masters.service.js';
import type { Principal } from '../rbac/principal.js';
import { TaskSubjectRegistry } from '../tasks/task-subject.registry.js';
import { BrokenPromiseSweepHandler } from './broken-promise-sweep.handler.js';
import { CollectionsController } from './collections.controller.js';
import { CollectionsService } from './collections.service.js';
import { ReminderService } from './reminder.service.js';

/**
 * REQ-AJ-04 / D-17: a follow-up is a task on the party, in the platform's
 * own tasks table; this names the subject. A party the caller could not
 * open is a party they cannot attach a task to.
 */
@Injectable()
export class PartyTaskSubject implements OnModuleInit {
  constructor(
    private readonly registry: TaskSubjectRegistry,
    private readonly masters: MastersService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      subjectType: 'party',
      describe: async (principal: Principal, id: string) => {
        try {
          const party = await this.masters.findParty(principal, id);
          return { label: party.name };
        } catch (error: unknown) {
          if (error instanceof AppError && error.status === 404) return null;
          throw error;
        }
      },
    });
  }
}

/**
 * Area AJ (docs/15): collections. Platform, not a module: it reads the
 * projection and the masters, and the sales module reads its broken-promise
 * count for the credit check (REQ-AJ-10), and modules may not import each
 * other.
 */
@Module({
  imports: [MastersModule, DocumentsModule],
  controllers: [CollectionsController],
  providers: [CollectionsService, ReminderService, BrokenPromiseSweepHandler, PartyTaskSubject],
  exports: [CollectionsService, ReminderService],
})
export class CollectionsModule {}
