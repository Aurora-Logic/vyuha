import { PERMISSIONS, REPORT_DEFINITIONS, type ReportFilters } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness } from '../../test-support/api-harness.js';
import type { Principal } from '../rbac/principal.js';

import { AnalyticsReportSource } from './analytics-report.source.js';

/**
 * D-21: the GST inputs summary. Inputs for whoever files, never a return --
 * the projection carries tax only as ledger-line names, so the report
 * classifies heads by word and owns up to the ones it cannot place.
 *
 * The fixture is arranged so every classification rule earns its keep: an
 * IGST ledger named without digits, a UTGST ledger that must land under
 * SGST, a TCS ledger that is tax but no GST head, and a Round Off line that
 * is not tax at all and must land nowhere.
 */
const ORG_ID = '01900000-0000-7000-8000-00000000f0db';
const AUGUST: ReportFilters = { from: '2026-08-01', to: '2026-08-31' };

let harness: ApiHarness;
let source: AnalyticsReportSource;
let principal: Principal;
let connectionId = '';

function principalFor(orgId: string, permissions: string[]): Principal {
  return {
    userId: '01900000-0000-7000-8000-0000000000aa',
    orgId,
    employeeId: null,
    email: 'gst@example.test',
    status: 'ACTIVE',
    sessionId: '01900000-0000-7000-8000-0000000000bb',
    roles: [],
    permissions: new Set(permissions),
  } as unknown as Principal;
}

async function voucher(opts: { number: string; type: 'Sales' | 'Credit Note'; on: string; cancelled?: boolean }): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (org_id, connection_id, alter_id, voucher_date, voucher_type, voucher_number, party_name, narration, is_cancelled, amount, last_pulled_at)
    VALUES (${ORG_ID}, ${connectionId}, ${Math.floor(Math.random() * 1e9)}, ${opts.on}::date, ${opts.type}, ${opts.number}, 'Asha Traders', '', ${opts.cancelled ?? false}, 0, now())
    RETURNING id
  `);
  return rows.rows[0]?.id ?? '';
}

async function ledgerLine(voucherId: string, lineNo: number, name: string, amount: number): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount)
    VALUES (${ORG_ID}, ${voucherId}, ${lineNo}, 'ledger', ${name}, false, ${amount})
  `);
}

async function inventoryLine(voucherId: string, lineNo: number, amount: number): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, actual_qty, billed_qty, rate, amount)
    VALUES (${ORG_ID}, ${voucherId}, ${lineNo}, 'inventory', 'Cat6 cable 305m', '1 BOX', '1 BOX', ${amount}, ${amount})
  `);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'GST Summary Org');
  source = harness.resolve(AnalyticsReportSource);
  principal = principalFor(ORG_ID, [PERMISSIONS.RECEIVABLES_VIEW]);

  await harness.db.execute(sql`DELETE FROM voucher_lines WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`);
  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid) VALUES (${ORG_ID}, 'TALLY', 'GST Co', ${`guid-gst-${ORG_ID}`}) RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';

  // An intra-state sale: CGST + SGST, and a rounding line that is not tax.
  const inv1 = await voucher({ number: 'GST-1', type: 'Sales', on: '2026-08-05' });
  await inventoryLine(inv1, 1, 1000);
  await ledgerLine(inv1, 2, 'Output CGST @ 9%', 90);
  await ledgerLine(inv1, 3, 'Output SGST @ 9%', 90);
  await ledgerLine(inv1, 4, 'Round Off', 0.4);

  // An inter-state sale: an IGST ledger named without digits, a UTGST line
  // that belongs beside SGST, a cess, and a TCS head that is not GST.
  const inv2 = await voucher({ number: 'GST-2', type: 'Sales', on: '2026-08-12' });
  await inventoryLine(inv2, 1, 500);
  await ledgerLine(inv2, 2, 'Output IGST', 90);
  await ledgerLine(inv2, 3, 'Output UTGST', 3);
  await ledgerLine(inv2, 4, 'Compensation Cess', 2);
  await ledgerLine(inv2, 5, 'TCS on Sales', 5);

  // A credit note nets off value and tax alike.
  const cn1 = await voucher({ number: 'GST-CN-1', type: 'Credit Note', on: '2026-08-20' });
  await inventoryLine(cn1, 1, 200);
  await ledgerLine(cn1, 2, 'Output CGST @ 9%', 18);
  await ledgerLine(cn1, 3, 'Output SGST @ 9%', 18);

  // Out of period, and cancelled: each must leave no trace in August.
  const march = await voucher({ number: 'GST-3', type: 'Sales', on: '2026-03-10' });
  await inventoryLine(march, 1, 9999);
  await ledgerLine(march, 2, 'Output CGST @ 9%', 899.91);
  const cancelled = await voucher({ number: 'GST-4', type: 'Sales', on: '2026-08-25', cancelled: true });
  await inventoryLine(cancelled, 1, 5000);
  await ledgerLine(cancelled, 2, 'Output CGST @ 9%', 450);
});

afterAll(async () => {
  await harness.close();
});

describe('the GST inputs summary', () => {
  it('sums the period by head, sales net of credit notes', async () => {
    const page = await source.page(principal, 'gst-summary', AUGUST, 50, 0);
    expect(page.total).toBe(1);
    const row = page.rows[0] as Record<string, unknown>;
    expect(row.month).toBe('2026-08');
    expect(row.taxableValue).toBe('1300.00');
    expect(row.cgst).toBe('72.00');
    expect(row.sgst).toBe('75.00');
    expect(row.igst).toBe('90.00');
    expect(row.cess).toBe('2.00');
    // TCS is tax but no GST head; Round Off is not tax and lands nowhere.
    expect(row.otherTax).toBe('5.00');
  });

  it('carries whole-report totals for the headline', async () => {
    const page = await source.page(principal, 'gst-summary', AUGUST, 50, 0);
    expect(page.totals).toMatchObject({ taxableValue: '1300.00', cgst: '72.00', sgst: '75.00', igst: '90.00' });
  });

  it('keeps months apart and in order across a wider period', async () => {
    const page = await source.page(principal, 'gst-summary', { from: '2026-01-01', to: '2026-12-31' }, 50, 0);
    const rows = page.rows as Record<string, unknown>[];
    expect(rows.map((r) => r.month)).toEqual(['2026-03', '2026-08']);
    expect(rows[0]?.taxableValue).toBe('9999.00');
    expect(rows[0]?.cgst).toBe('899.91');
  });

  it('says plainly that it is not a return', () => {
    expect(REPORT_DEFINITIONS['gst-summary'].description).toContain('not a return');
    expect(REPORT_DEFINITIONS['gst-summary'].description).toContain('Tally');
  });

  it('is refused without the receivables key, and absent from the catalogue', async () => {
    const outsider = principalFor(ORG_ID, []);
    await expect(source.page(outsider, 'gst-summary', AUGUST, 50, 0)).rejects.toThrow();
    expect(source.visibleDefinitions(outsider).map((d) => d.key)).not.toContain('gst-summary');
    expect(source.visibleDefinitions(principal).map((d) => d.key)).toContain('gst-summary');
  });
});
