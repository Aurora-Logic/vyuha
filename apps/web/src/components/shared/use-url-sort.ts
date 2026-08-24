import { useSearchParams } from 'react-router';

import type { RecordSort } from './record-table';

/**
 * The `?sort=` term a register carries, read and written the one way.
 *
 * A `RecordTable` header sorts by handing back a field and a direction; the
 * server takes a single term where a leading "-" means descending (the shape
 * `parseSort` expects, and what the vouchers register already wrote). This puts
 * both halves in the URL so the back button and a shared link keep the order,
 * and pages the register — so a header click starts again at page one rather
 * than sorting a single page of a larger set, which would read as wrong.
 *
 * `allowed` is the field list the server honours (e.g. `ESTIMATE_SORT_FIELDS`).
 * A hand-edited or stale term outside it paints no arrow and is not sent, so a
 * header never claims an order the API will ignore.
 */
export function useUrlSort(allowed: readonly string[]): {
  /** Pass to the data hook; undefined when there is no honoured term. */
  sort: string | undefined;
  /** Pass to `RecordTable`'s `sort`. */
  activeSort: RecordSort | null;
  /** Pass to `RecordTable`'s `onSortChange`. */
  onSortChange: (next: RecordSort) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('sort') ?? '';
  const field = raw.startsWith('-') ? raw.slice(1) : raw;
  const active = allowed.includes(field);
  return {
    sort: active ? raw : undefined,
    activeSort: active ? { field, descending: raw.startsWith('-') } : null,
    onSortChange: (next: RecordSort) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          params.set('sort', next.descending ? `-${next.field}` : next.field);
          params.delete('page');
          return params;
        },
        { replace: true },
      );
    },
  };
}
