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

/**
 * How close a mistyped word has to be before it counts as the same word.
 *
 * Measured against this catalogue rather than picked from a blog: "acem"
 * scores 0.400 against "Acme Trading Co", "ashaa" 0.667 against "Asha
 * Traders", "bharrat" 0.667 against "Bharat Cables" -- and "zzz" scores 0.000
 * against all of them, which is the number that matters. 0.35 sits under
 * every real typo above and well over the noise.
 */
const FUZZY_THRESHOLD = 0.35;

/** Below this a typo is indistinguishable from a different word. */
const FUZZY_MIN_LENGTH = 4;

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
      // A mistyped word still finds its row (owner: "acem" should find
      // "Acme"). `word_similarity` compares the term against the closest word
      // in the value rather than the whole string, which is what makes it work
      // on "Acme Trading Co" -- plain `similarity` against the full name
      // scores 0.19 there and would never fire.
      //
      // Only from four characters up. Below that a typo is indistinguishable
      // from a different word, and "ac" would fuzzily match most of the book.
      const fuzzy =
        word.length < FUZZY_MIN_LENGTH
          ? []
          : [sql`word_similarity(${word.toLowerCase()}, lower(${column})) >= ${FUZZY_THRESHOLD}`];
      return [sql`${column} ILIKE ${plain}`, ...loose, ...fuzzy];
    });

    return sql`(${sql.join(branches, sql` OR `)})`;
  });

  // AND across words, OR across columns within a word: "asha nashik" finds a
  // party named Asha in an address in Nashik, which is the useful reading.
  return sql`(${sql.join(perWord, sql` AND `)})`;
}

/**
 * Where the match landed, as a number to sort by.
 *
 * `masterSearch` is deliberately forgiving, and that is what made the list
 * unreadable: typing "C" to find "C&S Electric" matched every party with a
 * "c" anywhere in it -- Acme, Ambad MIDC, Bharat Cables -- and then ordered
 * the lot alphabetically, so the row the person was typing towards sat fourth
 * behind three they were not. A forgiving filter needs an opinionated order,
 * or it is just a longer list.
 *
 * Five tiers, best first: the whole name, then the name starting with the
 * term, then a word inside it starting with the term, then the term anywhere,
 * then matched only once the separators were stripped out. The caller keeps
 * its own sort after this, so equally-relevant rows stay alphabetical and
 * paging stays deterministic.
 *
 * The term is used whole rather than per word: somebody typing "c&s el" means
 * those characters in that order, and the AND-across-words rule in
 * `masterSearch` has already decided what matches at all. This only decides
 * what comes first.
 */
export function masterRelevance(term: string, column: PgColumn | SQL): SQL | undefined {
  const trimmed = term.trim();
  if (trimmed === '') return undefined;

  const escape = (value: string): string => value.replace(/([\\%_])/gu, '\\$1');
  const lower = trimmed.toLowerCase();
  const plain = escape(lower);
  const stripped = escape(lower.replace(SEPARATORS, ''));

  return sql`CASE
    WHEN lower(${column}) = ${lower} THEN 0
    WHEN lower(${column}) LIKE ${`${plain}%`} THEN 1
    WHEN lower(${column}) LIKE ${`% ${plain}%`} THEN 2
    WHEN lower(${column}) LIKE ${`%${plain}%`} THEN 3
    WHEN ${stripped} <> '' AND regexp_replace(lower(${column}), '[^a-z0-9]', '', 'g') LIKE ${`${stripped}%`} THEN 4
    ELSE 5
  END`;
}

/**
 * The caller's ordering, with relevance in front of it when a term was typed.
 *
 * Kept as its own step rather than folded into `masterOrderBy` so that an
 * unfiltered list is byte-for-byte the query it always was: no term, no CASE,
 * nothing for the planner to think about on the screens that page through
 * everything.
 */
export function withRelevance(
  term: string | undefined,
  column: PgColumn | SQL,
  order: (SQL | PgColumn)[],
): (SQL | PgColumn)[] {
  const relevance = term === undefined ? undefined : masterRelevance(term, column);
  return relevance === undefined ? order : [relevance, ...order];
}
