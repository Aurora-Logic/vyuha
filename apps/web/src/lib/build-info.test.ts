import { describe, expect, it } from 'vitest';

import { buildInfo, buildLabel } from './build-info';

/**
 * The bundle has to be able to name itself. Reading the version from an
 * endpoint would have a stale tab report the server's build rather than the
 * one it is running -- which is the exact case anyone asking cares about.
 *
 * Under vitest the Vite `define` does not run, which is the unstamped path --
 * so these also prove the module degrades to "dev" instead of throwing a
 * ReferenceError on the one screen whose job is to say what is running.
 */
describe('build info', () => {
  it('never throws when the bundler did not stamp it', () => {
    expect(() => buildInfo()).not.toThrow();
    expect(() => buildLabel()).not.toThrow();
  });

  it('reads as a development build when unstamped, rather than inventing a commit', () => {
    expect(buildInfo().commit).toBe('dev');
    expect(buildInfo().builtAt).toBeNull();
    expect(buildLabel()).toMatch(/\+dev$/u);
  });

  it('separates the build metadata the way semver does', () => {
    // `1.1.0+a3f91c2` stays a valid semver, and a reader who knows the
    // notation already knows which half is which.
    const [version, metadata] = buildLabel().split('+');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(metadata).toBeTruthy();
  });
});
