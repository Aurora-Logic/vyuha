import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { loadDotEnvFiles } from '../src/platform/common/dotenv.js';

loadDotEnvFiles();

const FORCE_FLAG = '--force';

interface DeleteSummary {
  table: string;
  deletedCount: number;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  // Safety check: Refuse to clear data in production unless explicitly forced
  if (process.env.NODE_ENV === 'production' && !process.argv.includes(FORCE_FLAG)) {
    throw new Error(
      `Refusing to clear Tally projection data with NODE_ENV=production. Re-run with ${FORCE_FLAG} if that is genuinely intended.`,
    );
  }

  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool);

  try {
    const started = Date.now();
    const summaries: DeleteSummary[] = [];

    // Query which tables actually exist in the database
    const tablesRes = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const existingTables = new Set(tablesRes.rows.map((r) => r.table_name));

    await db.transaction(async (tx) => {
      async function safeDelete(table: string, query?: ReturnType<typeof sql>): Promise<void> {
        if (!existingTables.has(table)) {
          return;
        }
        try {
          const stmt = query ?? sql.raw(`DELETE FROM "${table}"`);
          const result = await tx.execute<{ id?: string }>(stmt);
          summaries.push({
            table,
            deletedCount: result.rowCount ?? 0,
          });
        } catch (err: any) {
          console.warn(`⚠️ Could not delete from ${table}: ${err.message}`);
        }
      }

      // 1. Dependent Voucher Lines & Allocations
      await safeDelete('bill_allocations');
      await safeDelete('voucher_lines');
      await safeDelete('vouchers');
      await safeDelete('price_list_entries');

      // 2. Collections / CRM / Portal references attached to parties/stock items
      await safeDelete('promises_to_pay');
      await safeDelete('reminder_notices');
      await safeDelete('collector_assignments');
      await safeDelete('price_list_assignments');
      await safeDelete('price_list_lines');
      await safeDelete('portal_link_keys');
      await safeDelete('portal_access_log');
      await safeDelete('item_vendors');
      await safeDelete('procurement_requirements');

      // 3. Core Projections (Stock items & Parties)
      await safeDelete('stock_items');
      await safeDelete('parties');

      // 4. Mappings and Sync State
      if (existingTables.has('external_refs')) {
        const res = await tx.execute(
          sql`DELETE FROM external_refs WHERE entity_type IN ('party', 'stock_item', 'voucher', 'price_list', 'bill')`,
        );
        summaries.push({
          table: 'external_refs (Tally mappings)',
          deletedCount: res.rowCount ?? 0,
        });
      }

      await safeDelete('sync_inbox');
      await safeDelete('sync_cursors');
      await safeDelete('sync_exceptions');
      await safeDelete('sync_jobs');

      // 5. Reset install binding on integration_connections so the next webhook delivery can re-bind cleanly
      if (existingTables.has('integration_connections')) {
        await tx.execute(
          sql`UPDATE integration_connections SET webhook_install_id = NULL WHERE webhook_install_id IS NOT NULL`,
        );
      }
    });

    const elapsedMs = Date.now() - started;

    console.log('\n' + '='.repeat(60));
    console.log(' 🧹 TALLY DATA CLEARANCE REPORT');
    console.log('='.repeat(60));
    console.table(summaries);
    console.log('='.repeat(60));
    console.log(`✨ All Tally synced masters, vouchers, and cursors cleared in ${elapsedMs}ms.`);
    console.log('🔄 The next sync from OpsTally Agent or pull agent will do a clean initial load.\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n❌ Failed to clear Tally data:', err.message);
  process.exit(1);
});
