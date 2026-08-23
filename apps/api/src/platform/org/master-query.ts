import { type SortTerm } from '@vyuha/shared';
import { asc, desc, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * The two things every master list does: order by a whitelisted column and
 * filter on a typed-in term. Departments, designations and locations share
 * them because they are the same list with different columns -- three copies
 * would be three chances to forget the escaping below.
 */

/**
 * The id tiebreak makes paging deterministic. Without it two rows with the
 * same name can swap places between requests, which shows up as a row that
 * appears on two pages while another never appears at all.
 */
export function masterOrderBy(
  sort: readonly SortTerm[],
  columns: Readonly<Record<string, PgColumn>>,
  fallback: PgColumn,
  id: PgColumn,
): (SQL | PgColumn)[] {
  const clauses: (SQL | PgColumn)[] = [];
  for (const term of sort) {
    const column = columns[term.field];
    if (column === undefined) continue;
    clauses.push(term.direction === 'desc' ? desc(column) : asc(column));
  }
  if (clauses.length === 0) clauses.push(asc(fallback));
  clauses.push(asc(id));
  return clauses;
}

/**
 * What somebody typed, against what is stored, forgivingly.
 *
 * A plain `ILIKE '%term%'` demands the separators be right. Searching an item
 * called "MCCB 100A 3P 36kA" only worked if you reproduced its spacing, so
 * "mccb100a" found nothing, "cat-6" found nothing against "CAT6", and typing
 * "100A MCCB" -- the way somebody actually thinks of it -- found nothing at
 * all. That is a search that only helps people who already know the answer.
 *
 * Two rules fix it, and they compose:
 *
 * **Every word must appear, in any order.** The term is split on whitespace
 * and the words are ANDed, so "100a mccb" and "mccb 100a" find the same row
 * and a stray double space changes nothing.
 *
 * **A word matches loosely or exactly.** Each word tries a plain contains
 * first, then a contains against both sides stripped of everything that is not
 * a letter or a digit. The stripped form is what lets "cat6" find "CAT-6" and
 * "mccb100a" find "MCCB 100A".
 *
 * The plain branch is kept rather than replaced because it is the one an index
 * can serve; the stripped branch cannot be, since it is a function of the
 * column. On master tables -- parties, items, departments, shifts -- that is
 * a scan over hundreds of rows and costs nothing measurable. If this is ever
 * pointed at a table with millions, the stripped form wants its own expression
 * index rather than this being made cleverer.
 */

/** Everything that is not a letter or a digit, which is what separators are. */
const SEPARATORS = /[^a-z0-9]/gu;

export function masterSearch(term: string, columns: readonly PgColumn[]): SQL {
  const escape = (value: string): string => value.replace(/([\\%_])/gu, '\\$1');

  const words = term.trim().split(/\s+/u).filter((word) => word !== '');
  // An empty term is not a filter. Returning a true predicate keeps the caller
  // from having to special-case it, and matches what `%%` used to do.
  if (words.length === 0) return sql`true`;

  const perWord = words.map((word) => {
    const plain = `%${escape(word)}%`;
    const stripped = word.toLowerCase().replace(SEPARATORS, '');

    const branches = columns.flatMap((column) => {
      const loose =
        stripped === ''
          ? []
          : [
              sql`regexp_replace(lower(${column}), '[^a-z0-9]', '', 'g') LIKE ${`%${escape(stripped)}%`}`,
            ];
      return [sql`${column} ILIKE ${plain}`, ...loose];
    });

    return sql`(${sql.join(branches, sql` OR `)})`;
  });

  // AND across words, OR across columns within a word: "asha nashik" finds a
  // party named Asha in an address in Nashik, which is the useful reading.
  return sql`(${sql.join(perWord, sql` AND `)})`;
}
