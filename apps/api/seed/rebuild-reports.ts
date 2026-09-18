import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadDotEnvFiles } from '../src/platform/common/dotenv.js';
import { SalesFactService } from '../src/modules/cfo/sales-fact.service.js';
import { OwnerMapService } from '../src/modules/cfo/attribution/owner-map.service.js';
import { ReceivableSnapshotService } from '../src/modules/cfo/receivable-snapshot.service.js';
import { InterestBuildService } from '../src/modules/interest/interest-build.service.js';

/**
 * Rebuilds all pre-aggregated analytical tables on demand without waiting for nightly cron:
 * 1. fact_sales_daily (Sales Analysis report)
 * 2. fact_receivable_snapshot (Customer Ageing on Receivables and Overview reports)
 * 3. interest_daily_party & interest_daily_stock (Interest exposure series)
 *
 * Non-destructive & safe for production: only derives and upserts facts from existing vouchers/ledgers.
 */
async function main(): Promise<void> {
  loadDotEnvFiles();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  try {
    const orgsRes = await pool.query('SELECT id, name FROM organizations ORDER BY created_at ASC');
    if (orgsRes.rows.length === 0) {
      console.log('No organizations found in database.');
      return;
    }

    const targetOrgId = process.argv.find((arg) => arg.startsWith('--org='))?.split('=')[1];
    const orgs = targetOrgId
      ? orgsRes.rows.filter((o) => o.id === targetOrgId)
      : orgsRes.rows;

    if (orgs.length === 0) {
      console.error(`Organization with id "${targetOrgId}" not found.`);
      process.exit(1);
    }

    const ownerMapService = new OwnerMapService(db as any);
    const salesFactService = new SalesFactService(db as any, ownerMapService);
    const receivableSnapshotService = new ReceivableSnapshotService(db as any);
    const interestBuildService = new InterestBuildService(db as any);

    for (const org of orgs) {
      console.log(`\n==================================================`);
      console.log(`Materializing reports for: ${org.name} (${org.id})`);
      console.log(`==================================================`);

      // 1. Sales Analysis (fact_sales_daily)
      const salesDaysRes = await pool.query(`
        SELECT DISTINCT voucher_date::date::text AS d
        FROM vouchers
        WHERE org_id = $1 AND voucher_kind IN ('Sales', 'Credit Note') AND is_cancelled = false
        ORDER BY 1
      `, [org.id]);

      console.log(`\n[1/3] Building Sales Analysis facts (fact_sales_daily) across ${salesDaysRes.rows.length} sales dates...`);
      let totalSalesFactRows = 0;
      for (let i = 0; i < salesDaysRes.rows.length; i++) {
        const day = salesDaysRes.rows[i].d;
        const rows = await salesFactService.buildOrgDay(org.id, day);
        totalSalesFactRows += rows;
        if ((i + 1) % 50 === 0 || i === salesDaysRes.rows.length - 1) {
          console.log(`  Processed ${i + 1}/${salesDaysRes.rows.length} days (${totalSalesFactRows} rows total)`);
        }
      }

      // 2. Receivables Aging Snapshots (fact_receivable_snapshot)
      const snapshotDatesQuery = await pool.query(`
        SELECT DISTINCT (date_trunc('month', voucher_date) + interval '1 month - 1 day')::date::text AS d
        FROM vouchers
        WHERE org_id = $1 AND is_cancelled = false
        UNION
        SELECT DISTINCT voucher_date::date::text AS d
        FROM vouchers
        WHERE org_id = $1 AND is_cancelled = false AND voucher_date >= (CURRENT_DATE - interval '90 days')
        UNION
        SELECT CURRENT_DATE::text AS d
        ORDER BY 1
      `, [org.id]);

      console.log(`\n[2/3] Building Customer Ageing snapshots (fact_receivable_snapshot) across ${snapshotDatesQuery.rows.length} dates...`);
      let totalReceivableRows = 0;
      for (let i = 0; i < snapshotDatesQuery.rows.length; i++) {
        const day = snapshotDatesQuery.rows[i].d;
        const rows = await receivableSnapshotService.buildOrgDay(org.id, day);
        totalReceivableRows += rows;
        if ((i + 1) % 20 === 0 || i === snapshotDatesQuery.rows.length - 1) {
          console.log(`  Processed ${i + 1}/${snapshotDatesQuery.rows.length} snapshots for ${day} (${totalReceivableRows} rows total)`);
        }
      }

      // 3. Interest Series (interest_daily_party and interest_daily_stock)
      console.log(`\n[3/3] Building Interest Exposure series...`);
      const interestResult = await interestBuildService.buildOrg(org.id);
      console.log(`  Interest build complete:`, interestResult);

      // Summary verification
      const salesCount = await pool.query('SELECT count(*), min(date), max(date), sum(net) as total_net FROM fact_sales_daily WHERE org_id = $1', [org.id]);
      const recvCount = await pool.query('SELECT count(*), min(snapshot_date), max(snapshot_date), sum(outstanding) as total_out FROM fact_receivable_snapshot WHERE org_id = $1', [org.id]);

      console.log(`\n✓ All report data materialized successfully:`);
      console.log(`  - fact_sales_daily: ${salesCount.rows[0].count} rows (Total Net: ₹${Number(salesCount.rows[0].total_net || 0).toLocaleString('en-IN')})`);
      console.log(`  - fact_receivable_snapshot: ${recvCount.rows[0].count} rows (Total Outstanding: ₹${Number(recvCount.rows[0].total_out || 0).toLocaleString('en-IN')})`);
    }

    console.log('\nAll done! You can now view all 3 report pages immediately.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error materializing reports:', err);
  process.exit(1);
});
