import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ALL_PERMISSIONS } from '@vyuha/shared';

import { renderWithProviders } from '@/test-support/render-shell';

const permission = { held: new Set<string>() };
vi.mock('@/lib/session/permissions', () => ({
  usePermission: (key: string) => permission.held.has(key),
  usePermissions: () => permission.held,
}));
import { AdminShell } from './admin-shell';

/**
 * The rail beside every administration screen. What it must get right is
 * which entry it lights: ten settings pages share one pathname, so a rail
 * that judged by path would light all ten at once.
 */
function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route element={<AdminShell />}>
        <Route path="settings" element={<p>Settings body</p>} />
        <Route path="roles" element={<p>Roles body</p>} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('AdminShell', () => {
  it('lights exactly the settings page in the address and still renders the page', () => {
    permission.held = new Set(ALL_PERMISSIONS);
    renderAt('/settings?tab=email');

    const rail = screen.getByRole('navigation', { name: 'Administration' });
    const current = within(rail).getAllByRole('link', { current: 'page' });
    expect(current.map((link) => link.textContent)).toEqual(['Email']);
    expect(within(rail).getByRole('link', { name: 'Documents' }).getAttribute('href')).toBe('/settings?tab=documents');
    expect(screen.getByText('Settings body')).not.toBeNull();
  });

  it('names where the reader is on the phone trigger', () => {
    permission.held = new Set(ALL_PERMISSIONS);
    renderAt('/roles');

    expect(screen.getByRole('button', { name: 'Administration sections' }).textContent).toBe('Workspace / Roles and permissions');
  });

  it('leaves somebody with no permissions only what nobody is gated from, and still renders the page', () => {
    permission.held = new Set();
    renderAt('/settings');

    const rail = screen.getByRole('navigation', { name: 'Administration' });
    expect(within(rail).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/downloads']);
    expect(within(rail).queryAllByRole('link', { current: 'page' })).toEqual([]);
    expect(screen.getByText('Settings body')).not.toBeNull();
  });
});
