import { sql, type SQL } from 'drizzle-orm';

/**
 * One ORDER BY, built from a per-report whitelist.
 *
 * Three report sources grew their own copy of this and four others wrote
 * `sort === 'x' ? … : sort === 'y' ? …` chains instead. The chains were where
 * columns went missing: a column can declare `sortField` in the catalogue and
 * have no arm in the chain, and then the header shows a sort arrow, the click
 * changes the URL, and the rows come back in exactly the order they were in.
 * A map cannot half-implement a field -- it is present or it is not -- so
 * `sortableFields` on the source can report the truth, and
 * `report-sorting.test.ts` holds it against what the catalogue advertises.
 *
 * `sql.raw` is safe here because both halves come from constants: the caller's
 * own map and its own fallback. A term naming anything else is dropped.
 */
export type SortMap = Readonly<Record<string, string>>;

export function orderBy(sort: string | undefined, fields: SortMap, fallback: string, tiebreak?: string): SQL {
  if (sort !== undefined) {
    const descending = sort.startsWith('-');
    const field = descending ? sort.slice(1) : sort;
    /*
     * `Object.hasOwn`, not a bare lookup: `fields` is an object literal, so a
     * field named "constructor" resolves up the prototype chain to a function
     * that would stringify straight into the ORDER BY.
     */
    if (Object.hasOwn(fields, field)) {
      const column = fields[field];
      if (column !== undefined) {
        const direction = descending ? 'DESC' : 'ASC';
        // Without a total order one row can appear on two pages and another
        // on none, so a sort with ties carries the report's own tiebreak.
        return sql.raw(`${column} ${direction} NULLS LAST${tiebreak === undefined ? '' : `, ${tiebreak}`}`);
      }
    }
  }
  return sql.raw(fallback);
}
