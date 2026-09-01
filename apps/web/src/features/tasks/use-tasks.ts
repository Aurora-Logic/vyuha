import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';
import { TASK_AGE_BUCKETS, TASK_PRIORITIES } from '@vyuha/shared';
import type {
  CreateBoardColumnInput,
  CreateTaskInput,
  TaskDueFilter,
  TaskPriority,
  UpdateBoardColumnInput,
  UpdateTaskInput,
} from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';
import { postMultipart } from '@/lib/offline/multipart';
import { parseOrThrow } from '@/lib/api/parse';

import {
  boardColumnSchema,
  boardColumnsSchema,
  boardResponseSchema,
  taskSchema,
  tasksResponseSchema,
  type BoardColumn,
  type BoardResponse,
  type Task,
  type TaskDraft,
  type TasksResponse,
} from './types';

/**
 * Tasks (REQ-V-01…V-07). REQ-V-04 on the client: `TaskFilters` is one shape,
 * serialised by one function, sent to both `/tasks` and `/tasks/board`.
 */

export interface TaskFilters {
  q?: string;
  mine?: boolean;
  due?: TaskDueFilter;
  priority?: TaskPriority;
  columnId?: string;
  assigneeId?: string;
  subjectType?: string;
  subjectId?: string;
  includeClosed?: boolean;
  /** A term the server knows (TASK_SORT_FIELDS), e.g. "-dueDate" or "priority". The board ignores it. */
  sort?: string;
}

function filterParams(filters: TaskFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.mine) params.set('mine', 'true');
  if (filters.due) params.set('due', filters.due);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.columnId) params.set('columnId', filters.columnId);
  if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
  if (filters.subjectType) params.set('subjectType', filters.subjectType);
  if (filters.subjectId) params.set('subjectId', filters.subjectId);
  if (filters.includeClosed) params.set('includeClosed', 'true');
  if (filters.sort) params.set('sort', filters.sort);
  return params;
}

export function useTasks(
  filters: TaskFilters & { page: number },
  options: { enabled?: boolean } = {},
): UseQueryResult<TasksResponse, Error> {
  const params = filterParams(filters);
  params.set('page', String(filters.page));
  params.set('pageSize', '50');
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['tasks', 'list', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/tasks?${key}`, { signal });
      return parseOrThrow(tasksResponseSchema, body, 'task list');
    },
    placeholderData: keepPreviousData,
  });
}

export function useTaskBoard(filters: TaskFilters, options: { enabled?: boolean } = {}): UseQueryResult<BoardResponse, Error> {
  const key = filterParams(filters).toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['tasks', 'board', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/tasks/board${key ? `?${key}` : ''}`, { signal });
      return parseOrThrow(boardResponseSchema, body, 'task board');
    },
    placeholderData: keepPreviousData,
  });
}

export function useTask(id: string | null): UseQueryResult<Task, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['tasks', 'one', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/tasks/${id ?? ''}`, { signal });
      return parseOrThrow(taskSchema, body, 'task');
    },
  });
}

export function useBoardColumns(options: { enabled?: boolean } = {}): UseQueryResult<BoardColumn[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['tasks', 'columns'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/tasks/columns', { signal });
      return parseOrThrow(boardColumnsSchema, body, 'board columns');
    },
    staleTime: 5 * 60_000,
  });
}

function useInvalidateTasks(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['tasks'] });
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** Parsed rather than trusted, like every other response this file reads. */
const taskAnalyticsSchema = z.object({
  totals: z.object({
    open: z.number(),
    overdue: z.number(),
    dueToday: z.number(),
    dueThisWeek: z.number(),
    unassigned: z.number(),
    closedInPeriod: z.number(),
    avgDaysToClose: z.number().nullable(),
  }),
  columns: z.array(
    z.object({
      columnId: z.string(),
      columnName: z.string(),
      sortOrder: z.number(),
      isDone: z.boolean(),
      count: z.number(),
    }),
  ),
  assignees: z.array(
    z.object({
      assigneeId: z.string().nullable(),
      assigneeName: z.string().nullable(),
      openCount: z.number(),
      overdueCount: z.number(),
    }),
  ),
  priorities: z.array(z.object({ priority: z.enum(TASK_PRIORITIES), openCount: z.number() })),
  flow: z.array(z.object({ weekStart: z.string(), raised: z.number(), closed: z.number() })),
  // Defaulted, so a client built before the server shipped these still reads
  // a dashboard. Declared at all because zod strips what it does not declare
  // -- the attachment count rendered as a blank cell for exactly that reason.
  ageing: z
    .array(z.object({ bucket: z.enum(TASK_AGE_BUCKETS), openCount: z.number(), overdueCount: z.number() }))
    .default([]),
  customers: z
    .array(
      z.object({
        partyId: z.string(),
        partyName: z.string(),
        openCount: z.number(),
        overdueCount: z.number(),
      }),
    )
    .default([]),
});

export type TaskAnalytics = z.infer<typeof taskAnalyticsSchema>;

export function useSaveTask(): UseMutationResult<Task, Error, TaskDraft> {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (draft: TaskDraft) => {
      const common = {
        title: draft.title.trim(),
        description: blank(draft.description),
        assigneeId: draft.assigneeId,
        dueDate: draft.dueDate,
        priority: draft.priority,
        subjectType: draft.subjectType,
        subjectId: draft.subjectId,
        partyId: draft.partyId,
        vendorId: draft.vendorId,
        // Always sent, so clearing the last item reaches the server: an
        // absent `itemIds` means "leave them alone", which would silently
        // keep an item the reader had just removed.
        itemIds: draft.items.map((item) => item.itemId),
      };
      const body: CreateTaskInput | UpdateTaskInput =
        draft.id === undefined
          ? { ...common, columnId: draft.columnId }
          : { ...common, ...(draft.columnId === null ? {} : { columnId: draft.columnId }) };
      const response = await apiRequest<unknown>(draft.id === undefined ? '/tasks' : `/tasks/${draft.id}`, {
        method: draft.id === undefined ? 'POST' : 'PATCH',
        body,
      });
      return parseOrThrow(taskSchema, response, 'saved task');
    },
    onSuccess: invalidate,
  });
}

/** REQ-V-06: a drag, a keyboard move, a "mark done" — all this one PATCH. */
export function useMoveTask(): UseMutationResult<Task, Error, { id: string; columnId: string }> {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async ({ id, columnId }) => {
      const body: UpdateTaskInput = { columnId };
      const response = await apiRequest<unknown>(`/tasks/${id}`, { method: 'PATCH', body });
      return parseOrThrow(taskSchema, response, 'moved task');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteTask(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<void>(`/tasks/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

export function useSaveBoardColumn(): UseMutationResult<
  BoardColumn,
  Error,
  { id?: string; name: string; isDone: boolean }
> {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (input) => {
      const body: CreateBoardColumnInput | UpdateBoardColumnInput = { name: input.name.trim(), isDone: input.isDone };
      const response = await apiRequest<unknown>(
        input.id === undefined ? '/tasks/columns' : `/tasks/columns/${input.id}`,
        { method: input.id === undefined ? 'POST' : 'PATCH', body },
      );
      return parseOrThrow(boardColumnSchema, response, 'board column');
    },
    onSuccess: invalidate,
  });
}

export function useReorderBoardColumns(): UseMutationResult<BoardColumn[], Error, string[]> {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (columnIds: string[]) => {
      const response = await apiRequest<unknown>('/tasks/columns/order', { method: 'PUT', body: { columnIds } });
      return parseOrThrow(boardColumnsSchema, response, 'board columns');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteBoardColumn(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<void>(`/tasks/columns/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

/**
 * REQ-V-11: the dashboard's figures, aggregated server-side under the
 * viewer's own task scope.
 *
 * Under the `['tasks']` prefix on purpose, so a live change to any task
 * refreshes the dashboard through the same invalidation every other task
 * screen uses — a dashboard that stayed stale while the board beside it
 * moved would be the most confusing screen in the product.
 */
export function useTaskAnalytics(filters: { weeks?: number } = {}): UseQueryResult<TaskAnalytics, Error> {
  const params = new URLSearchParams();
  if (filters.weeks !== undefined) params.set('weeks', String(filters.weeks));
  const key = params.toString();
  return useQuery({
    queryKey: ['tasks', 'analytics', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/tasks/analytics${key === '' ? '' : `?${key}`}`, { signal });
      return parseOrThrow(taskAnalyticsSchema, body, 'task analytics');
    },
    staleTime: 60_000,
  });
}

/** REQ-V-12: what is attached to a task, as the list reads it. */
const taskAttachmentSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  filename: z.string(),
  mime: z.string(),
  bytes: z.number(),
  uploadedAt: z.string(),
  uploadedByName: z.string().nullable().default(null),
});

export type TaskAttachment = z.infer<typeof taskAttachmentSchema>;

export function useTaskAttachments(
  taskId: string | null,
  options: { enabled?: boolean } = {},
): UseQueryResult<TaskAttachment[], Error> {
  return useQuery({
    enabled: (options.enabled ?? true) && taskId !== null,
    queryKey: ['tasks', 'attachments', taskId],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/tasks/${taskId ?? ''}/attachments`, { signal });
      return parseOrThrow(z.array(taskAttachmentSchema), body, 'task attachments');
    },
    staleTime: 60_000,
  });
}

/**
 * REQ-V-12. The file rides as multipart through `postMultipart`, the same
 * helper the punch, dispatch and deal uploads use — the browser writes the
 * boundary, and the shared helper carries the auth and refresh behaviour.
 */
export function useTaskAttachmentActions(taskId: string): {
  upload: (file: File) => Promise<void>;
  remove: (attachmentId: string) => Promise<void>;
} {
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['tasks', 'attachments', taskId] });
  };
  return {
    upload: async (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      await postMultipart(`/tasks/${taskId}/attachments`, form, (body) =>
        parseOrThrow(taskAttachmentSchema, body, 'task attachment'),
      );
      await refresh();
    },
    remove: async (attachmentId: string) => {
      await apiRequest(`/tasks/${taskId}/attachments/${attachmentId}`, { method: 'DELETE' });
      await refresh();
    },
  };
}
