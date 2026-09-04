import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { CompanyPicker } from './company-picker';
import type { Company } from './types';

/**
 * The company twin of the party and item guards: `useCompanyOptions` read 200
 * companies once and filtered them in the browser, so the 201st could not be
 * attached to a contact, a deal or a sales document. These pin the server
 * search and the by-id resolve a record opened cold depends on.
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

function company(id: string, name: string): Company {
  return {
    id,
    name,
    phone: null,
    email: null,
    website: null,
    city: null,
    notes: null,
    ownerId: null,
    ownerName: null,
    partyId: null,
    contactCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function page(data: Company[]) {
  return { data, meta: { page: 1, pageSize: 25, total: data.length } };
}

describe('CompanyPicker', () => {
  it('reaches a company past the first page by searching, and hands the row back', async () => {
    request.mockImplementation((url: string) => {
      if (url.includes('q=zenith')) return Promise.resolve(page([company('z-900', 'Zenith Fabricators')]));
      return Promise.resolve(page([company('a-1', 'Ambad Polymers'), company('b-2', 'Bharat Steel')]));
    });
    const onValueChange = vi.fn();
    renderWithProviders(
      <CompanyPicker companyId={null} onValueChange={onValueChange} label="Company" placeholder="No company" />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Company' }));
    await userEvent.type(await screen.findByPlaceholderText('Name, city or website'), 'zenith');
    await userEvent.click(await screen.findByText('Zenith Fabricators'));

    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'z-900', name: 'Zenith Fabricators' }),
      );
    });
  });

  it('names a company held only by id, resolving it on its own', async () => {
    request.mockImplementation((url: string) => {
      if (url.includes('/crm/companies/z-900')) return Promise.resolve(company('z-900', 'Zenith Fabricators'));
      return Promise.resolve(page([company('a-1', 'Ambad Polymers')]));
    });
    renderWithProviders(
      <CompanyPicker companyId="z-900" onValueChange={() => {}} label="Company" placeholder="No company" />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Company' }).textContent).toContain('Zenith Fabricators');
    });
  });

  it('does not read a company by id when the picker is disabled for lack of permission', async () => {
    request.mockImplementation(() => Promise.resolve(page([])));
    renderWithProviders(
      <CompanyPicker
        companyId="z-900"
        enabled={false}
        disabled
        onValueChange={() => {}}
        label="Company"
        placeholder="No company"
      />,
    );
    // Give any errant effect a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(request.mock.calls.some(([url]) => String(url).includes('/crm/companies/z-900'))).toBe(false);
  });

  it('shows a caller-supplied name at once and issues no by-id read', async () => {
    request.mockImplementation(() => Promise.resolve(page([])));
    renderWithProviders(
      <CompanyPicker
        companyId="z-900"
        companyName="Zenith Fabricators"
        onValueChange={() => {}}
        label="Company"
        placeholder="No company"
      />,
    );
    expect(screen.getByRole('button', { name: 'Company' }).textContent).toContain('Zenith Fabricators');
    await new Promise((r) => setTimeout(r, 50));
    expect(request.mock.calls.some(([url]) => String(url).includes('/crm/companies/z-900'))).toBe(false);
  });
});
