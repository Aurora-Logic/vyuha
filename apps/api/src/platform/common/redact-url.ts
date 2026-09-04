/**
 * A request URL fit for a log line.
 *
 * Four routes carry a credential in the URL itself, because the whole link
 * has to be pasteable into a WhatsApp message or a mail: the portal key
 * (`/portal/:key`), the invitation and password-reset tokens
 * (`/auth/invitations/:token/accept`, `/auth/password-resets/:token/confirm`)
 * and the disk-driver file signature (`/files/raw/...?expires=&signature=`).
 * pino-http logged `req.url` raw and the exception filter logged
 * `originalUrl`, so every one of them sat in the application log, replayable
 * by whoever could read it -- a support export, an aggregator, a backup (H-01).
 *
 * The query string goes entirely: nothing this API reads from a query is
 * worth a log line, and the signature is the one thing that must not be. The
 * three path secrets are masked in place so the route stays legible.
 * `for-employee` is excluded because those two routes take an employee id,
 * not a token, and an id is exactly what a log line is for.
 */
const SECRET_SEGMENTS: readonly RegExp[] = [
  /(\/portal\/)[^/?#]+/u,
  /(\/invitations\/)(?!for-employee(?:[/?#]|$))[^/?#]+/u,
  /(\/password-resets\/)(?!for-employee(?:[/?#]|$))[^/?#]+/u,
];

export function redactUrl(url: string): string {
  const path = url.split('?', 1)[0] ?? url;
  return SECRET_SEGMENTS.reduce((acc, pattern) => acc.replace(pattern, '$1[redacted]'), path);
}
