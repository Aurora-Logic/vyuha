import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PERMISSIONS, type GoToRecord } from '@vyuha/shared';

import type { Principal } from '../rbac/principal.js';
import { GoToSourceRegistry, type GoToSource } from '../search/go-to-source.registry.js';
import { TaskService } from './task.service.js';

/** REQ-O-05 names task titles. Open tasks only — a closed one is history, and the list has it. */
@Injectable()
export class TaskGoToSource implements GoToSource, OnModuleInit {
  readonly recordType = 'task';
  readonly permissions = [
    PERMISSIONS.CRM_TASK_VIEW_SELF,
    PERMISSIONS.CRM_TASK_VIEW_TEAM,
    PERMISSIONS.CRM_TASK_VIEW_ALL,
  ] as const;

  constructor(
    private readonly registry: GoToSourceRegistry,
    private readonly tasksService: TaskService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async search(principal: Principal, term: string, limit: number): Promise<GoToRecord[]> {
    const { data } = await this.tasksService.list(principal, { page: 1, pageSize: limit, q: term });
    return data.map((task) => ({
      type: this.recordType,
      id: task.id,
      title: task.title,
      subtitle:
        [task.columnName, task.dueDate === null ? null : `due ${task.dueDate}`, task.subjectLabel === null ? null : `on ${task.subjectLabel}`]
          .filter((p): p is string => p !== null)
          .join(' · ') || null,
      code: null,
    }));
  }
}
