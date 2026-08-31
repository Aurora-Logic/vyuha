import { describe, expect, it } from 'vitest';

import { ALL_PERMISSIONS, PERMISSIONS } from '@vyuha/shared';

import { ADMIN_GROUPS, activeRailItem, adminRailFor, SETTINGS_SECTIONS } from './nav';

const everything = new Set<string>(ALL_PERMISSIONS);

describe('adminRailFor', () => {
  it('lists the settings pages first and does not repeat /settings below them', () => {
    const groups = adminRailFor(everything);

    expect(groups[0]?.label).toBe('Settings');
    expect(groups[0]?.items.map((item) => item.to)).toEqual(SETTINGS_SECTIONS.map((item) => item.to));
    expect(groups.slice(1).flatMap((group) => group.items).some((item) => item.to === '/settings')).toBe(false);
  });

  it('keeps every other workspace destination, in registry order', () => {
    const groups = adminRailFor(everything);
    const expected = ADMIN_GROUPS.flatMap((group) => group.items).filter((item) => item.to !== '/settings');

    expect(groups.slice(1).flatMap((group) => group.items)).toEqual(expected);
  });

  it('shows a sales approver only the sales page and what nobody is gated from', () => {
    const groups = adminRailFor(new Set([PERMISSIONS.SALES_DISCOUNT_APPROVE]));

    expect(groups[0]?.label).toBe('Settings');
    expect(groups[0]?.items.map((item) => item.label)).toEqual(['Sales']);
    expect(groups.slice(1).flatMap((group) => group.items).map((item) => item.to)).toEqual(['/downloads']);
  });

  it('drops the settings group entirely when no page in it may be opened', () => {
    const groups = adminRailFor(new Set());

    expect(groups.map((group) => group.label)).not.toContain('Settings');
    expect(groups.flatMap((group) => group.items).map((item) => item.to)).toEqual(['/downloads']);
  });
});

describe('activeRailItem', () => {
  const groups = adminRailFor(everything);

  it('prefers the entry naming the tab over the bare settings entry', () => {
    expect(activeRailItem(groups, '/settings', '?tab=email')?.label).toBe('Email');
  });

  it('falls back to General when there is no tab or an unknown one', () => {
    expect(activeRailItem(groups, '/settings', '')?.label).toBe('General');
    expect(activeRailItem(groups, '/settings', '?tab=nonsense')?.label).toBe('General');
  });

  it('matches a plain destination by path alone', () => {
    expect(activeRailItem(groups, '/roles', '')?.to).toBe('/roles');
    expect(activeRailItem(groups, '/roles', '?q=admin')?.to).toBe('/roles');
  });

  it('is undefined off the rail', () => {
    expect(activeRailItem(groups, '/employees', '')).toBeUndefined();
  });
});
