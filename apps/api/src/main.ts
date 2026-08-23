import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { assertDecoratorMetadataIsEmitted } from './platform/common/decorator-metadata.js';
import { EnvValidationError } from './platform/common/env.schema.js';
import { StartupError } from './platform/common/startup-error.js';

/**
 * Everything below is imported dynamically, and that is deliberate.
 *
 * `env.ts` validates the environment as a side effect of being imported
 * (technical design §17), so a static import would make a bad variable throw
 * during module resolution -- before any handler exists to print the report,
 * and buried under a require stack. `env.schema.ts` above is side-effect free,
 * so the error type is safe to import statically.
 */
async function bootstrap(): Promise<void> {
  assertDecoratorMetadataIsEmitted();

  const { env } = await import('./platform/common/env.js');
  const { API_PREFIX } = await import('./platform/common/constants.js');
  const { REQUEST_ID_HEADER } = await import('./platform/common/request-id.js');
  const { AppModule } = await import('./app.module.js');

  // Buffered until the pino logger is attached, so startup lines are not
  // emitted in Nest's format and then everything else in JSON.
  // rawBody: the OpsTally webhook verifies an HMAC over the exact bytes it
  // was sent, so the parsed body is not enough — see SyncWebhookController.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));

  // Express/body-parser's default JSON cap is 100kb — fine for ordinary API
  // calls, but a 500-record OpsTally stock.snapshot/voucher.snapshot chunk
  // (full resync) blows past that easily. Respects the rawBody option above,
  // so the OpsTally webhook's HMAC verification is unaffected.
  app.useBodyParser('json', { limit: '15mb' });

  // OPEN-QUESTIONS P0-11. Behind a reverse proxy, `req.ip` is the proxy's
  // socket address until Express is told how many hops to trust -- and then
  // it believes exactly that many X-Forwarded-For entries, counted from the
  // right, no more. The count must match the real topology (Caddy in
  // production is 1): with 0 behind a proxy the per-IP login limit throttles
  // the whole company as one address; with too many, any client spoofs its
  // way past it by writing the header itself. 0 -- the dev default -- leaves
  // Express untouched, so the no-proxy topology behaves exactly as before.
  if (env.TRUST_PROXY_HOPS > 0) {
    const express = app.getHttpAdapter().getInstance();
    express.set('trust proxy', env.TRUST_PROXY_HOPS);
  }

  app.setGlobalPrefix(API_PREFIX);

  app.use(helmet({
    // The API serves JSON to a web client on a different origin. Helmet's
    // default same-origin resource policy is written for a server that also
    // serves the page, and would block those responses in some browsers.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.enableCors({
    // Exactly one origin, from validated config. No wildcard: `credentials`
    // below carries the rotating refresh cookie (ADR 0002).
    origin: [env.WEB_BASE_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', REQUEST_ID_HEADER],
    // Without this the browser can see the header but script cannot read it,
    // and the web client has nothing to quote in a bug report.
    exposedHeaders: [REQUEST_ID_HEADER],
  });

  // Runs onApplicationShutdown on SIGTERM and SIGINT, which is what ends the
  // Postgres pool (DbModule).
  app.enableShutdownHooks();
  installShutdownWatchdog();

  await app.listen(env.PORT);

  const logger = app.get(Logger);
  logger.log({
    msg: `🚀 API server is listening on ${env.API_BASE_URL}/${API_PREFIX}`,
    port: env.PORT,
    storage: env.STORAGE_DRIVER,
  });
}

/**
 * The backstop for a shutdown that will not finish.
 *
 * `JobRunner` bounds every stage of its own teardown, so the hook returns; a
 * socket a driver refuses to release can still hold the event loop open after
 * it, and the process would linger with nothing left to do. Docker sends
 * SIGKILL after its grace period and the deploy is marked failed, so exiting
 * on our own terms -- after the hooks have had their turn -- is strictly
 * better than being killed.
 *
 * `unref` is what keeps this from being the thing that delays exit: a process
 * that is otherwise finished does not wait for this timer.
 */
function installShutdownWatchdog(): void {
  // Comfortably past the bounded queue teardown (`SHUTDOWN_BUDGET_MS`) plus
  // the Redis and Postgres hooks that run after it, and comfortably inside the
  // `stop_grace_period` the production compose states -- a watchdog that fires
  // after Docker's SIGKILL is no watchdog at all, which the first version of
  // this was: it forced the exit at 15s, and the default grace is 10.
  const GRACE_MS = 12_000;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      setTimeout(() => {
        process.stderr.write(
          `${signal} received ${String(GRACE_MS / 1000)}s ago and the process has not exited; forcing it. ` +
            'Something is holding the event loop open -- check the shutdown warnings above.\n',
        );
        process.exit(1);
      }, GRACE_MS).unref();
    });
  }
}

bootstrap().catch((error: unknown) => {
  // Both of these report themselves: the message is the whole report, and a
  // stack trace would only point at the parser or the driver, never at the
  // thing the reader has to fix.
  if (error instanceof EnvValidationError || error instanceof StartupError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`API failed to start: ${String(error)}\n`);
  if (error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
