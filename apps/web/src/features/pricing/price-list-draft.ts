import type { PriceBasis, PriceListAssignmentInput, PriceListDetail, PriceListDraftInput, PriceListLineInput } from '@vyuha/shared';

/**
 * The editor's draft of a price list and its two-way reading: a detail
 * from the API into boxes, the boxes into the input the API takes. Pure,
 * so the rules a salesperson meets in the form are tested here.
 */

export interface LineDraft {
  readonly key: string;
  readonly target: 'item' | 'group';
  readonly stockItemId: string | null;
  readonly itemName: string | null;
  readonly itemGroup: string;
  readonly basis: PriceBasis;
  readonly rate: string;
  readonly discountPct: string;
  readonly minQty: string;
  readonly maxQty: string;
}

export interface AssignmentDraft {
  readonly key: string;
  readonly kind: 'party' | 'group' | 'default';
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyGroup: string;
}

export interface PriceListDraft {
  readonly name: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly notes: string;
  readonly lines: readonly LineDraft[];
  readonly assignments: readonly AssignmentDraft[];
}

let counter = 0;
function key(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

export function newLineDraft(over: Partial<LineDraft> = {}): LineDraft {
  return { key: key('line'), target: 'item', stockItemId: null, itemName: null, itemGroup: '', basis: 'discount_pct', rate: '', discountPct: '', minQty: '', maxQty: '', ...over };
}

export function newAssignmentDraft(over: Partial<AssignmentDraft> = {}): AssignmentDraft {
  return { key: key('assign'), kind: 'party', partyId: null, partyName: null, partyGroup: '', ...over };
}

export function emptyDraft(today: string): PriceListDraft {
  return { name: '', effectiveFrom: today, effectiveTo: '', notes: '', lines: [newLineDraft()], assignments: [newAssignmentDraft()] };
}

export function draftOf(detail: PriceListDetail): PriceListDraft {
  return {
    name: detail.name,
    effectiveFrom: detail.effectiveFrom,
    effectiveTo: detail.effectiveTo ?? '',
    notes: detail.notes ?? '',
    lines: detail.lines.map((line) =>
      newLineDraft({
        target: line.stockItemId === null ? 'group' : 'item',
        stockItemId: line.stockItemId,
        itemName: line.itemName,
        itemGroup: line.itemGroup ?? '',
        basis: line.basis,
        rate: line.rate ?? '',
        discountPct: line.discountPct ?? '',
        minQty: line.minQty ?? '',
        maxQty: line.maxQty ?? '',
      }),
    ),
    assignments: detail.assignments.map((a) => newAssignmentDraft({ kind: a.isDefault ? 'default' : a.partyId !== null ? 'party' : 'group', partyId: a.partyId, partyName: a.partyName, partyGroup: a.partyGroup ?? '' })),
  };
}

function blank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Why a line cannot be sent yet, in the form's own words; null when it can. */
export function lineProblem(line: LineDraft): string | null {
  if (line.target === 'item' && line.stockItemId === null) return 'Pick the item.';
  if (line.target === 'group' && line.itemGroup.trim() === '') return 'Name the item group.';
  if (line.basis !== 'discount_pct' && blank(line.rate) === null) return 'A rate is needed.';
  if (line.basis !== 'rate' && blank(line.discountPct) === null) return 'A percentage is needed.';
  const min = blank(line.minQty);
  const max = blank(line.maxQty);
  if (min !== null && max !== null && Number(min) >= Number(max)) return 'The slab floor must be below its ceiling.';
  return null;
}

export function assignmentProblem(a: AssignmentDraft): string | null {
  if (a.kind === 'party' && a.partyId === null) return 'Pick the party.';
  if (a.kind === 'group' && a.partyGroup.trim() === '') return 'Name the party group.';
  return null;
}

export function draftProblem(draft: PriceListDraft): string | null {
  if (draft.name.trim() === '') return 'The list needs a name.';
  if (draft.effectiveFrom === '') return 'The list needs an effective-from date.';
  if (draft.effectiveTo !== '' && draft.effectiveTo < draft.effectiveFrom) return 'Effective-to must not precede effective-from.';
  if (draft.lines.length === 0) return 'The list needs at least one line.';
  const line = draft.lines.map(lineProblem).find((p) => p !== null);
  if (line !== undefined && line !== null) return line;
  const assignment = draft.assignments.map(assignmentProblem).find((p) => p !== null);
  if (assignment !== undefined && assignment !== null) return assignment;
  return null;
}

export function toDraftInput(draft: PriceListDraft): PriceListDraftInput {
  const lines: PriceListLineInput[] = draft.lines.map((line) => ({
    stockItemId: line.target === 'item' ? line.stockItemId : null,
    itemGroup: line.target === 'group' ? blank(line.itemGroup) : null,
    basis: line.basis,
    rate: line.basis === 'discount_pct' ? null : blank(line.rate),
    discountPct: line.basis === 'rate' ? null : blank(line.discountPct),
    minQty: blank(line.minQty),
    maxQty: blank(line.maxQty),
  }));
  const assignments: PriceListAssignmentInput[] = draft.assignments.map((a) => ({
    partyId: a.kind === 'party' ? a.partyId : null,
    partyGroup: a.kind === 'group' ? blank(a.partyGroup) : null,
    isDefault: a.kind === 'default',
  }));
  return { name: draft.name.trim(), effectiveFrom: draft.effectiveFrom, effectiveTo: blank(draft.effectiveTo), notes: blank(draft.notes), lines, assignments };
}
