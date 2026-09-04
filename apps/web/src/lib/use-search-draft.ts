import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The search box on a register: a local draft that writes itself into the URL
 * 300ms after typing stops, and follows the URL back when something else
 * changes it -- a cleared filter, or Back.
 *
 * The sync back matters because Go To can navigate to a register that is
 * already mounted, carrying a fresh ?q. A draft that ignored that would
 * debounce the incoming filter straight back out of the URL.
 *
 * Sixteen registers hand-rolled this before it lived here, which is how one
 * screen gets a flush fix and the other fifteen keep the bug. Same reasoning
 * as `useDebouncedValue`, one level up.
 */
export function useSearchDraft(param = 'q'): readonly [string, (value: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const committed = searchParams.get(param) ?? '';

  const [draft, setDraft] = useState(committed);
  const [synced, setSynced] = useState(committed);
  if (synced !== committed) {
    setSynced(committed);
    if (draft.trim() !== committed) setDraft(committed);
  }

  useEffect(() => {
    if (draft.trim() === committed) return undefined;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          const value = draft.trim();
          if (value) next.set(param, value);
          else next.delete(param);
          // Narrowing the list invalidates the page number: page 4 of three
          // pages of results is an empty screen that looks like no matches.
          next.delete('page');
          return next;
        },
        // Replace, so Back leaves the search rather than walking backwards
        // through every prefix that was typed to reach it.
        { replace: true },
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, committed, param, setSearchParams]);

  return [draft, setDraft] as const;
}
