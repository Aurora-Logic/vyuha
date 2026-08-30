import { Injectable, Logger } from '@nestjs/common';
import {
  PUSH_KINDS,
  voucherPushPayloadSchema,
  type AgentResultsAck,
  type AgentResultsInput,
  type BillAllocationPullRow,
  type PartyPullRow,
  type PriceListPullRow,
  type PushKind,
  type StockItemPullRow,
  type VoucherPullRow,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AppError } from '../common/errors.js';
import { isUniqueViolation } from '../db/pg-error.js';
import { PushOutcomeRegistry, type PushOutcome } from './push-outcome.registry.js';
import { InjectDatabase, type Database, type Transaction } from '../db/db.provider.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { requireAgentCompany, type AgentPrincipal } from './agent-principal.js';

/**
 * The only code that writes a projection table (09 §1.1, §3.2, REQ-T-03).
 *
 * One chunk, one transaction, and the ordering inside it is the design:
 * rows upsert on GUID, the journal records the exchange, the cursor
 * advances, and — on the final chunk — the job completes, all together or
 * not at all. A crash mid-chunk therefore re-reads a chunk and never skips
 * one: the cursor cannot be ahead of data that committed, and a re-posted
 * chunk upserts the same GUIDs to the same values (idempotent by
 * construction, which is what makes the agent's retry safe).
 *
 * Tally wins, silently (REQ-T-03). A projection row that differs from what
 * the pull carries is normal operation, not a conflict; it is overwritten
 * without ceremony because that is what "system of record" means
 * operationally.
 */

/**
 * What the mapping lookup decided about a GUID, once the ownership rules
 * have been applied. `internalId` is null when the GUID is unmapped and an
 * insert is the right move.
 */
interface MappingDecision {
  readonly internalId: string | null;
}

/** Everything anchored in `external_refs` by a Tally GUID. */
type MappedEntity = 'party' | 'stock_item' | 'voucher';

/**
 * The two facts every projection write is scoped by. `AgentPrincipal`
 * satisfies it structurally; so does a verified webhook delivery. Nothing
 * below reads more than these, which is what lets one writer serve both
 * doors without a second copy of the ownership rules.
 */
export interface WriterScope {
  readonly orgId: string;
  readonly connectionId: string;
}

@Injectable()
export class SyncWriterService {
  private readonly logger = new Logger(SyncWriterService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly pushOutcomes: PushOutcomeRegistry,
    private readonly jobs: JobRunner,
  ) {}

  async ingest(agent: AgentPrincipal, input: AgentResultsInput): Promise<AgentResultsAck> {
    requireAgentCompany(agent, input.openCompanyGuid);

    const written = await this.db.transaction(async (tx) => {
      /*
       * The job row is the lock and the rulebook: it must be this
       * connection's, claimed by this instance, and about this entity.
       * FOR UPDATE serialises competing posts for one job, and the WHERE is
       * the enforcement — the checks re-state the rule the claim already
       * put in its own predicate, at results time, because a lease can have
       * moved between poll and post.
       */
      // A push job's entity_type is `voucher_push:<document id>` — one open
      // push per document, not one per connection — so the results match on
      // the kind before the colon.
      const jobs = await tx.execute<{ id: string; payload: unknown; created_at: Date }>(sql`
        SELECT id, payload, created_at FROM sync_jobs
         WHERE id = ${input.jobId}
           AND connection_id = ${agent.connectionId}
           AND state = 'CLAIMED'
           AND claimed_by = ${input.agentInstanceId}
           AND split_part(entity_type, ':', 1) = ${input.entityType}
           FOR UPDATE
      `);
      const job = jobs.rows[0];
      if (job === undefined) {
        throw AppError.conflict(
          'These results match no claimed job for this connection and instance. The job may ' +
            'have been completed, failed, or claimed over; poll again rather than re-posting.',
        );
      }

      if (input.entityType === 'voucher_push') {
        await this.settlePush(tx, agent, job.id, job.payload, input);
        return { written: 0, skipped: 0, lastAlterId: 0, pushed: true };
      }

      // The discriminant narrows `rows`; a chunk of stock items claiming to
      // be parties never got past validation.
      let skipped = 0;
      if (input.entityType === 'party') {
        for (const row of input.rows) await this.upsertParty(tx, agent, row);
      } else if (input.entityType === 'stock_item') {
        for (const row of input.rows) await this.upsertStockItem(tx, agent, row);
      } else if (input.entityType === 'price_list') {
        for (const row of input.rows) await this.upsertPriceEntry(tx, agent, row);
      } else {
        skipped = await this.replaceBillAllocations(tx, agent, input.rows);
      }

      // REQ-Q-06: the exchange, hashed. `result` is the writer's outcome —
      // the agent's own errors arrive on the errors endpoint, never here.
      // Skips are part of that outcome: the journal is where "this chunk
      // carried rows the projection could not anchor yet" stays visible.
      const journalResult =
        skipped === 0
          ? `ok: ${String(input.rows.length)} rows`
          : `ok: ${String(input.rows.length - skipped)} rows, ${String(skipped)} skipped: voucher not yet pulled`;
      await tx.execute(sql`
        INSERT INTO sync_journal
          (org_id, connection_id, direction, entity_type, request_hash, response_hash,
           request_body, response_body, result, duration_ms)
        VALUES
          (${agent.orgId}, ${agent.connectionId}, 'PULL', ${input.entityType},
           ${input.requestHash}, ${input.responseHash},
           ${input.requestBody ?? null}, ${input.responseBody ?? null},
           ${journalResult}, ${input.durationMs ?? null})
      `);

      /*
       * GREATEST, not assignment: chunks can arrive with interleaved AlterID
       * ranges after a retry, and a cursor that moved backwards would
       * re-request everything above the lower mark forever. Advancing only
       * inside the transaction that committed the rows is the property 09
       * §3.2 names: a crash re-reads a chunk, it never skips one.
       */
      const maxAlterId = input.rows.reduce((max, row) => Math.max(max, row.alterId), 0);
      let committedAlterId = 0;
      if (input.rows.length > 0) {
        const cursor = await tx.execute<{ last_alter_id: number }>(sql`
          INSERT INTO sync_cursors (org_id, connection_id, entity_type, last_alter_id, last_run_at)
          VALUES (${agent.orgId}, ${agent.connectionId}, ${input.entityType}, ${maxAlterId}, now())
          ON CONFLICT (connection_id, entity_type)
          DO UPDATE SET last_alter_id = GREATEST(sync_cursors.last_alter_id, EXCLUDED.last_alter_id),
                        last_run_at = now(),
                        updated_at = now()
          RETURNING last_alter_id
        `);
        committedAlterId = Number(cursor.rows[0]?.last_alter_id ?? maxAlterId);
      }

      if (input.final) {
        /*
         * REQ-R-06, licensed by the payload alone: only a full pull may say
         * what is absent, because only a full pull saw everything. The
         * watermark is the job's created_at, not claimed_at -- the liveness
         * refresh moves claimed_at on every chunk, and the one-open-job
         * invariant guarantees no rival same-entity pull touched mappings in
         * between. Every row this job carried has last_pulled_at after the
         * watermark; whatever does not is gone from Tally, and is marked,
         * never deleted -- anything pointing at it keeps resolving.
         */
        const isFull =
          typeof job.payload === 'object' &&
          job.payload !== null &&
          (job.payload as { full?: unknown }).full === true;
        if (isFull && (input.entityType === 'party' || input.entityType === 'stock_item')) {
          await this.markAbsentees(tx, agent, input.entityType, new Date(job.created_at));
        }
        if (isFull && input.entityType === 'price_list') {
          await this.deleteStalePriceEntries(tx, agent, new Date(job.created_at));
        }

        await tx.execute(sql`
          UPDATE sync_jobs SET state = 'DONE', updated_at = now() WHERE id = ${input.jobId}
        `);
      } else {
        // claimed_at doubles as the liveness mark the unstick sweep reads.
        // Without this refresh, a first backfill slower than the takeover
        // threshold is requeued out from under an agent that is actively
        // posting — every chunk after the flip 409s, attempts climb to the
        // cap, and a perfectly healthy large pull is declared FAILED.
        await tx.execute(sql`
          UPDATE sync_jobs SET claimed_at = now(), updated_at = now() WHERE id = ${input.jobId}
        `);
      }

      return {
        written: input.rows.length - skipped,
        skipped,
        lastAlterId: committedAlterId,
        pushed: false,
      };
    });

    if (written.pushed) {
      this.logger.log({ msg: 'Push outcome settled', connectionId: agent.connectionId, jobId: input.jobId });
      return { jobId: input.jobId, written: 0, lastAlterId: 0, jobState: 'DONE' };
    }

    this.logger.log({
      msg: 'Pull chunk ingested',
      connectionId: agent.connectionId,
      entityType: input.entityType,
      rows: written.written,
      skipped: written.skipped,
      final: input.final,
    });

    // 15 REQ-AO-13: the masters have changed; the duplicate detector reads
    // them once the pull is whole. One job per organisation and entity type,
    // so a burst of final chunks is one detection. A refusal to enqueue must
    // not fail the ack -- the agent would resend a chunk already committed.
    if (input.final && (input.entityType === 'party' || input.entityType === 'stock_item')) {
      try {
        // The id dedupes a burst of final chunks, not every pull for ever:
        // BullMQ remembers a completed job id, so a constant one would run the
        // detector once and silently drop every later pull. The minute is the
        // window a burst lives in.
        const minute = new Date().toISOString().slice(0, 16).replace(/[:T-]/gu, '');
        await this.jobs.enqueue('detect-duplicates', { orgId: agent.orgId, entityType: input.entityType, requestedAt: new Date().toISOString() }, { jobId: `duplicates-${agent.orgId}-${input.entityType}-${minute}` });
      } catch (error) {
        this.logger.error({ msg: 'Duplicate detection could not be enqueued after a pull', orgId: agent.orgId, entityType: input.entityType, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      jobId: input.jobId,
      written: written.written,
      ...(written.skipped > 0 ? { skipped: written.skipped } : {}),
      // The watermark THIS transaction committed, read inside it via
      // RETURNING — a post-commit read could report a rival chunk's later
      // cursor as if this chunk had established it.
      lastAlterId: written.lastAlterId,
      jobState: input.final ? 'DONE' : 'CLAIMED',
    };
  }

  /** REQ-R-06's marking half; see the final-chunk comment for the licence. */
  private async markAbsentees(
    tx: Transaction,
    agent: WriterScope,
    entityType: 'party' | 'stock_item',
    watermark: Date,
  ): Promise<void> {
    // Two branches rather than an interpolated table name: the projection
    // tables are code, not data, and a fixed statement per table keeps this
    // greppable next to the upserts it mirrors.
    const marked =
      entityType === 'party'
        ? await tx.execute<{ id: string }>(sql`
            UPDATE parties p
               SET absent_in_tally = true, updated_at = now()
              FROM external_refs x
             WHERE x.internal_type = 'party' AND x.internal_id = p.id
               AND x.org_id = ${agent.orgId}
               AND x.system = 'TALLY'
               AND x.entity_type = 'party'
               AND x.connection_id = ${agent.connectionId}
               AND x.deleted_at IS NULL
               AND x.last_pulled_at < ${watermark}
               AND p.connection_id = ${agent.connectionId}
               AND p.absent_in_tally = false
            RETURNING p.id
          `)
        : await tx.execute<{ id: string }>(sql`
            UPDATE stock_items i
               SET absent_in_tally = true, updated_at = now()
              FROM external_refs x
             WHERE x.internal_type = 'stock_item' AND x.internal_id = i.id
               AND x.org_id = ${agent.orgId}
               AND x.system = 'TALLY'
               AND x.entity_type = 'stock_item'
               AND x.connection_id = ${agent.connectionId}
               AND x.deleted_at IS NULL
               AND x.last_pulled_at < ${watermark}
               AND i.connection_id = ${agent.connectionId}
               AND i.absent_in_tally = false
            RETURNING i.id
          `);

    if (marked.rows.length > 0) {
      this.logger.warn({
        msg: 'Masters absent after full pull (REQ-R-06)',
        connectionId: agent.connectionId,
        entityType,
        marked: marked.rows.length,
      });
    }
  }

  /**
   * P6b-1 (owner decision 28 Aug 2026), REQ-R-03/R-06: on the final chunk of
   * a FULL price_list pull, entries the job did not touch are deleted — the
   * same created_at watermark markAbsentees trusts, under the same licence
   * (only a full pull saw everything; an incremental window proves nothing,
   * so it never reaches here). Deleted rather than marked, unlike the
   * masters: a rate is a derived row nothing references, it carries no
   * absent flag, and a stale rate shown as current is worse than a gap.
   * This is the one place the sync engine hard-deletes on its own
   * initiative.
   */
  private async deleteStalePriceEntries(
    tx: Transaction,
    agent: WriterScope,
    watermark: Date,
  ): Promise<void> {
    const removed = await tx.execute<{ id: string }>(sql`
      DELETE FROM price_list_entries
       WHERE org_id = ${agent.orgId}
         AND connection_id = ${agent.connectionId}
         AND last_pulled_at < ${watermark}
       RETURNING id
    `);

    if (removed.rows.length > 0) {
      this.logger.warn({
        msg: 'Stale price entries deleted after full pull (P6b-1)',
        connectionId: agent.connectionId,
        deleted: removed.rows.length,
      });
    }
  }

  /**
   * The projection writes alone, for a source that owns its own transaction,
   * journal row and idempotency (the OpsTally webhook receiver). Same rows,
   * same ownership rules, same "Tally wins": a master reaching Vyuha by push
   * lands exactly as one reaching it by pull would.
   */
  async applyRows(
    tx: Transaction,
    scope: WriterScope,
    rows:
      | { entityType: 'party'; rows: readonly PartyPullRow[] }
      | { entityType: 'stock_item'; rows: readonly StockItemPullRow[] }
      | { entityType: 'voucher'; rows: readonly VoucherPullRow[] },
  ): Promise<void> {
    if (rows.entityType === 'party') {
      for (const row of rows.rows) await this.upsertParty(tx, scope, row);
    } else if (rows.entityType === 'stock_item') {
      for (const row of rows.rows) await this.upsertStockItem(tx, scope, row);
    } else {
      for (const row of rows.rows) await this.upsertVoucher(tx, scope, row);
    }
  }

  /*
   * One org-wide lookup, but the decision reads the mapping's OWNER.
   * GUIDs are per-company in Tally, so a mapping held by a *living* other
   * connection is a forgery (or two connections misconfigured onto one
   * company) and refuses — an org-blind upsert here would let connection
   * B's credential overwrite A's projection, the exact crossing the 6b
   * exit gate forbids. A mapping whose owning connection is soft-deleted
   * is different: it is the residue of a replaced connection for the same
   * books, and refusing it would mean a recreated connection could never
   * re-pull its own masters. Those are adopted — repointed to the caller
   * — because the GUID, not the connection row, is the identity of the
   * record (09 §4.1). Stated once, for every GUID-anchored entity type.
   */
  private async resolveMapping(
    tx: Transaction,
    agent: WriterScope,
    entityType: MappedEntity,
    guid: string,
  ): Promise<MappingDecision> {
    const existing = await tx.execute<{
      internal_id: string;
      owner_alive: boolean;
      is_mine: boolean;
    }>(sql`
      SELECT x.internal_id,
             (c.id IS NOT NULL AND c.deleted_at IS NULL) AS owner_alive,
             (x.connection_id = ${agent.connectionId}) AS is_mine
        FROM external_refs x
        LEFT JOIN integration_connections c ON c.id = x.connection_id
       WHERE x.org_id = ${agent.orgId}
         AND x.system = 'TALLY'
         AND x.entity_type = ${entityType}
         AND x.external_guid = ${guid}
         AND x.deleted_at IS NULL
       LIMIT 1
    `);

    const mapped = existing.rows[0];
    if (mapped === undefined) return { internalId: null };
    if (!mapped.is_mine && mapped.owner_alive) {
      throw AppError.conflict(
        `GUID ${guid} is already mapped under a different connection. One company, ` +
          'one connection (REQ-Q-03); results cannot cross that line.',
      );
    }
    return { internalId: mapped.internal_id };
  }

  /** Advances the mapping row alongside whichever projection row it anchors. */
  private async touchMapping(
    tx: Transaction,
    agent: WriterScope,
    entityType: MappedEntity,
    guid: string,
    alterId: number,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE external_refs
         SET external_alter_id = ${alterId},
             connection_id = ${agent.connectionId},
             last_pulled_at = now(),
             updated_at = now()
       WHERE org_id = ${agent.orgId}
         AND system = 'TALLY'
         AND entity_type = ${entityType}
         AND external_guid = ${guid}
         AND deleted_at IS NULL
    `);
  }

  private async insertMapping(
    tx: Transaction,
    agent: WriterScope,
    entityType: MappedEntity,
    guid: string,
    alterId: number,
    internalId: string,
  ): Promise<void> {
    try {
      await tx.execute(sql`
        INSERT INTO external_refs
          (org_id, system, entity_type, external_guid, external_alter_id,
           internal_type, internal_id, connection_id, last_pulled_at)
        VALUES
          (${agent.orgId}, 'TALLY', ${entityType}, ${guid}, ${alterId},
           ${entityType}, ${internalId}, ${agent.connectionId}, now())
      `);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        // A racing chunk mapped the GUID between our lookup and insert. The
        // owner-liveness rule above still applies on the retry; refusing
        // here keeps the race loud instead of absorbing it.
        throw AppError.conflict(
          `GUID ${guid} was mapped concurrently. Retry the chunk; the upsert path will take it.`,
        );
      }
      throw error;
    }
  }

  /**
   * Upsert keyed on the GUID mapping in `external_refs`, the same anchoring
   * every synced entity uses. Two statements per row rather than a clever
   * single one, because the mapping and the projection are different tables
   * with different lifetimes — and at 500 rows per chunk, clarity wins.
   */
  /**
   * 09 §3.3's three outcomes, in one transaction with the job: the journal
   * row (direction PUSH, Tally's words verbatim), the job DONE or FAILED,
   * `external_refs` anchored on the GUID Tally answered with (with the
   * idempotency key beside it, REQ-W-07's alter target) under entity_type
   * `voucher_push`, not `voucher`: the pull maps the same GUID to its
   * projection row under `voucher`, and one key cannot point at both the
   * document and the voucher — an outcome ref under `voucher` would make
   * the pull update a vouchers row that does not exist, and the pushed
   * voucher would never appear in the books here. An exception when
   * Tally refused (REQ-T-01), and the owning module told through the
   * registry so its document shows the state (REQ-W-06).
   */
  private async settlePush(
    tx: Transaction,
    agent: WriterScope,
    jobId: string,
    rawPayload: unknown,
    input: Extract<AgentResultsInput, { entityType: 'voucher_push' }>,
  ): Promise<void> {
    const payload = voucherPushPayloadSchema.parse(rawPayload);
    const outcome: PushOutcome = {
      outcome: input.outcome,
      remoteGuid: input.remoteGuid ?? null,
      remoteVoucherNumber: input.remoteVoucherNumber ?? null,
      errorText: input.errorText ?? null,
    };
    if (outcome.outcome !== 'rejected' && outcome.remoteGuid === null) {
      throw AppError.validation('An accepted push must carry the GUID Tally answered with.', {
        fields: [{ path: 'remoteGuid', message: 'is required unless rejected' }],
      });
    }
    if (outcome.outcome === 'rejected' && outcome.errorText === null) {
      throw AppError.validation("A rejected push must carry Tally's error text.", {
        fields: [{ path: 'errorText', message: 'is required when rejected' }],
      });
    }

    await tx.execute(sql`
      INSERT INTO sync_journal
        (org_id, connection_id, direction, entity_type, request_hash, response_hash,
         request_body, response_body, result, duration_ms)
      VALUES
        (${agent.orgId}, ${agent.connectionId}, 'PUSH', ${payload.kind},
         ${input.requestHash}, ${input.responseHash},
         ${input.requestBody ?? null}, ${input.responseBody ?? null},
         ${outcome.outcome === 'rejected' ? `rejected: ${outcome.errorText ?? ''}` : `${outcome.outcome}: ${outcome.remoteGuid ?? ''}`},
         ${input.durationMs ?? null})
    `);

    if (outcome.outcome === 'rejected') {
      await tx.execute(sql`UPDATE sync_jobs SET state = 'FAILED', updated_at = now() WHERE id = ${jobId}`);
      // REQ-T-01: Tally's verbatim words, against the document, for a person.
      await tx.execute(sql`
        INSERT INTO sync_exceptions (org_id, connection_id, kind, entity_type, entity_id, tally_error)
        VALUES (${agent.orgId}, ${agent.connectionId}, 'REJECTION', ${payload.kind}, ${payload.documentId},
                ${`${payload.reference}: ${outcome.errorText ?? ''}`})
      `);
    } else {
      await tx.execute(sql`UPDATE sync_jobs SET state = 'DONE', updated_at = now() WHERE id = ${jobId}`);
      await tx.execute(sql`
        INSERT INTO external_refs
          (org_id, system, entity_type, external_guid, internal_type, internal_id, connection_id,
           remote_voucher_number, remote_voucher_type, sync_state, idempotency_key, last_pushed_at)
        VALUES
          (${agent.orgId}, 'TALLY', 'voucher_push', ${outcome.remoteGuid}, ${payload.kind}, ${payload.documentId},
           ${agent.connectionId}, ${outcome.remoteVoucherNumber}, ${payload.voucherType}, 'pushed', ${payload.idempotencyKey}, now())
        ON CONFLICT (org_id, system, internal_type, internal_id) WHERE deleted_at IS NULL
        DO UPDATE SET external_guid = EXCLUDED.external_guid,
                      remote_voucher_number = EXCLUDED.remote_voucher_number,
                      sync_state = 'pushed',
                      idempotency_key = EXCLUDED.idempotency_key,
                      last_pushed_at = now(),
                      last_error = NULL,
                      updated_at = now()
      `);
    }

    const handler = this.pushOutcomes.find(payload.kind);
    if (handler === null) {
      throw AppError.conflict(`No module handles push outcomes for ${payload.kind}.`);
    }
    await handler.onOutcome(tx, agent.orgId, payload, outcome);
  }

  private async upsertParty(
    tx: Transaction,
    agent: WriterScope,
    row: PartyPullRow,
  ): Promise<void> {
    const mapping = await this.resolveMapping(tx, agent, 'party', row.guid);
    if (mapping.internalId !== null) {
      /*
       * Identity fields are assigned: Tally wins, and a name that cleared in
       * Tally should clear here. The detail fields below are COALESCEd instead,
       * because a source that omits one is saying "not reported", not
       * "cleared" -- an OpsTally Agent older than the party-detail fields sends
       * no address and no balance at all, and must not wipe what a newer Agent
       * or a Tally XML pull already wrote. `closingBalance` is COALESCEd on the
       * same reading, but a zero that *is* sent lands: a settled account is a
       * real balance, unlike a zero price, which means "unresolvable".
       */
      await tx.execute(sql`
        UPDATE parties
           SET name = ${row.name},
               alias = ${row.alias ?? null},
               parent_group = ${row.parentGroup},
               gstin = ${row.gstin ?? null},
               gst_registration_type = COALESCE(${row.gstRegistrationType ?? null}, gst_registration_type),
               address = COALESCE(${row.address ?? null}, address),
               state = COALESCE(${row.state ?? null}, state),
               country = COALESCE(${row.country ?? null}, country),
               pincode = COALESCE(${row.pincode ?? null}, pincode),
               email = ${row.email ?? null},
               phone = ${row.phone ?? null},
               contact_person = COALESCE(${row.contactPerson ?? null}, contact_person),
               credit_limit = ${row.creditLimit ?? null},
               credit_days = ${row.creditDays ?? null},
               opening_balance = ${row.openingBalance ?? null},
               closing_balance = COALESCE(${row.closingBalance ?? null}::numeric, closing_balance),
               bill_wise_tracking = COALESCE(${row.billWiseTracking ?? null}, bill_wise_tracking),
               connection_id = ${agent.connectionId},
               absent_in_tally = false,
               last_pulled_at = now(),
               updated_at = now()
         WHERE id = ${mapping.internalId}
      `);
      await this.touchMapping(tx, agent, 'party', row.guid, row.alterId);
      return;
    }

    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO parties
        (org_id, connection_id, name, alias, parent_group, gstin, gst_registration_type,
         address, state, country, pincode, email, phone, contact_person,
         credit_limit, credit_days, opening_balance, closing_balance, bill_wise_tracking)
      VALUES
        (${agent.orgId}, ${agent.connectionId}, ${row.name}, ${row.alias ?? null},
         ${row.parentGroup}, ${row.gstin ?? null}, ${row.gstRegistrationType ?? null},
         ${row.address ?? null}, ${row.state ?? null}, ${row.country ?? null}, ${row.pincode ?? null},
         ${row.email ?? null}, ${row.phone ?? null}, ${row.contactPerson ?? null},
         ${row.creditLimit ?? null}, ${row.creditDays ?? null}, ${row.openingBalance ?? null},
         ${row.closingBalance ?? null}, ${row.billWiseTracking ?? null})
      RETURNING id
    `);
    const partyId = inserted.rows[0]?.id;
    if (partyId === undefined) throw new Error('Party insert returned no row.');
    await this.insertMapping(tx, agent, 'party', row.guid, row.alterId, partyId);
  }

  /** REQ-R-02, the same shape as parties: GUID-anchored, Tally wins. */
  private async upsertStockItem(
    tx: Transaction,
    agent: WriterScope,
    row: StockItemPullRow,
  ): Promise<void> {
    const mapping = await this.resolveMapping(tx, agent, 'stock_item', row.guid);
    if (mapping.internalId !== null) {
      /*
       * Held figures: a source that carries none (undefined) leaves what is
       * stored; a source that carries "0" for a price is saying it could not
       * resolve one -- the OpsTally reference is explicit that zero is not
       * "free" and that a stored non-zero should survive it. Quantity has no
       * such reading: zero on hand is a fact, and lands.
       */
      await tx.execute(sql`
        UPDATE stock_items
           SET name = ${row.name},
               alias = ${row.alias ?? null},
               unit = ${row.unit},
               parent_group = ${row.parentGroup},
               gst_rate = COALESCE(${row.gstRate ?? null}, gst_rate),
               closing_qty = COALESCE(${row.closingQty ?? null}, closing_qty),
               sale_price = CASE
                 WHEN ${row.salePrice ?? null}::numeric IS NULL THEN sale_price
                 WHEN ${row.salePrice ?? null}::numeric = 0 AND sale_price IS NOT NULL AND sale_price <> 0 THEN sale_price
                 ELSE ${row.salePrice ?? null}::numeric END,
               cost_price = CASE
                 WHEN ${row.costPrice ?? null}::numeric IS NULL THEN cost_price
                 WHEN ${row.costPrice ?? null}::numeric = 0 AND cost_price IS NOT NULL AND cost_price <> 0 THEN cost_price
                 ELSE ${row.costPrice ?? null}::numeric END,
               connection_id = ${agent.connectionId},
               absent_in_tally = false,
               last_pulled_at = now(),
               updated_at = now()
         WHERE id = ${mapping.internalId}
      `);
      await this.touchMapping(tx, agent, 'stock_item', row.guid, row.alterId);
      return;
    }

    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO stock_items
        (org_id, connection_id, name, alias, unit, parent_group, gst_rate,
         closing_qty, sale_price, cost_price)
      VALUES
        (${agent.orgId}, ${agent.connectionId}, ${row.name}, ${row.alias ?? null},
         ${row.unit}, ${row.parentGroup}, ${row.gstRate ?? null},
         ${row.closingQty ?? null}, ${row.salePrice ?? null}, ${row.costPrice ?? null})
      RETURNING id
    `);
    const itemId = inserted.rows[0]?.id;
    if (itemId === undefined) throw new Error('Stock item insert returned no row.');
    await this.insertMapping(tx, agent, 'stock_item', row.guid, row.alterId, itemId);
  }

  /**
   * Phase 6c: vouchers, GUID-anchored like the masters, with one difference
   * in shape — the lines are replaced wholesale. A line has no identity
   * across syncs (Tally renumbers them freely), so reconciling old against
   * new row by row would invent one; delete-and-insert inside the voucher's
   * own transaction is the honest upsert. Party and item references resolve
   * by exact name within the connection because that is Tally's own
   * reference (a voucher names its party ledger); unresolved stays null and
   * the verbatim name is kept either way.
   */
  private async upsertVoucher(
    tx: Transaction,
    agent: WriterScope,
    row: VoucherPullRow,
  ): Promise<void> {
    const mapping = await this.resolveMapping(tx, agent, 'voucher', row.guid);

    const partyId = await this.resolvePartyId(tx, agent, row.partyName ?? '');
    let voucherId: string;
    if (mapping.internalId !== null) {
      await tx.execute(sql`
        UPDATE vouchers
           SET master_id = ${row.masterId ?? null},
               alter_id = ${row.alterId},
               voucher_date = ${row.date},
               voucher_type = ${row.voucherType},
               voucher_number = ${row.voucherNumber ?? ''},
               party_name = ${row.partyName ?? ''},
               party_id = ${partyId},
               narration = ${row.narration ?? ''},
               is_cancelled = ${row.isCancelled},
               amount = ${row.amount},
               /*
                * COALESCEd, unlike the identity fields above: a source that
                * omits one of these is saying "not reported", not "cleared".
                * An OpsTally Agent older than the order/dispatch fields sends
                * none of them, and must not blank detail a newer Agent wrote.
                */
               reference = COALESCE(${row.reference ?? null}, reference),
               reference_date = COALESCE(${row.referenceDate ?? null}::date, reference_date),
               order_ref = COALESCE(${row.orderRef ?? null}, order_ref),
               buyer_order_number = COALESCE(${row.buyerOrderNumber ?? null}, buyer_order_number),
               buyer_order_date = COALESCE(${row.buyerOrderDate ?? null}::date, buyer_order_date),
               payment_terms = COALESCE(${row.paymentTerms ?? null}, payment_terms),
               delivery_terms = COALESCE(${row.deliveryTerms ?? null}, delivery_terms),
               dispatched_through = COALESCE(${row.dispatchedThrough ?? null}, dispatched_through),
               dispatch_doc_no = COALESCE(${row.dispatchDocNo ?? null}, dispatch_doc_no),
               vehicle_number = COALESCE(${row.vehicleNumber ?? null}, vehicle_number),
               destination = COALESCE(${row.destination ?? null}, destination),
               buyer_name = COALESCE(${row.buyerName ?? null}, buyer_name),
               buyer_address = COALESCE(${row.buyerAddress ?? null}, buyer_address),
               party_gstin = COALESCE(${row.partyGstin ?? null}, party_gstin),
               party_state = COALESCE(${row.partyState ?? null}, party_state),
               place_of_supply = COALESCE(${row.placeOfSupply ?? null}, place_of_supply),
               consignee_name = COALESCE(${row.consigneeName ?? null}, consignee_name),
               consignee_state = COALESCE(${row.consigneeState ?? null}, consignee_state),
               consignee_pincode = COALESCE(${row.consigneePincode ?? null}, consignee_pincode),
               consignee_gstin = COALESCE(${row.consigneeGstin ?? null}, consignee_gstin),
               connection_id = ${agent.connectionId},
               last_pulled_at = now(),
               updated_at = now()
         WHERE id = ${mapping.internalId}
      `);
      await this.touchMapping(tx, agent, 'voucher', row.guid, row.alterId);
      voucherId = mapping.internalId;
      await tx.execute(sql`DELETE FROM voucher_lines WHERE voucher_id = ${voucherId}`);
    } else {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO vouchers
          (org_id, connection_id, master_id, alter_id, voucher_date, voucher_type, voucher_number,
           party_name, party_id, narration, is_cancelled, amount,
           reference, reference_date, order_ref, buyer_order_number, buyer_order_date,
           payment_terms, delivery_terms, dispatched_through, dispatch_doc_no, vehicle_number,
           destination, buyer_name, buyer_address, party_gstin, party_state, place_of_supply,
           consignee_name, consignee_state, consignee_pincode, consignee_gstin)
        VALUES
          (${agent.orgId}, ${agent.connectionId}, ${row.masterId ?? null}, ${row.alterId}, ${row.date},
           ${row.voucherType}, ${row.voucherNumber ?? ''}, ${row.partyName ?? ''}, ${partyId},
           ${row.narration ?? ''}, ${row.isCancelled}, ${row.amount},
           ${row.reference ?? null}, ${row.referenceDate ?? null}, ${row.orderRef ?? null},
           ${row.buyerOrderNumber ?? null}, ${row.buyerOrderDate ?? null},
           ${row.paymentTerms ?? null}, ${row.deliveryTerms ?? null}, ${row.dispatchedThrough ?? null},
           ${row.dispatchDocNo ?? null}, ${row.vehicleNumber ?? null}, ${row.destination ?? null},
           ${row.buyerName ?? null}, ${row.buyerAddress ?? null}, ${row.partyGstin ?? null},
           ${row.partyState ?? null}, ${row.placeOfSupply ?? null}, ${row.consigneeName ?? null},
           ${row.consigneeState ?? null}, ${row.consigneePincode ?? null}, ${row.consigneeGstin ?? null})
        RETURNING id
      `);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('Voucher insert returned no row.');
      await this.insertMapping(tx, agent, 'voucher', row.guid, row.alterId, id);
      voucherId = id;
    }

    let lineNo = 0;
    for (const line of row.lines) {
      lineNo += 1;
      if (line.kind === 'ledger') {
        // Lines are deleted and reinserted wholesale above, so settlement is
        // assigned rather than COALESCEd: there is no prior row to preserve.
        await tx.execute(sql`
          INSERT INTO voucher_lines
            (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount,
             settlement_type, settlement_mode, instrument_number, instrument_date,
             bank_name, payment_favouring)
          VALUES
            (${agent.orgId}, ${voucherId}, ${lineNo}, 'ledger', ${line.ledgerName},
             ${line.isDeemedPositive}, ${line.amount},
             ${line.settlementType ?? null}, ${line.settlementMode ?? null},
             ${line.instrumentNumber ?? null}, ${line.instrumentDate ?? null},
             ${line.bankName ?? null}, ${line.paymentFavouring ?? null})
        `);
      } else {
        const itemId = await this.resolveStockItemId(tx, agent, line.stockItemName);
        await tx.execute(sql`
          INSERT INTO voucher_lines
            (org_id, voucher_id, line_no, kind, stock_item_name, stock_item_id,
             actual_qty, billed_qty, rate, amount)
          VALUES
            (${agent.orgId}, ${voucherId}, ${lineNo}, 'inventory', ${line.stockItemName}, ${itemId},
             ${line.actualQty}, ${line.billedQty}, ${line.rate ?? null}, ${line.amount})
        `);
      }
    }
    // D-38 / REQ-W-06: a voucher this side pushed has come back. Tell the
    // document's module what Tally now says about it — cancelled, renumbered
    // — through the same seam that told it the push landed.
    await this.mirrorToDocument(tx, agent, row);
  }

  private async mirrorToDocument(tx: Transaction, agent: WriterScope, row: VoucherPullRow): Promise<void> {
    const refs = await tx.execute<{ internal_type: string; internal_id: string }>(sql`
      SELECT internal_type, internal_id FROM external_refs
       WHERE org_id = ${agent.orgId} AND system = 'TALLY' AND entity_type = 'voucher_push' AND external_guid = ${row.guid} AND deleted_at IS NULL
       LIMIT 1
    `);
    const ref = refs.rows[0];
    if (ref === undefined) return;
    if (!(PUSH_KINDS as readonly string[]).includes(ref.internal_type)) return;
    const handler = this.pushOutcomes.find(ref.internal_type as PushKind);
    if (handler?.onMirror === undefined) return;
    await handler.onMirror(tx, agent.orgId, ref.internal_id, {
      remoteGuid: row.guid,
      remoteVoucherNumber: row.voucherNumber ?? null,
      isCancelled: row.isCancelled,
      alterId: row.alterId,
    });
    await tx.execute(sql`
      UPDATE external_refs SET sync_state = ${row.isCancelled ? 'voided_in_tally' : 'pushed'}, external_alter_id = ${row.alterId}, last_pulled_at = now(), updated_at = now()
       WHERE org_id = ${agent.orgId} AND system = 'TALLY' AND entity_type = 'voucher_push' AND external_guid = ${row.guid} AND deleted_at IS NULL
    `);
  }

  private readonly partyCache = new Map<string, string | null>();
  private readonly stockItemCache = new Map<string, string | null>();

  private async resolvePartyId(tx: Transaction, agent: WriterScope, name: string): Promise<string | null> {
    if (name === '') return null;
    const cacheKey = `${agent.connectionId}:${name}`;
    const cached = this.partyCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM parties
       WHERE connection_id = ${agent.connectionId} AND name = ${name}
       LIMIT 1
    `);
    const id = rows.rows[0]?.id ?? null;
    this.partyCache.set(cacheKey, id);
    return id;
  }

  private async resolveStockItemId(tx: Transaction, agent: WriterScope, name: string): Promise<string | null> {
    if (name === '') return null;
    const cacheKey = `${agent.connectionId}:${name}`;
    const cached = this.stockItemCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM stock_items
       WHERE connection_id = ${agent.connectionId} AND name = ${name}
       LIMIT 1
    `);
    const id = rows.rows[0]?.id ?? null;
    this.stockItemCache.set(cacheKey, id);
    return id;
  }

  /**
   * REQ-R-03. A rate has no GUID of its own; its identity is (connection,
   * item, level), and the unique index makes the upsert one statement. The
   * item is resolved through the same ownership rules as everything else —
   * a rate cannot smuggle a reference to another connection's item — and a
   * rate for an item this connection has not pulled yet refuses loudly:
   * the agent orders item chunks before price chunks, so this firing means
   * the ordering broke, not that the data did.
   */
  private async upsertPriceEntry(
    tx: Transaction,
    agent: WriterScope,
    row: PriceListPullRow,
  ): Promise<void> {
    const mapping = await this.resolveMapping(tx, agent, 'stock_item', row.stockItemGuid);
    if (mapping.internalId === null) {
      throw AppError.conflict(
        `Price for stock item GUID ${row.stockItemGuid} arrived before the item itself. ` +
          'Pull stock items before price lists.',
      );
    }

    await tx.execute(sql`
      INSERT INTO price_list_entries
        (org_id, connection_id, stock_item_id, price_level, rate, unit)
      VALUES
        (${agent.orgId}, ${agent.connectionId}, ${mapping.internalId}, ${row.priceLevel},
         ${row.rate}, ${row.unit ?? null})
      ON CONFLICT (connection_id, stock_item_id, price_level)
      DO UPDATE SET rate = EXCLUDED.rate,
                    unit = EXCLUDED.unit,
                    last_pulled_at = now(),
                    updated_at = now()
    `);
  }

  /**
   * REQ-AJ-02 (owner decision 28 Aug 2026): the bill-wise detail ageing,
   * statements and promise-kept states read. Allocations are the voucher's
   * rows the way lines are: they carry no identity across syncs, and Tally
   * re-sends a changed voucher's set whole (alterId rides on the voucher),
   * so delete-and-reinsert per voucher is the honest upsert here for the
   * same reason it is for voucher_lines — reconciling old against new on
   * (bill name, ref type) would leave a bill reference that was edited away
   * standing, and the schema's own index comment promises "a re-pull
   * rewrites a voucher's allocations as a set". A replayed chunk deletes
   * and reinserts the same rows, so the agent's retry stays safe by
   * construction. The one contract this places on the agent: a voucher's
   * allocations travel together in one chunk, as its lines travel in one
   * row.
   *
   * A voucher that has not arrived cannot anchor its allocations. Expected
   * on this path — vouchers reach Vyuha through the webhook door, and this
   * queue orders nothing before them — so the rows are skipped and counted,
   * never thrown: failing the chunk would wedge the whole pull behind one
   * unmatched GUID. The cursor still advances past a skipped row; a later
   * alteration of the voucher, or a full re-pull, delivers the set again
   * once the voucher lands.
   */
  private async replaceBillAllocations(
    tx: Transaction,
    agent: WriterScope,
    rows: readonly BillAllocationPullRow[],
  ): Promise<number> {
    const byVoucher = new Map<string, BillAllocationPullRow[]>();
    for (const row of rows) {
      const group = byVoucher.get(row.voucherGuid);
      if (group === undefined) byVoucher.set(row.voucherGuid, [row]);
      else group.push(row);
    }

    let skipped = 0;
    for (const [guid, group] of byVoucher) {
      const mapping = await this.resolveMapping(tx, agent, 'voucher', guid);
      if (mapping.internalId === null) {
        skipped += group.length;
        this.logger.warn({
          msg: 'Bill allocations skipped: voucher not yet pulled (REQ-AJ-02)',
          connectionId: agent.connectionId,
          voucherGuid: guid,
          rows: group.length,
        });
        continue;
      }

      await tx.execute(sql`DELETE FROM bill_allocations WHERE voucher_id = ${mapping.internalId}`);
      for (const row of group) {
        const partyId = await this.resolvePartyId(tx, agent, row.partyName);
        await tx.execute(sql`
          INSERT INTO bill_allocations
            (org_id, connection_id, voucher_id, party_id, party_name, bill_name, ref_type,
             bill_date, due_date, amount)
          VALUES
            (${agent.orgId}, ${agent.connectionId}, ${mapping.internalId}, ${partyId},
             ${row.partyName}, ${row.billName}, ${row.refType},
             ${row.billDate ?? null}, ${row.dueDate ?? null}, ${row.amount})
        `);
      }
    }
    return skipped;
  }
}
