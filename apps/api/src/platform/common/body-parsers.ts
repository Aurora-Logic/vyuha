import type { IncomingMessage } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { ERROR_CODES } from '@vyuha/shared';
import type { RequestHandler } from 'express';

import { API_PREFIX_PATH } from './constants.js';
import { toErrorBody } from './errors.js';
import { resolveRequestId } from './request-id.js';

/**
 * Large bodies only where they arrive. OpsTally chunks and the agent's
 * result chunks come through /sync -- a 500-record snapshot blows past
 * body-parser's 100 kB default easily -- so /sync takes 15 MB. Everything
 * else is a form, and 1 MB is several hundred times the largest. A global
 * 15 MB let an unauthenticated POST to any route buffer and parse 15 MB
 * before a guard ran (H-02).
 *
 * Two parsers told apart by body-parser's `type` predicate rather than an
 * Express mount, so Nest keeps attaching the raw bytes to both -- the
 * webhook verifies its HMAC over them -- and no package this app does not
 * declare has to be imported.
 *
 * One function for main.ts and the test harness both, because they had
 * drifted: production ran the global 15 MB, the harness ran Nest's default,
 * and so no test had ever exercised the limit production actually had.
 */
export const SYNC_BODY_LIMIT = '15mb';
export const DEFAULT_BODY_LIMIT = '1mb';

function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').toLowerCase().includes('application/json');
}

export function isSyncDoor(req: IncomingMessage): boolean {
  if (req.method !== 'POST') return false;
  const path = (req.url ?? '').split('?', 1)[0] ?? '';
  const relative = path.slice(API_PREFIX_PATH.length);
  return path.toLowerCase().startsWith(API_PREFIX_PATH.toLowerCase()) &&
    /^\/sync\/(?:agent\/results|webhooks\/opstally\/[0-9a-f-]{36})\/?$/iu.test(relative);
}

/** Bound buffered JSON per process, before body-parser or any database work. */
export function createBodyAdmission(largeLimit = 2, ordinaryLimit = 32): RequestHandler {
  let large = 0;
  let ordinary = 0;
  return (req, res, next): void => {
    if (!isJson(req)) { next(); return; }
    const sync = isSyncDoor(req);
    if ((sync ? large : ordinary) >= (sync ? largeLimit : ordinaryLimit)) {
      const requestId = resolveRequestId(req, res);
      res.setHeader('Retry-After', '5');
      res.setHeader('Connection', 'close');
      res.status(429).json(toErrorBody(ERROR_CODES.RATE_LIMITED, 'The service is busy. Retry in a moment.', requestId));
      return;
    }
    if (sync) large += 1; else ordinary += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      if (sync) large -= 1; else ordinary -= 1;
    };
    // Bound slow uploads. Stop this timer once bytes finish arriving; the
    // concurrency slot remains held until the handler/response completes.
    const timer = setTimeout(() => { req.destroy(); }, 30_000);
    timer.unref();
    req.once('end', () => { clearTimeout(timer); });
    req.once('aborted', release);
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

export function registerBodyParsers(app: NestExpressApplication): void {
  app.use(createBodyAdmission());
  app.useBodyParser('json', { limit: SYNC_BODY_LIMIT, type: (req: IncomingMessage) => isJson(req) && isSyncDoor(req) });
  app.useBodyParser('json', { limit: DEFAULT_BODY_LIMIT, type: (req: IncomingMessage) => isJson(req) && !isSyncDoor(req) });
}
