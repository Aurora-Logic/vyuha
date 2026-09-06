import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';

import { apiRequest } from '@/lib/api/client';
import { emptyTaskDraft, taskSchema } from './types';
import { useSaveTask } from './use-tasks';

vi.mock('@/lib/api/client', () => ({ apiRequest: vi.fn() }));

const saved = taskSchema.parse({
  id: 'task-1', title: 'Retry task', description: null,
  subjectType: null, subjectId: null, subjectLabel: null,
  assigneeId: null, assigneeName: null, ownerId: null, ownerName: null,
  dueDate: null, priority: 'MEDIUM', columnId: 'column-1', columnName: 'To do',
  isClosed: false, closedAt: null, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
});

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return renderHook(() => useSaveTask(), { wrapper: Wrapper });
}

beforeEach(() => vi.mocked(apiRequest).mockReset());

it('retains the create key after a lost response and starts a new intent after success', async () => {
  vi.mocked(apiRequest).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(saved);
  const { result } = setup();
  const draft = emptyTaskDraft({ title: 'Retry task' });
  await act(async () => { await expect(result.current.mutateAsync(draft)).rejects.toThrow('Failed to fetch'); });
  await act(async () => { await result.current.mutateAsync(draft); });
  await act(async () => { await result.current.mutateAsync(draft); });
  const keys = vi.mocked(apiRequest).mock.calls.map((call) => call[1]?.idempotencyKey);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
});

it('changes the key for an edited failed draft and leaves updates unkeyed', async () => {
  vi.mocked(apiRequest).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(saved);
  const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(emptyTaskDraft({ title: 'First' }))).rejects.toThrow(); });
  await act(async () => { await result.current.mutateAsync(emptyTaskDraft({ title: 'Edited' })); });
  await act(async () => { await result.current.mutateAsync(emptyTaskDraft({ id: saved.id, title: 'Update' })); });
  const calls = vi.mocked(apiRequest).mock.calls;
  expect(calls[1]?.[1]?.idempotencyKey).not.toBe(calls[0]?.[1]?.idempotencyKey);
  expect(calls[2]?.[1]?.idempotencyKey).toBeUndefined();
  expect(calls[2]?.[1]?.method).toBe('PATCH');
});
