import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { env, isProduction } from '../common/env.js';
import { describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { redisPing } from './redis-ping.js';

/**
 * Technical design §17 asks for `/health` and `/ready`. They answer different
 * questions and must not be merged: liveness says "this process is not wedged,
 * do not restart it", readiness says "this process can serve traffic, send it
 * some". A liveness probe that touches Postgres restarts the API every time
 * the database hiccups, which is precisely the wrong response.
 */

export type DependencyState = 'ok' | 'down';

export interface DependencyResult {
  status: DependencyState;
  latencyMs: number;
  /** Withheld in production; a connection error names hosts and ports. */
  error?: string;
}

import { buildInfo } from './build-info.js';

export interface LivenessResult {
  status: 'ok';
  uptimeSeconds: number;
  /** Which build answered. See `build-info.ts` for why this is here. */
  version: string;
  commit: string;
  builtAt: string | null;
}

export interface ReadinessResult {
  status: 'ok' | 'degraded';
  checks: Record<string, DependencyResult>;
}

const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  liveness(): LivenessResult {
    const build = buildInfo();
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: build.version,
      commit: build.commit,
      builtAt: build.builtAt,
    };
  }

  async readiness(): Promise<ReadinessResult> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    const checks = { postgres, redis };
    const degraded = Object.values(checks).some((check) => check.status === 'down');
    return { status: degraded ? 'degraded' : 'ok', checks };
  }

  private async checkPostgres(): Promise<DependencyResult> {
    return this.timed('postgres', async () => {
      // Goes through the same pool the application uses, so a pool that has
      // run out of connections reads as down rather than as healthy.
      await this.db.execute(sql`select 1`);
    });
  }

  private async checkRedis(): Promise<DependencyResult> {
    if (!env.JOBS_WORKER_ENABLED) {
      return { status: 'ok', latencyMs: 0 };
    }
    return this.timed('redis', () => redisPing(env.REDIS_URL, CHECK_TIMEOUT_MS));
  }

  private async timed(name: string, probe: () => Promise<void>): Promise<DependencyResult> {
    const started = process.hrtime.bigint();
    const elapsed = (): number => Number((process.hrtime.bigint() - started) / 1_000_000n);

    try {
      await probe();
      return { status: 'ok', latencyMs: elapsed() };
    } catch (error: unknown) {
      const message = describeError(error);
      // Logged in full regardless of environment; the response is the only
      // place the detail is held back.
      this.logger.warn({ msg: `Readiness check failed: ${name}`, dependency: name, err: message });
      const result: DependencyResult = { status: 'down', latencyMs: elapsed() };
      if (!isProduction) result.error = message;
      return result;
    }
  }
}
