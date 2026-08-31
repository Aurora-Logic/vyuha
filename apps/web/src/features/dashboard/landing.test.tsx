import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

const permission = vi.hoisted(() => ({ held: new Set<string>() }));
vi.mock('@/lib/session/permissions', () => ({
  usePermission: (key: string) => permission.held.has(key),
  usePermissions: () => permission.held,
}));
import { LandingPage } from './landing';
import { MODULES } from '@/lib/nav';

/**
 * Where "/" sends somebody. The failure this guards is quiet: an owner signing
 * in and getting their own punch card, then navigating away every time.
 */
describe('the landing screen', () => {
  it('sends whoever can see the books to the reports dashboard', () => {
    permission.held = new Set(['receivables.view']);
    renderWithProviders(<LandingPage />, { route: '/' });
    // A redirect, so the attendance dashboard must not have rendered at all.
    expect(screen.queryByText('attendance dashboard')).toBeNull();
  });

  it('sends everybody else to the attendance dashboard', () => {
    permission.held = new Set(['punch.self', 'attendance.view.self']);
    const { container } = renderWithProviders(<LandingPage />, { route: '/' });
    // A redirect either way: "/" is the entry and renders nothing itself.
    expect(container.textContent).toBe('');
  });

  it('never renders a screen at "/" itself', () => {
    /*
     * The regression this pins. While "/" both redirected *and* was the
     * attendance module's home, clicking Attendance navigated to "/" and was
     * bounced straight back -- the module could not be opened at all by
     * anyone the redirect applied to. "/" chooses; the screens have their own
     * addresses.
     */
    for (const held of [['receivables.view'], ['punch.self']]) {
      permission.held = new Set(held);
      const { container, unmount } = renderWithProviders(<LandingPage />, { route: '/' });
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('decides on a permission, not a role name', () => {
    // PRD §2: nothing branches on a role name -- "Admin" is renameable and
    // roles are editable. Somebody granted receivables.view on a custom role
    // gets the same landing as Admin, which is the point.
    permission.held = new Set(['receivables.view']);
    renderWithProviders(<LandingPage />, { route: '/' });
    expect(screen.queryByText('attendance dashboard')).toBeNull();
  });
});

describe('every module home opens something', () => {
  it('points no module at a route that only redirects', () => {
    /*
     * The bug in one assertion. Attendance's home was "/", and "/" redirects,
     * so the switcher navigated to a route that immediately sent you
     * elsewhere -- clicking Attendance did nothing visible. A module's home
     * must be a screen, not the chooser.
     */
    for (const module of MODULES) {
      expect(module.home, `${module.id} points at the redirecting root`).not.toBe('/');
      expect(module.home.startsWith('/'), `${module.id} home is not a path`).toBe(true);
    }
  });
});
