import { z } from 'zod';

import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  approveRequestSchema,
  bulkApprovalDecisionSchema,
  rejectRequestSchema,
  type ApprovalRequestSummary,
  type ApprovalStatus,
  type ApprovalType,
  type BulkApprovalDecisionInput,
  type NamedRef,
} from '@vyuha/shared';

/**
 * REQ-I-01: one approval mechanism for leave, regularization, on-duty,
 * flagged punches and device rebinding. There is deliberately no per-type
 * shape here — the inbox renders a request by what every type has in common,
 * and `subject` is the server's one-line statement of what is being asked.
 * A screen that branched on `type` to build its own sentence per type would
 * be the four separate inboxes REQ-I-01 forbids.
 *
 * The row shape and the request bodies are the published contract, imported
 * rather than restated. What stays here is the *parser* for the response and
 * the labels, for the reason the attendance feature gives: an unvalidated
 * response fails three components deep in a cell renderer, and the stack trace
 * names the table rather than the field the server changed.
 *
 * `z.ZodType<ApprovalRequestSummary>` is the link that makes drift a compile
 * error: change the contract and this parser stops typechecking, rather than
 * silently stripping a field the screen then renders as blank.
 */
export type ApprovalRequest = ApprovalRequestSummary;

const namedRefSchema: z.ZodType<NamedRef> = z.object({
  id: z.string(),
  name: z.string(),
});

export const approvalRequestSchema: z.ZodType<ApprovalRequest> = z.object({
  id: z.string(),
  type: z.enum(APPROVAL_TYPES),
  subjectType: z.string(),
  subjectId: z.string(),
  requester: namedRefSchema,
  subject: z.string(),
  submittedAt: z.string(),
  currentStep: z.number().int(),
  status: z.enum(APPROVAL_STATUSES),
});

/**
 * The request bodies, straight from the contract package.
 *
 * REQ-F-05's "a rejection requires a reason" is expressed once, in
 * `rejectRequestSchema`, and the server parses the same object. A second
 * definition here is how the client comes to allow something the server
 * refuses -- or, worse, the reverse.
 */
export { approveRequestSchema, bulkApprovalDecisionSchema, rejectRequestSchema };
export type BulkAction = BulkApprovalDecisionInput;

export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  LEAVE: 'Leave',
  REGULARIZATION: 'Regularization',
  ON_DUTY: 'On duty',
  FLAGGED_PUNCH: 'Flagged punch',
  DEVICE_REBIND: 'Device rebind',
  PURCHASE_ORDER: 'Purchase order',
  SALES_DISCOUNT: 'Sales discount',
  PRICE_LIST: 'Price list',
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  ESCALATED: 'Escalated',
};

export const APPROVAL_STATUS_VARIANT: Record<
  ApprovalStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  PENDING: 'default',
  APPROVED: 'secondary',
  REJECTED: 'destructive',
  CANCELLED: 'outline',
  ESCALATED: 'default',
};

export type { ApprovalStatus, ApprovalType };
