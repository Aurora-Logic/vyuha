import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { renderWithProviders } from '@/test-support/render-shell';

import { CollapsibleSearch } from './collapsible-search';
import { FilterButton, FilterChips, FilterField, type FilterChip } from './filter-bar';

/**
 * The rule this whole change exists to enforce (owner, 1 Sep 2026): a control
 * costs its space whether or not it has anything to say, so a screen with
 * nothing filtered should carry no filter furniture. These pin that — the
 * toolbar starts as buttons, and the chips only exist once something is set.
 */

function Search() {
  const [value, setValue] = useState('');
  return (
    <CollapsibleSearch
      id="s"
      label="Search tasks"
      value={value}
      onValueChange={setValue}
      placeholder="Title or notes"
    />
  );
}

describe('CollapsibleSearch', () => {
  it('is a button until somebody wants it, then a field with the caret in it', async () => {
    renderWithProviders(<Search />);
    expect(screen.queryByRole('searchbox')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Search tasks' }));

    const field = screen.getByRole('searchbox', { name: 'Search tasks' });
    expect(field).toBeTruthy();
    // Revealing a field without focusing it makes the click worth nothing.
    expect(document.activeElement).toBe(field);
  });

  it('stays open while it holds a term, so the page never filters invisibly', async () => {
    renderWithProviders(<Search />);
    await userEvent.click(screen.getByRole('button', { name: 'Search tasks' }));
    await userEvent.type(screen.getByRole('searchbox'), 'busbar');

    // Blur it: a field that is filtering the page must not collapse and hide
    // the reason the list looks the way it does.
    await userEvent.tab();
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('collapses again when it is emptied and left', async () => {
    renderWithProviders(
      <>
        <Search />
        <Button variant="ghost">elsewhere</Button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Search tasks' }));
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('opens by itself for a term that arrived without a click', () => {
    // A saved view carrying ?q= must not filter behind a closed box.
    renderWithProviders(
      <CollapsibleSearch id="s" label="Search tasks" value="busbar" onValueChange={() => {}} placeholder="x" />,
    );
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });
});

describe('FilterChips', () => {
  it('renders nothing at all when nothing is filtered', () => {
    const { container } = renderWithProviders(<FilterChips chips={[]} />);
    expect(container.textContent).toBe('');
  });

  it('names both halves, because a bare value has no subject', () => {
    const chips: FilterChip[] = [{ key: 'p', label: 'Priority', value: 'High', onClear: () => {} }];
    renderWithProviders(<FilterChips chips={chips} />);
    expect(screen.getByText('Priority:')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
  });

  it('clears the one it was asked to clear', async () => {
    const onClear = vi.fn();
    renderWithProviders(
      <FilterChips
        chips={[
          { key: 'p', label: 'Priority', value: 'High', onClear },
          { key: 'd', label: 'Due', value: 'Overdue', onClear: () => {} },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clear the priority filter' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('FilterButton', () => {
  it('says how many are set, and offers no "clear all" when none are', async () => {
    renderWithProviders(
      <FilterButton active={0} onClearAll={() => {}}>
        <FilterField label="Priority">
          <span>controls</span>
        </FilterField>
      </FilterButton>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByText('controls')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('counts what is set and clears the lot on request', async () => {
    const onClearAll = vi.fn();
    renderWithProviders(
      <FilterButton active={2} onClearAll={onClearAll}>
        <FilterField label="Priority">
          <span>controls</span>
        </FilterField>
      </FilterButton>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filters, 2 set' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
