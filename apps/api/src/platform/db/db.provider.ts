import { Inject, Logger, type Provider } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../common/env.js';

/**
 * ADR 0001: "The Drizzle client is created without a global schema generic,
 * and code uses the builder API (`db.select().from(table)`) rather than the
 * relational API (`db.query.users.findMany()`)."
 *
 * The relational API needs every table registered on one client object, which
 * would force `platform/` to import `modules/` and break the §1 dependency
 * rule. `Record<string, never>` is the type-level statement of that: there is
 * no `db.query` to reach for, so the boundary cannot be crossed by accident.
 */
export type Database = NodePgDatabase<Record<string, never>>;

export const DRIZZLE = 'DRIZZLE';
export const PG_POOL = 'PG_POOL';

/** Constructor sugar so call sites do not repeat the token string. */
export const InjectDatabase = (): ParameterDecorator => Inject(DRIZZLE);
export const InjectPool = (): ParameterDecorator => Inject(PG_POOL);

export const pgPoolProvider: Provider = {
  provide: PG_POOL,
  useFactory: (): Pool => {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      // Without a bound, a Postgres that is up but not accepting connections
      // turns every request into a hang instead of a 503 from /ready.
      connectionTimeoutMillis: 5_000,
      // Shows up in pg_stat_activity, which is the difference between "some
      // connection is holding a lock" and "the API is holding a lock".
      application_name: 'vyuha-api',
    });

    // node-postgres emits 'error' on the pool when an *idle* client dies --
    // a database restart, a network blip, an idle-session timeout. With no
    // listener Node treats it as an unhandled 'error' event and kills the
    // process, so the API would go down every time Postgres bounced.
    const logger = new Logger('Database');
    pool.on('error', (error: Error) => {
      logger.error({
        msg: 'Idle Postgres client errored; the pool will replace it.',
        err: { name: error.name, message: error.message, stack: error.stack },
      });
    });

    // Auto-terminate orphaned transactions if they remain idle in transaction for >30s
    pool.on('connect', (client) => {
      client.query("SET idle_in_transaction_session_timeout = '30000'").catch(() => {});
      client.query("SET statement_timeout = '120000'").catch(() => {});
    });

    return pool;
  },
};

export const drizzleProvider: Provider = {
  provide: DRIZZLE,
  inject: [PG_POOL],
  useFactory: (pool: Pool): Database => drizzle(pool),
};

/**
 * One statement-executor type for code inside a `db.transaction` callback.
 * Derived once here: four services each derived it privately, and a drizzle
 * signature change would have needed four coordinated edits.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
