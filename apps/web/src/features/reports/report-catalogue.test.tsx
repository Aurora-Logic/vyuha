import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REPORT_CATEGORIES, type ReportDefinition } from '@vyuha/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { CategoryChip, CATEGORY_TONE } from './category-chip';
import { ReportCatalogue } from './report-catalogue';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiRequest: vi.fn() };
});

const { apiRequest } = await import('@/lib/api/client');
const request = vi.mocked(apiRequest);

/**
 * The hub after the 25 Aug rebuild: shelves instead of a table.
 *
 * What is worth pinning is the organisation itself — sections in the
 * catalogue's order, search that narrows to a flat chip-labelled list, the
 * sidebar's ?category= links landing on one shelf with a way back, and a
 * "Recently used" row that exists exactly when there is history to show.
 */

function report(key: string, label: string, category: ReportDefinition['category']): ReportDefinition {
  return {
    key, label, category,
    description: `What ${label} answers`,
    columns: [],
    defaultSort: '-x',
    filters: [],
  } as unknown as ReportDefinition;
}

const REPORTS = [
  report('daily-muster', 'Daily muster', 'Attendance'),
  report('punch-audit', 'Punch audit', 'Attendance'),
  report('ageing', 'Ageing', 'Receivables'),
  report('low-stock', 'Below reorder level', 'Inventory'),
];

beforeEach(() => {
  // No history unless a test says otherwise: the recent row must be earned.
  request.mockResolvedValue({ data: [] });
});

afterEach(() => {
  request.mockReset();
});

describe('the report hub', () => {
  it('shelves every report under its category heading, in catalogue order', () => {
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />);

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    // The catalogue's reading order, not the alphabet's -- and no empty
    // shelf for a category this caller has no reports in.
    expect(headings).toEqual(['Attendance', 'Receivables', 'Inventory']);
    for (const r of REPORTS) {
      expect(screen.getByRole('button', { name: new RegExp(r.label, 'u') })).toBeTruthy();
    }
  });

  it('narrows to a flat list as you type, each match wearing its category chip', async () => {
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />);
    await userEvent.type(screen.getByLabelText('Search reports'), 'ageing');

    const row = screen.getByRole('button', { name: /Ageing/u });
    // No heading says Receivables in the flat results, so the row must.
    expect(within(row).getByText('Receivables')).toBeTruthy();
    expect(screen.queryByText('Daily muster')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('finds a report by what it answers, not only by name', async () => {
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />);
    await userEvent.type(screen.getByLabelText('Search reports'), 'what below reorder');

    expect(screen.getByRole('button', { name: /Below reorder level/u })).toBeTruthy();
    expect(screen.queryByText('Ageing')).toBeNull();
  });

  it('says nothing matched, rather than showing an empty surface', async () => {
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />);
    await userEvent.type(screen.getByLabelText('Search reports'), 'zzzz');

    expect(screen.getByText('No report matches')).toBeTruthy();
  });

  it('honours the sidebar link to one category, with a way back to all', async () => {
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />, {
      route: '/reports?category=Receivables',
    });

    // One shelf, said out loud -- not a filter someone has to notice.
    expect(screen.getByText('Showing Receivables only.')).toBeTruthy();
    expect(screen.getByText('Ageing')).toBeTruthy();
    expect(screen.queryByText('Daily muster')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show all reports' }));
    expect(screen.getByText('Daily muster')).toBeTruthy();
    expect(screen.queryByText('Showing Receivables only.')).toBeNull();
  });

  it('shows the recently used row when there is history, newest habit first', async () => {
    request.mockResolvedValue({ data: ['ageing', 'daily-muster'] });
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />);

    await waitFor(() => {
      expect(screen.getByText('Recently used')).toBeTruthy();
    });
    const rowLabel = screen.getByText('Recently used');
    const chips = within(rowLabel.parentElement as HTMLElement).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Ageing', 'Daily muster']);
  });

  it('drops a recent key the catalogue no longer serves, never a dead chip', async () => {
    // A key this client has never heard of, or one whose permission was
    // withdrawn, must not become a chip that opens "not available".
    request.mockResolvedValue({ data: ['retired-report', 'punch-audit'] });
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />);

    await waitFor(() => {
      expect(screen.getByText('Recently used')).toBeTruthy();
    });
    const rowLabel = screen.getByText('Recently used');
    const chips = within(rowLabel.parentElement as HTMLElement).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Punch audit']);
  });

  it('renders no recent row at all for a person with no history', () => {
    renderWithProviders(<ReportCatalogue reports={REPORTS} loading={false} />);
    // Absent entirely -- a labelled empty shell would tell a first-time
    // visitor the feature is broken.
    expect(screen.queryByText('Recently used')).toBeNull();
  });

  it('shows the loading skeleton while the catalogue is on its way', () => {
    renderWithProviders(<ReportCatalogue reports={[]} loading />);
    expect(screen.getByRole('status', { name: 'Loading the catalogue' })).toBeTruthy();
  });

  it('states a failed load, never "no report matches"', async () => {
    // The two are different problems: one is the network, the other reads as
    // "your role sees nothing", and sending someone to ask about permissions
    // over a dropped connection wastes two people's morning.
    const retry = vi.fn();
    renderWithProviders(
      <ReportCatalogue reports={[]} loading={false} error={{ message: 'The server is unreachable.', retry }} />,
    );
    expect(screen.getByText('The report list could not be loaded')).toBeTruthy();
    expect(screen.queryByText('No report matches')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('category chips', () => {
  it('gives every category its own colour, none shared', () => {
    // Two categories on one hue is worse than no colour: it says they are the
    // same kind of thing.
    const dots = REPORT_CATEGORIES.map((c) => CATEGORY_TONE[c].dot);
    expect(new Set(dots).size).toBe(REPORT_CATEGORIES.length);
  });

  it('has a tone for every category, so none renders uncoloured', () => {
    for (const category of REPORT_CATEGORIES) {
      expect(CATEGORY_TONE[category], category).toBeDefined();
    }
  });

  it('keeps a category on its own colour wherever the chip renders', () => {
    // Colour follows the entity, never its position -- the chip in the hub's
    // search results and the one in the report header must agree.
    const { unmount } = renderWithProviders(<CategoryChip category="Receivables" />);
    const before = screen.getByText('Receivables').className;
    unmount();

    renderWithProviders(<CategoryChip category="Receivables" />);
    expect(screen.getByText('Receivables').className).toBe(before);
    expect(before).toContain('amber');
  });

  it('does not dress Exceptions in the destructive colour', () => {
    // An empty exceptions report is the system working, not a fault. Reusing
    // the status red would make a healthy report read as a broken one.
    expect(CATEGORY_TONE.Exceptions.dot).not.toContain('destructive');
  });
});
