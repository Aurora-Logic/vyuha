import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PERMISSIONS } from '@vyuha/shared';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { RolesPage } from './roles-page';
import type { Role } from './types';

/**
 * Owner, 27 Aug 2026: the roles register on Supabase's Team pattern. What can
 * be wrong here without failing a type: the filter matching the wrong field,
 * the count under the table disagreeing with the rows, a seeded role offered
 * for deletion, and the primary action drifting off the strip's row.
 */

const ROLES: Role[] = [
  {
    id: 'r-admin',
    name: 'Admin',
    description: 'Everything',
    isSystem: true,
    permissions: [PERMISSIONS.ROLES_MANAGE, PERMISSIONS.AUDIT_VIEW],
    memberCount: 1,
  },
  {
    id: 'r-hr',
    name: 'HR',
    description: 'Leave, holidays and the payroll handoff',
    isSystem: true,
    permissions: [PERMISSIONS.LEAVE_POLICY_MANAGE],
    memberCount: 2,
  },
  {
    id: 'r-ops',
    name: 'Warehouse ops',
    description: null,
    isSystem: false,
    permissions: [],
    memberCount: 0,
  },
];

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiRequest: (path: string) =>
    path === '/roles'
      ? Promise.resolve({ data: ROLES })
      : Promise.reject(new Error(`Unexpected request: ${path}`)),
}));

describe('RolesPage', () => {
  it('lists every role, marks its kind, and counts them under the table', async () => {
    renderWithProviders(<RolesPage />);

    expect(await screen.findByText('3 roles')).toBeTruthy();
    // The desktop table; the phone cards sit beside it in the DOM and CSS
    // chooses, so the assertions scope to one branch.
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Seeded')).toHaveLength(2);
    expect(within(table).getAllByText('Custom')).toHaveLength(1);
  });

  it('filters by name and by description, and says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText('3 roles');
    const filter = screen.getByRole('searchbox', { name: 'Filter roles by name or description' });

    await user.type(filter, 'ware');
    expect(screen.getByText('1 role')).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('Admin')).toBeNull();

    await user.clear(filter);
    await user.type(filter, 'payroll');
    expect(screen.getByText('1 role')).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('HR')).toBeTruthy();

    await user.clear(filter);
    await user.type(filter, 'nobody');
    expect(screen.getByText('No roles match')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();

    // PRD §6.4: Esc clears the field it is typed in.
    await user.keyboard('{Escape}');
    expect(screen.getByText('3 roles')).toBeTruthy();
  });

  it('keeps the primary action on the strip row', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByText('3 roles');

    const row = screen.getByRole('tablist').parentElement;
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole('button', { name: /New role/u })).toBeTruthy();
  });

  it('refuses to delete a seeded role from its row, and says why', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText('3 roles');

    await user.click(screen.getByRole('button', { name: 'Actions for Admin' }));
    const remove = await screen.findByRole('menuitem', { name: /Delete role/u });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/cannot be deleted/u)).toBeTruthy();
  });

  it('offers a custom role for deletion from its row, through the reason dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText('3 roles');

    await user.click(screen.getByRole('button', { name: 'Actions for Warehouse ops' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete role/u }));
    expect(await screen.findByRole('heading', { name: 'Delete Warehouse ops?' })).toBeTruthy();
  });

  it('counts the catalogue under the permissions tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByText('3 roles');

    await user.click(screen.getByRole('tab', { name: /Permissions/u }));
    expect(await screen.findByText(/^\d+ permissions$/u)).toBeTruthy();
  });
});
