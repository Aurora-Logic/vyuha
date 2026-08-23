import { Injectable, Logger } from '@nestjs/common';
import {
  AGENT_LEASE_TAKEOVER_MINUTES,
  type AgentClaimInput,
  type AgentClaimResponse,
  type AgentCondition,
  type AgentErrorAck,
  type AgentErrorInput,
  type AgentHeartbeatAck,
  type AgentHeartbeatInput,
  type ClaimedSyncJob,
  type VoucherPushPayload,
} from '@vyuha/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { PushOutcomeRegistry } from './push-outcome.registry.js';
import { integrationConnections } from '../db/schema/index.js';
import { requireAgentCompany, type AgentPrincipal } from './agent-principal.js';

/**
 * What the agent may do once its credential has resolved: say it is alive,
 * and ask for work (REQ-Q-02, REQ-Q-04, 09 §3.4).
 *
 * The lease is the invariant both methods defend — one agent per company,
 * because two agents pulling one cursor double-import and two pushing race
 * the idempotency check. Every decision that must hold under concurrency is
 * a predicate inside its own UPDATE, never an application-side check against
 * the principal's snapshot: the heartbeat's lease handover, and the claim's
 * lease-and-company requirement, are both enforced by the statement that
 * acts on them. The app-side checks exist only to turn a zero-row result
 * into a refusal that names its rule.
 *
 * Takeover timing: a rival may take a lease whose holder has been silent
 * past `AGENT_LEASE_TAKEOVER_MINUTES` — the same threshold the Integrations
 * screen uses for its STALE label, deliberately one number, so a connection
 * cannot change hands while the screen still calls it healthy.
 */
@Injectable()
export class SyncAgentService {
  private readonly logger = new Logger(SyncAgentService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly pushOutcomes: PushOutcomeRegistry,
  ) {}

  async heartbeat(agent: AgentPrincipal, input: AgentHeartbeatInput): Promise<AgentHeartbeatAck> {
    const condition = this.effectiveCondition(agent, input);

    /*
     * The lease changes hands inside the UPDATE's own predicate, so two rival
     * instances heartbeating together cannot both win: whichever statement
     * runs second sees the row the first one wrote and matches nothing.
     *
     * `updated_by` is explicitly null: this is a machine writing, and leaving
     * the last human editor's id under a fresh timestamp would read as that
     * person editing the connection around the clock.
     */
    // Postgres's clock on both sides of the comparison. The written
    // last_heartbeat_at and the takeover cutoff must come from one clock —
    // with two API instances whose clocks disagree, a JS-computed cutoff
    // widens or narrows the window by the skew, and a rival could seize a
    // lease from a live agent.
    const updated = await this.db
      .update(integrationConnections)
      .set({
        leaseHolder: input.agentInstanceId,
        lastHeartbeatAt: sql`now()`,
        agentVersion: input.agentVersion,
        // Preserved when omitted: the agent cannot read a version out of a
        // Tally that is closed, and "what version was installed" is part of
        // diagnosing exactly that condition (REQ-Q-04, Q-05).
        ...(input.tallyVersion === undefined ? {} : { tallyVersion: input.tallyVersion }),
        status: condition === 'OK' ? 'CONNECTED' : 'ERROR',
        lastCondition: condition,
        updatedAt: sql`now()`,
        updatedBy: null,
      })
      .where(
        and(
          eq(integrationConnections.id, agent.connectionId),
          isNull(integrationConnections.deletedAt),
          sql`(
            ${integrationConnections.leaseHolder} IS NULL
            OR ${integrationConnections.leaseHolder} = ${input.agentInstanceId}
            OR ${integrationConnections.lastHeartbeatAt} IS NULL
            OR ${integrationConnections.lastHeartbeatAt} < now() - make_interval(mins => ${AGENT_LEASE_TAKEOVER_MINUTES})
          )`,
        ),
      )
      .returning({ companyGuid: integrationConnections.companyGuid });

    const row = updated[0];
    if (row === undefined) {
      // 09 §3.4: two agents, one company — the second is refused, and the
      // refusal names the rule rather than reading as a credential problem.
      throw AppError.conflict(
        `Another agent instance holds this connection's lease. One agent per company; ` +
          `the lease frees ${String(AGENT_LEASE_TAKEOVER_MINUTES)} minutes after its holder's last heartbeat.`,
        { leaseTakeoverMinutes: AGENT_LEASE_TAKEOVER_MINUTES },
      );
    }

    if (agent.leaseHolder !== null && agent.leaseHolder !== input.agentInstanceId) {
      // A takeover is an operational event somebody may need to explain later
      // — two installs fighting is a misconfiguration this row is evidence
      // of. Recorded through the context so the interceptor attaches ip,
      // user agent and request id: for this event the caller's address IS
      // the evidence.
      this.auditContext.record({
        orgId: agent.orgId,
        actorUserId: null,
        action: 'sync.lease_taken_over',
        entityType: 'integration_connection',
        entityId: agent.connectionId,
        before: { leaseHolder: agent.leaseHolder },
        after: { leaseHolder: input.agentInstanceId },
      });
      this.logger.warn({
        msg: 'Sync lease taken over after silence',
        connectionId: agent.connectionId,
        previousHolder: agent.leaseHolder,
        newHolder: input.agentInstanceId,
      });
    } else {
      // Routine keepalive, the same reasoning as POST /auth/refresh: one row
      // per agent per minute would bury the entries that matter. The status
      // and condition it wrote are readable on the connection itself.
      this.auditContext.suppress();
    }

    return {
      connectionId: agent.connectionId,
      companyGuid: row.companyGuid,
      condition,
      leaseTakeoverMinutes: AGENT_LEASE_TAKEOVER_MINUTES,
    };
  }

  /**
   * The next queued job for this connection, claimed atomically.
   *
   * The inner SELECT joins the connection and restates the lease, the bound
   * company and liveness — not because the app-side checks below are
   * distrusted, but because they read a snapshot from credential resolution,
   * and between that read and this statement a rival can have taken the
   * lease (its holder went silent, its claim loop did not). With the rule in
   * the predicate, a stale claimant matches zero rows; the checks below only
   * exist to turn that into a refusal that names which rule refused.
   *
   * `FOR UPDATE SKIP LOCKED` makes a double poll harmless: two requests
   * racing on one queue each lock a different row or find none, and a job
   * can never be handed out twice.
   */
  async claim(agent: AgentPrincipal, input: AgentClaimInput): Promise<AgentClaimResponse> {
    this.requireLease(agent, input.agentInstanceId);
    requireAgentCompany(agent, input.openCompanyGuid);

    const rows = await this.db.execute<{
      id: string;
      direction: 'PULL' | 'PUSH';
      entity_type: string;
      payload: unknown;
      attempts: number;
      from_alter_id: number;
    }>(sql`
      UPDATE sync_jobs
         SET state = 'CLAIMED',
             claimed_by = ${input.agentInstanceId},
             claimed_at = now(),
             attempts = attempts + 1,
             updated_at = now()
       WHERE id = (
         SELECT j.id
           FROM sync_jobs j
           JOIN integration_connections c
             ON c.id = j.connection_id
            AND c.deleted_at IS NULL
            AND c.lease_holder = ${input.agentInstanceId}
            AND c.company_guid = ${input.openCompanyGuid ?? null}
          WHERE j.connection_id = ${agent.connectionId}
            AND j.state = 'QUEUED'
          ORDER BY j.created_at
          LIMIT 1
          FOR UPDATE OF j SKIP LOCKED
       )
       RETURNING id, direction, entity_type, payload, attempts,
         -- The server's watermark rides on the claim: the agent pulls above
         -- this, and after a full re-pull (cursor deleted) it is zero.
         (SELECT COALESCE(sc.last_alter_id, 0) FROM sync_cursors sc
           WHERE sc.connection_id = sync_jobs.connection_id
             AND sc.entity_type = sync_jobs.entity_type) AS from_alter_id
    `);

    // The claim is the audit trail here: sync_jobs carries claimed_by and
    // claimed_at, and an audit row per poll of an empty queue would be noise.
    this.auditContext.suppress();

    const row = rows.rows[0];
    if (row === undefined) {
      // Zero rows has two readings and they demand opposite behaviour from
      // the agent: an empty queue means sleep, a predicate refusal means the
      // snapshot the app-side checks passed on has gone stale — a rival took
      // the lease, an admin rebound the company — and the agent must
      // heartbeat, not idle believing there is no work while a QUEUED job
      // sits unclaimed. Diagnose before answering "empty".
      await this.refuseIfDeposed(agent, input);
      return { job: null };
    }

    const job: ClaimedSyncJob = {
      id: row.id,
      direction: row.direction,
      entityType: row.entity_type,
      payload: row.payload,
      attempts: row.attempts,
      fromAlterId: Number(row.from_alter_id ?? 0),
    };
    return { job };
  }

  /**
   * The agent's failure report (09 §5): one transaction that journals the
   * exchange, fails the job this instance holds (if it named one), and
   * raises the exception REQ-T-01 puts in front of a person.
   *
   * The job UPDATE carries the same ownership predicate the writer uses —
   * this connection, this instance, still CLAIMED — so a report from a
   * deposed agent cannot fail a job its successor is working. A report that
   * matches no job still journals and still raises the exception: the error
   * happened whether or not the queue remembers the work.
   */
  async reportError(agent: AgentPrincipal, input: AgentErrorInput): Promise<AgentErrorAck> {
    const outcome = await this.db.transaction(async (tx) => {
      // Pulls are the only direction until the push slices land; the journal
      // needs a direction and PULL is the only one that can have produced an
      // agent-side error today.
      await tx.execute(sql`
        INSERT INTO sync_journal
          (org_id, connection_id, direction, entity_type, request_hash, response_hash,
           request_body, response_body, result, error_code, error_text, duration_ms)
        VALUES
          (${agent.orgId}, ${agent.connectionId}, 'PULL', ${input.entityType ?? null},
           ${input.requestHash ?? 'unrecorded'}, ${input.responseHash ?? null},
           ${input.requestBody ?? null}, ${input.responseBody ?? null},
           'error', ${input.errorCode ?? null}, ${input.errorText},
           ${input.durationMs ?? null})
      `);

      let jobFailed = false;
      if (input.jobId !== undefined) {
        const failed = await tx.execute<{ id: string; entity_type: string; payload: VoucherPushPayload | null }>(sql`
          UPDATE sync_jobs
             SET state = 'FAILED', updated_at = now()
           WHERE id = ${input.jobId}
             AND connection_id = ${agent.connectionId}
             AND state = 'CLAIMED'
             AND claimed_by = ${input.agentInstanceId}
           RETURNING id, entity_type, payload
        `);
        jobFailed = failed.rows.length > 0;
        // A failed push has to reach the document it was for. Only the job
        // used to be marked, so the order stayed QUEUED for ever: the screen
        // said it was with the agent, Push refused because it was already
        // queued, and there was no way forward from either. The document
        // hears the same 'rejected' it hears down the results path.
        const row = failed.rows[0];
        if (row?.payload != null && row.entity_type.startsWith('voucher_push:')) {
          const handler = this.pushOutcomes.find(row.payload.kind);
          await handler?.onOutcome(tx, agent.orgId, row.payload, {
            outcome: 'rejected',
            remoteGuid: null,
            remoteVoucherNumber: null,
            errorText: input.errorText,
          });
        }
      }

      const exception = await tx.execute<{ id: string }>(sql`
        INSERT INTO sync_exceptions
          (org_id, connection_id, kind, entity_type, tally_error)
        VALUES
          (${agent.orgId}, ${agent.connectionId}, 'AGENT_ERROR',
           ${input.entityType ?? null}, ${input.errorText})
        RETURNING id
      `);
      const exceptionId = exception.rows[0]?.id;
      if (exceptionId === undefined) throw new Error('Exception insert returned no row.');

      return { exceptionId, jobFailed };
    });

    // Rare and material, unlike the heartbeat: this one keeps its audit row.
    this.logger.warn({
      msg: 'Agent reported an error',
      connectionId: agent.connectionId,
      entityType: input.entityType ?? null,
      errorCode: input.errorCode ?? null,
      jobFailed: outcome.jobFailed,
    });

    return outcome;
  }

  // ------------------------------------------------------------- internals

  /**
   * Why did a claim over a non-empty queue match nothing? Read-only, and only
   * reached on the zero-row path, so the common case — genuinely no work —
   * costs one SELECT. A stale read here at worst repeats the old behaviour
   * (null instead of a name), never the reverse.
   */
  private async refuseIfDeposed(agent: AgentPrincipal, input: AgentClaimInput): Promise<void> {
    const queued = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM sync_jobs
       WHERE connection_id = ${agent.connectionId} AND state = 'QUEUED'
       LIMIT 1
    `);
    if (queued.rows[0] === undefined) return;

    const fresh = await this.db.execute<{ lease_holder: string | null; company_guid: string | null }>(
      sql`
        SELECT lease_holder, company_guid FROM integration_connections
         WHERE id = ${agent.connectionId} AND deleted_at IS NULL
      `,
    );
    const connection = fresh.rows[0];
    if (connection === undefined) {
      throw AppError.conflict(
        'This connection is no longer alive; its queued work will not be handed out.',
      );
    }
    if (connection.lease_holder !== input.agentInstanceId) {
      throw AppError.conflict(
        'The connection lease moved to another instance between poll and claim. Heartbeat ' +
          'first; only the current holder may claim.',
      );
    }
    if (connection.company_guid !== (input.openCompanyGuid ?? null)) {
      throw AppError.conflict(
        'The bound company changed between poll and claim. Open the currently bound company ' +
          'and heartbeat again.',
        { expectedCompanyGuid: connection.company_guid },
      );
    }
    // Lock contention from a racing poll, or the job was claimed mid-flight:
    // nothing is wrong, and the next poll answers normally.
  }

  /**
   * REQ-Q-05, the server's half: whatever the agent self-reports, a reported
   * company GUID that disagrees with the bound one is `WRONG_COMPANY_OPEN` —
   * a confused agent cannot call the wrong books "OK". An unbound connection
   * cannot mismatch; an agent that omitted the GUID is reporting a condition
   * where no company is readable, which its own `condition` already names.
   */
  private effectiveCondition(agent: AgentPrincipal, input: AgentHeartbeatInput): AgentCondition {
    if (input.condition !== 'OK') return input.condition;
    if (
      agent.companyGuid !== null &&
      input.openCompanyGuid !== undefined &&
      input.openCompanyGuid !== agent.companyGuid
    ) {
      return 'WRONG_COMPANY_OPEN';
    }
    return 'OK';
  }

  /** Claims are lease-holder only; the heartbeat is where a lease is won. */
  private requireLease(agent: AgentPrincipal, instanceId: string): void {
    if (agent.leaseHolder === instanceId) return;
    throw AppError.conflict(
      'This instance does not hold the connection lease. Heartbeat first; if another ' +
        'instance is alive, only it may claim work.',
    );
  }
}
