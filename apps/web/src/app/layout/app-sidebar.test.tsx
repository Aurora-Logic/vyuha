import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SidebarProvider } from '@/components/ui/sidebar';
import { renderWithProviders } from '@/test-support/render-shell';

import { AppSidebar } from './app-sidebar';

/**
 * REQ-O-01 at the component level: the sidebar renders the current module and
 * offers the others. The Masters module existed in `MODULES` for a full slice
 * while nothing rendered it — reachable only by typing into Alt+G — because
 * the sidebar was hard-wired to the attendance groups and no test noticed.
 * These do.
 */

function renderSidebar(role: 'Admin' | 'Employee', route = '/') {
  return renderWithProviders(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>,
    { role, route },
  );
}

describe('AppSidebar', () => {
  it('offers the module switcher to an account that can see a second module', async () => {
    renderSidebar('Admin');

    const switcher = await screen.findByRole('button', { name: 'Switch module' });
    await userEvent.click(switcher);

    expect(await screen.findByRole('menuitem', { name: /Sales/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Logistics/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Attendance/ })).toBeTruthy();
  });

  it('hides the switcher from an account with one module', () => {
    renderSidebar('Employee');

    expect(screen.getByText('Punch')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Switch module' })).toBeNull();
  });

  it('renders the owning module for a masters route', () => {
    renderSidebar('Admin', '/masters/parties');

    expect(screen.getByText('Parties')).toBeTruthy();
    // The attendance groups belong to the other module now.
    expect(screen.queryByText('Punch')).toBeNull();
  });

  it('falls back to attendance for routes no module owns', () => {
    renderSidebar('Admin', '/audit');

    expect(screen.getByText('Punch')).toBeTruthy();
    expect(screen.queryByText('Parties')).toBeNull();
  });
});
