import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { PlaceOrderDialog } from './place-order-dialog';

/**
 * REQ-V-17. The order the owner asked for: customer, items with quantity and
 * discount, a total, notes -- and it refuses to place one that is not an
 * order, because a row with no customer or nothing on it is not one.
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

function open() {
  renderWithProviders(<PlaceOrderDialog open onOpenChange={() => {}} />);
}

describe('PlaceOrderDialog', () => {
  it('asks for the customer, the items and the notes, in that order', () => {
    request.mockImplementation(() => Promise.resolve({ data: [], meta: { page: 1, pageSize: 25, total: 0 } }));
    open();
    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent ?? '';
    expect(text.indexOf('Customer')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Customer')).toBeLessThan(text.indexOf('Items'));
    expect(text.indexOf('Items')).toBeLessThan(text.indexOf('Notes and comments'));
  });

  it('refuses to place an order with no customer and no items, and says which', async () => {
    request.mockImplementation(() => Promise.resolve({ data: [], meta: { page: 1, pageSize: 25, total: 0 } }));
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    // Nothing was sent, and the reader is told what is missing rather than
    // left with a button that does nothing.
    expect(request.mock.calls.some(([url]) => String(url) === '/tasks')).toBe(false);
    await waitFor(() => {
      expect(screen.getByText('An order is placed by somebody. Choose the customer.')).toBeTruthy();
    });
    expect(screen.getByText('Add at least one item.')).toBeTruthy();
  });
});
