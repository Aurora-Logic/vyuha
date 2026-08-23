import { sql, type SQL } from 'drizzle-orm';

/**
 * A document that counts: neither a draft nor a cancellation.
 *
 * Every figure on the lifecycle and analytics screens excluded drafts and let
 * cancellations through, so a customer who ordered once and cancelled it read
 * as a customer with an order and an ordered value, a cancelled order with
 * nothing dispatched read as still open, and an item's ordered quantity
 * carried goods nobody ever bought. The rule lives here so the two screens
 * cannot answer the same question differently.
 *
 * `alias` is the table alias in the query, and is always a literal written at
 * the call site -- never anything a request supplies.
 */
export function live(alias: string): SQL {
  return sql`${sql.raw(alias)}.status NOT IN ('DRAFT', 'CANCELLED')`;
}
