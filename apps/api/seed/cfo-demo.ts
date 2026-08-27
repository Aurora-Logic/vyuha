import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadDotEnvFiles } from '../src/platform/common/dotenv.js';
import type { AuditService } from '../src/platform/audit/audit.service.js';
import { OwnerMapService } from '../src/modules/cfo/attribution/owner-map.service.js';
import { ReceivableSnapshotService } from '../src/modules/cfo/receivable-snapshot.service.js';
import { SalesFactService } from '../src/modules/cfo/sales-fact.service.js';

/**
 * `pnpm db:cfo-demo` -- gives the Virtual CFO something to say about the
 * demo organisation. `pnpm db:demo` seeds one year of sales and receipts;
 * the CFO module compares every window with the same days last year,
 * attributes sales to people, classes customers, and reads a nightly
 * fact and a nightly book photograph that no job builds on a laptop. This
 * fills those gaps, in the same spirit as the demo seed: fictional,
 * local-only, skipped where already present.
 *
 *   - a second year of history (Sales, Receipts) so "last year" exists
 *   - switchgear items under the two principals, so brand and category read
 *   - credit notes, a trade-discount line, a cancelled voucher, a duplicate,
 *     a backdated entry -- so Exceptions has rows
 *   - credit terms and phones on most parties, deliberately not all
 *   - the owner map (two salespeople, one split, two left unassigned)
 *   - fact_sales_daily for every day that has a voucher
 *   - receivable snapshots for today and the four months before it
 *   - customer classes, targets, desk outcomes
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'postgres', 'db']);
const ORG_ID = process.env.CFO_DEMO_ORG;
const RESET = process.argv.includes('--reset');

const SWITCHGEAR = [
  ['MCB 10A SP B-Curve', 'C&S Electric', 152],
  ['MCB 20A DP C-Curve', 'C&S Electric', 398],
  ['MCCB 125A 3P 36kA', 'C&S Electric', 8900],
  ['MCCB 250A 4P 50kA', 'BCH Electric', 21400],
  ['RCCB 63A 100mA 4P', 'BCH Electric', 3120],
  ['RCBO 32A 30mA', 'C&S Electric', 1980],
  ['ACB 800A 3P EDO', 'BCH Electric', 148000],
  ['ACB 1600A 4P Fixed', 'C&S Electric', 236000],
  ['APFC Panel 100 kVAr', 'BCH Electric', 98000],
  ['Capacitor 25 kVAr 440V', 'C&S Electric', 4600],
] as const;

const OUTCOMES: readonly [string, string | null, string | null, string][] = [
  ['NO_RESPONSE', null, null, 'Rang twice, no answer'],
  ['PROMISE_TO_PAY', '45000', '+10', 'Will clear the 31-60 bucket by the tenth'],
  ['PARTIAL_PAYMENT', '18000', null, 'Paid part against the oldest bill'],
  ['ORDER_PLACED', '62000', null, 'MCCB order for the new site'],
  ['CALL_AGAIN', null, '+7', 'Owner travelling, call next week'],
  ['DISPUTE_RAISED', null, null, 'Claims short supply on GC/1032'],
];

let seed = 20260827;
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const between = (lo: number, hi: number): number => Math.floor(rand() * (hi - lo + 1)) + lo;
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const shift = (day: string, n: number): string => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  loadDotEnvFiles();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const host = new URL(connectionString).hostname;
  if (process.env.NODE_ENV === 'production' || !LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to write CFO demo data to ${host}: fictional invoices do not belong in a live ledger.`);
  }
  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool);
  const report: Record<string, number> = {};
  const bump = (k: string, n = 1): void => {
    report[k] = (report[k] ?? 0) + n;
  };
  try {
    const org = ORG_ID
      ? (await pool.query<{ id: string; name: string }>('SELECT id, name FROM organizations WHERE id = $1', [ORG_ID])).rows[0]
      : (await pool.query<{ id: string; name: string }>('SELECT id, name FROM organizations WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1')).rows[0];
    if (org === undefined) throw new Error('No organisation. Run pnpm db:seed first.');
    console.log(`CFO demo data -> ${new URL(connectionString).pathname.slice(1)} / ${org.name}`);
    const orgId = org.id;

    if (RESET) {
      // Only what this seed wrote: its vouchers carry a 'CFO demo:' narration.
      await pool.query(`DELETE FROM voucher_lines WHERE org_id = $1 AND voucher_id IN (SELECT id FROM vouchers WHERE org_id = $1 AND narration LIKE 'CFO demo:%')`, [orgId]);
      await pool.query(`DELETE FROM vouchers WHERE org_id = $1 AND narration LIKE 'CFO demo:%'`, [orgId]);
      for (const t of ['fact_sales_daily', 'fact_receivable_snapshot', 'customer_owner_map', 'customer_tier_assignments', 'cfo_targets', 'cfo_desk_outcomes', 'cfo_desk_served']) {
        await pool.query(`DELETE FROM ${t} WHERE org_id = $1`, [orgId]);
      }
      await pool.query(`DELETE FROM stock_items WHERE org_id = $1 AND parent_group IN ('C&S Electric', 'BCH Electric')`, [orgId]);
      console.log('reset: CFO demo rows removed');
    }

    const connection = (await pool.query<{ id: string }>('SELECT id FROM integration_connections WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1', [orgId])).rows[0];
    if (connection === undefined) throw new Error('No Tally connection on the organisation. Run pnpm db:demo first.');
    const users = (await pool.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at', [orgId])).rows;
    if (users.length < 2) throw new Error('Two users are needed to be salespeople.');
    const salespeople = users.slice(0, 2);
    const director = users.at(-1) ?? salespeople[0];
    if (director === undefined) throw new Error('No director.');

    // ----------------------------------------------------- switchgear items
    const haveSwitchgear = (await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_items WHERE org_id = $1 AND parent_group IN ('C&S Electric', 'BCH Electric')`, [orgId])).rows[0]?.n !== '0';
    if (!haveSwitchgear) {
      for (const [name, brand, price] of SWITCHGEAR) {
        await pool.query(
          `INSERT INTO stock_items (id, org_id, connection_id, name, unit, parent_group, gst_rate, sale_price, cost_price, closing_qty, last_pulled_at)
           VALUES ($1,$2,$3,$4,'Nos',$5,18,$6,$7,$8, now())`,
          [randomUUID(), orgId, connection.id, name, brand, price, Math.round(price * 0.68), between(4, 60)],
        );
        bump('stock_items');
      }
    }
    // Two items without a cost, so Data Quality has something to say.
    await pool.query(`UPDATE stock_items SET cost_price = NULL WHERE org_id = $1 AND id IN (SELECT id FROM stock_items WHERE org_id = $1 ORDER BY name LIMIT 2)`, [orgId]);

    const items = (await pool.query<{ id: string; name: string; parentGroup: string; price: string | null }>(`SELECT id, name, parent_group AS "parentGroup", sale_price::text AS price FROM stock_items WHERE org_id = $1 AND absent_in_tally = false ORDER BY name`, [orgId])).rows;
    const debtors = (await pool.query<{ id: string; name: string }>(`SELECT id, name FROM parties WHERE org_id = $1 AND parent_group ILIKE '%debtor%' AND absent_in_tally = false ORDER BY created_at`, [orgId])).rows;
    if (debtors.length === 0) throw new Error('No customers. Run pnpm db:demo first.');

    // ------------------------------------------------ credit terms and phones
    let i = 0;
    for (const p of debtors) {
      i += 1;
      // Two parties keep no terms and no phone on purpose.
      if (i % 9 === 0) continue;
      await pool.query(
        `UPDATE parties SET credit_days = coalesce(credit_days, $2), credit_limit = coalesce(credit_limit, $3), phone = coalesce(nullif(phone, ''), $4) WHERE id = $1`,
        [p.id, pick([30, 45, 60]), between(2, 15) * 100000, `+91 98${String(between(10000000, 99999999))}`],
      );
    }

    // --------------------------------------------- the prior year of history
    const priorYear = (await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM vouchers WHERE org_id = $1 AND narration = 'CFO demo: prior year'`, [orgId])).rows[0]?.n !== '0';
    let voucherNo = 5000;
    const sale = async (partyId: string, party: string, date: string, lines: { item: (typeof items)[number]; qty: number }[], narration: string, extras: { discount?: number; cancelled?: boolean; backdatedBy?: number; number?: string; rateFactor?: number } = {}): Promise<{ id: string; total: number; number: string }> => {
      voucherNo += 1;
      const rate = (item: (typeof items)[number]): number => Math.round(Number(item.price ?? 0) * (extras.rateFactor ?? 1));
      const gross = lines.reduce((s, l) => s + l.qty * rate(l.item), 0);
      const discount = extras.discount ?? 0;
      const total = Math.round((gross - discount) * 1.18 * 100) / 100;
      const id = randomUUID();
      const number = extras.number ?? `GC/${String(voucherNo)}`;
      await pool.query(
        `INSERT INTO vouchers (id, org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, amount, narration, is_cancelled, last_pulled_at, created_at)
         VALUES ($1,$2,$3,$4,'Sales',$5,$6,$7,$8,$9,$10, now(), $11)`,
        [id, orgId, connection.id, date, number, party, partyId, total.toFixed(2), narration, extras.cancelled ?? false, extras.backdatedBy === undefined ? new Date(Date.parse(date) + 3_600_000) : new Date(Date.parse(date) + extras.backdatedBy * 86_400_000)],
      );
      bump('vouchers');
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await pool.query(
          `INSERT INTO voucher_lines (id, org_id, voucher_id, line_no, kind, stock_item_name, stock_item_id, actual_qty, billed_qty, rate, amount)
           VALUES ($1,$2,$3,$4,'inventory',$5,$6,$7,$8,$9,$10)`,
          [randomUUID(), orgId, id, lineNo, l.item.name, l.item.id, l.qty, l.qty, rate(l.item).toFixed(2), (l.qty * rate(l.item)).toFixed(2)],
        );
        bump('voucher_lines');
      }
      if (discount > 0) {
        lineNo += 1;
        await pool.query(
          `INSERT INTO voucher_lines (id, org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount) VALUES ($1,$2,$3,$4,'ledger','Trade Discount',false,$5)`,
          [randomUUID(), orgId, id, lineNo, (-discount).toFixed(2)],
        );
        bump('voucher_lines');
      }
      lineNo += 1;
      await pool.query(
        `INSERT INTO voucher_lines (id, org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount) VALUES ($1,$2,$3,$4,'ledger','Output GST',false,$5)`,
        [randomUUID(), orgId, id, lineNo, (-Math.round((gross - discount) * 0.18 * 100) / 100).toFixed(2)],
      );
      bump('voucher_lines');
      return { id, total, number };
    };
    const receipt = async (partyId: string, party: string, date: string, amount: number, narration: string): Promise<void> => {
      voucherNo += 1;
      const id = randomUUID();
      await pool.query(
        `INSERT INTO vouchers (id, org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, amount, narration, last_pulled_at)
         VALUES ($1,$2,$3,$4,'Receipt',$5,$6,$7,$8,$9, now())`,
        [id, orgId, connection.id, date, `RCT/${String(voucherNo)}`, party, partyId, amount.toFixed(2), narration],
      );
      await pool.query(`INSERT INTO voucher_lines (id, org_id, voucher_id, line_no, kind, ledger_name, amount) VALUES ($1,$2,$3,1,'ledger',$4,$5)`, [randomUUID(), orgId, id, party, amount.toFixed(2)]);
      bump('vouchers');
    };
    const creditNote = async (partyId: string, party: string, date: string, amount: number, narration: string): Promise<void> => {
      voucherNo += 1;
      await pool.query(
        `INSERT INTO vouchers (id, org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, amount, narration, last_pulled_at)
         VALUES ($1,$2,$3,$4,'Credit Note',$5,$6,$7,$8,$9, now())`,
        [randomUUID(), orgId, connection.id, date, `CN/${String(voucherNo)}`, party, partyId, amount.toFixed(2), narration],
      );
      bump('vouchers');
    };
    const switchgear = items.filter((it) => it.parentGroup === 'C&S Electric' || it.parentGroup === 'BCH Electric');
    const others = items.filter((it) => !switchgear.includes(it));
    // A customer's usual items: three they buy in both years, so the bridge
    // has customer x SKU pairs to price for volume and price effects.
    const usual = new Map<string, (typeof items)[number][]>();
    for (const d of debtors) usual.set(d.id, [pick(switchgear), pick(switchgear), pick(others)]);
    const basket = (partyId?: string): { item: (typeof items)[number]; qty: number }[] => {
      const n = between(1, 4);
      const lines: { item: (typeof items)[number]; qty: number }[] = [];
      const mine = partyId === undefined ? [] : (usual.get(partyId) ?? []);
      for (let k = 0; k < n; k += 1) {
        const item = mine.length > 0 && rand() < 0.7 ? pick(mine) : rand() < 0.6 ? pick(switchgear) : pick(others);
        const big = Number(item.price ?? 0) > 50_000;
        lines.push({ item, qty: big ? 1 : between(2, 30) });
      }
      return lines;
    };

    if (!priorYear) {
      // Months 13..24 ago: the year the current year compares against. The
      // customers who later go quiet or decline are simply busier here.
      for (let month = 24; month >= 13; month -= 1) {
        const n = between(7, 12);
        for (let k = 0; k < n; k += 1) {
          const p = pick(debtors);
          const date = daysAgo(month * 30 + between(0, 27));
          const s = await sale(p.id, p.name, date, basket(p.id), 'CFO demo: prior year');
          if (rand() < 0.85) await receipt(p.id, p.name, shift(date, between(10, 70)), s.total, 'Payment against invoice');
        }
      }
      // A busier recent year on switchgear, spread across the last 360 days,
      // so brand and category grids have depth; a few customers get nothing
      // in the last 120 days and read as silent churn.
      const quiet = new Set(debtors.slice(-3).map((d) => d.id));
      for (let day = 360; day >= 1; day -= between(2, 5)) {
        const p = pick(debtors);
        if (quiet.has(p.id) && day < 120) continue;
        const date = daysAgo(day);
        const discount = rand() < 0.2 ? between(500, 5000) : 0;
        const s = await sale(p.id, p.name, date, basket(p.id), 'CFO demo: switchgear', { discount });
        const roll = rand();
        if (roll < 0.55) await receipt(p.id, p.name, shift(date, between(10, 60)), s.total, 'Payment against invoice');
        else if (roll < 0.75) await receipt(p.id, p.name, shift(date, between(20, 80)), Math.round(s.total * 0.5), 'Part payment');
        if (rand() < 0.08) await creditNote(p.id, p.name, shift(date, between(3, 20)), Math.round(s.total * 0.15), 'Goods return');
      }
      // Exceptions: a cancelled voucher, a duplicate pair, a backdated entry,
      // a same-day sale and return.
      const a = debtors[0];
      const b = debtors[1] ?? debtors[0];
      if (a !== undefined && b !== undefined) {
        await sale(a.id, a.name, daysAgo(12), [{ item: pick(switchgear), qty: 3 }], 'CFO demo: cancelled', { cancelled: true });
        const dup = await sale(b.id, b.name, daysAgo(9), [{ item: pick(switchgear), qty: 4 }], 'CFO demo: duplicate');
        await sale(b.id, b.name, daysAgo(9), [{ item: pick(switchgear), qty: 4 }], 'CFO demo: duplicate', { number: `${dup.number}A` });
        await sale(a.id, a.name, daysAgo(40), [{ item: pick(switchgear), qty: 2 }], 'CFO demo: backdated', { backdatedBy: 15 });
        const same = await sale(a.id, a.name, daysAgo(5), [{ item: pick(switchgear), qty: 6 }], 'CFO demo: same day');
        await creditNote(a.id, a.name, daysAgo(5), Math.round(same.total * 0.5), 'Same-day return');
      }
    }
    // The same days last year, days 366..460 back: the window every screen
    // compares against, on the same customers and items at prices six per
    // cent lower -- so the bridge carries volume, price and mix, not only
    // "new". Two customers sit only here, so "lost" has names too.
    const sameDays = (await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM vouchers WHERE org_id = $1 AND narration = 'CFO demo: same days last year'`, [orgId])).rows[0]?.n !== '0';
    if (!sameDays) {
      const lostOnly = new Set(debtors.slice(-2).map((d) => d.id));
      const retained = debtors.filter((d) => !lostOnly.has(d.id));
      for (let day = 460; day >= 366; day -= between(2, 4)) {
        const p = rand() < 0.15 ? pick(debtors.slice(-2)) : pick(retained);
        const date = daysAgo(day);
        const s = await sale(p.id, p.name, date, basket(p.id), 'CFO demo: same days last year', { rateFactor: 0.94 });
        if (rand() < 0.8) await receipt(p.id, p.name, shift(date, between(10, 60)), s.total, 'Payment against invoice');
      }
    }

    // The duplicate pair shares a value; make sure both rows have the same amount.
    await pool.query(
      `UPDATE vouchers v SET amount = d.amount FROM (SELECT party_id, voucher_date, min(amount) AS amount FROM vouchers WHERE org_id = $1 AND narration = 'CFO demo: duplicate' GROUP BY 1, 2) d
       WHERE v.org_id = $1 AND v.narration = 'CFO demo: duplicate' AND v.party_id = d.party_id AND v.voucher_date = d.voucher_date`,
      [orgId],
    );

    // ---------------------------------------------------------- owner map
    const audit = { write: async () => undefined } as unknown as AuditService;
    const owners = new OwnerMapService(db, audit);
    const haveOwners = (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM customer_owner_map WHERE org_id = $1', [orgId])).rows[0]?.n !== '0';
    if (!haveOwners) {
      const [rs, mp] = salespeople;
      if (rs === undefined || mp === undefined) throw new Error('salespeople');
      debtors.forEach((p, index) => {
        void p;
        void index;
      });
      for (const [index, p] of debtors.entries()) {
        // The last two stay unassigned on purpose: B3's visible bucket.
        if (index >= debtors.length - 2) continue;
        const shares = index % 5 === 4
          ? [{ ownerRef: `user:${rs.id}`, share: 60 }, { ownerRef: `user:${mp.id}`, share: 40 }]
          : [{ ownerRef: `user:${index % 2 === 0 ? rs.id : mp.id}`, share: 100 }];
        await owners.assign(orgId, null, p.id, shares, '2025-04-01');
        bump('customer_owner_map');
      }
    }

    // --------------------------------------------------------------- facts
    const facts = new SalesFactService(db, owners);
    const days = (await pool.query<{ d: string }>(`SELECT DISTINCT voucher_date::text AS d FROM vouchers WHERE org_id = $1 AND voucher_type IN ('Sales', 'Credit Note') ORDER BY 1`, [orgId])).rows;
    for (const { d } of days) bump('fact_sales_daily', await facts.buildOrgDay(orgId, d));

    // ----------------------------------------------------------- snapshots
    const snapshots = new ReceivableSnapshotService(db);
    for (const back of [120, 90, 60, 30, 14, 7, 1, 0]) bump('fact_receivable_snapshot', await snapshots.buildOrgDay(orgId, daysAgo(back)));

    // ------------------------------------------------------------- classes
    const tiersExist = (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM customer_tiers WHERE org_id = $1', [orgId])).rows[0]?.n !== '0';
    if (!tiersExist) {
      const defaults: [string, string, string, string, number, number, string, number | null, string, string, number][] = [
        ['A+', 'Key account', 'Director relationship, quarterly visit', 'fresh-1', 45, 1500000, '12.00', 30, 'Highest — dispatch same day', 'Quarterly', 1],
        ['A', 'Major', 'Sales head relationship', 'fresh-4', 45, 800000, '10.00', 45, 'High', 'Quarterly', 2],
        ['B', 'Regular', 'Salesperson relationship', 'fresh-3', 30, 300000, '8.00', 60, 'Normal', 'Half-yearly', 3],
        ['C', 'Occasional', 'Order-driven', 'fresh-2', 15, 100000, '5.00', 90, 'Normal', 'Annually', 4],
        ['D', 'Cash', 'Cash and carry, no credit', 'fresh-5', 0, 0, '2.00', null, 'Standard', 'Annually', 5],
      ];
      for (const t of defaults) {
        await pool.query(
          `INSERT INTO customer_tiers (org_id, code, label, description, colour_token, credit_days, credit_limit, max_discount_pct, contact_every_days, service_priority, review_every, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (org_id, code) DO NOTHING`,
          [orgId, ...t],
        );
      }
    }
    const haveClasses = (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM customer_tier_assignments WHERE org_id = $1', [orgId])).rows[0]?.n !== '0';
    if (!haveClasses) {
      const ranked = (await pool.query<{ partyId: string }>(
        `SELECT party_id AS "partyId" FROM fact_sales_daily WHERE org_id = $1 AND party_id IS NOT NULL AND date > (current_date - 365) GROUP BY 1 ORDER BY sum(net) DESC`,
        [orgId],
      )).rows.map((r) => r.partyId);
      for (const [index, partyId] of ranked.entries()) {
        // One in four stays unclassed, for the Data Quality count.
        if (index % 4 === 3) continue;
        const code = index < 2 ? 'A+' : index < 5 ? 'A' : index < 10 ? 'B' : index < 14 ? 'C' : 'D';
        await pool.query(
          `INSERT INTO customer_tier_assignments (org_id, party_id, tier_code, effective_from, assigned_by, reason) VALUES ($1,$2,$3,'2026-04-01',$4,$5)`,
          [orgId, partyId, code, director.id, index < 2 ? 'Top of the book by revenue; director relationship' : 'First classification with the sales team, FY27'],
        );
        bump('customer_tier_assignments');
      }
    }

    // ------------------------------------------------------------- targets
    const haveTargets = (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM cfo_targets WHERE org_id = $1', [orgId])).rows[0]?.n !== '0';
    if (!haveTargets) {
      for (const sp of salespeople) {
        const avg = (await pool.query<{ avg: string | null }>(
          `SELECT (sum(net) / 12)::text AS avg FROM fact_sales_daily WHERE org_id = $1 AND salesperson_ref = $2 AND date > (current_date - 365)`,
          [orgId, `user:${sp.id}`],
        )).rows[0]?.avg;
        const monthly = Math.round((Number(avg ?? 0) * 1.1) / 1000) * 1000 || 500000;
        for (const month of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
          await pool.query(`INSERT INTO cfo_targets (org_id, owner_ref, month, net_target) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [orgId, `user:${sp.id}`, month, monthly]);
          bump('cfo_targets');
        }
      }
    }

    // ------------------------------------------------------ desk outcomes
    const haveOutcomes = (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM cfo_desk_outcomes WHERE org_id = $1', [orgId])).rows[0]?.n !== '0';
    if (!haveOutcomes) {
      for (const [index, [outcome, amount, next, notes]] of OUTCOMES.entries()) {
        const p = debtors[index % debtors.length];
        if (p === undefined) continue;
        const on = daysAgo(index + 1);
        await pool.query(
          `INSERT INTO cfo_desk_outcomes (org_id, party_id, owner_ref, outcome, amount, next_date, notes, logged_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orgId, p.id, `user:${(salespeople[index % 2] ?? director).id}`, outcome, amount, next === null ? null : shift(on, Number(next)), notes, on],
        );
        bump('cfo_desk_outcomes');
      }
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
