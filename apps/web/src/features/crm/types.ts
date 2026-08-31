import { DEAL_PRIORITIES, type DealPriority } from '@vyuha/shared';
import { z } from 'zod';

/**
 * What `/crm/contacts` and `/crm/companies` answer (REQ-U-01, REQ-U-02),
 * parsed at the boundary like every other feed. The shared package's views
 * are the contract; these schemas are the check that the server kept it.
 */

export const contactSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  designation: z.string().nullable(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  source: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  city: z.string().nullable(),
  notes: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  partyId: z.string().nullable(),
  contactCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Company = z.infer<typeof companySchema>;

const pageMetaSchema = z.object({ page: z.number(), pageSize: z.number(), total: z.number() });

export const contactsResponseSchema = z.object({ data: z.array(contactSchema), meta: pageMetaSchema });
export type ContactsResponse = z.infer<typeof contactsResponseSchema>;

export const companiesResponseSchema = z.object({ data: z.array(companySchema), meta: pageMetaSchema });
export type CompaniesResponse = z.infer<typeof companiesResponseSchema>;

/** REQ-U-08: what the form is warned with, not the record itself. */
export const contactDuplicateSchema = z.object({
  id: z.string(),
  name: z.string(),
  companyName: z.string().nullable(),
  ownerName: z.string().nullable(),
  matchedOn: z.array(z.enum(['phone', 'email'])),
});
export type ContactDuplicate = z.infer<typeof contactDuplicateSchema>;
export const contactDuplicatesSchema = z.array(contactDuplicateSchema);

/** The form's working copy of a contact; ids are null until chosen. */
export interface ContactDraft {
  id?: string;
  name: string;
  phone: string;
  email: string;
  designation: string;
  companyId: string | null;
  ownerId: string | null;
  source: string;
  notes: string;
}

export interface CompanyDraft {
  id?: string;
  name: string;
  phone: string;
  email: string;
  website: string;
  city: string;
  ownerId: string | null;
  notes: string;
}

export function emptyContactDraft(overrides: Partial<ContactDraft> = {}): ContactDraft {
  return {
    name: '',
    phone: '',
    email: '',
    designation: '',
    companyId: null,
    ownerId: null,
    source: '',
    notes: '',
    ...overrides,
  };
}

export function contactToDraft(contact: Contact): ContactDraft {
  return {
    id: contact.id,
    name: contact.name,
    phone: contact.phone ?? '',
    email: contact.email ?? '',
    designation: contact.designation ?? '',
    companyId: contact.companyId,
    ownerId: contact.ownerId,
    source: contact.source ?? '',
    notes: contact.notes ?? '',
  };
}

export function emptyCompanyDraft(): CompanyDraft {
  return { name: '', phone: '', email: '', website: '', city: '', ownerId: null, notes: '' };
}

export function companyToDraft(company: Company): CompanyDraft {
  return {
    id: company.id,
    name: company.name,
    phone: company.phone ?? '',
    email: company.email ?? '',
    website: company.website ?? '',
    city: company.city ?? '',
    ownerId: company.ownerId,
    notes: company.notes ?? '',
  };
}

// ---------------------------------------------------------------- deals

export const pipelineStageSchema = z.object({
  id: z.string(),
  name: z.string(),
  sortOrder: z.number(),
  probability: z.number(),
  isWon: z.boolean(),
  isLost: z.boolean(),
});
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

export const pipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  stages: z.array(pipelineStageSchema),
});
export type Pipeline = z.infer<typeof pipelineSchema>;
export const pipelinesSchema = z.array(pipelineSchema);

export const dealSchema = z.object({
  id: z.string(),
  name: z.string(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  partyId: z.string().nullable(),
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  pipelineId: z.string(),
  pipelineName: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  probability: z.number(),
  value: z.string().nullable(),
  expectedCloseDate: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  status: z.enum(['open', 'won', 'lost']),
  closedAt: z.string().nullable(),
  leadSource: z.string().nullable(),
  priority: z.enum(DEAL_PRIORITIES).nullable(),
  nextFollowUpDate: z.string().nullable(),
  competitor: z.string().nullable(),
  lossReason: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Deal = z.infer<typeof dealSchema>;

export const dealsResponseSchema = z.object({ data: z.array(dealSchema), meta: pageMetaSchema });
export type DealsResponse = z.infer<typeof dealsResponseSchema>;

export const dealBoardSchema = z.object({
  pipeline: pipelineSchema,
  lanes: z.array(z.object({ stage: pipelineStageSchema, deals: z.array(dealSchema), total: z.number(), valueTotal: z.string() })),
});
export type DealBoard = z.infer<typeof dealBoardSchema>;

export interface DealDraft {
  id?: string;
  name: string;
  companyId: string | null;
  contactId: string | null;
  pipelineId: string | null;
  stageId: string | null;
  value: string;
  expectedCloseDate: string | null;
  ownerId: string | null;
  leadSource: string;
  priority: DealPriority | null;
  nextFollowUpDate: string | null;
  competitor: string;
  lossReason: string;
  notes: string;
}

export function emptyDealDraft(overrides: Partial<DealDraft> = {}): DealDraft {
  return {
    name: '',
    companyId: null,
    contactId: null,
    pipelineId: null,
    stageId: null,
    value: '',
    expectedCloseDate: null,
    ownerId: null,
    leadSource: '',
    priority: null,
    nextFollowUpDate: null,
    competitor: '',
    lossReason: '',
    notes: '',
    ...overrides,
  };
}

export function dealToDraft(deal: Deal): DealDraft {
  return {
    id: deal.id,
    name: deal.name,
    companyId: deal.companyId,
    contactId: deal.contactId,
    pipelineId: deal.pipelineId,
    stageId: deal.stageId,
    value: deal.value ?? '',
    expectedCloseDate: deal.expectedCloseDate,
    ownerId: deal.ownerId,
    leadSource: deal.leadSource ?? '',
    priority: deal.priority,
    nextFollowUpDate: deal.nextFollowUpDate,
    competitor: deal.competitor ?? '',
    lossReason: deal.lossReason ?? '',
    notes: deal.notes ?? '',
  };
}

// ------------------------------------------------------------- activities

export const activitySchema = z.object({
  id: z.string(),
  kind: z.enum(['call', 'meeting', 'note', 'email', 'system']),
  action: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  actorName: z.string().nullable(),
  occurredAt: z.string(),
  recordedAt: z.string(),
});
export type Activity = z.infer<typeof activitySchema>;

export const activityPageSchema = z.object({ data: z.array(activitySchema), nextCursor: z.string().nullable() });
export type ActivityPageView = z.infer<typeof activityPageSchema>;
