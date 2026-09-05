import { sql } from 'drizzle-orm';
import type { Database } from './db.provider.js';

/** Read-only preflight: never resolve duplicate business records by deletion. */
export async function migrationPreflight(db: Database): Promise<void> {
  const relation = await db.execute<{ present: boolean }>(sql`
    SELECT to_regclass('public.sales_documents') IS NOT NULL AS present
  `);
  if (!relation.rows[0]?.present) return;
  const column = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sales_documents' AND column_name = 'return_id') AS present
  `);
  if (!column.rows[0]?.present) return;
  const duplicates = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM (
      SELECT return_id FROM sales_documents
      WHERE return_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY return_id HAVING count(*) > 1
    ) conflicts
  `);
  if (duplicates.rows[0]?.count !== '0') {
    throw new Error('Migration preflight: duplicate live replacement orders exist. Review migration 0091 conflicts using docs/RELEASE.md; no records were modified.');
  }
}
