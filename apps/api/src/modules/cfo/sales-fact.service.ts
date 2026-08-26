import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { splitQuantity } from '@vyuha/shared';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { OwnerMapService } from './attribution/owner-map.service.js';

/**
 * Builds fact_sales_daily (brief K2) from the voucher projection, one day
 * at a time, replaced as a unit — the same rebuild discipline as the
 * receivable snapshot, except this table CAN be rebuilt from source, so a
 * full-history backfill is a loop over days, not a loss.
 *
 * What Phase 1 classifies, and what it defers:
 * - Sales vouchers: inventory lines become item rows (qty from the billed
 *   text via the same splitQuantity the paper uses); ledger lines whose
 *   name contains "discount" become R02; a voucher with no inventory lines
 *   lands whole as one ledger-only row.
 * - Credit Notes: all of them sit in returns (R03) until the goods-return
 *   vs rate-difference natures are classifiable (decisions table).
 * - Margin columns stay null: the valuation method (M1) is not confirmed.
 *
 * Attribution (B4, M3 "both"): the voucher's own salesperson would win if
 * the sync carried one — it does not yet (raised in the decisions table) —
 * then the dated owner map AS OF THE VOUCHER DATE, else UNASSIGNED, which
 * is a visible bucket, never a drop. Split credit splits the money in
 * integer paise with the remainder to the first owner, so the split rows
 * still sum to the voucher to the paisa — the reconciliation check would
 * catch any float shortcut here.
 */

type Paise = bigint;

function toPaise(text: string): Paise {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -value : value;
}

function fromPaise(paise: Paise): string {
  const sign = paise < 0n ? '-' : '';
  const abs = paise < 0n ? -paise : paise;
  return `${sign}${String(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Quantity to thousandths, the qty column's scale. */
function toMilli(text: string): bigint {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const value = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  return negative ? -value : value;
}

function fromMilli(milli: bigint): string {
  const sign = milli < 0n ? '-' : '';
  const abs = milli < 0n ? -milli : milli;
  return `${sign}${String(abs / 1000n)}.${String(abs % 1000n).padStart(3, '0')}`;
}

interface FactAccumulator {
  voucherType: string;
  partyId: string | null;
  partyName: string;
  itemId: string | null;
  itemName: string;
  brand: string;
  qty: bigint;
  gross: Paise;
  discount: Paise;
  returns: Paise;
  vouchers: Set<string>;
}

const DISCOUNT_LEDGER = /discount/iu;

@Injectable()
export class SalesFactService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly owners: OwnerMapService,
  ) {}

  /** Rebuilds one organisation-day. Returns the number of fact rows written. */
  async buildOrgDay(orgId: string, day: string): Promise<number> {
    const vouchers = await this.db.execute<{
      id: string;
      voucherType: string;
      partyId: string | null;
      partyName: string;
      amount: string;
    }>(sql`
      SELECT id, voucher_type AS "voucherType", party_id AS "partyId", party_name AS "partyName", amount
      FROM vouchers
      WHERE org_id = ${orgId} AND voucher_date = ${day} AND is_cancelled = false
        AND voucher_type IN ('Sales', 'Credit Note')
    `);

    const lines = await this.db.execute<{
      voucherId: string;
      kind: string;
      ledgerName: string | null;
      stockItemId: string | null;
      stockItemName: string | null;
      billedQty: string | null;
      actualQty: string | null;
      amount: string;
      brand: string | null;
    }>(sql`
      SELECT l.voucher_id AS "voucherId", l.kind, l.ledger_name AS "ledgerName",
             l.stock_item_id AS "stockItemId", l.stock_item_name AS "stockItemName",
             l.billed_qty AS "billedQty", l.actual_qty AS "actualQty", l.amount,
             s.parent_group AS brand
      FROM voucher_lines l
      JOIN vouchers v ON v.id = l.voucher_id
      LEFT JOIN stock_items s ON s.id = l.stock_item_id
      WHERE v.org_id = ${orgId} AND v.voucher_date = ${day} AND v.is_cancelled = false
        AND v.voucher_type IN ('Sales', 'Credit Note')
    `);
    const linesByVoucher = new Map<string, typeof lines.rows>();
    for (const line of lines.rows) {
      const list = linesByVoucher.get(line.voucherId) ?? [];
      list.push(line);
      linesByVoucher.set(line.voucherId, list);
    }

    // One accumulator per (party, item); the owner split multiplies rows later.
    const groups = new Map<string, FactAccumulator>();
    const group = (voucherType: string, partyId: string | null, partyName: string, itemId: string | null, itemName: string, brand: string): FactAccumulator => {
      const key = `${voucherType}|${partyId ?? 'none'}|${itemId ?? 'none'}`;
      const found = groups.get(key);
      if (found !== undefined) return found;
      const fresh: FactAccumulator = {
        voucherType,
        partyId,
        partyName,
        itemId,
        itemName,
        brand,
        qty: 0n,
        gross: 0n,
        discount: 0n,
        returns: 0n,
        vouchers: new Set<string>(),
      };
      groups.set(key, fresh);
      return fresh;
    };

    for (const voucher of vouchers.rows) {
      const voucherLines = linesByVoucher.get(voucher.id) ?? [];

      if (voucher.voucherType === 'Credit Note') {
        // R03 whole, at party grain, until natures classify R04 out of it.
        const g = group('Credit Note', voucher.partyId, voucher.partyName, null, '', 'Unbranded');
        g.returns += toPaise(voucher.amount);
        g.vouchers.add(voucher.id);
        continue;
      }

      const inventory = voucherLines.filter((l) => l.kind === 'inventory');
      if (inventory.length === 0) {
        const g = group('Sales', voucher.partyId, voucher.partyName, null, '', 'Unbranded');
        g.gross += toPaise(voucher.amount);
        g.vouchers.add(voucher.id);
      } else {
        for (const line of inventory) {
          const g = group('Sales', voucher.partyId, voucher.partyName, line.stockItemId, line.stockItemName ?? '', line.brand ?? 'Unbranded');
          const { quantity } = splitQuantity(line.billedQty ?? line.actualQty);
          g.qty += toMilli(quantity);
          const amount = toPaise(line.amount);
          g.gross += amount < 0n ? -amount : amount;
          g.vouchers.add(voucher.id);
        }
      }
      for (const line of voucherLines) {
        if (line.kind === 'ledger' && line.ledgerName !== null && DISCOUNT_LEDGER.test(line.ledgerName)) {
          const g = group('Sales', voucher.partyId, voucher.partyName, null, '', 'Unbranded');
          const amount = toPaise(line.amount);
          g.discount += amount < 0n ? -amount : amount;
          g.vouchers.add(voucher.id);
        }
      }
    }

    // Owner resolution per party, as of the voucher date, once.
    const ownerCache = new Map<string, { ownerRef: string; share: number }[]>();
    const ownersOf = async (partyId: string | null) => {
      if (partyId === null) return [{ ownerRef: 'UNASSIGNED', share: 100 }];
      const cached = ownerCache.get(partyId);
      if (cached !== undefined) return cached;
      const resolved = await this.owners.resolveOwners(orgId, partyId, day);
      const result = resolved.length > 0 ? resolved : [{ ownerRef: 'UNASSIGNED', share: 100 }];
      ownerCache.set(partyId, result);
      return result;
    };

    interface FactRow extends Omit<FactAccumulator, 'vouchers'> {
      salespersonRef: string;
      voucherCount: number;
    }
    const rows: FactRow[] = [];
    for (const g of groups.values()) {
      const owners = await ownersOf(g.partyId);
      // Integer split with the remainder to the first owner: the paise must
      // re-add to the whole, or the level reconciliation fails by design.
      let qtyLeft = g.qty;
      let grossLeft = g.gross;
      let discountLeft = g.discount;
      let returnsLeft = g.returns;
      owners.forEach((owner, index) => {
        const last = index === owners.length - 1;
        const cut = (left: bigint, whole: bigint): bigint => (last ? left : (whole * BigInt(owner.share)) / 100n);
        const qty = cut(qtyLeft, g.qty);
        const gross = cut(grossLeft, g.gross);
        const discount = cut(discountLeft, g.discount);
        const returns = cut(returnsLeft, g.returns);
        qtyLeft -= qty;
        grossLeft -= gross;
        discountLeft -= discount;
        returnsLeft -= returns;
        rows.push({
          voucherType: g.voucherType,
          partyId: g.partyId,
          partyName: g.partyName,
          itemId: g.itemId,
          itemName: g.itemName,
          brand: g.brand,
          qty,
          gross,
          discount,
          returns,
          salespersonRef: owner.ownerRef,
          voucherCount: g.vouchers.size,
        });
      });
    }

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM fact_sales_daily WHERE org_id = ${orgId} AND date = ${day}`);
      for (const row of rows) {
        const net = row.gross - row.discount - row.returns;
        await tx.execute(sql`
          INSERT INTO fact_sales_daily
            (org_id, date, party_id, party_name, item_id, item_name, brand, business_line,
             salesperson_ref, voucher_type, qty, gross, discount, returns, rate_diff, net, voucher_count)
          VALUES
            (${orgId}, ${day}, ${row.partyId}, ${row.partyName}, ${row.itemId}, ${row.itemName},
             ${row.brand}, 'DOMESTIC', ${row.salespersonRef}, ${row.voucherType},
             ${fromMilli(row.qty)}::numeric, ${fromPaise(row.gross)}::numeric, ${fromPaise(row.discount)}::numeric,
             ${fromPaise(row.returns)}::numeric, 0, ${fromPaise(net)}::numeric, ${row.voucherCount})
        `);
      }
    });

    return rows.length;
  }

  /**
   * B3's reconciliation: the fact against its source, and every level
   * against every other, to the paisa. Any tie failure is an exception, not
   * a rounding note.
   */
  async reconcile(orgId: string, from: string, to: string): Promise<{
    ties: boolean;
    factNet: string;
    sourceNet: string;
    byPersonNet: string;
    byBrandNet: string;
    unassignedNet: string;
  }> {
    const fact = await this.db.execute<{ net: string | null }>(sql`
      SELECT sum(net)::text AS net FROM fact_sales_daily WHERE org_id = ${orgId} AND date BETWEEN ${from} AND ${to}
    `);
    const byPerson = await this.db.execute<{ net: string | null }>(sql`
      SELECT sum(person_net)::text AS net FROM (
        SELECT sum(net) AS person_net FROM fact_sales_daily
        WHERE org_id = ${orgId} AND date BETWEEN ${from} AND ${to} GROUP BY salesperson_ref
      ) p
    `);
    const byBrand = await this.db.execute<{ net: string | null }>(sql`
      SELECT sum(brand_net)::text AS net FROM (
        SELECT sum(net) AS brand_net FROM fact_sales_daily
        WHERE org_id = ${orgId} AND date BETWEEN ${from} AND ${to} GROUP BY brand
      ) b
    `);
    const unassigned = await this.db.execute<{ net: string | null }>(sql`
      SELECT coalesce(sum(net), 0)::numeric(16,2)::text AS net FROM fact_sales_daily
      WHERE org_id = ${orgId} AND date BETWEEN ${from} AND ${to} AND salesperson_ref = 'UNASSIGNED'
    `);
    // Ex-GST like the fact (B1): a GST invoice's voucher total includes tax,
    // its inventory lines do not, so the source reads lines where lines
    // exist and falls back to the voucher total only for ledger-only sales.
    const source = await this.db.execute<{ net: string | null }>(sql`
      SELECT (
        coalesce((SELECT sum(abs(l.amount)) FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
          WHERE v.org_id = ${orgId} AND v.voucher_date BETWEEN ${from} AND ${to}
            AND v.is_cancelled = false AND v.voucher_type = 'Sales' AND l.kind = 'inventory'), 0)
        +
        coalesce((SELECT sum(v.amount) FROM vouchers v
          WHERE v.org_id = ${orgId} AND v.voucher_date BETWEEN ${from} AND ${to}
            AND v.is_cancelled = false AND v.voucher_type = 'Sales'
            AND NOT EXISTS (SELECT 1 FROM voucher_lines l WHERE l.voucher_id = v.id AND l.kind = 'inventory')), 0)
        -
        coalesce((SELECT sum(v.amount) FROM vouchers v
          WHERE v.org_id = ${orgId} AND v.voucher_date BETWEEN ${from} AND ${to}
            AND v.is_cancelled = false AND v.voucher_type = 'Credit Note'), 0)
        -
        coalesce((SELECT sum(abs(l.amount)) FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
          WHERE v.org_id = ${orgId} AND v.voucher_date BETWEEN ${from} AND ${to}
            AND v.is_cancelled = false AND v.voucher_type = 'Sales'
            AND l.kind = 'ledger' AND l.ledger_name ~* 'discount'), 0)
      )::text AS net
    `);

    const factNet = fact.rows[0]?.net ?? '0';
    const sourceNet = source.rows[0]?.net ?? '0';
    const byPersonNet = byPerson.rows[0]?.net ?? '0';
    const byBrandNet = byBrand.rows[0]?.net ?? '0';
    const ties =
      Number(factNet) === Number(sourceNet) &&
      Number(factNet) === Number(byPersonNet) &&
      Number(factNet) === Number(byBrandNet);
    return {
      ties,
      factNet,
      sourceNet,
      byPersonNet,
      byBrandNet,
      unassignedNet: unassigned.rows[0]?.net ?? '0',
    };
  }
}
