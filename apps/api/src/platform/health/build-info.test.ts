import { afterEach, describe, expect, it } from 'vitest';

import { buildInfo, resetBuildInfo } from './build-info.js';

/**
 * Three things claimed to be the version and none came from the build: every
 * package.json said 0.0.0, the changelog said 0.9.0, the only tag said
 * v1.0.0-attendance. This pins the one that answers "what is running".
 */
describe('build info', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    resetBuildInfo();
  });

  it('takes the version from the package when the release does not name one', () => {
    delete process.env.APP_VERSION;
    resetBuildInfo();
    // Semver, and not the 0.0.0 every package carried before.
    expect(buildInfo().version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(buildInfo().version).not.toBe('0.0.0');
  });

  it('prefers what the release stamped', () => {
    process.env.APP_VERSION = '9.9.9';
    resetBuildInfo();
    expect(buildInfo().version).toBe('9.9.9');
  });

  it('says unknown rather than inventing a commit', () => {
    delete process.env.GIT_COMMIT;
    delete process.env.BUILT_AT;
    resetBuildInfo();
    // A wrong SHA is worse than an absent one: it sends someone to the wrong
    // diff when they are trying to work out what shipped.
    expect(buildInfo().commit).toBe('unknown');
    expect(buildInfo().builtAt).toBeNull();
  });

  it('carries the commit and build time the release stamped', () => {
    process.env.GIT_COMMIT = 'a3f91c2';
    process.env.BUILT_AT = '2026-08-23T10:00:00.000Z';
    resetBuildInfo();
    expect(buildInfo()).toMatchObject({ commit: 'a3f91c2', builtAt: '2026-08-23T10:00:00.000Z' });
  });

  it('reads once, so a health check is not a file read per call', () => {
    resetBuildInfo();
    expect(buildInfo()).toBe(buildInfo());
  });
});
