import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';
import type { AccessWindow, LocationSummary, Paginated, SalesSettings } from '@vyuha/shared';

import { sampleSettings } from './sample';
import { SettingsPage } from './settings-page';
import type { OrgSettings, SettingsPatch } from './types';

/**
 * The screen after the tab strip left (owner, 27 Aug 2026: Supabase's
 * anatomy). The rail outside the page writes `?tab=`; the page draws only
 * the sections that page names, and each panel saves only the groups it
 * owns. The API is mocked at `apiRequest`, so what is under test is which
 * sections render for which address, and what a Save actually sends.
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

const WINDOW: AccessWindow = { enabled: false, closesAt: '20:00', reopensAt: '08:00', days: [1, 2, 3, 4, 5] };
const SALES: SalesSettings = { discountApprovalPct: 10 };
const NO_LOCATIONS: Paginated<LocationSummary> = { data: [], meta: { page: 1, pageSize: 50, total: 0 } };

/** The server's answer to a PATCH: the whole record, with the groups sent laid over it. */
function applyPatch(current: OrgSettings, patch: SettingsPatch): OrgSettings {
  return {
    ...current,
    organisation: { ...current.organisation, ...patch.organisation },
    attendance: { ...current.attendance, ...patch.attendance },
    photo: { ...current.photo, ...patch.photo },
    security: { ...current.security, ...patch.security },
    appearance: { ...current.appearance, ...patch.appearance },
    locale: { ...current.locale, ...patch.locale },
    retention: { ...current.retention, ...patch.retention },
    duplicates: { ...current.duplicates, ...patch.duplicates },
    returns: { ...current.returns, ...patch.returns },
    interest: { ...current.interest, ...patch.interest },
    leave: { ...current.leave, ...patch.leave },
  };
}

/** A server holding `settings`, answering every route the screen reaches for. */
function serve(settings: OrgSettings = sampleSettings()) {
  let current = settings;
  request.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (path === '/settings' && options?.method === 'PATCH') {
      current = applyPatch(current, options.body as SettingsPatch);
      return Promise.resolve(current);
    }
    if (path === '/settings') return Promise.resolve(current);
    if (path === '/settings/access-window') return Promise.resolve(WINDOW);
    if (path.startsWith('/locations')) return Promise.resolve(NO_LOCATIONS);
    if (path === '/sales/settings') return Promise.resolve(SALES);
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
}

/** The bodies of every PATCH /settings so far, oldest first. */
function patchesSent(): SettingsPatch[] {
  return request.mock.calls
    .filter(([path, options]) => path === '/settings' && options?.method === 'PATCH')
    .map(([, options]) => options?.body as SettingsPatch);
}

describe('the settings screen', () => {
  it('draws only the section the address names, and no tab strip', async () => {
    serve();
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=email' });

    expect(await screen.findByRole('heading', { name: 'Outbound email' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Organisation profile' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Attendance policy' })).toBeNull();
  });

  it('lands on the organisation page for an address it does not recognise', async () => {
    serve();
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=nonsense' });

    expect(await screen.findByRole('heading', { name: 'Organisation profile' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Interest cost' })).toBeTruthy();
  });

  it('saves one panel at a time, sending only the groups it owns', async () => {
    serve();
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />, { route: '/settings' });

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Acme Cables');
    const downloads = screen.getByLabelText('Keep downloads for (days)');
    await user.clear(downloads);
    await user.type(downloads, '14');

    const profile = screen.getByRole('region', { name: 'Organisation profile' });
    const retention = screen.getByRole('region', { name: 'Data retention' });
    expect(within(profile).getByText('Unsaved changes')).toBeTruthy();
    expect(within(retention).getByText('Unsaved changes')).toBeTruthy();
    // A clean panel has nothing to send, and says so by refusing.
    const money = screen.getByRole('region', { name: 'Numbers and money' });
    expect(within(money).getByText('Saved')).toBeTruthy();
    expect(within(money).getByRole('button', { name: /Save changes/u }).hasAttribute('disabled')).toBe(true);

    await user.click(within(profile).getByRole('button', { name: /Save changes/u }));

    await waitFor(() => {
      expect(patchesSent()).toHaveLength(1);
    });
    const [sent] = patchesSent();
    expect(Object.keys(sent ?? {})).toEqual(['organisation']);
    expect(sent?.organisation?.name).toBe('Acme Cables');

    // The profile is settled; the retention edit was not sent and is still here.
    expect(await within(profile).findByText('Saved')).toBeTruthy();
    expect(within(retention).getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Keep downloads for (days)').value).toBe('14');
  });

  it('puts a panel back with Cancel without touching the others', async () => {
    serve();
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />, { route: '/settings' });

    const name = await screen.findByLabelText('Name');
    await user.type(name, ' Ltd');
    const downloads = screen.getByLabelText('Keep downloads for (days)');
    await user.clear(downloads);
    await user.type(downloads, '30');

    const profile = screen.getByRole('region', { name: 'Organisation profile' });
    await user.click(within(profile).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Sample Organisation');
    expect(within(profile).getByText('Saved')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Keep downloads for (days)').value).toBe('30');
    expect(patchesSent()).toHaveLength(0);
  });

  it('saves everything dirty on the screen from Ctrl+A', async () => {
    serve();
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />, { route: '/settings' });

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Acme');
    const downloads = screen.getByLabelText('Keep downloads for (days)');
    await user.clear(downloads);
    await user.type(downloads, '21');

    // From inside the field: PRD §6.4 says Accept fires wherever the cursor is.
    fireEvent.keyDown(downloads, { key: 'a', code: 'KeyA', ctrlKey: true });

    await waitFor(() => {
      expect(patchesSent()).toHaveLength(1);
    });
    const [sent] = patchesSent();
    expect(Object.keys(sent ?? {}).sort()).toEqual(['organisation', 'retention']);
    expect(sent?.retention?.exportsDays).toBe(21);
  });

  it('saves the leave policy panel, sending only the leave group (OS-1)', async () => {
    serve();
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=attendance' });

    const leave = await screen.findByRole('region', { name: 'Leave policy' });
    const expiry = screen.getByLabelText('Comp-off credits expire after (days)');
    await user.clear(expiry);
    await user.type(expiry, '45');

    expect(within(leave).getByText('Unsaved changes')).toBeTruthy();
    // The attendance panel beside it did not move and must not be sent.
    const attendance = screen.getByRole('region', { name: 'Attendance policy' });
    expect(within(attendance).getByText('Saved')).toBeTruthy();

    await user.click(within(leave).getByRole('button', { name: /Save changes/u }));

    await waitFor(() => {
      expect(patchesSent()).toHaveLength(1);
    });
    const [sent] = patchesSent();
    expect(Object.keys(sent ?? {})).toEqual(['leave']);
    expect(sent?.leave).toEqual({
      yearStartMonth: 4,
      compOffExpiryDays: 45,
      concurrentAbsenceThreshold: 0,
    });

    expect(await within(leave).findByText('Saved')).toBeTruthy();
  });

  it('gives a module approver the page they may see when the address names one they may not', async () => {
    serve();
    // Sales manager holds sales.discount.approve and neither settings.manage
    // nor purchase.document.approve.
    renderWithProviders(<SettingsPage />, { role: 'Sales manager', route: '/settings?tab=purchase' });

    expect(await screen.findByRole('heading', { name: 'Sales' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Purchase' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Organisation profile' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
