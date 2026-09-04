import {
  LEAVE_MOVEMENT_BUCKET,
  closingLeaveBalance,
  roundLeaveDays,
  type LeaveBalanceBucket,
  type LeaveMovementType,
} from '@vyuha/shared';

/**
 * REQ-G-03: the balance is a projection of the ledger, and nothing else.
 *
 * `leave_balances` is a cache. Every one of its six numbers is reproducible by
 * summing `leave_ledger`, which is what makes a disagreement between them
 * detectable rather than a matter of opinion. This file is the single place
 * that turns rows into numbers, so the accrual job, the application, the
 * cancellation and the reconciliation check cannot each project them slightly
 * differently.
 *
 * Sign convention, stated once because everything downstream depends on it:
 *
 *   - the ledger stores a **signed** movement. AVAILED and LAPSE are negative,
 *     ACCRUAL, OPENING, CARRY_FORWARD and REVERSAL positive, ADJUSTMENT either.
 *   - the balance stores `availed` as a **positive quantity taken**, which is
 *     why `closingLeaveBalance` subtracts it.
 *
 * The two meet here. `closing` therefore equals both
 * `opening + accrued - availed + adjusted + carriedForward` *and* the plain sum
 * of every signed row -- two independent routes to the same number, which is
 * what `assertProjectionIsSound` checks and what the property test exploits.
 */

export interface LedgerMovement {
  readonly movementType: LeaveMovementType;
  readonly days: number;
}

export interface ProjectedBalance {
  readonly opening: number;
  readonly accrued: number;
  readonly availed: number;
  readonly adjusted: number;
  readonly carriedForward: number;
  readonly closing: number;
}

/**
 * Rounds each bucket before the closing figure is derived from them.
 *
 * Not cosmetic. Every stored movement has at most two decimals, so the true
 * bucket sums do too -- but accumulating them as binary floats does not, and
 * 0.1 + 0.2 landing on 0.30000000000000004 is the difference between the
 * database accepting the row and the check constraint added in migration 0009
 * rejecting it. Rounding a sum whose exact value has two decimals recovers
 * that exact value, so this loses nothing.
 */
export function projectLedger(movements: Iterable<LedgerMovement>): ProjectedBalance {
  let opening = 0;
  let accrued = 0;
  let availedSigned = 0;
  let adjusted = 0;
  let carriedForward = 0;

  for (const movement of movements) {
    const bucket: LeaveBalanceBucket = LEAVE_MOVEMENT_BUCKET[movement.movementType];
    switch (bucket) {
      case 'opening':
        opening += movement.days;
        break;
      case 'accrued':
        accrued += movement.days;
        break;
      case 'availed':
        availedSigned += movement.days;
        break;
      case 'adjusted':
        adjusted += movement.days;
        break;
      case 'carriedForward':
        carriedForward += movement.days;
        break;
    }
  }

  // `availed` is the magnitude taken, and the signed rows that feed it are
  // negative for an AVAILED and positive for the REVERSAL that gives it back.
  const balance = {
    opening: roundLeaveDays(opening),
    accrued: roundLeaveDays(accrued),
    availed: roundLeaveDays(-availedSigned),
    adjusted: roundLeaveDays(adjusted),
    carriedForward: roundLeaveDays(carriedForward),
  };

  return { ...balance, closing: closingLeaveBalance(balance) };
}

/**
 * The second route to the same number.
 *
 * A projection is only trustworthy if it can be checked against something that
 * did not come from the same code path. Summing the signed rows uses neither
 * the bucket map nor the invariant formula, so a mistake in either shows up
 * here as a disagreement rather than as two consistent wrong answers.
 */
export function sumSignedMovements(movements: Iterable<LedgerMovement>): number {
  let total = 0;
  for (const movement of movements) total += movement.days;
  return roundLeaveDays(total);
}

export class LeaveProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveProjectionError';
  }
}

/**
 * Throws rather than logging.
 *
 * Called on every write path before the balance row is saved. A balance that
 * disagrees with its own ledger must never reach the table -- the check
 * constraint would refuse it anyway, but a constraint violation surfaces as a
 * driver error naming a column, and this names the disagreement.
 */
export function assertProjectionIsSound(
  movements: readonly LedgerMovement[],
  balance: ProjectedBalance,
): void {
  const signed = sumSignedMovements(movements);
  if (signed !== balance.closing) {
    throw new LeaveProjectionError(
      `Ledger projection is inconsistent: the signed rows sum to ${String(signed)} ` +
        `but the buckets close at ${String(balance.closing)}.`,
    );
  }
}

/**
 * REQ-G-08: "negative balance is allowed, up to a limit set per leave type".
 *
 * Returns the shortfall beyond the limit, or 0 when the application fits.
 * Expressed as a magnitude so the caller reports a number the employee can
 * act on rather than a boolean they cannot.
 */
export function negativeLimitShortfall(input: {
  readonly closingBefore: number;
  readonly daysRequested: number;
  readonly negativeBalanceLimit: number;
}): number {
  const after = roundLeaveDays(input.closingBefore - input.daysRequested);
  const floor = roundLeaveDays(-Math.abs(input.negativeBalanceLimit));
  return after < floor ? roundLeaveDays(floor - after) : 0;
}
