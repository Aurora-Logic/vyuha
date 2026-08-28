import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';
import { ApiError } from '@/lib/api/client';
import type { LocationSummary } from '@/features/org-masters/types';
import type { Paginated } from '@vyuha/shared';

import { OfficeLocationPanel } from './office-location-panel';
import { useOfficeGeofence } from './use-office-location';

/**
 * The three states that are not the happy path.
 *
 * Driven in a browser, a failing list read left the panel on its skeleton for
 * as long as anybody cared to watch — no error, no way back. These pin the
 * loading, error and empty branches to the query state that produces them, so
 * the next person to touch the hook finds out here rather than by staring at a
 * pulsing rectangle.
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

const BEHAVIOUR = { value: 'BLOCK', enforcedBy: null } as const;

function page(data: LocationSummary[]): Paginated<LocationSummary> {
  return { data, meta: { page: 1, pageSize: 50, total: data.length } };
}

const HEAD_OFFICE: LocationSummary = {
  id: 'loc-1',
  name: 'Head Office',
  code: 'HO',
  address: null,
  timezone: null,
  geofenceLat: 19.076,
  geofenceLng: 72.8777,
  geofenceRadiusM: 100,
  ipAllowlist: [],
  holidayCalendarId: null,
};

/** The panel needs the hook's shape, and the hook needs a component to live in. */
function Harness() {
  const office = useOfficeGeofence();
  return <OfficeLocationPanel office={office} behaviour={BEHAVIOUR} saveError={null} />;
}

describe('the office location panel', () => {
  it('shows the geofence once the list arrives', async () => {
    request.mockResolvedValue(page([HEAD_OFFICE]));
    renderWithProviders(<Harness />);

    expect(await screen.findByText(/Geofencing is on for Head Office/u)).toBeTruthy();
    expect(screen.queryByLabelText('Loading the office location')).toBeNull();
  });

  it('is loading while the list is in flight, and only then', async () => {
    let release: (value: Paginated<LocationSummary>) => void = () => undefined;
    request.mockReturnValue(
      new Promise<Paginated<LocationSummary>>((resolve) => {
        release = resolve;
      }),
    );
    renderWithProviders(<Harness />);

    expect(await screen.findByLabelText('Loading the office location')).toBeTruthy();
    release(page([HEAD_OFFICE]));
    await waitFor(() => {
      expect(screen.queryByLabelText('Loading the office location')).toBeNull();
    });
  });

  it('says the list could not be read, and offers a way back', async () => {
    request.mockRejectedValue(
      new ApiError({ code: 'INTERNAL_ERROR', message: 'Something went wrong.', status: 500 }),
    );
    renderWithProviders(<Harness />);

    expect(await screen.findByText(/Could not load locations/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again/u })).toBeTruthy();
    // The skeleton must go. A screen that keeps pulsing after a failure tells
    // the reader to wait for something that is never coming.
    expect(screen.queryByLabelText('Loading the office location')).toBeNull();
  });

  it('names the missing permission when the list is refused', async () => {
    request.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN', message: 'Missing permission', status: 403 }),
    );
    renderWithProviders(<Harness />);

    // Not the shared "you are out of scope" copy: reading locations takes
    // employee.view while writing one takes settings.manage, so an
    // administrator can reach this tab and still be refused the list.
    expect(await screen.findByText(/employee.view/u)).toBeTruthy();
    expect(screen.queryByLabelText('Loading the office location')).toBeNull();
  });

  it('sends somebody to create a location when there are none', async () => {
    request.mockResolvedValue(page([]));
    renderWithProviders(<Harness />);

    expect(await screen.findByText('There are no locations yet')).toBeTruthy();
    expect(screen.queryByLabelText('Loading the office location')).toBeNull();
  });

  it('states that geofencing is off when no centre is stored', async () => {
    request.mockResolvedValue(
      page([{ ...HEAD_OFFICE, geofenceLat: null, geofenceLng: null }]),
    );
    renderWithProviders(<Harness />);

    expect(await screen.findByText(/Geofencing is off for Head Office/u)).toBeTruthy();
    // REQ-D-08: with no centre the punch is accepted from anywhere and flagged,
    // and the panel has to say so rather than leaving an empty field to imply it.
    expect(screen.getByText(/accepted wherever the person is standing/u)).toBeTruthy();
  });

  it('offers no picker when there is only one location', async () => {
    request.mockResolvedValue(page([HEAD_OFFICE]));
    renderWithProviders(<Harness />);

    await screen.findByText(/Geofencing is on for Head Office/u);
    expect(screen.queryByLabelText('Location')).toBeNull();
  });

  it('offers a picker when there are several', async () => {
    request.mockResolvedValue(
      page([HEAD_OFFICE, { ...HEAD_OFFICE, id: 'loc-2', name: 'Andheri Branch', code: 'AND' }]),
    );
    renderWithProviders(<Harness />);

    expect(await screen.findByLabelText('Location')).toBeTruthy();
  });
});
