import { createCompanySchema, type CreateCompanyInput } from '@vyuha/shared';

import type { CompanyDraft } from './types';

const EDITABLE_FIELDS = [
  'name',
  'phone',
  'email',
  'website',
  'city',
  'ownerId',
  'notes',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];
export type CompanyDraftErrors = Partial<Record<EditableField, string>>;

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** The exact request body both client validation and the mutation use. */
export function companyInputOf(draft: CompanyDraft): CreateCompanyInput {
  return {
    name: draft.name.trim(),
    phone: blank(draft.phone),
    email: blank(draft.email),
    website: blank(draft.website),
    city: blank(draft.city),
    ownerId: draft.ownerId,
    notes: blank(draft.notes),
  };
}

/** First actionable schema error per field, using the shared API contract. */
export function companyDraftErrors(draft: CompanyDraft): CompanyDraftErrors {
  const result = createCompanySchema.safeParse(companyInputOf(draft));
  if (result.success) return {};

  const errors: CompanyDraftErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      EDITABLE_FIELDS.includes(field as EditableField) &&
      errors[field as EditableField] === undefined
    ) {
      errors[field as EditableField] = issue.message;
    }
  }
  return errors;
}
