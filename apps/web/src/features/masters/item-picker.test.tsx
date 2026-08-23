import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { ItemPicker } from './item-picker';
import type { StockItem } from './use-stock-items';

/**
 * The bug this guards: a 5,000-item catalogue was loaded 25 rows at a time and
 * filtered in the browser, so an item past the first alphabetical page could
 * not be chosen from a sales or purchase line at all. These pin the two facts
 * that undo it — a typed search reaches the server, and the row it returns is
 * selectable — and the one that must survive it: a chosen item the current
 * search page does not contain still reads on the trigger.
 */

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiRequest: vi.fn() };
});

const { apiRequest } = await import('@/lib/api/client');
const request = vi.mocked(apiRequest);

afterEach(() => {
  request.mockReset();
});

function item(id: string, name: string): StockItem {
  return {
    id,
    connectionId: 'c1',
    name,
    alias: null,
    unit: 'NOS',
    parentGroup: 'Primary',
    gstRate: '18',
    closingQty: null,
    salePrice: null,
    costPrice: null,
    absentInTally: false,
    lastPulledAt: '2026-01-01T00:00:00Z',
    duplicate: null,
  };
}

function page(data: StockItem[]) {
  return { data, meta: { page: 1, pageSize: 25, total: data.length } };
}

/** First page is A-items; only a q=zinc search surfaces the far item. */
function respondByQuery(url: string): unknown {
  if (url.includes('q=zinc')) return page([item('z-5000', 'Zinc Sheet')]);
  return page([item('a-1', 'Aluminium Rod'), item('a-2', 'Angle Bar')]);
}

describe('ItemPicker', () => {
  it('reaches an item past the first page by searching on the server, and hands the row back', async () => {
    request.mockImplementation((url: string) => Promise.resolve(respondByQuery(url)));
    const onValueChange = vi.fn();
    renderWithProviders(
      <ItemPicker value={null} onValueChange={onValueChange} label="Line item" placeholder="Choose an item" />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Line item' }));
    const input = await screen.findByPlaceholderText('Search stock items');
    await userEvent.type(input, 'zinc');

    const option = await screen.findByText('Zinc Sheet');
    await userEvent.click(option);

    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'z-5000', name: 'Zinc Sheet' }));
    });
    // The query that found it carried the term and the small page — not the
    // whole catalogue.
    expect(request.mock.calls.some(([url]) => String(url).includes('q=zinc') && String(url).includes('pageSize=25'))).toBe(true);
  });

  it('shows a chosen item on the trigger even when the current results do not contain it', async () => {
    request.mockImplementation((url: string) => Promise.resolve(respondByQuery(url)));
    renderWithProviders(
      <ItemPicker
        value={{ id: 'z-5000', label: 'Zinc Sheet' }}
        onValueChange={() => {}}
        label="Line item"
        placeholder="Choose an item"
      />,
    );

    // The first page (A-items) is what loaded; the trigger still names the pick.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Line item' }).textContent).toContain('Zinc Sheet');
    });
  });
});
