import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { PartyPicker } from './party-picker';
import type { Party } from './use-parties';

/**
 * The party twin of the item-picker guards: a 1,000-party book was loaded 25 at
 * a time and filtered in the browser, hiding most customers and vendors from
 * every document. These pin the server search, and the by-id resolve that lets
 * a document opened cold name its party without the whole book in hand.
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

function party(id: string, name: string): Party {
  return {
    id,
    connectionId: 'c1',
    name,
    alias: null,
    parentGroup: 'Sundry Debtors',
    gstin: null,
    address: null,
    creditLimit: null,
    creditDays: null,
    openingBalance: null,
    absentInTally: false,
    lastPulledAt: '2026-01-01T00:00:00Z',
    manager: null,
    duplicate: null,
  };
}

function page(data: Party[]) {
  return { data, meta: { page: 1, pageSize: 25, total: data.length } };
}

describe('PartyPicker', () => {
  it('reaches a party past the first page by searching, and hands the row back', async () => {
    request.mockImplementation((url: string) => {
      if (url.includes('q=zaid')) return Promise.resolve(page([party('z-900', 'Zaid Traders')]));
      return Promise.resolve(page([party('a-1', 'Asha Traders'), party('b-2', 'Bharat Steel')]));
    });
    const onValueChange = vi.fn();
    renderWithProviders(
      <PartyPicker partyId={null} onValueChange={onValueChange} label="Customer" placeholder="Choose a customer" />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Customer' }));
    await userEvent.type(await screen.findByPlaceholderText('Name, alias or GSTIN'), 'zaid');
    await userEvent.click(await screen.findByText('Zaid Traders'));

    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'z-900', name: 'Zaid Traders' }));
    });
  });

  it('names a party held only by id, resolving it on its own', async () => {
    request.mockImplementation((url: string) => {
      if (url.includes('/masters/parties/z-900')) return Promise.resolve(party('z-900', 'Zaid Traders'));
      return Promise.resolve(page([party('a-1', 'Asha Traders')]));
    });
    renderWithProviders(
      <PartyPicker partyId="z-900" onValueChange={() => {}} label="Customer" placeholder="Choose a customer" />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Customer' }).textContent).toContain('Zaid Traders');
    });
  });

  it('does not read a party by id when the picker is disabled for lack of permission', async () => {
    request.mockImplementation(() => Promise.resolve(page([])));
    renderWithProviders(
      <PartyPicker partyId="z-900" enabled={false} disabled onValueChange={() => {}} label="Customer" placeholder="Choose a customer" />,
    );
    // Give any errant effect a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(request.mock.calls.some(([url]) => String(url).includes('/masters/parties/z-900'))).toBe(false);
  });

  it('shows a caller-supplied name at once and issues no by-id read', async () => {
    request.mockImplementation(() => Promise.resolve(page([])));
    renderWithProviders(
      <PartyPicker partyId="z-900" partyName="Zaid Traders" onValueChange={() => {}} label="Vendor" placeholder="Choose a vendor" />,
    );
    expect(screen.getByRole('button', { name: 'Vendor' }).textContent).toContain('Zaid Traders');
    await new Promise((r) => setTimeout(r, 50));
    expect(request.mock.calls.some(([url]) => String(url).includes('/masters/parties/z-900'))).toBe(false);
  });
});
