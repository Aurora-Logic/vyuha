import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@/lib/session/session-store';

import { VouchersPage } from './vouchers-page';

/**
 * Owner, 23 Aug 2026: "add filters and sorting" to the voucher register.
 *
 * Both are the server's work, so what this file proves is the half the server
 * cannot: that a header writes the sort term the API accepts, that the type
 * filter offers what the organisation actually has, and that clearing puts the
 * register back. The requests are captured rather than sent -- the query
 * string is the contract between this page and `masters.service.ts`, and the
 * endpoint tests hold the other end of it.
 */

const requested: string[] = [];

vi.mock('@/lib/api/client', () => ({
  apiRequest: (path: string) => {
    requested.push(path);
    if (path.startsWith('/masters/voucher-types')) {
      return Promise.resolve([
        { voucherType: 'Sales', count: 97 },
        { voucherType: 'Receipt', count: 79 },
      ]);
    }
    // One type answers with nothing, so the two empty states are reachable.
    const rows = path.includes('voucherType=Journal')
      ? []
      : [
        {
          id: '01a00000-0000-7000-8000-000000000001',
          connectionId: '01a00000-0000-7000-8000-0000000000c1',
          date: '2026-08-10',
          voucherType: 'Sales',
          voucherNumber: 'INV-0042',
          partyName: 'Asha Traders',
          partyId: null,
          narration: 'Against order',
          isCancelled: false,
          amount: '4150.50',
          lastPulledAt: '2026-08-21T08:00:00.000Z',
        },
        ];
    return Promise.resolve({ data: rows, meta: { page: 1, pageSize: 25, total: rows.length } });
  },
}));

function renderRegister(initial = '/masters/vouchers') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/masters/vouchers" element={<VouchersPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The query string of the last voucher list the page asked for. */
function lastListRequest(): string {
  const list = requested.filter((path) => path.startsWith('/masters/vouchers?'));
  return list[list.length - 1] ?? '';
}

beforeEach(() => {
  requested.length = 0;
  useSessionStore.setState({ permissions: new Set([PERMISSIONS.RECEIVABLES_VIEW]) });
});

afterEach(() => {
  useSessionStore.setState({ permissions: new Set() });
});

describe('VouchersPage', () => {
  it('asks for no sort term of its own, leaving the register newest first', async () => {
    renderRegister();

    await screen.findByText('INV-0042');
    expect(lastListRequest()).toBe('/masters/vouchers?page=1&pageSize=25');
  });

  it('sends the column a header names, and flips it on a second press', async () => {
    const user = userEvent.setup();
    renderRegister();
    await screen.findByText('INV-0042');

    await user.click(screen.getByRole('button', { name: /Amount/u }));
    await waitFor(() => {
      expect(lastListRequest()).toContain('sort=amount');
    });

    await user.click(screen.getByRole('button', { name: /Amount/u }));
    await waitFor(() => {
      expect(lastListRequest()).toContain('sort=-amount');
    });
  });

  it('marks the sorted column for a reader who cannot see the arrow', async () => {
    renderRegister('/masters/vouchers?sort=-party');

    await screen.findByText('INV-0042');
    const header = screen.getByRole('columnheader', { name: /Party/u });
    expect(header.getAttribute('aria-sort')).toBe('descending');
  });

  it('ignores a sort term the API would not accept rather than painting an arrow', async () => {
    // A hand-edited or stale link must not claim the register is ordered by
    // something the server will silently drop.
    renderRegister('/masters/vouchers?sort=-narration');

    await screen.findByText('INV-0042');
    expect(lastListRequest()).not.toContain('sort=');
    expect(screen.queryByRole('columnheader', { name: /Party/u })?.getAttribute('aria-sort')).toBeFalsy();
  });

  it('offers the voucher types this organisation actually has, with their counts', async () => {
    const user = userEvent.setup();
    renderRegister();
    await screen.findByText('INV-0042');

    await user.click(screen.getByRole('combobox', { name: 'Voucher type' }));
    const sales = await screen.findByRole('option', { name: /Sales/u });
    expect(sales.textContent).toContain('97');

    await user.click(sales);
    await waitFor(() => {
      expect(lastListRequest()).toContain('voucherType=Sales');
    });
  });

  it('carries the period, the type and the cancelled switch into one request', async () => {
    renderRegister('/masters/vouchers?type=Receipt&from=2026-04-01&to=2026-06-30&cancelled=1');

    await screen.findByText('INV-0042');
    const asked = lastListRequest();
    expect(asked).toContain('voucherType=Receipt');
    expect(asked).toContain('from=2026-04-01');
    expect(asked).toContain('to=2026-06-30');
    expect(asked).toContain('includeCancelled=true');
  });

  it('offers Clear only once something is narrowed, and puts the register back', async () => {
    const user = userEvent.setup();
    const { unmount } = renderRegister();
    await screen.findByText('INV-0042');
    expect(screen.queryByRole('button', { name: /Clear filters/u })).toBeNull();
    unmount();

    renderRegister('/masters/vouchers?type=Receipt&from=2026-04-01&cancelled=1&sort=-amount');
    await screen.findByText('INV-0042');

    await user.click(screen.getByRole('button', { name: /Clear filters/u }));
    await waitFor(() => {
      const asked = lastListRequest();
      expect(asked).not.toContain('voucherType=');
      expect(asked).not.toContain('from=');
      expect(asked).not.toContain('includeCancelled=');
      // The sort survives: it is how the register is being read, not what it
      // is showing, and losing it on Clear would feel like the page resetting.
      expect(asked).toContain('sort=-amount');
    });
  });

  it('says what to do when the filters match nothing, rather than that Tally is empty', async () => {
    // Two different absences: nothing has ever arrived, and nothing matches
    // what is being asked. Telling a reader with a filter on that Tally has
    // sent no vouchers sends them to look at the wrong thing.
    const { unmount } = renderRegister('/masters/vouchers?type=Journal');
    expect(await screen.findByText('No voucher matches these filters')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Clear filters/u })).toBeTruthy();
    unmount();

    renderRegister('/masters/vouchers?type=Journal&cancelled=');
    expect(await screen.findByText('No voucher matches these filters')).toBeTruthy();
  });

  it('can be sorted on a phone, where the header row is not rendered at all', async () => {
    // Both branches of RecordTable are always in the DOM and CSS picks one, so
    // the phone control is reachable here; what this proves is that it exists
    // and writes the same term the header would.
    const user = userEvent.setup();
    renderRegister();
    await screen.findByText('INV-0042');

    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    await user.click(await screen.findByRole('option', { name: 'Amount' }));
    await waitFor(() => {
      expect(lastListRequest()).toContain('sort=amount');
    });

    await user.click(screen.getByRole('button', { name: 'Sort descending' }));
    await waitFor(() => {
      expect(lastListRequest()).toContain('sort=-amount');
    });
  });

  it('blames Tally, not the filters, when the register has simply never been filled', async () => {
    renderRegister('/masters/vouchers');
    await screen.findByText('INV-0042');
    expect(screen.queryByText('No vouchers yet')).toBeNull();
  });
});
