import { Injectable, Logger } from '@nestjs/common';
import {
  AGENT_LEASE_TAKEOVER_MINUTES,
  NOTIFICATION_EVENTS,
  PERMISSIONS,
  SYNC_ENTITY_TYPES,
  type SyncEntityType,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';
import { orgContextOf, type Principal } from '../rbac/principal.js';

/**
 * What may actually be pulled today: only the entity types a writer exists
 * for. `SYNC_ENTITY_TYPES` is the contract's full vocabulary; this list
 * grows a member per writer, because a job the agent can claim but whose
 * results the API refuses is a treadmill, not a queue.
 */
// Item chunks must land before price chunks — the price writer resolves
// items through their GUID mappings — and the array order here is the order
// both the sweep enqueues and the agent works. Allocations resolve vouchers,
// which reach Vyuha through the webhook door rather than this queue, so no
// order here can guarantee them: an allocation whose voucher has not arrived
// is skipped and counted by the writer, never failed.
export const PULL_ENTITY_TYPES: readonly SyncEntityType[] = [
  'party',
  'stock_item',
  'price_list',
  'bill_allocation',
];

/**
 * A pull that five claims could not finish is not going to finish on the
 * sixth; it fails visibly instead of cycling the queue forever.
 */
const MAX_PULL_ATTEMPTS = 5;

/** D-20: bodies live thirty days; hashes are the evidence and never expire. */
export const JOURNAL_BODY_RETENTION_DAYS = 30;

/**
 * How long a delivered event's id stays in `sync_inbox`.
 *
 * The row *is* the idempotency key — a repeat of an event whose row is gone
 * would be processed a second time — so this has to comfortably outlive the
 * Agent's own retry window, which the OpsTally reference caps at twelve
 * attempts over ten hours. Ninety days is three orders of magnitude past
 * that, and keeps the inbox readable as a recent history of the exchange
 * rather than as everything that has ever arrived.
 */
export const INBOX_RETENTION_DAYS = 90;

/**
 * Rows removed per statement when pruning the inbox.
 *
 * The first sweep after this shipped may face a whole backlog. One statement
 * would hold locks across all of it; batching keeps each transaction short
 * enough that an agent posting an event never waits behind the sweep.
 */
const INBOX_PRUNE_BATCH = 5_000;

/**
 * Makes pull work exist (REQ-R-07): on the 15-minute sweep, and on demand.
 *
 * The interesting property is what this deliberately does not do — it never
 * checks whether a job is already open. The `sync_jobs_one_open_uq` index
 * holds "one open job per connection per entity type", and the enqueue is
 * `ON CONFLICT DO NOTHING` against it, so an agent that was away for a day
 * finds one waiting job rather than ninety-six copies, and two sweeps racing
 * cannot double-enqueue. The invariant lives in the schema; this service
 * only ever tries.
 */
@Injectable()
export class SyncSchedulerService {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly notifications: NotificationDispatcher,
  ) {}

  /**
   * REQ-Q-04: a heartbeat older than five minutes raises a notification —
   * once, on the transition, with the recovery announced the same way.
   *
   * Both transitions are UPDATEs whose predicates are the edge itself
   * (`stale_notified_at` null against not-null), so two sweeps racing cannot
   * double-notify: the second one's UPDATE matches zero rows. Connections
   * that never heartbeated stay silent here — DISCONNECTED-from-birth is the
   * Integrations screen's business; this sweep is about an agent that *was*
   * alive and stopped.
   *
   * Audience: `integration.manage` holders. 08 §2.2 names `tally.sync.run`,
   * which arrives with the Accounts role in the permission expansion; the
   * guard and this audience widen together.
   */
  async checkHeartbeatStaleness(): Promise<{ wentStale: number; recovered: number }> {
    const wentStale = await this.db.execute<{
      id: string;
      org_id: string;
      name: string;
      last_heartbeat_at: Date;
    }>(sql`
      UPDATE integration_connections
         SET stale_notified_at = now(), updated_at = now(), updated_by = NULL
       WHERE deleted_at IS NULL
         AND last_heartbeat_at IS NOT NULL
         AND last_heartbeat_at < now() - make_interval(mins => ${AGENT_LEASE_TAKEOVER_MINUTES})
         AND stale_notified_at IS NULL
         -- Webhook connections are heard from only when Tally changed; a
         -- quiet afternoon there is not a silence to alarm about.
         AND webhook_secret_enc IS NULL
       RETURNING id, org_id, name, last_heartbeat_at
    `);

    for (const row of wentStale.rows) {
      const lastBeat = new Date(row.last_heartbeat_at);
      await this.notifications.emit({
        orgId: row.org_id,
        type: NOTIFICATION_EVENTS.SYNC_AGENT_STALE,
        audience: { kind: 'permission', key: PERMISSIONS.INTEGRATION_MANAGE },
        payload: {
          connectionName: row.name,
          lastHeartbeatAt: lastBeat.toISOString(),
        },
        // Keyed by which silence this is: the same connection going quiet
        // again after recovering is a new fact and must notify again.
        idempotencyKey: `sync-stale-${row.id}-${String(lastBeat.getTime())}`,
      });
    }

    const recovered = await this.db.execute<{ id: string; org_id: string; name: string }>(sql`
      UPDATE integration_connections
         SET stale_notified_at = NULL, updated_at = now(), updated_by = NULL
       WHERE deleted_at IS NULL
         AND stale_notified_at IS NOT NULL
         AND last_heartbeat_at >= now() - make_interval(mins => ${AGENT_LEASE_TAKEOVER_MINUTES})
       RETURNING id, org_id, name
    `);

    for (const row of recovered.rows) {
      await this.notifications.emit({
        orgId: row.org_id,
        type: NOTIFICATION_EVENTS.SYNC_AGENT_RECOVERED,
        audience: { kind: 'permission', key: PERMISSIONS.INTEGRATION_MANAGE },
        payload: { connectionName: row.name },
      });
    }

    if (wentStale.rows.length > 0 || recovered.rows.length > 0) {
      this.logger.warn({
        msg: 'Agent staleness transitions',
        wentStale: wentStale.rows.length,
        recovered: recovered.rows.length,
      });
    }

    return { wentStale: wentStale.rows.length, recovered: recovered.rows.length };
  }

  /**
   * D-20's nightly sweep: null bodies older than the retention window —
   * the one UPDATE `vyuha_sync_journal_guard` permits, and the *only*
   * write this service ever makes to the journal. The predicate skips rows
   * already swept, so the nightly cost is proportional to one day's
   * exchanges, not to history.
   *
   * The inbox is pruned on the same pass. It had no retention at all: one
   * row per delivered event, kept forever, on the one table whose row count
   * is driven by how busy the customer's Tally is rather than by how much
   * data they hold. Rows still carrying a `payload` are left alone whatever
   * their age — those are the deferred vouchers `replayDeferred` has yet to
   * drain, and dropping one would lose the voucher, not merely its receipt.
   */
  async sweepJournalBodies(): Promise<{ cleared: number; pruned: number }> {
    const cleared = await this.db.execute<{ id: string }>(sql`
      UPDATE sync_journal
         SET request_body = NULL, response_body = NULL
       WHERE created_at < now() - make_interval(days => ${JOURNAL_BODY_RETENTION_DAYS})
         AND (request_body IS NOT NULL OR response_body IS NOT NULL)
       RETURNING id
    `);

    /*
     * `rowCount`, not `RETURNING id`. The first sweep on an installation that
     * has never pruned deletes every delivered row past retention, and
     * returning them materialised a UUID per row into this worker's heap
     * purely so `.length` could be read.
     *
     * Batched, so that first sweep is a series of short transactions rather
     * than one long one holding locks over the whole backlog; the loop stops
     * as soon as a batch comes back short.
     */
    let prunedInboxRows = 0;
    for (;;) {
      const batch = await this.db.execute(sql`
        DELETE FROM sync_inbox
         WHERE id IN (
           SELECT id FROM sync_inbox
            WHERE received_at < now() - make_interval(days => ${INBOX_RETENTION_DAYS})
              AND payload IS NULL
            LIMIT ${INBOX_PRUNE_BATCH}
         )
      `);
      const removed = batch.rowCount ?? 0;
      prunedInboxRows += removed;
      if (removed < INBOX_PRUNE_BATCH) break;
    }

    if (cleared.rows.length > 0 || prunedInboxRows > 0) {
      this.logger.log({
        msg: 'Journal bodies swept (D-20)',
        cleared: cleared.rows.length,
        prunedInboxRows,
      });
    }
    return { cleared: cleared.rows.length, pruned: prunedInboxRows };
  }

  /**
   * A pull job per eligible connection per writable entity type.
   *
   * Eligible means the job could actually be claimed: the connection is
   * alive, bound to a company (the claim refuses unbound ones), and holds an
   * issued credential (nothing could ever present otherwise). Enqueuing for
   * the ineligible would fill the queue with work whose refusal is already
   * known.
   */
  async enqueueDuePulls(): Promise<{ enqueued: number; requeued: number; failed: number }> {
    /*
     * First, unstick. A claim whose agent died — crash, lease takeover,
     * token rotation (which frees the lease but not the job) — would hold
     * its CLAIMED state forever, and the one-open-job invariant would then
     * refuse every future enqueue for that entity type: the queue wedges
     * shut, permanently, with nothing on any screen saying why. claimed_at
     * is a liveness mark, not a birth date: the writer refreshes it on every
     * ingested chunk, so "older than the takeover threshold" means the whole
     * exchange has been silent that long — a healthy agent mid-way through a
     * slow first backfill keeps its claim. Then it requeues; the results
     * path re-checks claimed_by, so a zombie's
     * late post after requeue answers 409, never a double write. Attempts
     * are counted at claim time; past five, the job fails instead of
     * cycling forever, and the failure is visible in the row.
     */
    const requeued = await this.db.execute<{ id: string }>(sql`
      UPDATE sync_jobs
         SET state = 'QUEUED', claimed_by = NULL, claimed_at = NULL, updated_at = now()
       WHERE state = 'CLAIMED'
         AND claimed_at < now() - make_interval(mins => ${AGENT_LEASE_TAKEOVER_MINUTES})
         AND attempts < ${MAX_PULL_ATTEMPTS}
       RETURNING id
    `);
    const failed = await this.db.execute<{ id: string }>(sql`
      UPDATE sync_jobs
         SET state = 'FAILED', updated_at = now()
       WHERE state = 'CLAIMED'
         AND claimed_at < now() - make_interval(mins => ${AGENT_LEASE_TAKEOVER_MINUTES})
         AND attempts >= ${MAX_PULL_ATTEMPTS}
       RETURNING id
    `);
    if (requeued.rows.length > 0 || failed.rows.length > 0) {
      this.logger.warn({
        msg: 'Stale claimed pull jobs swept',
        requeued: requeued.rows.length,
        failed: failed.rows.length,
      });
    }

    let enqueued = 0;
    for (const entityType of PULL_ENTITY_TYPES) {
      const result = await this.db.execute<{ id: string }>(sql`
        INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type)
        SELECT c.org_id, c.id, 'PULL', ${entityType}
          FROM integration_connections c
         WHERE c.deleted_at IS NULL
           AND c.company_guid IS NOT NULL
           AND c.agent_token_hash IS NOT NULL
        ON CONFLICT (connection_id, entity_type) WHERE state IN ('QUEUED', 'CLAIMED')
        DO NOTHING
        RETURNING id
      `);
      enqueued += result.rows.length;
    }

    if (enqueued > 0) {
      this.logger.log({ msg: 'Pull jobs enqueued by sweep', enqueued });
    }
    return { enqueued, requeued: requeued.rows.length, failed: failed.rows.length };
  }

  /**
   * REQ-R-07's "and on demand" (09 §5's manual pull), from the Integrations
   * screen. The refusals name their rule: an entity type without a writer is
   * a build limitation worth saying plainly, and an already-open job means
   * the ask is already answered — the existing job is returned rather than
   * an error page.
   */
  /**
   * REQ-R-05's second sentence: a full re-pull is an explicit administrative
   * action, not a fallback. `full` deletes the cursor -- the administrative
   * re-pull action by definition -- and stamps the job's payload, which is
   * what licenses the writer to mark what did not arrive (REQ-R-06). An
   * incremental pull can never mark: a chunk above the cursor is a window,
   * and absence from a window proves nothing.
   */
  async enqueueManualPull(
    principal: Principal,
    connectionId: string,
    requested: string,
    full = false,
  ): Promise<{ jobId: string; entityType: SyncEntityType; alreadyQueued: boolean }> {
    const entityType = PULL_ENTITY_TYPES.find((candidate) => candidate === requested);
    if (entityType === undefined) {
      const known = (SYNC_ENTITY_TYPES as readonly string[]).includes(requested);
      throw AppError.validation(
        known
          ? `This build cannot pull "${requested}" yet; its writer lands later in Phase 6b.`
          : `"${requested}" is not a sync entity type.`,
        { fields: [{ path: 'entityType', message: 'not pullable' }] },
      );
    }

    const ctx = orgContextOf(principal);
    const eligible = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM integration_connections
       WHERE id = ${connectionId}
         AND org_id = ${ctx.orgId}
         AND deleted_at IS NULL
         AND company_guid IS NOT NULL
         AND agent_token_hash IS NOT NULL
    `);
    if (eligible.rows[0] === undefined) {
      throw AppError.conflict(
        'This connection cannot be pulled: it must exist, be bound to a Tally company, and ' +
          'have an agent token issued. Bind the company and issue the token first.',
      );
    }

    const payload = full ? JSON.stringify({ full: true }) : null;
    const insertedId = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO sync_jobs (org_id, connection_id, direction, entity_type, payload, created_by)
        VALUES (${ctx.orgId}, ${connectionId}, 'PULL', ${entityType}, ${payload}::jsonb, ${ctx.actorUserId})
        ON CONFLICT (connection_id, entity_type) WHERE state IN ('QUEUED', 'CLAIMED')
        DO NOTHING
        RETURNING id
      `);
      const id = inserted.rows[0]?.id;
      if (id !== undefined && full) {
        // Deleting the cursor IS the re-pull (REQ-R-05): the next claim asks
        // Tally for everything above zero. In the same transaction as the
        // job, so a crash cannot leave a full job whose cursor still gates.
        await tx.execute(sql`
          DELETE FROM sync_cursors
           WHERE connection_id = ${connectionId} AND entity_type = ${entityType}
        `);
      }
      return id;
    });

    if (insertedId !== undefined) {
      this.auditContext.record({
        action: 'sync.pull_requested',
        entityType: 'integration_connection',
        entityId: connectionId,
        after: { syncEntityType: entityType, jobId: insertedId, full },
      });
      return { jobId: insertedId, entityType, alreadyQueued: false };
    }

    // The invariant answered: a job is already open. Saying which one keeps
    // the screen honest instead of making a second press look like a fault.
    const open = await this.db.execute<{ id: string; state: string }>(sql`
      SELECT id, state FROM sync_jobs
       WHERE connection_id = ${connectionId}
         AND entity_type = ${entityType}
         AND state IN ('QUEUED', 'CLAIMED')
       LIMIT 1
    `);
    const openRow = open.rows[0];
    if (openRow === undefined) {
      // The conflict target vanished between statements — a claim completed
      // it in the gap. Trying once more would almost certainly succeed, but
      // the sweep is minutes away and a plain answer beats a loop here.
      throw AppError.conflict('The queue moved while enqueuing; try again.');
    }

    if (full) {
      /*
       * An open job blocks a second one, but "make this one full" is still
       * answerable while it is only QUEUED: the payload upgrade happens
       * before any agent has read it. Once CLAIMED the agent is mid-flight
       * on incremental semantics, and rewriting the meaning of work in an
       * agent's hands is how a partial window gets treated as the whole
       * truth -- refused instead.
       */
      const upgraded = await this.db.transaction(async (tx) => {
        const marked = await tx.execute<{ id: string }>(sql`
          UPDATE sync_jobs SET payload = '{"full": true}'::jsonb, updated_at = now()
           WHERE id = ${openRow.id} AND state = 'QUEUED'
           RETURNING id
        `);
        if (marked.rows[0] === undefined) return false;
        await tx.execute(sql`
          DELETE FROM sync_cursors
           WHERE connection_id = ${connectionId} AND entity_type = ${entityType}
        `);
        return true;
      });
      if (!upgraded) {
        throw AppError.conflict(
          'A pull for this entity type is already running. Request the full re-pull again once it completes.',
        );
      }
      this.auditContext.record({
        action: 'sync.pull_requested',
        entityType: 'integration_connection',
        entityId: connectionId,
        after: { syncEntityType: entityType, jobId: openRow.id, full: true, upgraded: true },
      });
    }

    return { jobId: openRow.id, entityType, alreadyQueued: true };
  }
}
