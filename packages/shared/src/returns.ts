import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * Area AK — sales returns and replacements (15 REQ-AK-01…AK-11).
 *
 * Structurally the GRN inverted: goods come back, quantity and condition
 * are recorded at the desk, and the accounting document is Tally's. Vyuha
 * raises no credit note (REQ-AK-05, D-01) and moves no stock (REQ-AK-07) —
 * a restocked line rises in Tally as a consequence of the credit note and
 * arrives here on the following pull.
 */

/** REQ-AK-05/AK-06: received and waiting on Tally's credit note, then credited. Cancelled is a receipt written in error. */
export const RETURN_STATES = ['awaiting_credit_note', 'credited', 'cancelled'] as const;
export type ReturnState = (typeof RETURN_STATES)[number];
export const RETURN_STATE_LABELS: Record<ReturnState, string> = {
  awaiting_credit_note: 'Awaiting credit note',
  credited: 'Credited',
  cancelled: 'Cancelled',
};

/** REQ-AK-01: the physical state the goods came back in, separate from why they came back. */
export const RETURN_CONDITIONS = ['sealed', 'opened', 'damaged'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];
export const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = {
  sealed: 'Sealed',
  opened: 'Opened',
  damaged: 'Damaged',
};

/** REQ-AK-03: decided at the desk with the goods in hand, never later in someone's head. */
export const RETURN_DISPOSITIONS = ['restock', 'scrap'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];
export const RETURN_DISPOSITION_LABELS: Record<ReturnDisposition, string> = {
  restock: 'Restock',
  scrap: 'Scrap',
};

/** REQ-AK-09 / D-51: chargeable or free, decided per return. There is deliberately no default. */
export const REPLACEMENT_CHARGES = ['chargeable', 'free'] as const;
export type ReplacementCharge = (typeof REPLACEMENT_CHARGES)[number];
export const REPLACEMENT_CHARGE_LABELS: Record<ReplacementCharge, string> = {
  chargeable: 'Chargeable',
  free: 'Free of charge',
};

/**
 * REQ-AK-02: the reasons are a list an organisation edits, so they are
 * stored as the words themselves rather than codes — a reason retired next
 * year must not rewrite what last year's receipt says. Free text rides
 * alongside in `reasonNote`, never instead of a reason.
 */
export const DEFAULT_RETURN_REASONS = [
  'Damaged in transit',
  'Wrong item',
  'Wrong quantity',
  'Quality rejection',
  'Customer cancelled',
  'Warranty',
] as const;

export const returnReasonsPolicySchema = z.object({
  reasons: z.array(z.string().trim().min(2).max(60)).min(1).max(30),
});
export type ReturnReasonsPolicy = z.infer<typeof returnReasonsPolicySchema>;
export const DEFAULT_RETURN_REASONS_POLICY: ReturnReasonsPolicy = { reasons: [...DEFAULT_RETURN_REASONS] };

const quantity = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/u, 'a quantity');

export const returnLineInputSchema = z.object({
  /** The line of the invoice or order this came off, when the return is against a Vyuha document. */
  lineId: z.uuid().nullish(),
  stockItemId: z.uuid().nullish(),
  description: z.string().trim().min(1).max(300),
  unit: z.string().trim().max(20).nullish(),
  quantity,
  reason: z.string().trim().min(2).max(60),
  reasonNote: z.string().trim().max(500).nullish(),
  condition: z.enum(RETURN_CONDITIONS),
  disposition: z.enum(RETURN_DISPOSITIONS),
});
export type ReturnLineInput = z.infer<typeof returnLineInputSchema>;

/** REQ-AK-01: a return receipt. Photographs (REQ-AK-04) travel as multipart parts beside this JSON. */
export const createReturnSchema = z.object({
  partyId: z.uuid().nullish(),
  customerName: z.string().trim().min(1).max(200),
  /** The invoice or sales order it relates to; a dispatch narrows it further. */
  sourceDocumentId: z.uuid().nullish(),
  dispatchId: z.uuid().nullish(),
  receivedOn: z.iso.date().optional(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(returnLineInputSchema).min(1).max(200),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

/** REQ-AK-03 / `returns.disposition`: scrapping is its own key, and a change is reasoned. */
export const setDispositionSchema = z.object({
  lineId: z.uuid(),
  disposition: z.enum(RETURN_DISPOSITIONS),
  reason: z.string().trim().min(3).max(500),
});
export type SetDispositionInput = z.infer<typeof setDispositionSchema>;

/** REQ-AK-09: the decision that determines whether the replacement waits for an invoice. */
export const decideReplacementSchema = z.object({
  charge: z.enum(REPLACEMENT_CHARGES),
  lines: z.array(z.object({ lineId: z.uuid(), quantity })).max(200).optional(),
});
export type DecideReplacementInput = z.infer<typeof decideReplacementSchema>;

export const linkCreditNoteSchema = z.object({ voucherId: z.uuid() });
export type LinkCreditNoteInput = z.infer<typeof linkCreditNoteSchema>;

export interface ReturnLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly sourceLineId: string | null;
  readonly stockItemId: string | null;
  readonly description: string;
  readonly unit: string | null;
  readonly quantity: string;
  readonly reason: string;
  readonly reasonNote: string | null;
  readonly condition: ReturnCondition;
  readonly disposition: ReturnDisposition;
  /** REQ-AK-08: how much of this line has already gone back out on a replacement. */
  readonly replacedQty: string;
}

export interface ReturnAttachmentView {
  readonly id: string;
  readonly fileId: string;
  readonly kind: string;
  readonly uploadedAt: string;
}

export interface ReturnCreditNoteView {
  readonly voucherId: string;
  readonly voucherNumber: string;
  readonly date: string;
  readonly amount: string;
  readonly method: string;
  readonly linkedAt: string;
}

export interface ReturnReplacementView {
  readonly documentId: string;
  readonly number: string;
  readonly status: string;
  readonly grandTotal: string;
  readonly dispatchCount: number;
}

export interface SalesReturnView {
  readonly id: string;
  readonly number: string;
  readonly state: ReturnState;
  readonly partyId: string | null;
  readonly customerName: string;
  readonly sourceDocumentId: string | null;
  readonly sourceNumber: string | null;
  readonly dispatchId: string | null;
  readonly dispatchNumber: string | null;
  readonly receivedOn: string;
  readonly receivedById: string | null;
  readonly receivedByName: string | null;
  readonly notes: string | null;
  readonly replacementCharge: ReplacementCharge | null;
  readonly cancelledReason: string | null;
  readonly lines: readonly ReturnLineView[];
  readonly attachments: readonly ReturnAttachmentView[];
  readonly creditNote: ReturnCreditNoteView | null;
  readonly replacement: ReturnReplacementView | null;
}

export interface SalesReturnSummary {
  readonly id: string;
  readonly number: string;
  readonly state: ReturnState;
  readonly partyId: string | null;
  readonly customerName: string;
  readonly sourceNumber: string | null;
  readonly receivedOn: string;
  readonly lineCount: number;
  readonly quantity: string;
  readonly reasons: readonly string[];
  readonly scrapLines: number;
  readonly replacementCharge: ReplacementCharge | null;
  readonly replacementNumber: string | null;
  readonly creditNoteNumber: string | null;
}

export const returnListQuerySchema = pageQuerySchema.extend({
  state: z.enum(RETURN_STATES).optional(),
  partyId: z.uuid().optional(),
  stockItemId: z.uuid().optional(),
  reason: z.string().trim().min(2).max(60).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type ReturnListQuery = z.infer<typeof returnListQuerySchema>;

/**
 * REQ-AK-06: a Credit Note that names no return. Candidates are the party's
 * open returns; nothing is guessed at by party and date alone — a person
 * chooses, exactly as with the unlinked Sales vouchers (12 §3.3).
 */
export interface UnlinkedCreditNote {
  readonly voucherId: string;
  readonly voucherNumber: string;
  readonly date: string;
  readonly partyId: string | null;
  readonly partyName: string;
  readonly amount: string;
  readonly narration: string | null;
  readonly candidateReturns: readonly { readonly returnId: string; readonly number: string; readonly receivedOn: string; readonly quantity: string }[];
}
