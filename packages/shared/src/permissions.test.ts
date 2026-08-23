import { describe, expect, it } from 'vitest';

import { PERMISSIONS, ROLE_PERMISSION_MATRIX, SYSTEM_ROLES } from './permissions.js';

/**
 * The one property the role matrix must never lose.
 */
describe('the Admin role', () => {
  it('holds every permission in the catalogue', () => {
    // The failure this prevents is silent: a permission added for a new module
    // and not granted here leaves the owner of the system with a 403 on a
    // screen they are supposed to own, and nothing says why.
    const admin = new Set<string>(ROLE_PERMISSION_MATRIX.Admin);
    const missing = Object.values(PERMISSIONS).filter((key) => !admin.has(key));
    expect(missing, `Admin is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('holds no key that is not in the catalogue', () => {
    // The other direction: a renamed permission leaving a dead string behind
    // would grant nothing and look like it granted something.
    const catalogue = new Set<string>(Object.values(PERMISSIONS));
    const strays = ROLE_PERMISSION_MATRIX.Admin.filter((key) => !catalogue.has(key));
    expect(strays).toEqual([]);
  });

  it('grants each permission once', () => {
    const admin = ROLE_PERMISSION_MATRIX.Admin;
    expect(new Set(admin).size).toBe(admin.length);
  });
});

describe('the seeded roles', () => {
  it('gives every system role a defined set', () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      expect(ROLE_PERMISSION_MATRIX[role], role).toBeDefined();
    }
  });

  it('grants no role a permission the catalogue does not define', () => {
    const catalogue = new Set<string>(Object.values(PERMISSIONS));
    for (const role of Object.values(SYSTEM_ROLES)) {
      const strays = ROLE_PERMISSION_MATRIX[role].filter((key) => !catalogue.has(key));
      expect(strays, `${role} grants unknown: ${strays.join(', ')}`).toEqual([]);
    }
  });
});
