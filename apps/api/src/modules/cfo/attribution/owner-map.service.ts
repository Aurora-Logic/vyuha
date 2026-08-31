import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { AppError } from '../../../platform/common/errors.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { customerOwnerMap } from '../schema/cfo.schema.js';
import { addDays } from '../period/period-resolver.js';

/**
 * Customer -> owner, effective-dated (brief B4). The rules that are hard:
 *
 * - History is never rewritten. An assignment starts today or later; the
 *   previous open interval closes the day before the new one starts. An
 *   attempt to start on or before an existing interval's start is refused,
 *   because honouring it would move old vouchers to a new owner — the
 *   mistake B4 says destroys every league table permanently.
 * - At most two owners at once (M13, decided at two), shares summing to 100.
 * - The house book is 'HOUSE', explicitly — never a blank.
 */

export interface OwnerShare {
  readonly ownerRef: string;
  readonly share: number;
}

const OWNER_REF = /^(user:[0-9a-f-]{36}|HOUSE)$/u;

@Injectable()
export class OwnerMapService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async listForParty(orgId: string, partyId: string): Promise<(typeof customerOwnerMap.$inferSelect)[]> {
    return this.db
      .select()
      .from(customerOwnerMap)
      .where(and(eq(customerOwnerMap.orgId, orgId), eq(customerOwnerMap.partyId, partyId)))
      .orderBy(desc(customerOwnerMap.effectiveFrom));
  }

  /** The owners in force on a date, resolved for voucher attribution. */
  async resolveOwners(orgId: string, partyId: string, onDate: string): Promise<OwnerShare[]> {
    const rows = await this.db
      .select()
      .from(customerOwnerMap)
      .where(
        and(
          eq(customerOwnerMap.orgId, orgId),
          eq(customerOwnerMap.partyId, partyId),
          sql`${customerOwnerMap.effectiveFrom} <= ${onDate}`,
          sql`(${customerOwnerMap.effectiveTo} IS NULL OR ${customerOwnerMap.effectiveTo} >= ${onDate})`,
        ),
      );
    return rows.map((row) => ({ ownerRef: row.ownerRef, share: row.share }));
  }

  async assign(
    orgId: string,
    actorUserId: string | null,
    partyId: string,
    owners: readonly OwnerShare[],
    effectiveFrom: string,
  ): Promise<void> {
    if (owners.length < 1 || owners.length > 2) {
      throw AppError.validation('A customer carries one or two owners, no more (M13).');
    }
    if (owners.some((o) => !OWNER_REF.test(o.ownerRef))) {
      throw AppError.validation('An owner is user:<id> or HOUSE — the house book is explicit, never blank.');
    }
    if (new Set(owners.map((o) => o.ownerRef)).size !== owners.length) {
      throw AppError.validation('The same owner cannot hold two shares of one customer.');
    }
    const total = owners.reduce((sum, o) => sum + o.share, 0);
    if (total !== 100 || owners.some((o) => o.share < 1)) {
      throw AppError.validation('Owner shares are whole percents summing to exactly 100.');
    }

    const existing = await this.listForParty(orgId, partyId);
    if (existing.some((row) => row.effectiveFrom >= effectiveFrom)) {
      // Rewriting an interval that has already started would re-attribute
      // history. The correction for a wrong start date is a new assignment
      // from a later date, with the story living in the audit trail.
      throw AppError.conflict('An assignment already starts on or after that date; history is never rewritten (B4).');
    }

    const before = existing.filter((row) => row.effectiveTo === null).map((row) => ({ ownerRef: row.ownerRef, share: row.share }));

    await this.db.transaction(async (tx) => {
      await tx
        .update(customerOwnerMap)
        .set({ effectiveTo: addDays(effectiveFrom, -1) })
        .where(
          and(
            eq(customerOwnerMap.orgId, orgId),
            eq(customerOwnerMap.partyId, partyId),
            isNull(customerOwnerMap.effectiveTo),
          ),
        );
      for (const owner of owners) {
        await tx.insert(customerOwnerMap).values({
          orgId,
          partyId,
          ownerRef: owner.ownerRef,
          share: owner.share,
          effectiveFrom,
        });
      }
    });

    await this.audit.write({
      orgId,
      actorUserId,
      action: 'cfo.owner_map.assigned',
      entityType: 'customer_owner_map',
      entityId: partyId,
      before: { owners: before },
      after: { owners, effectiveFrom },
    });
  }
}
