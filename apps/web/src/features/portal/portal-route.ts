/**
 * 15 REQ-AL-01: which portal key a path carries, if any.
 *
 * Matched in SessionGate like the invitation and legal screens, because a
 * customer has no account by definition and the sign-in form is the one
 * thing this page must never become. The key is the credential and it is in
 * the path, so the whole link survives being pasted into a message.
 */
export function portalRoute(pathname: string): string | null {
  const prefix = '/portal/';
  if (!pathname.startsWith(prefix)) return null;
  const key = pathname.slice(prefix.length).replace(/\/+$/u, '');
  return key === '' ? null : key;
}
