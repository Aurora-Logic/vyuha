import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CreateCompanyInput,
  CreateContactInput,
  UpdateCompanyInput,
  UpdateContactInput,
} from '@vyuha/shared';

import { apiRequest } from '@/lib/api/client';
import { parseOrThrow } from '@/lib/api/parse';

import {
  companiesResponseSchema,
  companySchema,
  contactDuplicatesSchema,
  contactSchema,
  contactsResponseSchema,
  type CompaniesResponse,
  type Company,
  type CompanyDraft,
  type Contact,
  type ContactDraft,
  type ContactDuplicate,
  type ContactsResponse,
} from './types';

/**
 * Contacts and companies (REQ-U-01, REQ-U-02, REQ-U-08). Both caches hang
 * off the `crm` root so a write to either invalidates the other: a contact's
 * row shows its company's name, a company's row shows its contact count.
 */

const PAGE_SIZE = '25';

export interface ContactFilters {
  page: number;
  q?: string;
  companyId?: string;
  /** A term the server knows (CONTACT_SORT_FIELDS), e.g. "-name" or "name". */
  sort?: string;
}

export function useContacts(
  filters: ContactFilters,
  options: { enabled?: boolean } = {},
): UseQueryResult<ContactsResponse, Error> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: PAGE_SIZE });
  if (filters.q) params.set('q', filters.q);
  if (filters.companyId) params.set('companyId', filters.companyId);
  if (filters.sort) params.set('sort', filters.sort);
  const key = params.toString();

  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['crm', 'contacts', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/contacts?${key}`, { signal });
      return parseOrThrow(contactsResponseSchema, body, 'contact list');
    },
    placeholderData: keepPreviousData,
  });
}

export function useContact(id: string | null): UseQueryResult<Contact, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['crm', 'contact', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/contacts/${id ?? ''}`, { signal });
      return parseOrThrow(contactSchema, body, 'contact');
    },
  });
}

export interface CompanyFilters {
  page: number;
  q?: string;
  /** A term the server knows (COMPANY_SORT_FIELDS), e.g. "-name" or "name". */
  sort?: string;
}

export function useCompanies(
  filters: CompanyFilters,
  options: { enabled?: boolean } = {},
): UseQueryResult<CompaniesResponse, Error> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: PAGE_SIZE });
  if (filters.q) params.set('q', filters.q);
  if (filters.sort) params.set('sort', filters.sort);
  const key = params.toString();

  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['crm', 'companies', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/companies?${key}`, { signal });
      return parseOrThrow(companiesResponseSchema, body, 'company list');
    },
    placeholderData: keepPreviousData,
  });
}

export function useCompany(id: string | null): UseQueryResult<Company, Error> {
  return useQuery({
    enabled: id !== null,
    queryKey: ['crm', 'company', id],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/companies/${id ?? ''}`, { signal });
      return parseOrThrow(companySchema, body, 'company');
    },
  });
}

/**
 * The company picker's options: the first two hundred by name, which is
 * every company a prospect list of this size has. Under the `crm` root so a
 * company created from the contact form appears in the picker at once.
 */
export function useCompanyOptions(options: { enabled?: boolean } = {}): UseQueryResult<Company[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['crm', 'companies', 'options'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/crm/companies?pageSize=200', { signal });
      return parseOrThrow(companiesResponseSchema, body, 'company list').data;
    },
    staleTime: 5 * 60_000,
  });
}

/**
 * REQ-U-08. Asked as the phone and email fields settle, and only once either
 * is long enough to be a real value — the server refuses shorter, and asking
 * would only paint an error where a warning belongs.
 */
export function useContactDuplicates(input: {
  phone: string;
  email: string;
  excludeId?: string | undefined;
  enabled: boolean;
}): UseQueryResult<ContactDuplicate[], Error> {
  const phone = input.phone.trim();
  const email = input.email.trim();
  const phoneUsable = phone.length >= 6;
  const emailUsable = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email);
  const params = new URLSearchParams();
  if (phoneUsable) params.set('phone', phone);
  if (emailUsable) params.set('email', email);
  if (input.excludeId !== undefined) params.set('excludeId', input.excludeId);
  const key = params.toString();

  return useQuery({
    enabled: input.enabled && (phoneUsable || emailUsable),
    queryKey: ['crm', 'contact-duplicates', key],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/crm/contacts/duplicates?${key}`, { signal });
      return parseOrThrow(contactDuplicatesSchema, body, 'duplicate contacts');
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

function useInvalidateCrm(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['crm'] });
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function useSaveContact(): UseMutationResult<Contact, Error, ContactDraft> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async (draft: ContactDraft) => {
      const body: CreateContactInput | UpdateContactInput = {
        name: draft.name.trim(),
        phone: blank(draft.phone),
        email: blank(draft.email),
        designation: blank(draft.designation),
        companyId: draft.companyId,
        ownerId: draft.ownerId,
        source: blank(draft.source),
        notes: blank(draft.notes),
      };
      const response = await apiRequest<unknown>(
        draft.id === undefined ? '/crm/contacts' : `/crm/contacts/${draft.id}`,
        { method: draft.id === undefined ? 'POST' : 'PATCH', body },
      );
      return parseOrThrow(contactSchema, response, 'saved contact');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteContact(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<void>(`/crm/contacts/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}

export function useSaveCompany(): UseMutationResult<Company, Error, CompanyDraft> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async (draft: CompanyDraft) => {
      const body: CreateCompanyInput | UpdateCompanyInput = {
        name: draft.name.trim(),
        phone: blank(draft.phone),
        email: blank(draft.email),
        website: blank(draft.website),
        city: blank(draft.city),
        ownerId: draft.ownerId,
        notes: blank(draft.notes),
      };
      const response = await apiRequest<unknown>(
        draft.id === undefined ? '/crm/companies' : `/crm/companies/${draft.id}`,
        { method: draft.id === undefined ? 'POST' : 'PATCH', body },
      );
      return parseOrThrow(companySchema, response, 'saved company');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteCompany(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateCrm();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest<void>(`/crm/companies/${id}`, { method: 'DELETE' });
    },
    onSuccess: invalidate,
  });
}
