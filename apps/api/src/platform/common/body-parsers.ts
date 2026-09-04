import type { IncomingMessage } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';

import { API_PREFIX_PATH } from './constants.js';

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

function isSyncDoor(req: IncomingMessage): boolean {
  return (req.url ?? '').startsWith(`${API_PREFIX_PATH}/sync/`);
}

export function registerBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: SYNC_BODY_LIMIT, type: (req: IncomingMessage) => isJson(req) && isSyncDoor(req) });
  app.useBodyParser('json', { limit: DEFAULT_BODY_LIMIT, type: (req: IncomingMessage) => isJson(req) && !isSyncDoor(req) });
}
