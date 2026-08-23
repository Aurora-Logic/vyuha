import { describe, expect, it } from 'vitest';

import { assignmentProblem, draftProblem, emptyDraft, lineProblem, newAssignmentDraft, newLineDraft, toDraftInput } from './price-list-draft';

describe('price list draft', () => {
  it('names what a line or an assignment still needs', () => {
    expect(lineProblem(newLineDraft())).toBe('Pick the item.');
    expect(lineProblem(newLineDraft({ target: 'group' }))).toBe('Name the item group.');
    expect(lineProblem(newLineDraft({ stockItemId: 'i', basis: 'rate' }))).toBe('A rate is needed.');
    expect(lineProblem(newLineDraft({ stockItemId: 'i', basis: 'discount_pct' }))).toBe('A percentage is needed.');
    expect(lineProblem(newLineDraft({ stockItemId: 'i', basis: 'both', rate: '100', discountPct: '5', minQty: '10', maxQty: '5' }))).toBe('The slab floor must be below its ceiling.');
    expect(lineProblem(newLineDraft({ stockItemId: 'i', basis: 'both', rate: '100', discountPct: '5' }))).toBeNull();
    expect(assignmentProblem(newAssignmentDraft())).toBe('Pick the party.');
    expect(assignmentProblem(newAssignmentDraft({ kind: 'default' }))).toBeNull();
  });

  it('reads the whole draft, first problem first', () => {
    const draft = emptyDraft('2026-04-01');
    expect(draftProblem(draft)).toBe('The list needs a name.');
    expect(draftProblem({ ...draft, name: 'Asha terms', effectiveTo: '2026-03-01' })).toBe('Effective-to must not precede effective-from.');
    expect(draftProblem({ ...draft, name: 'Asha terms', lines: [] })).toBe('The list needs at least one line.');
  });

  it('sends only what the basis and the target use, and blanks as nulls', () => {
    const input = toDraftInput({
      name: ' Asha terms ',
      effectiveFrom: '2026-04-01',
      effectiveTo: '',
      notes: '',
      lines: [
        newLineDraft({ stockItemId: 'i', basis: 'discount_pct', rate: '999', discountPct: '12' }),
        newLineDraft({ target: 'group', itemGroup: 'Cables', basis: 'rate', rate: '3900', discountPct: '7', minQty: '10', maxQty: '' }),
      ],
      assignments: [newAssignmentDraft({ partyId: 'p' }), newAssignmentDraft({ kind: 'group', partyGroup: 'Sundry Debtors' }), newAssignmentDraft({ kind: 'default' })],
    });
    expect(input.name).toBe('Asha terms');
    expect(input.effectiveTo).toBeNull();
    expect(input.lines[0]).toEqual({ stockItemId: 'i', itemGroup: null, basis: 'discount_pct', rate: null, discountPct: '12', minQty: null, maxQty: null });
    expect(input.lines[1]).toEqual({ stockItemId: null, itemGroup: 'Cables', basis: 'rate', rate: '3900', discountPct: null, minQty: '10', maxQty: null });
    expect(input.assignments).toEqual([
      { partyId: 'p', partyGroup: null, isDefault: false },
      { partyId: null, partyGroup: 'Sundry Debtors', isDefault: false },
      { partyId: null, partyGroup: null, isDefault: true },
    ]);
  });
});
