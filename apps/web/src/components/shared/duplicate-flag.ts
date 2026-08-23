import { z } from 'zod';

import { DUPLICATE_MATCH_FIELD_LABELS } from '@vyuha/shared';

/**
 * 15 REQ-AO-06/07/08, the pure half: the surface a flagged row wears, the
 * contract the list hooks parse, and the one sentence that says who else
 * and on what. The badge that shows it is `DuplicateBadge`.
 */

/** The destructive surface at a tenth: legible in both themes, over the table's hover and selection tints. */
export const DUPLICATE_ROW_CLASS = 'bg-destructive/10 hover:bg-destructive/15 data-[state=selected]:bg-destructive/15';

export const duplicateFlagSchema = z.object({
  clusterId: z.string(),
  confidence: z.number(),
  matchedFields: z.array(z.string()),
  others: z.array(z.string()),
});

export interface FlagLike {
  readonly others: readonly string[];
  readonly matchedFields: readonly string[];
}

export function matchedFieldLabels(fields: readonly string[]): string[] {
  return fields.map((field) => (DUPLICATE_MATCH_FIELD_LABELS as Record<string, string>)[field] ?? field);
}

/** One sentence, for a tooltip or a picker: who else, and on what. */
export function duplicateWarning(flag: FlagLike): string {
  const others = flag.others.length === 0 ? 'another record' : flag.others.join(', ');
  const fields = matchedFieldLabels(flag.matchedFields)
    .map((f) => f.toLowerCase())
    .join(', ');
  return `Likely the same as ${others}${fields ? ` (same ${fields})` : ''}. Merge in Tally.`;
}
