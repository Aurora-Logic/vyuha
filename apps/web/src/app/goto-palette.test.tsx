import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';
import { useUiStore } from '@/lib/ui-store';

import { GoToPalette } from './goto-palette';

/**
 * REQ-O-05 at the component level: the palette lists every screen the account
 * may reach — including the Administration destinations REQ-O-02 moved out of
 * the sidebar, which had silently dropped out of Alt+G — and renders the
 * record answers the server sends, opening one on selection.
 *
 * The server is a mock here: who may find whom is the API suite's business
 * (`go-to.endpoints.test.ts`). What this file holds still is the client's own
 * contract — what it asks, what it renders, where selection navigates.
 */

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiRequest: apiRequestMock,
}));

function openPalette() {
  useUiStore.getState().setGotoOpen(true);
}

function renderPalette(role?: 'Admin' | 'Employee') {
  return renderWithProviders(
    <>
      <GoToPalette />
      <Routes>
        <Route path="/" element={null} />
        <Route path="/employees/:id" element={<div data-testid="employee-screen" />} />
        <Route path="/audit" element={<div data-testid="audit-screen" />} />
        <Route path="*" element={null} />
      </Routes>
    </>,
    role === undefined ? {} : { role },
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue({ query: '', records: [] });
  useUiStore.getState().setGotoOpen(false);
});

describe('GoToPalette', () => {
  it('lists a group label once even when two modules use it', async () => {
    renderPalette('Admin');
    openPalette();
    await screen.findByText('Audit log');

    // Attendance and CRM both call a group "People". Rendered twice under one
    // key, React kept a stale copy standing after a query emptied the list,
    // and the empty state never showed (the over-cap test below).
    expect(screen.getAllByText('People')).toHaveLength(1);
    expect(screen.getByText('Employees')).toBeTruthy();
    expect(screen.getByText('Contacts')).toBeTruthy();
  });

  it('lists Administration destinations for an account that may reach them', async () => {
    renderPalette('Admin');
    openPalette();

    expect(await screen.findByText('Audit log')).toBeTruthy();
    expect(screen.getByText('Approvals')).toBeTruthy();
    expect(screen.getByText('Recycle bin')).toBeTruthy();
    // Every module's screens, not only attendance's: the Masters module's
    // Parties entry vanished from this palette once already, the same way
    // the Administration screens had before it.
    expect(screen.getByText('Parties')).toBeTruthy();
    expect(screen.getByText('Stock items')).toBeTruthy();
    expect(screen.getByText('Price lists')).toBeTruthy();
  });

  it('hides what the account cannot reach', async () => {
    renderPalette('Employee');
    openPalette();

    expect(await screen.findByText('Punch')).toBeTruthy();
    expect(screen.queryByText('Audit log')).toBeNull();
    expect(screen.queryByText('Roles and permissions')).toBeNull();
  });

  it('asks the server once the query is long enough, and renders what it answers', async () => {
    apiRequestMock.mockImplementation((path: string) =>
      path.startsWith('/go-to')
        ? Promise.resolve({
            query: 'asha',
            records: [
              {
                type: 'employee',
                id: 'emp-1',
                title: 'Asha Menon',
                subtitle: 'VY-0003 · Design',
                code: 'VY-0003',
              },
              // A type this bundle has never heard of: dropped, not fatal.
              { type: 'starship', id: 's-1', title: 'Unroutable', subtitle: null, code: null },
            ],
          })
        : Promise.resolve({}),
    );

    renderPalette('Admin');
    openPalette();

    const input = await screen.findByPlaceholderText('Screen, report, or employee');
    await userEvent.type(input, 'asha');

    expect(await screen.findByText('Asha Menon')).toBeTruthy();
    expect(screen.getByText('VY-0003 · Design')).toBeTruthy();
    expect(screen.queryByText('Unroutable')).toBeNull();

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith(
        '/go-to?q=asha',
        expect.objectContaining({ signal: expect.anything() as AbortSignal }),
      );
    });
  });

  it('does not ask below the minimum query length', async () => {
    renderPalette('Admin');
    openPalette();

    const input = await screen.findByPlaceholderText('Screen, report, or employee');
    await userEvent.type(input, 'a');

    // The debounce is 250ms; give it room to have fired if it was going to.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('forgets the query when a selection closes it, so it does not reopen on stale results', async () => {
    apiRequestMock.mockResolvedValue({
      query: 'vy-0003',
      records: [{ type: 'employee', id: 'emp-1', title: 'Asha Menon', subtitle: 'VY-0003', code: 'VY-0003' }],
    });
    renderPalette('Admin');
    openPalette();
    const input = await screen.findByPlaceholderText('Screen, report, or employee');
    await userEvent.type(input, 'vy-0003');
    await userEvent.click(await screen.findByText('Asha Menon'));
    expect(useUiStore.getState().gotoOpen).toBe(false);

    openPalette();
    const reopened = await screen.findByPlaceholderText('Screen, report, or employee');
    expect((reopened as HTMLInputElement).value).toBe('');
    // The screen list is unfiltered again, not narrowed to the last term.
    expect(await screen.findByText('Audit log')).toBeTruthy();
  });

  it('settles on "nothing matches" for an over-cap query instead of searching forever', async () => {
    // The server echoes the capped query; the palette must compare its own
    // capped term against it, or the empty state never resolves.
    const long = 'x'.repeat(100);
    apiRequestMock.mockImplementation((path: string) =>
      path.startsWith('/go-to') ? Promise.resolve({ query: long.slice(0, 80), records: [] }) : Promise.resolve({}),
    );
    renderPalette('Admin');
    openPalette();
    const input = await screen.findByPlaceholderText('Screen, report, or employee');
    await userEvent.type(input, long);
    expect(await screen.findByText('Nothing matches that.', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('opens the employee a selected record names', async () => {
    apiRequestMock.mockResolvedValue({
      query: 'vy-0003',
      records: [
        {
          type: 'employee',
          id: 'emp-1',
          title: 'Asha Menon',
          subtitle: 'VY-0003',
          code: 'VY-0003',
        },
      ],
    });

    renderPalette('Admin');
    openPalette();

    const input = await screen.findByPlaceholderText('Screen, report, or employee');
    await userEvent.type(input, 'vy-0003');

    await userEvent.click(await screen.findByText('Asha Menon'));

    expect(await screen.findByTestId('employee-screen')).toBeTruthy();
    expect(useUiStore.getState().gotoOpen).toBe(false);
  });
});
