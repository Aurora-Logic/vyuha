import { RATE_SOURCE_LABELS, type PriceBasis, type RateResolution, type RateSource } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import type { Database } from '../db/db.provider.js';

/** A database or a transaction: both execute SQL, and the sales repository resolves inside its own transaction. */
export type Executor = Pick<Database, 'execute'>;

/**
 * 15 REQ-AN-13/14: the rate for one line, at the document's date.
 *
 * First match wins: the party's own list, then its group's, then the
 * default, then the item's rate in Tally. Within a list an item line beats
 * an item-group line, and within either the narrowest quantity slab that
 * holds the quantity. The date decides which version of a lineage was in
 * force -- active from `effective_from` until it was superseded or
 * expired -- so a document from a year ago resolves against the list of a
 * year ago (REQ-AN-07).
 *
 * A plain function over a database handle rather than a service: the sales
 * repository calls it inside its own transaction when it writes a line, and
 * the simulator calls it from the controller with the same arguments, so
 * the two cannot disagree.
 */

export interface ResolveRateInput {
  readonly partyId: string | null;
  readonly stockItemId: string;
  readonly quantity: string;
  /** YYYY-MM-DD; the document's date. */
  readonly date: string;
}

interface ListRow {
  id: string;
  name: string;
  version: number;
  source: RateSource;
}

// A type alias, not an interface: execute<T> wants a Record, which an interface does not satisfy.
type LineRow = {
  id: string;
  stock_item_id: string | null;
  item_group: string | null;
  basis: PriceBasis;
  rate: string | null;
  discount_pct: string | null;
  min_qty: string | null;
  max_qty: string | null;
};

export interface ResolvedList extends ListRow {
  readonly applied: boolean;
  readonly why: string;
}

export interface ResolveRateResult extends RateResolution {
  readonly considered: readonly ResolvedList[];
  readonly partyName: string | null;
  readonly partyGroup: string | null;
  readonly itemName: string | null;
  readonly itemGroup: string | null;
}

function money(value: number): string {
  return value.toFixed(2);
}

/**
 * The lists that governed a party on a date, in resolution order. A version's
 * reign runs from its effective date -- or, for a version that replaced an
 * earlier one, from the day it was approved -- until it was superseded or
 * expired, so a date inside an old version's reign still finds it.
 */
async function listsFor(db: Executor, orgId: string, partyId: string | null, partyGroup: string | null, date: string): Promise<ListRow[]> {
  const rows = await db.execute<{ id: string; name: string; version: number; source: RateSource; rank: number }>(sql`
    SELECT l.id, l.name, l.version,
           CASE WHEN a.party_id IS NOT NULL THEN 'party' WHEN a.party_group IS NOT NULL THEN 'party_group' ELSE 'default' END AS source,
           CASE WHEN a.party_id IS NOT NULL THEN 1 WHEN a.party_group IS NOT NULL THEN 2 ELSE 3 END AS rank
      FROM price_lists l
      JOIN price_list_assignments a ON a.price_list_id = l.id
     WHERE l.org_id = ${orgId} AND l.deleted_at IS NULL
       AND l.state IN ('active', 'superseded', 'expired')
       AND l.effective_from <= ${date}::date
       AND (l.effective_to IS NULL OR l.effective_to >= ${date}::date)
       AND (l.superseded_at IS NULL OR l.superseded_at::date > ${date}::date)
       AND (l.supersedes_id IS NULL OR l.approved_at IS NULL OR l.approved_at::date <= ${date}::date)
       AND (
            (a.party_id IS NOT NULL AND a.party_id = ${partyId})
         OR (a.party_group IS NOT NULL AND a.party_group = ${partyGroup})
         OR a.is_default
       )
     ORDER BY rank, l.version DESC, l.effective_from DESC
  `);
  // One entry per lineage rank: the newest version in force at the date.
  const seen = new Set<string>();
  const out: ListRow[] = [];
  for (const row of rows.rows) {
    if (seen.has(row.source)) continue;
    seen.add(row.source);
    out.push({ id: row.id, name: row.name, version: row.version, source: row.source });
  }
  return out;
}

function slabHolds(line: LineRow, quantity: number): boolean {
  const min = line.min_qty === null ? null : Number(line.min_qty);
  const max = line.max_qty === null ? null : Number(line.max_qty);
  return (min === null || quantity >= min) && (max === null || quantity <= max);
}

/** The narrowest slab wins; an unbounded one is widest. */
function slabWidth(line: LineRow): number {
  const min = line.min_qty === null ? 0 : Number(line.min_qty);
  const max = line.max_qty === null ? Number.POSITIVE_INFINITY : Number(line.max_qty);
  return max - min;
}

function pickLine(lines: readonly LineRow[], stockItemId: string, itemGroup: string | null, quantity: number): { line: LineRow; matchedBy: 'item' | 'item_group' } | null {
  const byItem = lines.filter((l) => l.stock_item_id === stockItemId && slabHolds(l, quantity)).sort((a, b) => slabWidth(a) - slabWidth(b));
  if (byItem[0] !== undefined) return { line: byItem[0], matchedBy: 'item' };
  const byGroup = lines.filter((l) => l.stock_item_id === null && l.item_group !== null && l.item_group === itemGroup && slabHolds(l, quantity)).sort((a, b) => slabWidth(a) - slabWidth(b));
  if (byGroup[0] !== undefined) return { line: byGroup[0], matchedBy: 'item_group' };
  return null;
}

function rateOf(line: LineRow, tallyRate: number | null): number | null {
  const discount = line.discount_pct === null ? 0 : Number(line.discount_pct);
  if (line.basis === 'rate') return Number(line.rate);
  if (line.basis === 'both') return Number(line.rate) * (1 - discount / 100);
  // discount_pct: a percentage off the Tally rate; without a Tally rate there is nothing to discount.
  return tallyRate === null ? null : tallyRate * (1 - discount / 100);
}

export async function resolveRate(db: Executor, orgId: string, input: ResolveRateInput): Promise<ResolveRateResult> {
  const [party, item] = await Promise.all([
    input.partyId === null
      ? Promise.resolve(null)
      : db.execute<{ name: string; parent_group: string }>(sql`SELECT name, parent_group FROM parties WHERE org_id = ${orgId} AND id = ${input.partyId}`).then((r) => r.rows[0] ?? null),
    db.execute<{ name: string; parent_group: string; sale_price: string | null }>(sql`SELECT name, parent_group, sale_price FROM stock_items WHERE org_id = ${orgId} AND id = ${input.stockItemId}`).then((r) => r.rows[0] ?? null),
  ]);
  const tallyRate = item?.sale_price === null || item?.sale_price === undefined ? null : Number(item.sale_price);
  const quantity = Number(input.quantity);
  const lists = await listsFor(db, orgId, input.partyId, party?.parent_group ?? null, input.date);
  const considered: ResolvedList[] = [];
  let resolved: RateResolution | null = null;

  for (const list of lists) {
    if (resolved !== null) {
      considered.push({ ...list, applied: false, why: 'A list earlier in the order already resolved the rate.' });
      continue;
    }
    const lines = await db
      .execute<LineRow>(sql`SELECT id, stock_item_id, item_group, basis, rate::text, discount_pct::text, min_qty::text, max_qty::text FROM price_list_lines WHERE price_list_id = ${list.id}`)
      .then((r) => r.rows);
    const pick = pickLine(lines, input.stockItemId, item?.parent_group ?? null, quantity);
    if (pick === null) {
      considered.push({ ...list, applied: false, why: `No line for this item${item ? ` or its group ${item.parent_group}` : ''} at quantity ${input.quantity}.` });
      continue;
    }
    const rate = rateOf(pick.line, tallyRate);
    if (rate === null) {
      considered.push({ ...list, applied: false, why: 'The line is a percentage off the Tally rate, and the item has no Tally rate.' });
      continue;
    }
    const slab = pick.line.min_qty === null && pick.line.max_qty === null ? null : { minQty: pick.line.min_qty, maxQty: pick.line.max_qty };
    const how =
      pick.line.basis === 'rate'
        ? `a fixed rate of ${money(Number(pick.line.rate))}`
        : pick.line.basis === 'both'
          ? `${money(Number(pick.line.rate))} less ${String(Number(pick.line.discount_pct))}%`
          : `${String(Number(pick.line.discount_pct))}% off the Tally rate of ${money(tallyRate ?? 0)}`;
    resolved = {
      rate: money(rate),
      source: list.source,
      priceListId: list.id,
      priceListVersion: list.version,
      priceListName: list.name,
      basis: pick.line.basis,
      listRate: pick.line.rate === null ? null : money(Number(pick.line.rate)),
      discountPct: pick.line.discount_pct === null ? null : String(Number(pick.line.discount_pct)),
      slab,
      matchedBy: pick.matchedBy,
      tallyRate: tallyRate === null ? null : money(tallyRate),
      explanation: `${RATE_SOURCE_LABELS[list.source]} (${list.name} v${String(list.version)}) gives ${money(rate)}: ${how}, matched by ${pick.matchedBy === 'item' ? 'the item' : `the item group ${item?.parent_group ?? ''}`}${slab ? ` for quantities ${slab.minQty ?? '0'} to ${slab.maxQty ?? 'any'}` : ''}.`,
    };
    considered.push({ ...list, applied: true, why: resolved.explanation });
  }

  const fallback: RateResolution =
    tallyRate === null
      ? { rate: null, source: 'none', priceListId: null, priceListVersion: null, priceListName: null, basis: null, listRate: null, discountPct: null, slab: null, matchedBy: null, tallyRate: null, explanation: 'No price list names this item and Tally holds no rate for it.' }
      : { rate: money(tallyRate), source: 'tally', priceListId: null, priceListVersion: null, priceListName: null, basis: null, listRate: null, discountPct: null, slab: null, matchedBy: null, tallyRate: money(tallyRate), explanation: `No price list names this item; the rate is Tally's ${money(tallyRate)}.` };

  return {
    ...(resolved ?? fallback),
    considered,
    partyName: party?.name ?? null,
    partyGroup: party?.parent_group ?? null,
    itemName: item?.name ?? null,
    itemGroup: item?.parent_group ?? null,
  };
}
