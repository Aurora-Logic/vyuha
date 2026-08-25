import { sql } from 'drizzle-orm';

import type { Database } from '../../platform/db/db.provider.js';
import {
  DEFAULT_INTEREST_POLICY,
  INTEREST_SETTINGS,
  interestPolicySchema,
  resolveGroup,
  type InterestPolicy,
} from '../../platform/settings/settings.catalogue.js';

/**
 * One read for the whole module. The build service and the report source
 * both need the same eight rows, and two hand-rolled readers would be two
 * places for a default to drift from the catalogue's.
 */
export async function readInterestPolicy(db: Database, orgId: string): Promise<InterestPolicy> {
  const rows = await db.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM settings
     WHERE org_id = ${orgId} AND scope = 'ORG' AND key LIKE 'interest.%' AND deleted_at IS NULL
  `);
  return resolveGroup(
    interestPolicySchema,
    INTEREST_SETTINGS,
    DEFAULT_INTEREST_POLICY,
    new Map(rows.rows.map((row) => [row.key, row.value])),
  ).value;
}
