import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { EmployeePicker } from './employee-picker';
import type { RosterCandidate } from './types';

/**
 * The roster and record-attendance combobox held 200 people and filtered them
 * in the browser. It now takes whatever the server returned for the term the
 * parent is holding, which means `shouldFilter` has to be off — and a picker
 * that silently filtered twice would drop every row the server matched on a
 * field the local filter cannot see.
 */

/** The row renders the code and the name in separate nodes, so read the whole option. */
function optionText(): string[] {
  return screen.getAllByRole('option').map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

function candidate(id: string, name: string, employeeCode: string): RosterCandidate {
  return { id, name, employeeCode, department: null };
}

describe('EmployeePicker', () => {
  it('shows what the server returned rather than filtering it again', async () => {
    const onSearchChange = vi.fn();
    // The term matches neither the code nor the name — only the department,
    // which cmdk's own filter cannot see. So this row is on screen if and only
    // if the local filter is genuinely off.
    renderWithProviders(
      <EmployeePicker
        value={null}
        onValueChange={() => {}}
        candidates={[{ id: 'e-900', name: 'Meera Iyer', employeeCode: 'GC-0912', department: 'Nashik' }]}
        search="nashik"
        onSearchChange={onSearchChange}
        label="Employee"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Employee' }));
    await waitFor(() => {
      expect(optionText()).toEqual(['GC-0912 — Meera IyerNashik']);
    });
  });

  it('reports what was typed so the parent can ask the server for it', async () => {
    const onSearchChange = vi.fn();
    renderWithProviders(
      <EmployeePicker
        value={null}
        onValueChange={() => {}}
        candidates={[]}
        search=""
        onSearchChange={onSearchChange}
        label="Employee"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Employee' }));
    await userEvent.type(await screen.findByPlaceholderText('Search by code or name'), 'm');
    expect(onSearchChange).toHaveBeenCalledWith('m');
  });

  it('keeps the chosen person visible once the search page no longer holds them', async () => {
    const chosen = candidate('e-900', 'Meera Iyer', 'GC-0912');
    renderWithProviders(
      <EmployeePicker
        value={chosen}
        onValueChange={() => {}}
        candidates={[candidate('e-1', 'Ravi Kumar', 'GC-0001')]}
        search="ravi"
        onSearchChange={() => {}}
        label="Employee"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Employee' }));
    await waitFor(() => {
      expect(optionText()).toEqual(['GC-0912 — Meera Iyer', 'GC-0001 — Ravi Kumar']);
    });
  });

  it('still filters locally for a caller that has the whole list in hand', async () => {
    renderWithProviders(
      <EmployeePicker
        value={null}
        onValueChange={() => {}}
        candidates={[candidate('e-1', 'Ravi Kumar', 'GC-0001'), candidate('e-2', 'Meera Iyer', 'GC-0912')]}
        label="Employee"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Employee' }));
    await userEvent.type(await screen.findByPlaceholderText('Search by code or name'), 'ravi');
    await waitFor(() => {
      expect(optionText()).toEqual(['GC-0001 — Ravi Kumar']);
    });
  });
});
