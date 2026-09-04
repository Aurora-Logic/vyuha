import { RequestMethod } from '@nestjs/common';
import type { Params } from 'nestjs-pino';

import { API_PREFIX_PATH, WILDCARD_ROUTE } from './constants.js';
import { env } from './env.js';
import { redactUrl } from './redact-url.js';
import { resolveRequestId } from './request-id.js';

/**
 * Technical design §17: structured JSON logs with a request id threaded
 * through. Deliberately no pretty-printing transport, in any environment — the
 * one log format that gets read in anger is the one production emits, and a
 * developer who only ever sees the pretty variant discovers on the bad day
 * that the field they needed was never in the JSON.
 */

/**
 * Headers that must never reach a log line. `redact` replaces the value in
 * place, so the presence of the header stays visible for debugging while the
 * credential does not.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export function pinoParams(): Params {
  return {
    // nestjs-pino still defaults to the Express 4 wildcard, which Nest 11 has
    // to auto-convert and warns about on every boot. Naming the parameter
    // ourselves keeps the startup log free of a warning nobody can act on.
    forRoutes: [{ path: WILDCARD_ROUTE, method: RequestMethod.ALL }],
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: resolveRequestId,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },

      // The exception filter already logs failures with their code and stack.
      // Letting pino-http log the same request again at error level doubles
      // every incident and makes any rate alarm fire twice.
      customLogLevel: (_req, res, err) => {
        if (err !== undefined && err !== null) return 'debug';
        if (res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },

      autoLogging: {
        // Liveness is polled every few seconds forever. Readiness is not
        // ignored: a failing /ready is exactly the line worth having.
        ignore: (req) => req.url === `${API_PREFIX_PATH}/health`,
      },

      // pino-http puts the id under `req.id`; lifting it to the top level as
      // well means one grep finds both the request summary and every line the
      // application logged inside it.
      customProps: (req) => ({ requestId: req.id }),

      serializers: {
        req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
