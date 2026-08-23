import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import type {
  AssignCollectorInput,
  AssignmentListQuery,
  CollectorAssignmentView,
  CollectorDashboard,
  CreatePromiseInput,
  DashboardQuery,
  OpenBillView,
  Paginated,
  PromiseListQuery,
  PromiseView,
  ReminderNoticeView,
  SendReminderInput,
} from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';

/** Area AJ: the collector's morning, the promises, the assignments and the reminders. */

const COLLECTIONS_KEY = ['collections'] as const;

function useInvalidateCollections(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: COLLECTIONS_KEY });
}

export function useCollectorDashboard(query: DashboardQuery, options: { enabled?: boolean } = {}): UseQueryResult<CollectorDashboard, Error> {
  const params = new URLSearchParams();
  if (query.collectorId) params.set('collectorId', query.collectorId);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...COLLECTIONS_KEY, 'dashboard', key],
    queryFn: ({ signal }) => apiRequest<CollectorDashboard>(`/collections/dashboard${key === '' ? '' : `?${key}`}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function usePromises(query: PromiseListQuery, options: { enabled?: boolean } = {}): UseQueryResult<Paginated<PromiseView>, Error> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.partyId) params.set('partyId', query.partyId);
  if (query.collectorId) params.set('collectorId', query.collectorId);
  if (query.state) params.set('state', query.state);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...COLLECTIONS_KEY, 'promises', key],
    queryFn: ({ signal }) => apiRequest<Paginated<PromiseView>>(`/collections/promises?${key}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** The bills a promise may name; empty means any receipt from the party counts towards it. */
export function useOpenBills(partyId: string | null): UseQueryResult<readonly OpenBillView[], Error> {
  return useQuery({
    enabled: partyId !== null,
    queryKey: [...COLLECTIONS_KEY, 'bills', partyId ?? ''],
    queryFn: ({ signal }) => apiRequest<readonly OpenBillView[]>(`/collections/parties/${partyId ?? ''}/bills`, { signal }),
  });
}

export function useTakePromise(): UseMutationResult<PromiseView, Error, CreatePromiseInput> {
  const invalidate = useInvalidateCollections();
  return useMutation({ mutationFn: (input) => apiRequest<PromiseView>('/collections/promises', { method: 'POST', body: input }), onSuccess: invalidate });
}

export function useAssignments(query: AssignmentListQuery, options: { enabled?: boolean } = {}): UseQueryResult<Paginated<CollectorAssignmentView>, Error> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.collectorId) params.set('collectorId', query.collectorId);
  if (query.partyId) params.set('partyId', query.partyId);
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...COLLECTIONS_KEY, 'assignments', key],
    queryFn: ({ signal }) => apiRequest<Paginated<CollectorAssignmentView>>(`/collections/assignments?${key}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useAssignCollector(): UseMutationResult<CollectorAssignmentView, Error, AssignCollectorInput> {
  const invalidate = useInvalidateCollections();
  return useMutation({ mutationFn: (input) => apiRequest<CollectorAssignmentView>('/collections/assignments', { method: 'POST', body: input }), onSuccess: invalidate });
}

export function useUnassignCollector(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateCollections();
  return useMutation({ mutationFn: (id) => apiRequest<void>(`/collections/assignments/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
}

export function useReminders(partyId: string | null): UseQueryResult<Paginated<ReminderNoticeView>, Error> {
  return useQuery({
    enabled: partyId !== null,
    queryKey: [...COLLECTIONS_KEY, 'reminders', partyId ?? ''],
    queryFn: ({ signal }) => apiRequest<Paginated<ReminderNoticeView>>(`/collections/parties/${partyId ?? ''}/reminders`, { signal }),
  });
}

export function useSendReminder(): UseMutationResult<readonly ReminderNoticeView[], Error, SendReminderInput> {
  const invalidate = useInvalidateCollections();
  return useMutation({ mutationFn: (input) => apiRequest<readonly ReminderNoticeView[]>('/collections/reminders', { method: 'POST', body: input }), onSuccess: invalidate });
}

export function useMarkReminderSent(): UseMutationResult<ReminderNoticeView, Error, string> {
  const invalidate = useInvalidateCollections();
  return useMutation({ mutationFn: (id) => apiRequest<ReminderNoticeView>(`/collections/reminders/${id}/sent`, { method: 'POST' }), onSuccess: invalidate });
}
