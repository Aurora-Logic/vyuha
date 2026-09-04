/**
 * Which built files the service worker must have before it may install, and
 * which it may fetch as it can.
 *
 * Every emitted script and stylesheet used to be "critical", and the worker
 * installs critical files with one atomic `cache.addAll`: 4.6 MB across every
 * lazy route, and a single failed chunk -- a deploy mid-download, a flaky
 * link -- aborted the whole installation (H-13). The shell that has to work
 * offline is the entry, what it statically imports, every stylesheet, and the
 * punch screen; that is what installs atomically. The other routes are
 * fetched one by one, a miss is a warning, and the runtime cache picks them
 * up on first use anyway.
 */
export interface BuiltFile {
  readonly type: string;
  readonly fileName?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly facadeModuleId?: string | null;
}

/** The one route that must work with no network: the punch screen (REQ-D-01). */
const OFFLINE_ROUTES = ['/features/punch/'];

export function splitPrecache(bundle: Readonly<Record<string, BuiltFile>>): { critical: string[]; optional: string[] } {
  const names = Object.keys(bundle).sort();
  const roots = names.filter((name) => {
    const file = bundle[name];
    if (file === undefined || file.type !== 'chunk') return false;
    if (file.isEntry === true) return true;
    const facade = file.facadeModuleId ?? '';
    return OFFLINE_ROUTES.some((route) => facade.includes(route));
  });

  // The static import closure of the roots: what the browser would load
  // before either screen could paint.
  const shell = new Set<string>();
  const walk = (name: string): void => {
    if (shell.has(name)) return;
    shell.add(name);
    for (const dep of bundle[name]?.imports ?? []) walk(dep);
  };
  for (const root of roots) walk(root);

  const critical: string[] = [];
  const optional: string[] = [];
  for (const name of names) {
    if (name === 'index.html' || name === 'sw.js') continue;
    const url = `/${name}`;
    if (name.endsWith('.css') || shell.has(name)) critical.push(url);
    else optional.push(url);
  }
  return { critical, optional };
}
