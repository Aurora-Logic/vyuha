/**
 * The five categories a switchgear distributor thinks in (brief G2, Q2.10):
 * MCB, MCCB, ACB, RCCB and PQ. Tally carries no category on a stock item --
 * the brand is the parent group -- so until a category master lands (S5),
 * the category is read off the item's name. MCCB is tested before MCB
 * because "MCCB" contains "MCB"; anything unrecognised is Other, and the
 * Data Quality screen counts those as items without a category.
 */

export const CATEGORIES = ['MCB', 'MCCB', 'ACB', 'RCCB', 'PQ', 'Other'] as const;
export type Category = (typeof CATEGORIES)[number];

const RULES: readonly { category: Exclude<Category, 'Other'>; pattern: RegExp }[] = [
  { category: 'MCCB', pattern: /\bMCCB\b|moulded case/iu },
  { category: 'RCCB', pattern: /\bRCCB\b|\bRCBO\b|\bELCB\b|residual current/iu },
  { category: 'ACB', pattern: /\bACB\b|air circuit/iu },
  { category: 'MCB', pattern: /\bMCB\b|miniature circuit|\bDP\b.*\bA\b|\bSP\b.*\bA\b/iu },
  { category: 'PQ', pattern: /\bPQ\b|\bAPFC\b|capacitor|power quality|harmonic|\bkVAr\b/iu },
];

export function categoryOf(itemName: string | null | undefined): Category {
  const name = (itemName ?? '').trim();
  if (name === '') return 'Other';
  for (const rule of RULES) if (rule.pattern.test(name)) return rule.category;
  return 'Other';
}

/** The SQL-side twin, so a grouped query classifies the same way the code does. */
export const CATEGORY_CASE_SQL = `CASE
  WHEN item_name ~* '\\mMCCB\\M|moulded case' THEN 'MCCB'
  WHEN item_name ~* '\\mRCCB\\M|\\mRCBO\\M|\\mELCB\\M|residual current' THEN 'RCCB'
  WHEN item_name ~* '\\mACB\\M|air circuit' THEN 'ACB'
  WHEN item_name ~* '\\mMCB\\M|miniature circuit' THEN 'MCB'
  WHEN item_name ~* '\\mPQ\\M|\\mAPFC\\M|capacitor|power quality|harmonic|\\mkVAr\\M' THEN 'PQ'
  ELSE 'Other' END`;
