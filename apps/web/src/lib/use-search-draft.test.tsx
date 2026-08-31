import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSearchDraft } from './use-search-draft';

/**
 * Nine registers shared one hand-rolled copy of this and none of them had a
 * test. What matters is the timing and the page reset: writing on every
 * keystroke floods the query, and keeping `page` strands the reader on an
 * empty page 4 of a three-page result.
 */

function setup(initial: string) {
  return renderHook(
    () => {
      const [params, setParams] = useSearchParams();
      const [draft, setDraft] = useSearchDraft();
      return { draft, setDraft, params, setParams };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
      ),
    },
  );
}

describe('useSearchDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the keystroke back for 300ms, then writes it and drops the page', () => {
    const { result } = setup('/orders?page=4');

    act(() => {
      result.current.setDraft('bolt');
    });
    expect(result.current.params.get('q')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current.params.get('q')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.params.get('q')).toBe('bolt');
    expect(result.current.params.get('page')).toBeNull();
  });

  it('removes the parameter when the box is cleared rather than writing an empty one', () => {
    const { result } = setup('/orders?q=bolt');

    act(() => {
      result.current.setDraft('   ');
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.params.has('q')).toBe(false);
  });

  it('follows the URL when something else changes it', () => {
    const { result } = setup('/orders?q=bolt');
    expect(result.current.draft).toBe('bolt');

    act(() => {
      result.current.setParams(new URLSearchParams());
    });
    expect(result.current.draft).toBe('');
  });
});
