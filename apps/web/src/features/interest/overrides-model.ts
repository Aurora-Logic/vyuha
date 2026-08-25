import type { InterestPartySetting } from './use-interest';

/**
 * The overrides screen's pure decisions, out of the component so they are
 * testable without rendering: what the two inputs mean, and which of the
 * server's rows belong to which list.
 */

/** A typed override field: empty clears, a number within bounds sets, anything else refuses. */
export type ParsedOverride = { kind: 'clear' } | { kind: 'set'; value: number } | { kind: 'invalid' };

/** Percent per annum, 0 to 100; decimals allowed because rates have them. */
export function parseRateInput(text: string): ParsedOverride {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'clear' };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) return { kind: 'invalid' };
  return { kind: 'set', value };
}

/** Whole days, 0 to 365 — the bounds the API's schema enforces. */
export function parseDaysInput(text: string): ParsedOverride {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'clear' };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > 365) return { kind: 'invalid' };
  return { kind: 'set', value };
}

/**
 * Whether the pair can be sent. Both empty is refused rather than sent: a PUT
 * of two nulls would keep a row alive that overrides nothing, and the honest
 * action for that intent is Remove.
 */
export function overridePayload(
  rate: ParsedOverride,
  days: ParsedOverride,
): { interestRateOverride: number | null; creditDaysOverride: number | null } | null {
  if (rate.kind === 'invalid' || days.kind === 'invalid') return null;
  if (rate.kind === 'clear' && days.kind === 'clear') return null;
  return {
    interestRateOverride: rate.kind === 'set' ? rate.value : null,
    creditDaysOverride: days.kind === 'set' ? days.value : null,
  };
}

/** Carries an override worth listing: either field beats the projection. */
export function hasOverride(setting: InterestPartySetting): boolean {
  return setting.creditDaysOverride !== null || setting.interestRateOverride !== null;
}

/**
 * The two lists the screen shows. A party can appear in both — a rate
 * override does not settle its credit terms — and hiding it from the missing
 * list would hide exactly the fact the flag exists to surface (D-22: never a
 * silent 30, it accrues from day zero).
 */
export function splitSettings(settings: readonly InterestPartySetting[]): {
  overridden: InterestPartySetting[];
  missing: InterestPartySetting[];
} {
  return {
    overridden: settings.filter(hasOverride),
    missing: settings.filter((setting) => setting.creditTermsMissing),
  };
}
