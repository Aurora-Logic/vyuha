import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ORG_SCOPED_TABLES } from '@vyuha/config/eslint-org-scope';

import { ApiHarness } from '../../test-support/api-harness.js';

/**
 * The org-scoping lint rule knows which tables carry an `org_id`, and it knows
 * it from a list. A list is only as good as the thing that keeps it honest:
 * a table added next month would sit outside the rule, silently, and the rule
 * would go on passing while the invariant it exists for stopped being checked.
 *
 * So the list is compared against the schema itself. When this fails, the fix
 * is to regenerate the list in `packages/config/eslint-org-scope.js` -- not to
 * edit the expectation.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f0d5';

let harness: ApiHarness;

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Org Scope Rule');
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('the org-scoping rule knows every scoped table', () => {
  it('lists exactly the tables that have an org_id column', async () => {
    const rows = await harness.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'org_id'
       ORDER BY table_name
    `);
    const inSchema = rows.rows.map((row) => row.table_name);
    const missing = inSchema.filter((name) => !ORG_SCOPED_TABLES.includes(name));
    const stale = ORG_SCOPED_TABLES.filter((name) => !inSchema.includes(name));

    expect(missing, `tables the rule would not police: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `tables the rule names that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });

  it('does not claim a table that has no org_id', async () => {
    // The other direction: naming an unscoped table would make the rule demand
    // an org_id that the table cannot carry, and the next person would reach
    // for a disable comment rather than a fix.
    const unscoped = await harness.db.execute<{ table_name: string }>(sql`
      SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'org_id'
         )
    `);
    const wrongly = unscoped.rows.map((row) => row.table_name).filter((name) => ORG_SCOPED_TABLES.includes(name));
    expect(wrongly, `unscoped tables the rule claims: ${wrongly.join(', ')}`).toEqual([]);
  });
});
