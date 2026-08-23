import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What is running.
 *
 * Three things could each claim to be the version and none was derived from
 * the build: every package.json said 0.0.0, the in-app changelog said 0.9.0,
 * and the only git tag said v1.0.0-attendance. Asked "what is on the server",
 * nobody could answer without reading a commit log.
 *
 * The version comes from the release when it stamps one and from package.json
 * otherwise. The commit and the build time can only come from the build, so
 * they arrive as environment variables; when they are absent -- a developer
 * running the API from source -- they say so rather than inventing a value,
 * because "unknown" is honest and a wrong SHA sends whoever is debugging to
 * the wrong diff.
 */
export interface BuildInfo {
  /** Semver. */
  readonly version: string;
  /** Short commit the build came from, or 'unknown' outside a release build. */
  readonly commit: string;
  /** ISO instant the build was produced, or null outside a release build. */
  readonly builtAt: string | null;
}

/**
 * The package's own version.
 *
 * From `process.cwd()`, which is the package root under `tsx`, under `node
 * dist/main.js`, and in the container, where WORKDIR is the app. Not from
 * `import.meta`: this package compiles to CommonJS, where it does not exist.
 * A release stamps `APP_VERSION` anyway; this is the fallback that keeps a
 * development server honest rather than the path production depends on.
 */
function packageVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    if (typeof raw === 'object' && raw !== null && 'version' in raw) {
      const { version } = raw;
      if (typeof version === 'string' && version !== '') return version;
    }
  } catch {
    // A health check must answer even when it cannot read its own package.
  }
  return '0.0.0';
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  cached ??= {
    version: process.env.APP_VERSION ?? packageVersion(),
    commit: process.env.GIT_COMMIT ?? 'unknown',
    builtAt: process.env.BUILT_AT ?? null,
  };
  return cached;
}

/** Test seam: the cache exists so a health check is not a file read per call. */
export function resetBuildInfo(): void {
  cached = null;
}
