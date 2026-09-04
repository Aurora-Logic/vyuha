import type { TaskItemLine } from './types';

/**
 * Whether an order line is one the server will accept.
 *
 * Its own module rather than living beside the field: it is not a component,
 * and a hook or a helper exported from a component file breaks fast refresh.
 * The dialog asks this before submitting, so an emptied quantity is a red
 * line in place rather than a 400 with a generic toast after the person has
 * already filled in the party, the items and the notes.
 *
 * These are the server's own shapes from `taskItemInputSchema`, so a line
 * that passes here cannot be refused there.
 */

const SERVER_QUANTITY = /^\d{1,12}(\.\d{1,3})?$/u;
const SERVER_MONEY = /^\d{1,14}(\.\d{1,2})?$/u;
const SERVER_PERCENT = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/u;

/** The lines that are not yet a valid order, by item id, for the caller to show. */
export function incompleteOrderLines(items: readonly TaskItemLine[]): string[] {
  return items
    .filter(
      (line) =>
        !SERVER_QUANTITY.test(line.quantity) ||
        !SERVER_PERCENT.test(line.discountPct) ||
        (line.rate !== null && !SERVER_MONEY.test(line.rate)),
    )
    .map((line) => line.itemId);
}
