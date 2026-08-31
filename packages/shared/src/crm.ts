import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * CRM contracts (08 §7, REQ-U-01 to REQ-U-08). Contacts and companies are
 * Vyuha's own records — nothing here is a projection of Tally, and nothing
 * here is ever pushed to it (REQ-U-03: "a prospect who never buys must not
 * become a ledger"). The link to a party arrives at conversion, through
 * `external_refs`, and is read here as `partyId` when it exists.
 */

const nameField = z.string().trim().min(1).max(120);

/** Same shape as an employee's address: RFC 5321's practical maximum, lowered. */
const emailField = z
  .email('must be an email address')
  .max(254)
  .transform((value) => value.trim().toLowerCase());

/**
 * As permissive as an employee's mobile (REQ-A-06's reasoning holds — a
 * number typed from a business card carries spaces, brackets and a code).
 * The duplicate check (REQ-U-08) compares `normalizePhone`, not the text.
 */
const phoneField = z
  .string()
  .trim()
  .min(6)
  .max(24)
  .regex(/^[+0-9][0-9 ()-]*$/u, 'may contain digits, spaces, brackets and a leading plus');

const websiteField = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}([/?#].*)?$/u, 'must be a domain or a URL without its scheme');

/**
 * Digits only, with a leading country code folded away when the number is
 * long enough to carry one. `+91 98765 43210`, `098765 43210` and
 * `9876543210` are the same phone; two contacts with two of those spellings
 * are the duplicate REQ-U-08 wants surfaced.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/gu, '');
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

export const CONTACT_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number];
export const DEFAULT_CONTACT_SORT = 'name';

export const COMPANY_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
export type CompanySortField = (typeof COMPANY_SORT_FIELDS)[number];
export const DEFAULT_COMPANY_SORT = 'name';

// ------------------------------------------------------------------ companies

export interface CompanyView {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly city: string | null;
  readonly notes: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  /** The Tally party this company was linked to on conversion (REQ-U-03), else null. */
  readonly partyId: string | null;
  readonly contactCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const companyListQuerySchema = pageQuerySchema.extend({
  /** Free text over name, city and website. */
  q: z.string().trim().min(1).max(80).optional(),
  ownerId: z.uuid().optional(),
  sort: z.string().max(200).optional(),
});
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

export const createCompanySchema = z.object({
  name: nameField,
  phone: phoneField.nullish(),
  email: emailField.nullish(),
  website: websiteField.nullish(),
  city: z.string().trim().min(1).max(80).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  /** Defaults to the caller's own employee record; only a `view.all` holder may name another. */
  ownerId: z.uuid().nullish(),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema.partial();
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

// ------------------------------------------------------------------- contacts

export interface ContactView {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly designation: string | null;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly source: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const contactListQuerySchema = pageQuerySchema.extend({
  /** Free text over name, phone, email and designation. */
  q: z.string().trim().min(1).max(80).optional(),
  companyId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  sort: z.string().max(200).optional(),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export const createContactSchema = z.object({
  name: nameField,
  phone: phoneField.nullish(),
  email: emailField.nullish(),
  designation: z.string().trim().min(1).max(80).nullish(),
  companyId: z.uuid().nullish(),
  /** Defaults to the caller's own employee record; only a `view.all` holder may name another. */
  ownerId: z.uuid().nullish(),
  /** Free text — "referral", "website", an exhibition's name. Not an enum yet: no list was agreed. */
  source: z.string().trim().min(1).max(60).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = createContactSchema.partial();
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

/**
 * REQ-U-08: the duplicate check. Called by the form as phone and email are
 * typed, and answered with the contacts that already carry either — the form
 * shows them and lets the user go ahead anyway. `excludeId` keeps a contact
 * from being reported as its own duplicate while it is being edited.
 */
export const contactDuplicateQuerySchema = z
  .object({
    phone: phoneField.optional(),
    email: emailField.optional(),
    excludeId: z.uuid().optional(),
  })
  .refine((q) => q.phone !== undefined || q.email !== undefined, {
    message: 'phone or email is required',
  });
export type ContactDuplicateQuery = z.infer<typeof contactDuplicateQuerySchema>;

export interface ContactDuplicate {
  readonly id: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly ownerName: string | null;
  /** Which field matched — the form points at the right one. */
  readonly matchedOn: readonly ('phone' | 'email')[];
}

// ------------------------------------------------------------ pipelines/deals

/**
 * REQ-U-04: pipelines and stages are configuration. One ships (the default
 * pipeline is created on first read); more may be added. A stage carries a
 * probability and, at the ends, a won or lost flag — entering such a stage
 * closes the deal, the way a done column closes a task.
 */
export interface PipelineStageView {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  /** 0–100, the default probability of a deal sitting here. */
  readonly probability: number;
  readonly isWon: boolean;
  readonly isLost: boolean;
}

export interface PipelineView {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly stages: readonly PipelineStageView[];
}

export const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isDefault: z.boolean().default(false),
});
export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = createPipelineSchema.partial();
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;

const probabilityField = z.number().int().min(0).max(100);

export const createPipelineStageSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    probability: probabilityField.default(0),
    isWon: z.boolean().default(false),
    isLost: z.boolean().default(false),
  })
  .refine((s) => !(s.isWon && s.isLost), { message: 'a stage is won or lost, not both', path: ['isLost'] });
export type CreatePipelineStageInput = z.infer<typeof createPipelineStageSchema>;

export const updatePipelineStageSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    probability: probabilityField.optional(),
    isWon: z.boolean().optional(),
    isLost: z.boolean().optional(),
  })
  .refine((s) => !(s.isWon === true && s.isLost === true), { message: 'a stage is won or lost, not both', path: ['isLost'] });
export type UpdatePipelineStageInput = z.infer<typeof updatePipelineStageSchema>;

export const reorderPipelineStagesSchema = z.object({ stageIds: z.array(z.uuid()).min(1).max(50) });
export type ReorderPipelineStagesInput = z.infer<typeof reorderPipelineStagesSchema>;

/** The pipeline an organisation starts with; renamed and reshaped from there. */
export const DEFAULT_PIPELINE = {
  name: 'Sales',
  stages: [
    { name: 'Lead', probability: 10, isWon: false, isLost: false },
    { name: 'Qualified', probability: 30, isWon: false, isLost: false },
    { name: 'Proposal', probability: 60, isWon: false, isLost: false },
    { name: 'Negotiation', probability: 80, isWon: false, isLost: false },
    { name: 'Won', probability: 100, isWon: true, isLost: false },
    { name: 'Lost', probability: 0, isWon: false, isLost: true },
  ],
} as const;

export const DEAL_STATUSES = ['open', 'won', 'lost', 'all'] as const;
export type DealStatusFilter = (typeof DEAL_STATUSES)[number];

export const DEAL_SORT_FIELDS = ['name', 'value', 'expectedCloseDate', 'createdAt', 'updatedAt'] as const;
export type DealSortField = (typeof DEAL_SORT_FIELDS)[number];
export const DEFAULT_DEAL_SORT = '-updatedAt';

/**
 * REQ-U-05. `value` is exact decimal text end to end: it is a figure a
 * salesperson types and reads, summed nowhere in Vyuha, and a float would
 * turn 1,00,000.10 into something else on the way back.
 */
export interface DealView {
  readonly id: string;
  readonly name: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  /** The Tally party the company is linked to (REQ-U-03), when it is. */
  readonly partyId: string | null;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly pipelineId: string;
  readonly pipelineName: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly probability: number;
  readonly value: string | null;
  readonly expectedCloseDate: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly status: 'open' | 'won' | 'lost';
  readonly closedAt: string | null;
  readonly leadSource: string | null;
  readonly priority: DealPriority | null;
  readonly nextFollowUpDate: string | null;
  readonly competitor: string | null;
  readonly lossReason: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const dealFilterSchema = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  /** Defaults to open. */
  status: z.enum(DEAL_STATUSES).optional(),
});
export type DealFilter = z.infer<typeof dealFilterSchema>;

export const dealListQuerySchema = pageQuerySchema.extend(dealFilterSchema.shape).extend({
  sort: z.string().max(200).optional(),
});
export type DealListQuery = z.infer<typeof dealListQuerySchema>;

export const dealBoardQuerySchema = dealFilterSchema;
export type DealBoardQuery = z.infer<typeof dealBoardQuerySchema>;

/** REQ-U-05: a file attached to a deal, as the sheet lists it. */
export interface DealAttachmentView {
  readonly id: string;
  readonly fileId: string;
  readonly filename: string;
  readonly mime: string;
  readonly bytes: number;
  readonly uploadedAt: string;
}

export interface DealBoardLane {
  readonly stage: PipelineStageView;
  readonly deals: readonly DealView[];
  readonly total: number;
  /** Sum of `value` over every deal in the lane (not only the capped page), exact decimal text. */
  readonly valueTotal: string;
}

export interface DealBoardView {
  readonly pipeline: PipelineView;
  readonly lanes: readonly DealBoardLane[];
}

export const DEAL_BOARD_LANE_CAP = 100;

/** Owner, 31 Aug 2026: how hard a deal is being chased. */
export const DEAL_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type DealPriority = (typeof DEAL_PRIORITIES)[number];

/** Up to 14 integer digits and 2 decimals, optionally signed off — a deal value, not a ledger. */
const moneyTextField = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,2})?$/u, 'a number with up to two decimals');

export const createDealSchema = z.object({
  name: z.string().trim().min(1).max(200),
  companyId: z.uuid().nullish(),
  contactId: z.uuid().nullish(),
  /** Defaults to the default pipeline. */
  pipelineId: z.uuid().nullish(),
  /** Defaults to the pipeline's first open stage. */
  stageId: z.uuid().nullish(),
  value: moneyTextField.nullish(),
  expectedCloseDate: z.iso.date().nullish(),
  ownerId: z.uuid().nullish(),
  leadSource: z.string().trim().max(120).nullish(),
  priority: z.enum(DEAL_PRIORITIES).nullish(),
  nextFollowUpDate: z.iso.date().nullish(),
  competitor: z.string().trim().max(120).nullish(),
  lossReason: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});
export type CreateDealInput = z.infer<typeof createDealSchema>;

export const updateDealSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  companyId: z.uuid().nullish(),
  contactId: z.uuid().nullish(),
  /** A move; must belong to the deal's pipeline. */
  stageId: z.uuid().optional(),
  value: moneyTextField.nullish(),
  expectedCloseDate: z.iso.date().nullish(),
  ownerId: z.uuid().nullish(),
  leadSource: z.string().trim().max(120).nullish(),
  priority: z.enum(DEAL_PRIORITIES).nullish(),
  nextFollowUpDate: z.iso.date().nullish(),
  competitor: z.string().trim().max(120).nullish(),
  lossReason: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});
export type UpdateDealInput = z.infer<typeof updateDealSchema>;

/**
 * REQ-U-03: linking a company to the Tally party it became. Offered when a
 * deal is won, but a property of the company — the party is who invoices go
 * to, whichever deal opened the door.
 */
export const linkCompanyPartySchema = z.object({ partyId: z.uuid().nullable() });
export type LinkCompanyPartyInput = z.infer<typeof linkCompanyPartySchema>;

// ------------------------------------------------------------------ activities

/**
 * REQ-U-07: the activity log per contact, company and deal is the audit
 * trail (technical design: "written through the platform audit interceptor,
 * not a parallel mechanism"). Logging a call is one audit entry against the
 * record; reading the timeline is reading that record's audit rows — so a
 * stage change, an edit and a phone call sit in one list, in order, with the
 * actor the interceptor already knew.
 */
export const CRM_ACTIVITY_KINDS = ['call', 'meeting', 'note', 'email'] as const;
export type CrmActivityKind = (typeof CRM_ACTIVITY_KINDS)[number];

export const CRM_ACTIVITY_KIND_LABELS: Record<CrmActivityKind, string> = {
  call: 'Call',
  meeting: 'Meeting',
  note: 'Note',
  email: 'Email',
};

export const CRM_ACTIVITY_SUBJECTS = ['contact', 'company', 'deal'] as const;
export type CrmActivitySubject = (typeof CRM_ACTIVITY_SUBJECTS)[number];

/** The audit action a logged activity is written under: `crm.activity.<kind>`. */
export const CRM_ACTIVITY_ACTION_PREFIX = 'crm.activity.';

export const logActivitySchema = z.object({
  subjectType: z.enum(CRM_ACTIVITY_SUBJECTS),
  subjectId: z.uuid(),
  kind: z.enum(CRM_ACTIVITY_KINDS),
  body: z.string().trim().min(1).max(4000),
  /** When it happened, if not now — a call logged after the fact. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
export type LogActivityInput = z.infer<typeof logActivitySchema>;

export const activityListQuerySchema = z.object({
  subjectType: z.enum(CRM_ACTIVITY_SUBJECTS),
  subjectId: z.uuid(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

export interface ActivityView {
  readonly id: string;
  /** A logged kind, or `system` for an event the record went through (created, moved, won…). */
  readonly kind: CrmActivityKind | 'system';
  /** The audit action, verbatim, for the reader who wants it. */
  readonly action: string;
  /** What to print: "Call", "Stage changed", "Won". */
  readonly title: string;
  readonly body: string | null;
  readonly actorName: string | null;
  /** When it happened: the logged `occurredAt`, else when the row was written. */
  readonly occurredAt: string;
  /** When it was recorded — differs from `occurredAt` for a call logged later. */
  readonly recordedAt: string;
}

export interface ActivityPage {
  readonly data: readonly ActivityView[];
  readonly nextCursor: string | null;
}
