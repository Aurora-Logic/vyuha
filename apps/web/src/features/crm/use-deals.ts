import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CreateDealInput,
  CreatePipelineStageInput,
  DealStatusFilter,
  UpdateDealInput,
  UpdatePipelineStageInput,
} from '@vyuha/shared';

import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { postMultipart } from '@/lib/offline/multipart';
import { parseOrThrow } from '@/lib/api/parse';

import {
  companySchema,
  contactsResponseSchema,
  dealBoardSchema,
  dealSchema,
  dealsResponseSchema,
  pipelineSchema,
  pipelineStageSchema,
  pipelinesSchema,
  type Company,
  type Contact,
  type Deal,
  type DealBoard,
  type DealDraft,
  type DealsResponse,
  type Pipeline,
  type PipelineStage,
} from './types';

/** Pipelines and deals (REQ-U-04, REQ-U-05). One filter shape for list and board. */

export interface DealFilters {
  q?: string;
  pipelineId?: string;
  stageId?: string;
  ownerId?: string;
  companyId?: string;
  contactId?: string;
  status?: DealStatusFilter;
  /** A term the server knows (DEAL_SORT_FIELDS), e.g. "-value" or "expectedCloseDate". The list carries it; the board never sets it. */
  sort?: string;
}

function filterParams(filters: DealFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.pipelineId) params.set('pipelineId', filters.pipelineId);
  if (filters.stageId) params.set('stageId', filters.stageId);
  if (filters.ownerId) params.set('ownerId', filters.ownerId);
  if (filters.companyId) params.set('companyId', filters.companyId);
  if (filters.contactId) params.set('contactId', filters.contactId);
  if (filters.status) params.set('status', filters.status);
  if (filters.sort) params.set('sort', filters.sort);
  return params;
}


export function usePipelines(options: { enabled?: boolean } = {}): UseQueryResult<Pipeline[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['crm', 'pipelines'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/crm/pipelines', { signal });
      return parseOrThrow(pipelinesSchema, body, 'pipelines');
    },
    staleTime: 5 * 60_000,
  });
}

export function useDeals(filters: DealFilters & { page: number }, options: { enabled?: boolean } = {}): UseQueryResult<DealsResponse, Error> {
  const params = filterParams(filters);
  params.set('page', String(filters.page));
  params.set('pageSize', '50');
  const key = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['crm', 'deals', 'list', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/deals?${key}`, { signal });
      return parseOrThrow(dealsResponseSchema, body, 'deal list');
    },
    placeholderData: keepPreviousData,
  });
}

export function useDealBoard(filters: DealFilters, options: { enabled?: boolean } = {}): UseQueryResult<DealBoard, Error> {
  const key = filterParams(filters).toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['crm', 'deals', 'board', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/deals/board${key ? `?${key}` : ''}`, { signal });
      return parseOrThrow(dealBoardSchema, body, 'deal board');
    },
    placeholderData: keepPreviousData,
  });
}

export function useDeal(id: string | null): UseQueryResult<Deal, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['crm', 'deals', 'one', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/deals/${id ?? ''}`, { signal });
      return parseOrThrow(dealSchema, body, 'deal');
    },
  });
}

/** Contacts of one company, for the deal sheet's contact picker. */
export function useCompanyContacts(companyId: string | null): UseQueryResult<Contact[], Error> {
  return useQuery({
    enabled: companyId !== null,
    queryKey: ['crm', 'contacts', 'by-company', companyId],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/contacts?pageSize=200&companyId=${companyId ?? ''}`, { signal });
      return parseOrThrow(contactsResponseSchema, body, 'contact list').data;
    },
    staleTime: 60_000,
  });
}

function useInvalidateCrm(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['crm'] });
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function useSaveDeal(): UseMutationResult<Deal, Error, DealDraft> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async (draft: DealDraft) => {
      const common = {
        name: draft.name.trim(),
        companyId: draft.companyId,
        contactId: draft.contactId,
        value: blank(draft.value.replace(/,/gu, '')),
        expectedCloseDate: draft.expectedCloseDate,
        ownerId: draft.ownerId,
        leadSource: blank(draft.leadSource),
        priority: draft.priority,
        nextFollowUpDate: draft.nextFollowUpDate,
        competitor: blank(draft.competitor),
        lossReason: blank(draft.lossReason),
        notes: blank(draft.notes),
      };
      const body: CreateDealInput | UpdateDealInput =
        draft.id === undefined
          ? { ...common, pipelineId: draft.pipelineId, stageId: draft.stageId }
          : { ...common, ...(draft.stageId === null ? {} : { stageId: draft.stageId }) };
      const response = await apiRequest<unknown>(draft.id === undefined ? '/crm/deals' : `/crm/deals/${draft.id}`, {
        method: draft.id === undefined ? 'POST' : 'PATCH',
        body,
      });
      return parseOrThrow(dealSchema, response, 'saved deal');
    },
    onSuccess: invalidate,
  });
}

export function useMoveDeal(): UseMutationResult<Deal, Error, { id: string; stageId: string }> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async ({ id, stageId }) => {
      const body: UpdateDealInput = { stageId };
      const response = await apiRequest<unknown>(`/crm/deals/${id}`, { method: 'PATCH', body });
      return parseOrThrow(dealSchema, response, 'moved deal');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteDeal(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<void>(`/crm/deals/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

/** REQ-U-03: the company's link to the Tally party it became. */
export function useLinkCompanyParty(): UseMutationResult<Company, Error, { companyId: string; partyId: string | null }> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async ({ companyId, partyId }) => {
      const response = await apiRequest<unknown>(`/crm/companies/${companyId}/party`, { method: 'PUT', body: { partyId } });
      return parseOrThrow(companySchema, response, 'company');
    },
    onSuccess: invalidate,
  });
}

export function useSavePipelineStage(): UseMutationResult<
  PipelineStage,
  Error,
  { pipelineId: string; id?: string; name: string; probability: number; isWon: boolean; isLost: boolean }
> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async (input) => {
      const body: CreatePipelineStageInput | UpdatePipelineStageInput = {
        name: input.name.trim(),
        probability: input.probability,
        isWon: input.isWon,
        isLost: input.isLost,
      };
      const response = await apiRequest<unknown>(
        input.id === undefined
          ? `/crm/pipelines/${input.pipelineId}/stages`
          : `/crm/pipelines/${input.pipelineId}/stages/${input.id}`,
        { method: input.id === undefined ? 'POST' : 'PATCH', body },
      );
      return parseOrThrow(pipelineStageSchema, response, 'stage');
    },
    onSuccess: invalidate,
  });
}

export function useReorderPipelineStages(): UseMutationResult<Pipeline, Error, { pipelineId: string; stageIds: string[] }> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async ({ pipelineId, stageIds }) => {
      const response = await apiRequest<unknown>(`/crm/pipelines/${pipelineId}/stages/order`, { method: 'PUT', body: { stageIds } });
      return parseOrThrow(pipelineSchema, response, 'pipeline');
    },
    onSuccess: invalidate,
  });
}

export function useDeletePipelineStage(): UseMutationResult<void, Error, { pipelineId: string; id: string }> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async ({ pipelineId, id }) => {
      await apiRequest<void>(`/crm/pipelines/${pipelineId}/stages/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------- attachments

const attachmentSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  filename: z.string(),
  mime: z.string(),
  bytes: z.number(),
  uploadedAt: z.string(),
});

export type DealAttachment = z.infer<typeof attachmentSchema>;

export function useDealAttachments(dealId: string | null, options: { enabled?: boolean } = {}): UseQueryResult<DealAttachment[], Error> {
  return useQuery({
    enabled: (options.enabled ?? true) && dealId !== null,
    queryKey: ['crm', 'deal-attachments', dealId],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/deals/${dealId ?? ''}/attachments`, { signal });
      return parseOrThrow(z.array(attachmentSchema), body, 'attachments');
    },
    staleTime: 60_000,
  });
}

/**
 * REQ-U-05. The file rides as multipart through `postMultipart`, the same
 * helper the punch and dispatch uploads use -- the browser writes the
 * boundary, and the shared helper carries the auth and refresh behaviour.
 */
export function useDealAttachmentActions(dealId: string): {
  upload: (file: File) => Promise<void>;
  remove: (attachmentId: string) => Promise<void>;
} {
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['crm', 'deal-attachments', dealId] });
  };
  return {
    upload: async (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      await postMultipart(`/crm/deals/${dealId}/attachments`, form, (body) => parseOrThrow(attachmentSchema, body, 'attachment'));
      await refresh();
    },
    remove: async (attachmentId: string) => {
      await apiRequest(`/crm/deals/${dealId}/attachments/${attachmentId}`, { method: 'DELETE' });
      await refresh();
    },
  };
}

