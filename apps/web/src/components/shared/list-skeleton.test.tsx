import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ListSkeleton } from './list-skeleton';

// One loading pattern for every register (CLAUDE.md §3.4). The region is a
// named, busy status so a screen reader hears what is loading and nothing
// else; the rows are decoration and stay out of the accessibility tree.
describe('ListSkeleton', () => {
  it('is a busy status region named for what is loading', () => {
    render(<ListSkeleton label="Loading roles" />);
    const status = screen.getByRole('status', { name: 'Loading roles' });
    expect(status.getAttribute('aria-busy')).toBe('true');
  });

  it('draws as many rows as asked, each hidden from assistive technology', () => {
    render(<ListSkeleton rows={7} />);
    const rows = Array.from(
      screen.getByRole('status').querySelectorAll('[data-slot="list-skeleton-row"]'),
    );
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('adds one heading line above the rows only when asked', () => {
    const { rerender } = render(<ListSkeleton rows={2} />);
    expect(screen.getByRole('status').querySelector('[data-slot="list-skeleton-heading"]')).toBeNull();

    rerender(<ListSkeleton rows={2} heading />);
    const status = screen.getByRole('status');
    expect(status.querySelector('[data-slot="list-skeleton-heading"]')).not.toBeNull();
    expect(status.querySelectorAll('[data-slot="list-skeleton-row"]')).toHaveLength(2);
  });
});
