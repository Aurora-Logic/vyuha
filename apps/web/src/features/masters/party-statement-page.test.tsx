import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startOfMonth } from 'date-fns';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toApiDate } from '@/features/insights/period';
import { formatDate } from '@/lib/format';
import { fyStart } from '@/lib/period-compare';
import { renderWithProviders } from '@/test-support/render-shell';
import { DEFAULT_DOCUMENT_SETTINGS } from '@vyuha/shared';

import { PartyStatementPage } from './party-statement-page';
import type { PartyStatement } from './use-parties';

/**
 * Report 48: the statement screen's half of the contract with the API. The
 * server walks the ledger; what is proven here is that the page asks for
 * the financial year to date by default, that the one period control in
 * the toolbar rewrites the URL and the request together, and that the
 * receivables key gates it.
 */

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiRequest: vi.fn() };
});

const { apiRequest } = await import('@/lib/api/client');
const request = vi.mocked(apiRequest);
const requested: string[] = [];

afterEach(() => {
  request.mockReset();
  requested.length = 0;
});

const party: PartyStatement['party'] = {
  id: 'p1',
  connectionId: 'c1',
  name: 'Asha Traders',
  alias: null,
  parentGroup: 'Sundry Debtors',
  gstin: null,
  address: null,
  creditLimit: null,
  creditDays: null,
  openingBalance: '-10000',
  closingBalance: '-15440',
  absentInTally: false,
  lastPulledAt: '2026-09-01T00:00:00.000Z',
  manager: null,
  duplicate: null,
};

function statementFor(path: string): PartyStatement {
  const params = new URLSearchParams(path.split('?')[1] ?? '');
  return {
    party,
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    opening: { amount: '11000.00', side: 'Dr' },
    closing: { amount: '15440.00', side: 'Dr' },
    entries: [{ voucherId: 'v1', date: '2026-08-10', voucherType: 'Sales', voucherNumber: 'INV-A1', narration: '', side: 'Dr', sideSource: 'line', amount: '4440.00', balance: '15440.00', balanceSide: 'Dr' }],
    totals: { debit: '4440.00', credit: '0.00' },
    unplaced: 0,
    tallyClosing: '-15440.00',
    earliestVoucherDate: '2026-07-05',
    generatedAt: '2026-09-09T00:00:00.000Z',
  };
}

function answer() {
  request.mockImplementation((path: string) => {
    requested.push(path);
    if (path.startsWith('/masters/parties/p1/statement')) return Promise.resolve(statementFor(path));
    if (path.startsWith('/masters/parties/p1')) return Promise.resolve(party);
    if (path.startsWith('/documents/settings')) return Promise.resolve(DEFAULT_DOCUMENT_SETTINGS);
    if (path.startsWith('/settings/branding')) return Promise.resolve({ name: 'Acme', logoUrl: null, logoUrlExpiresInSeconds: null });
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
}

function renderPage(route = '/masters/parties/p1/statement', role: 'Admin' | 'Employee' = 'Admin') {
  return renderWithProviders(
    <Routes>
      <Route path="/masters/parties/:id/statement" element={<PartyStatementPage />} />
    </Routes>,
    { role, route },
  );
}

/** The period the page last asked the server for. */
function lastPeriod(): { from: string | null; to: string | null } {
  const last = requested.filter((path) => path.startsWith('/masters/parties/p1/statement')).at(-1) ?? '';
  const params = new URLSearchParams(last.split('?')[1] ?? '');
  return { from: params.get('from'), to: params.get('to') };
}

describe('PartyStatementPage', () => {
  it('refuses a role without receivables.view, asking the server for nothing', () => {
    answer();
    renderPage('/masters/parties/p1/statement', 'Employee');
    expect(screen.getByText('You cannot view statements')).toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('asks for the financial year to date, draws the ledger, and shows the period as one control', async () => {
    answer();
    renderPage();
    const today = toApiDate(new Date());

    const paper = await screen.findByRole('article', { name: /Statement of Account/u });
    expect(lastPeriod()).toEqual({ from: fyStart(today), to: today });
    expect(within(paper).getByText('Opening Balance')).toBeDefined();
    expect(within(paper).getByText('INV-A1')).toBeDefined();
    expect(within(paper).getByText(`${formatDate(fyStart(today))} to ${formatDate(today)}`)).toBeDefined();

    // One trigger, reading the whole range, no label jammed against the date.
    const trigger = screen.getByRole('button', { name: 'Statement period' });
    expect(trigger.textContent).toBe(`${formatDate(fyStart(today))} – ${formatDate(today)}`);
  });

  it('a preset rewrites the URL and the request together, and the PDF and Excel links follow it', async () => {
    answer();
    renderPage('/masters/parties/p1/statement?from=2026-04-01&to=2026-04-30');
    const user = userEvent.setup();
    await screen.findByRole('article', { name: /Statement of Account/u });
    expect(lastPeriod()).toEqual({ from: '2026-04-01', to: '2026-04-30' });

    await user.click(screen.getByRole('button', { name: 'Statement period' }));
    await user.click(screen.getByRole('button', { name: 'This month' }));

    const from = toApiDate(startOfMonth(new Date()));
    const to = toApiDate(new Date());
    await waitFor(() => {
      expect(lastPeriod()).toEqual({ from, to });
    });
    expect(screen.getByRole('button', { name: 'Statement period' }).textContent).toBe(`${formatDate(from)} – ${formatDate(to)}`);
    // The PDF verb is an anchor wearing the button role (it opens the print route in its own tab).
    expect(document.querySelector('a[href^="/print/statements/p1"]')?.getAttribute('href')).toBe(`/print/statements/p1?from=${from}&to=${to}`);
  });
});
