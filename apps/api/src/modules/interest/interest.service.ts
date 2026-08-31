import { Injectable } from '@nestjs/common';
import type {
  InterestPartySettingView,
  RecomputeInterestInput,
  RecomputeInterestReceipt,
  UpsertInterestPartySettingInput,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditContext } from '../../platform/audit/audit-context.js';
import { AppError } from '../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { JobRunner } from '../../platform/jobs/job-runner.service.js';
import type { Principal } from '../../platform/rbac/principal.js';

/**
 * The configuration half of the interest module (D-22): the per-party
 * overrides that beat the Tally projection, and the on-demand recompute.
 * The projection itself is never written — an override is a Vyuha-side row
 * beside it, and clearing the override falls back to Tally's figure.
 */

type SettingRow = {
  party_id: string;
  party_name: string;
  parent_group: string;
  tally_credit_days: number | null;
  credit_days_override: number | null;
  interest_rate_override: string | null;
};

function viewOf(row: SettingRow): InterestPartySettingView {
  return {
    partyId: row.party_id,
    partyName: row.party_name,
    parentGroup: row.parent_group,
    tallyCreditDays: row.tally_credit_days,
    creditDaysOverride: row.credit_days_override,
    interestRateOverride: row.interest_rate_override,
    creditTermsMissing: row.tally_credit_days === null && row.credit_days_override === null,
  };
}

@Injectable()
export class InterestService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly jobs: JobRunner,
  ) {}

  /** Every party carrying an override, plus the flagged ones with no terms at all. */
  async listPartySettings(principal: Principal): Promise<InterestPartySettingView[]> {
    const rows = await this.db.execute<SettingRow>(sql`
      SELECT p.id AS party_id, p.name AS party_name, p.parent_group,
             p.credit_days AS tally_credit_days, s.credit_days_override, s.interest_rate_override::text AS interest_rate_override
        FROM parties p
        LEFT JOIN interest_party_settings s
          ON s.org_id = p.org_id AND s.party_id = p.id AND s.deleted_at IS NULL
       WHERE p.org_id = ${principal.orgId}
         AND (lower(p.parent_group) LIKE 'sundry debtors%' OR lower(p.parent_group) LIKE 'sundry creditors%')
         AND (s.id IS NOT NULL OR p.credit_days IS NULL)
       ORDER BY p.name
    `);
    return rows.rows.map(viewOf);
  }

  async upsertPartySetting(
    principal: Principal,
    partyId: string,
    input: UpsertInterestPartySettingInput,
  ): Promise<InterestPartySettingView> {
    const before = await this.readParty(principal, partyId);

    const existing = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM interest_party_settings
       WHERE org_id = ${principal.orgId} AND party_id = ${partyId} AND deleted_at IS NULL
    `);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      await this.db.execute(sql`
        INSERT INTO interest_party_settings (org_id, party_id, interest_rate_override, credit_days_override, created_by, updated_by)
        VALUES (${principal.orgId}, ${partyId}, ${input.interestRateOverride ?? null}, ${input.creditDaysOverride ?? null}, ${principal.userId}, ${principal.userId})
      `);
    } else {
      // Absent means unchanged; null clears. The two-write shape mirrors the
      // settings PATCH for the same reason it exists there.
      await this.db.execute(sql`
        UPDATE interest_party_settings
           SET interest_rate_override = ${input.interestRateOverride === undefined ? sql`interest_rate_override` : (input.interestRateOverride ?? null)},
               credit_days_override = ${input.creditDaysOverride === undefined ? sql`credit_days_override` : (input.creditDaysOverride ?? null)},
               updated_at = now(), updated_by = ${principal.userId}
         WHERE id = ${existingRow.id} AND org_id = ${principal.orgId}
      `);
    }

    const after = await this.readParty(principal, partyId);
    this.auditContext.record({
      action: 'interest.party_setting.upserted',
      entityType: 'interest_party_setting',
      entityId: partyId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  async removePartySetting(principal: Principal, partyId: string): Promise<InterestPartySettingView> {
    const before = await this.readParty(principal, partyId);
    await this.db.execute(sql`
      UPDATE interest_party_settings
         SET deleted_at = now(), updated_at = now(), updated_by = ${principal.userId}
       WHERE org_id = ${principal.orgId} AND party_id = ${partyId} AND deleted_at IS NULL
    `);
    const after = await this.readParty(principal, partyId);
    this.auditContext.record({
      action: 'interest.party_setting.removed',
      entityType: 'interest_party_setting',
      entityId: partyId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  /**
   * Queues the rebuild rather than running it inline: a full walk is minutes
   * of voucher replay on a real ledger, and the request that asked for it
   * deserves an answer now and a snapshot soon.
   */
  async recompute(principal: Principal, input: RecomputeInterestInput): Promise<RecomputeInterestReceipt> {
    if (input.partyId !== undefined) await this.readParty(principal, input.partyId);
    if (input.stockItemId !== undefined) {
      const item = await this.db.execute<{ id: string }>(sql`
        SELECT id FROM stock_items WHERE org_id = ${principal.orgId} AND id = ${input.stockItemId}
      `);
      if (item.rows[0] === undefined) throw AppError.notFound('Stock item', input.stockItemId);
    }

    const jobId = await this.jobs.enqueue('build-interest-snapshots', {
      now: new Date().toISOString(),
      orgId: principal.orgId,
      ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
      ...(input.stockItemId === undefined ? {} : { stockItemId: input.stockItemId }),
      ...(input.from === undefined ? {} : { from: input.from }),
    });

    this.auditContext.record({
      action: 'interest.recompute_requested',
      entityType: 'interest_build_state',
      entityId: principal.orgId,
      before: null,
      after: { jobId, ...input },
    });
    return { jobId };
  }

  private async readParty(principal: Principal, partyId: string): Promise<InterestPartySettingView> {
    const rows = await this.db.execute<SettingRow>(sql`
      SELECT p.id AS party_id, p.name AS party_name, p.parent_group,
             p.credit_days AS tally_credit_days, s.credit_days_override, s.interest_rate_override::text AS interest_rate_override
        FROM parties p
        LEFT JOIN interest_party_settings s
          ON s.org_id = p.org_id AND s.party_id = p.id AND s.deleted_at IS NULL
       WHERE p.org_id = ${principal.orgId} AND p.id = ${partyId}
    `);
    const row = rows.rows[0];
    if (row === undefined) throw AppError.notFound('Party', partyId);
    return viewOf(row);
  }
}
