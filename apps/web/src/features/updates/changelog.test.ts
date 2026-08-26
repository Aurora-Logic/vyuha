import { describe, expect, it } from 'vitest';

import { MAIN_TOUR } from '@/features/guide/tour-steps';
import { ALL_NAV_ITEMS } from '@/lib/nav';
import { ROLE_PERMISSION_MATRIX, ALL_PERMISSIONS, type PermissionKey } from '@vyuha/shared';

import { hasUnread, LATEST_VERSION, RELEASES, visibleReleases } from './changelog';

/**
 * The changelog is hand-written content, and its links are the part that rots:
 * a route gets renamed, a tour step gets a new id, and the entry keeps offering
 * a button that goes nowhere. Nothing else in the build would notice.
 */

/** Every route the router will actually serve, plus the off-sidebar ones. */
const ROUTES = new Set<string>([...ALL_NAV_ITEMS.map((i) => i.to), '/profile', '/updates']);

describe('changelog integrity', () => {
  it('points every "Take me there" at a route that exists', () => {
    for (const release of RELEASES) {
      for (const entry of release.entries) {
        if (!entry.route) continue;
        expect(ROUTES.has(entry.route), `${entry.title} -> ${entry.route}`).toBe(true);
      }
    }
  });

  it('points every "Show me" at a tour step that exists', () => {
    const stepIds = new Set(MAIN_TOUR.map((s) => s.id));

    for (const release of RELEASES) {
      for (const entry of release.entries) {
        if (!entry.guideStep) continue;
        expect(stepIds.has(entry.guideStep), `${entry.title} -> ${entry.guideStep}`).toBe(true);
      }
    }
  });

  it('names only permissions that exist', () => {
    const known = new Set<PermissionKey>(ALL_PERMISSIONS);

    for (const release of RELEASES) {
      for (const entry of release.entries) {
        if (!entry.permission) continue;
        expect(known.has(entry.permission), `${entry.title} -> ${entry.permission}`).toBe(true);
      }
    }
  });

  it('never offers a route to somebody the destination would refuse', () => {
    /*
     * The invariant is reachability, not equality.
     *
     * An entry gated on `employee.manage` linking to a screen gated on
     * `employee.view` is fine — stricter, not broken — so comparing the two
     * keys directly fails on correct data. What actually matters is that no
     * role can see the entry without also being able to open the destination,
     * which is a question about the matrix rather than about the two keys.
     */
    const roles = Object.keys(ROLE_PERMISSION_MATRIX) as (keyof typeof ROLE_PERMISSION_MATRIX)[];

    for (const release of RELEASES) {
      for (const entry of release.entries) {
        if (!entry.route) continue;
        const item = ALL_NAV_ITEMS.find((i) => i.to === entry.route);
        if (!item?.permission) continue;

        for (const role of roles) {
          const held = new Set<PermissionKey>(ROLE_PERMISSION_MATRIX[role]);
          const canSeeEntry = !entry.permission || held.has(entry.permission);
          if (!canSeeEntry) continue;

          expect(
            held.has(item.permission),
            `${role} can see "${entry.title}" but cannot open ${entry.route}`,
          ).toBe(true);
        }
      }
    }
  });

  it('lists releases newest first', () => {
    const dates = RELEASES.map((r) => r.date);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
  });

  it('has no duplicate versions', () => {
    const versions = RELEASES.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('changelog visibility', () => {
  it('hides an entry whose permission the reader lacks', () => {
    const employee = new Set(ROLE_PERMISSION_MATRIX.Employee);
    const entries = visibleReleases(employee).flatMap((r) => r.entries);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      if (entry.permission) expect(employee.has(entry.permission)).toBe(true);
    }
  });

  it('drops a release whose every entry was filtered away', () => {
    for (const release of visibleReleases(new Set())) {
      expect(release.entries.length).toBeGreaterThan(0);
    }
  });

  it('shows an administrator everything', () => {
    const admin = new Set(ROLE_PERMISSION_MATRIX.Admin);
    const shown = visibleReleases(admin).flatMap((r) => r.entries).length;
    const total = RELEASES.flatMap((r) => r.entries).length;

    expect(shown).toBe(total);
  });
});

describe('the unread dot', () => {
  it('is on for somebody who has never opened the page', () => {
    expect(hasUnread(null)).toBe(true);
  });

  it('is off once the newest release has been seen', () => {
    expect(hasUnread(LATEST_VERSION)).toBe(false);
  });

  it('is on again when a release ships after the one that was seen', () => {
    expect(hasUnread('0.0.1-old')).toBe(true);
  });

  it('takes its latest version from the first release, not from sorting', () => {
    expect(LATEST_VERSION).toBe(RELEASES[0]?.version);
  });
});
