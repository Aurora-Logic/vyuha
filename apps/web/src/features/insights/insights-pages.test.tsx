import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@/lib/session/session-store';

import { AreaPage } from './area-page';
import { CustomReportPage } from './custom-report-page';

/**
 * The reports pages against a captured API (owner, 26 Aug 2026). The area
 * endpoints and the custom-report CRUD are integration-tested server-side;
 * what this file proves is the page's half: the cards render from a
 * response, the period lands in the request, a widget the viewer's
 * permissions refuse shows the locked state rather than a crash, and the
 * builder's Save sends exactly the draft.
 */

const requested: string[] = [];
let putBody: unknown = null;

const AREA_RESPONSE = {
  area: 'receivables',
  from: '2026-08-01',
  to: '2026-08-30',
  metrics: [
    {
      key: 'invoiced',
      label: 'Invoiced',
      hint: 'Sales vouchers summed per day.',
      unit: 'money',
      headline: '1200.75',
      series: [{ key: 'invoiced', label: 'Invoiced' }],
      points: [
        { t: '2026-08-01', invoiced: '1000.50' },
        { t: '2026-08-02', invoiced: '200.25' },
      ],
      breakdown: {
        columns: [
          { key: 'party', label: 'Party' },
          { key: 'amount', label: 'Amount', numeric: true, unit: 'money' },
        ],
        rows: [{ party: 'Asha Traders', amount: '1000.50' }],
      },
    },
    {
      key: 'customer-ageing',
      label: 'Customer ageing',
      hint: 'Outstanding by days overdue.',
      unit: 'money',
      xKind: 'category',
      headline: '500.00',
      series: [{ key: 'outstanding', label: 'Outstanding' }],
      points: [
        { t: 'Not due', outstanding: '100.00' },
        { t: '31-60', outstanding: '400.00' },
      ],
    },
    {
      key: 'received',
      label: 'Received',
      hint: 'Receipt vouchers summed per day.',
      unit: 'money',
      headline: '300.00',
      series: [{ key: 'received', label: 'Received' }],
      points: [
        { t: '2026-08-01', received: 0 },
        { t: '2026-08-02', received: '300.00' },
      ],
    },
  ],
};

const REPORT = {
  id: '01a00000-0000-7000-8000-00000000c0de',
  name: 'Money week',
  shared: false,
  ownerUserId: 'u1',
  ownerName: 'admin@vyuha.test',
  editable: true,
  widgets: [
    {
      id: 'w1',
      title: 'Invoiced',
      kind: 'bar',
      size: '2x1',
      area: 'receivables',
      metric: 'invoiced',
      options: { legend: true, dataLabels: false, showTotal: true },
    },
    {
      id: 'w2',
      title: 'Sync jobs',
      kind: 'bar',
      size: '1x1',
      area: 'sync',
      metric: 'job-outcomes',
      options: { legend: true, dataLabels: false, showTotal: true },
    },
    {
      id: 'w3',
      title: 'Ageing table',
      kind: 'table',
      size: '1x1',
      area: 'receivables',
      metric: 'customer-ageing',
      options: { legend: true, dataLabels: false, showTotal: true },
    },
  ],
  updatedAt: '2026-08-26T10:00:00.000Z',
};

vi.mock('@/lib/api/client', () => ({
  apiRequest: (path: string, options?: { method?: string; body?: unknown }) => {
    requested.push(`${options?.method ?? 'GET'} ${path}`);
    if (options?.method === 'PUT') {
      putBody = options.body;
      return Promise.resolve({ ...REPORT, widgets: (options.body as { widgets: unknown[] }).widgets });
    }
    if (path.startsWith('/insights/custom-reports/')) return Promise.resolve(REPORT);
    if (path.startsWith('/insights/receivables')) return Promise.resolve(AREA_RESPONSE);
    if (path.startsWith('/insights/sync')) {
      // The viewer's key does not open this area; the widget must say so.
      return Promise.reject(new Error('This report area needs a permission you do not hold.'));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  },
}));

function renderAt(path: string, element: React.ReactElement, route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requested.length = 0;
  putBody = null;
  useSessionStore.setState({
    permissions: new Set([PERMISSIONS.REPORT_VIEW, PERMISSIONS.RECEIVABLES_VIEW]),
  });
});

afterEach(() => {
  useSessionStore.setState({ permissions: new Set() });
});

describe('AreaPage', () => {
  it('renders every metric as a card, headline formatted by its unit', async () => {
    renderAt('/reports/receivables', <AreaPage area="receivables" />, '/reports/receivables');

    expect(await screen.findByText('Invoiced')).toBeTruthy();
    expect(screen.getByText('₹1,200.75')).toBeTruthy();
    expect(screen.getByText('₹300.00')).toBeTruthy();
    // The breakdown table under the wide card.
    expect(screen.getByText('Asha Traders')).toBeTruthy();
  });

  it('asks the API for the period in the URL', async () => {
    renderAt('/reports/receivables?from=2026-08-01&to=2026-08-30', <AreaPage area="receivables" />, '/reports/receivables');

    await screen.findByText('Invoiced');
    expect(requested[0]).toBe('GET /insights/receivables?from=2026-08-01&to=2026-08-30');
  });
});

describe('CustomReportPage', () => {
  it('draws each widget from its area, and locks the one the viewer cannot see', async () => {
    renderAt(`/reports/custom/${REPORT.id}`, <CustomReportPage />, '/reports/custom/:id');

    expect(await screen.findByText('Money week')).toBeTruthy();
    expect(await screen.findByText('Sync jobs')).toBeTruthy();
    expect(await screen.findByText('Needs a permission you do not hold')).toBeTruthy();
  });

  it('renders a table widget as rows -- a report that is not a chart', async () => {
    renderAt(`/reports/custom/${REPORT.id}`, <CustomReportPage />, '/reports/custom/:id');

    await screen.findByText('Ageing table');
    // The category axis labels become the table's first column, the money its second.
    expect(await screen.findByText('Not due')).toBeTruthy();
    expect(screen.getByText('₹400.00')).toBeTruthy();
    // A widget stored before the palette option existed parses under defaults.
    expect(screen.queryByText('This metric no longer exists')).toBeNull();
  });

  it('saves exactly the draft: a removed widget is not in the payload', async () => {
    const user = userEvent.setup();
    renderAt(`/reports/custom/${REPORT.id}?edit=1`, <CustomReportPage />, '/reports/custom/:id');

    // ?edit=1 arms edit mode as soon as the report arrives.
    await screen.findByText('Money week');
    await screen.findByRole('button', { name: 'Save' });

    await user.click(screen.getByRole('button', { name: 'Sync jobs widget menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(putBody).not.toBeNull();
    });
    const body = putBody as { widgets: { id: string }[]; shared: boolean; name: string };
    expect(body.widgets.map((w) => w.id)).toEqual(['w1', 'w3']);
    expect(body.name).toBe('Money week');
  });
});
