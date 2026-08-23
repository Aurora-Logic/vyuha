import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import {
  punchFlagReviewSchema,
  type ApprovalStatus,
  type ApprovalType,
  type ApprovalView,
  type Paginated,
  type PunchFlagReviewInput,
} from '@vyuha/shared';

import { withDevFixture, type Sampled } from '@/features/leave/dev-fixture-fallback';
import { paginatedSchema } from '@/features/leave/types';
import { ApiError, apiRequest } from '@/lib/api/client';

import {
  approvalRequestSchema,
  approveRequestSchema,
  bulkApprovalDecisionSchema,
  rejectRequestSchema,
  type ApprovalRequest,
  type BulkAction,
} from './types';

/**
 * REQ-I-03: one inbox per approver, filterable by type, with bulk actions.
 *
 * All four verbs go through the same generic endpoints (REQ-I-01) — there is
 * no per-type approve call and there must never be one, or the four separate
 * inboxes the requirement forbids reappear one mutation at a time.
 *
 * Every body is parsed by the schema the server parses it with, imported from
 * `@vyuha/shared`. A client-side copy of "a rejection needs a reason" is how
 * the two ends come to disagree about what a valid request is.
 */

const approvalListSchema: z.ZodType<Paginated<ApprovalRequest>> =
  paginatedSchema(approvalRequestSchema);

export const APPROVALS_QUERY_ROOT = ['approvals'] as const;

export interface ApprovalListParams {
  page: number;
  pageSize: number;
  /**
   * Which slice of the approvals to ask for. `inbox` is what was routed to the
   * caller; `raised` is what they raised themselves. Two questions rather than
   * one default, because collapsing them would either hide a requester's own
   * request or bury an approver's inbox under everything they ever asked for.
   */
  view: ApprovalView;
  type: ApprovalType | null;
  status: ApprovalStatus | null;
}

/**
 * Kept out of `ApprovalListParams` deliberately: that object is the query
 * string and it is the cache key, so folding a switch into it would make the
 * same request cache under two keys depending on whether it was allowed to run.
 */
export interface ApprovalListOptions {
  enabled?: boolean;
}

export function useApprovals(
  params: ApprovalListParams,
  options: ApprovalListOptions = {},
): UseQueryResult<Sampled<Paginated<ApprovalRequest>>, Error> {
  const search = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
    view: params.view,
  });
  if (params.type) search.set('type', params.type);
  if (params.status) search.set('status', params.status);

  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...APPROVALS_QUERY_ROOT, 'list', params],
    queryFn: ({ signal }) =>
      withDevFixture(
        async () => {
          const body = await apiRequest<unknown>(`/approvals?${search.toString()}`, { signal });
          const parsed = approvalListSchema.safeParse(body);
          if (!parsed.success) {
            throw new ApiError({
              code: 'INTERNAL_ERROR',
              message: 'The approvals inbox came back in a shape this screen cannot read.',
              status: 0,
              details: { issues: z.treeifyError(parsed.error) },
            });
          }
          return parsed.data;
        },
        (fixtures) => fixtures.approvalsFixture(params),
      ),
    placeholderData: keepPreviousData,
  });
}

export interface SingleDecision {
  id: string;
  action: 'APPROVE' | 'REJECT';
  /** REQ-F-05: mandatory on reject, optional on approve. */
  reason?: string;
}

export function useDecideApproval(): UseMutationResult<void, Error, SingleDecision> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, action, reason }: SingleDecision) => {
      const body =
        action === 'REJECT'
          ? rejectRequestSchema.parse({ reason })
          : approveRequestSchema.parse(reason === undefined ? {} : { reason });
      await apiRequest<unknown>(
        `/approvals/${id}/${action === 'REJECT' ? 'reject' : 'approve'}`,
        { method: 'POST', body },
      );
    },
    onSuccess: () => {
      invalidateAfterDecision(queryClient);
    },
  });
}

/**
 * REQ-I-03 bulk. One request rather than a loop of single calls: a partial
 * failure halfway through a loop leaves the inbox in a state nobody chose, and
 * the server can apply the whole set in one call and one audit entry per
 * request it actually moved.
 */
/**
 * What a decision here makes stale.
 *
 * An approved leave moves a balance, and leave, corrections and on-duty all
 * recompute the affected days inline on the server -- so a decision taken in
 * the inbox moves the muster and the day sheet as surely as it moves the
 * inbox itself. Only the inbox and leave were refreshed, so a manager who
 * approved a correction and looked at the day still saw the old one.
 */
function invalidateAfterDecision(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_ROOT });
  void queryClient.invalidateQueries({ queryKey: ['leave'] });
  void queryClient.invalidateQueries({ queryKey: ['attendance'] });
  void queryClient.invalidateQueries({ queryKey: ['regularization'] });
}

export function useBulkDecision(): UseMutationResult<void, Error, BulkAction> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkAction) => {
      await apiRequest<unknown>('/approvals/bulk', {
        method: 'POST',
        body: bulkApprovalDecisionSchema.parse(input),
      });
    },
    onSuccess: () => {
      invalidateAfterDecision(queryClient);
    },
  });
}

/** Owner, 21 Aug 2026: the four admin actions on a flagged punch, from the inbox. */
export function useFlagReview(): UseMutationResult<void, Error, { punchId: string; input: PunchFlagReviewInput }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ punchId, input }) => {
      await apiRequest<unknown>(`/punches/${punchId}/flag-review`, {
        method: 'POST',
        body: punchFlagReviewSchema.parse(input),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_ROOT });
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}
