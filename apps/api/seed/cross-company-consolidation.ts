import { Pool } from 'pg';

import { loadDotEnvFiles } from '../src/platform/common/dotenv.js';

loadDotEnvFiles();

interface ConnectionRow {
  id: string;
  name: string;
  company_name: string | null;
  company_guid: string | null;
  status: string;
}

interface PartyRow {
  id: string;
  connection_id: string;
  connection_name: string;
  name: string;
  alias: string | null;
  gstin: string | null;
  parent_group: string;
  closing_balance: string | null;
  state: string | null;
  email: string | null;
  phone: string | null;
}

interface ConsolidatedEntity {
  gstin: string;
  canonicalName: string;
  companiesCount: number;
  companies: {
    connectionId: string;
    connectionName: string;
    partyId: string;
    ledgerName: string;
    parentGroup: string;
    closingBalance: number;
    state: string | null;
  }[];
  totalClosingBalance: number;
  totalVouchersCount: number;
  totalVouchersAmount: number;
  isInterCompany: boolean;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Please ensure .env is configured.');
  }

  const pool = new Pool({ connectionString, max: 1 });

  try {
    console.log('\n' + '='.repeat(80));
    console.log('CROSS-COMPANY ENTITY CONSOLIDATION & CONNECTION REPORT');
    console.log('='.repeat(80));

    // 1. Fetch all integration connections (Tally Companies)
    const connResult = await pool.query<ConnectionRow>(`
      SELECT id, name, company_name, company_guid, status 
      FROM integration_connections 
      ORDER BY name ASC
    `);
    const connections = connResult.rows;

    console.log(`\nFound ${connections.length} Integration Connection(s) / Company Profile(s):`);
    connections.forEach((c, idx) => {
      console.log(`${idx + 1}. [${c.status}] ${c.company_name || c.name} (ID: ${c.id})`);
    });

    if (connections.length === 0) {
      console.log('\nWarning: No connections found in database.');
      return;
    }

    // 2. Fetch all parties with their connection details
    const partiesResult = await pool.query<PartyRow>(`
      SELECT 
        p.id, 
        p.connection_id, 
        COALESCE(c.company_name, c.name) as connection_name,
        p.name, 
        p.alias, 
        UPPER(TRIM(p.gstin)) as gstin, 
        p.parent_group, 
        p.closing_balance, 
        p.state, 
        p.email, 
        p.phone
      FROM parties p
      JOIN integration_connections c ON p.connection_id = c.id
      WHERE p.absent_in_tally = false
      ORDER BY p.name ASC
    `);
    const allParties = partiesResult.rows;

    // 3. Fetch voucher aggregates per party and per connection
    const voucherStatsResult = await pool.query<{
      connection_id: string;
      party_id: string;
      party_gstin: string | null;
      vouchers_count: string;
      total_amount: string;
    }>(`
      SELECT 
        connection_id,
        party_id,
        UPPER(TRIM(party_gstin)) as party_gstin,
        COUNT(*)::text as vouchers_count,
        COALESCE(SUM(amount), 0)::text as total_amount
      FROM vouchers
      WHERE is_cancelled = false
      GROUP BY connection_id, party_id, UPPER(TRIM(party_gstin))
    `);
    const voucherStatsMap = new Map<string, { count: number; amount: number }>();
    for (const v of voucherStatsResult.rows) {
      if (v.party_id) {
        voucherStatsMap.set(v.party_id, {
          count: parseInt(v.vouchers_count, 10),
          amount: parseFloat(v.total_amount),
        });
      }
    }

    // 4. Group parties by valid GSTIN (15 chars)
    const gstinGroups = new Map<string, PartyRow[]>();
    const unmappedParties: PartyRow[] = [];

    for (const p of allParties) {
      const gstin = p.gstin?.replace(/[^0-9A-Z]/gi, '').toUpperCase();
      if (gstin && gstin.length === 15) {
        if (!gstinGroups.has(gstin)) {
          gstinGroups.set(gstin, []);
        }
        const group = gstinGroups.get(gstin);
        if (group) group.push(p);
      } else {
        unmappedParties.push(p);
      }
    }

    // 5. Build Consolidated Cross-Company Entities
    const consolidatedList: ConsolidatedEntity[] = [];
    let crossCompanyMatchesCount = 0;

    for (const [gstin, partiesList] of gstinGroups.entries()) {
      const uniqueConnections = new Set(partiesList.map((p) => p.connection_id));
      const isCrossCompany = uniqueConnections.size > 1;

      if (isCrossCompany) {
        crossCompanyMatchesCount++;
      }

      // Determine Canonical Name (Longest / Most specific name among aliases)
      const names = partiesList.map((p) => p.name);
      const canonicalName = names.reduce((a, b) => (a.length >= b.length ? a : b), names[0] ?? '');

      let totalClosing = 0;
      let totalVouchers = 0;
      let totalVoucherAmt = 0;

      const companyDetails = partiesList.map((p) => {
        const bal = parseFloat(p.closing_balance ?? '0') || 0;
        totalClosing += bal;

        const vStat = voucherStatsMap.get(p.id);
        if (vStat) {
          totalVouchers += vStat.count;
          totalVoucherAmt += vStat.amount;
        }

        return {
          connectionId: p.connection_id,
          connectionName: p.connection_name,
          partyId: p.id,
          ledgerName: p.name,
          parentGroup: p.parent_group,
          closingBalance: bal,
          state: p.state,
        };
      });

      consolidatedList.push({
        gstin,
        canonicalName,
        companiesCount: uniqueConnections.size,
        companies: companyDetails,
        totalClosingBalance: totalClosing,
        totalVouchersCount: totalVouchers,
        totalVouchersAmount: totalVoucherAmt,
        isInterCompany: false, // will flag below
      });
    }

    // Sort: Multi-company matches first, then by total transaction volume
    consolidatedList.sort((a, b) => {
      if (b.companiesCount !== a.companiesCount) {
        return b.companiesCount - a.companiesCount;
      }
      return b.totalVouchersAmount - a.totalVouchersAmount;
    });

    // 6. Print Cross-Company Summary
    console.log(`\nDATABASE METRICS & LINKAGE SUMMARY:`);
    console.log(`• Total Ledgers across all companies: ${allParties.length}`);
    console.log(`• Unique Valid GSTINs: ${gstinGroups.size}`);
    console.log(`• Entities appearing across MULTIPLE companies: ${crossCompanyMatchesCount}`);
    console.log(`• Unregistered / No-GSTIN parties: ${unmappedParties.length}`);

    console.log('\n' + '='.repeat(80));
    console.log('CROSS-COMPANY LINKED ENTITIES (SAME GSTIN IN MULTIPLE TALLY BOOKS)');
    console.log('='.repeat(80));

    const multiCompanyEntities = consolidatedList.filter((e) => e.companiesCount > 1);

    if (multiCompanyEntities.length === 0) {
      console.log('No parties currently share the exact same GSTIN across different connections.');
      console.log('(As you sync more companies with common vendors/customers, they will appear here automatically.)');
    } else {
      multiCompanyEntities.forEach((item, i) => {
        console.log(`\n[${i + 1}]  Canonical Legal Entity: "${item.canonicalName}"`);
        console.log(`GSTIN: ${item.gstin} | Present in ${item.companiesCount} Companies`);
        console.log(`Group Total Outstanding: ₹${item.totalClosingBalance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
        console.log(`Group Vouchers Volume: ${item.totalVouchersCount} vouchers (Total: ₹${item.totalVouchersAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })})`);
        console.log('Company Ledger Breakdown:');
        item.companies.forEach((c) => {
          console.log(`Company: "${c.connectionName}"`);
          console.log(`Local Ledger Name: "${c.ledgerName}"`);
          console.log(`Group: ${c.parentGroup}`);
          console.log(`Balance in this company: ₹${c.closingBalance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
        });
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log(' HOW TO USE THIS CROSS-COMPANY VIEW IN GC_FINAL QUERIES:');
    console.log('='.repeat(80));
    console.log(`
  You can execute unified group queries in Postgres without third-party APIs using:

  SELECT 
    UPPER(TRIM(p.gstin)) as gstin,
    MAX(p.name) as canonical_name,
    COUNT(DISTINCT p.connection_id) as companies_count,
    SUM(COALESCE(p.closing_balance, 0)) as group_total_balance,
    json_agg(json_build_object(
      'connection_name', c.name,
      'local_ledger_name', p.name,
      'closing_balance', p.closing_balance
    )) as tally_ledger_mappings
  FROM parties p
  JOIN integration_connections c ON p.connection_id = c.id
  WHERE p.gstin IS NOT NULL AND LENGTH(TRIM(p.gstin)) = 15
  GROUP BY UPPER(TRIM(p.gstin));
`);
    console.log('='.repeat(80) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nFailed: Error executing cross-company consolidation:', (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
