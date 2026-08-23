/**
 * Which build the person is looking at.
 *
 * Read from constants Vite replaces at build time (see `vite.config.ts`), not
 * from an endpoint: the bundle has to be able to name *itself*, or a stale tab
 * would cheerfully report the version the server is on rather than the one it
 * is actually running -- which is the exact case anyone asking the question
 * cares about.
 *
 * Every read is guarded. A bundler that did not run the define -- vitest, or a
 * tool wiring this up later -- gets "dev" and a working screen, not a
 * ReferenceError on a page whose only job is to tell you what is wrong.
 */
declare const __APP_VERSION__: string | undefined;
declare const __APP_COMMIT__: string | undefined;
declare const __APP_BUILT_AT__: string | undefined;

function stamped(name: 'version' | 'commit' | 'builtAt'): string {
  try {
    if (name === 'version') return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
    if (name === 'commit') return typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : '';
    return typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : '';
  } catch {
    return '';
  }
}

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  readonly builtAt: Date | null;
}

export function buildInfo(): BuildInfo {
  const raw = stamped('builtAt');
  const builtAt = raw === '' ? null : new Date(raw);
  return {
    version: stamped('version') === '' ? '0.0.0' : stamped('version'),
    commit: stamped('commit') === '' ? 'dev' : stamped('commit'),
    builtAt: builtAt !== null && !Number.isNaN(builtAt.getTime()) ? builtAt : null,
  };
}

/**
 * The one string to quote in a bug report: `1.1.0+a3f91c2`.
 *
 * The build metadata is separated with `+` because that is what semver calls
 * it, so the version stays a valid semver and a reader who knows the notation
 * already knows which half is which.
 */
export function buildLabel(): string {
  const { version, commit } = buildInfo();
  return commit === 'dev' || commit === 'unknown' ? `${version}+dev` : `${version}+${commit}`;
}
