import { Injectable } from '@nestjs/common';
import {
  categoryOf,
  type InterestPartySettingView,
  type RecomputeInterestInput,
  type RecomputeInterestReceipt,
  type StockInterestReportItem,
  type StockInterestReportSummary,
  type StockInterestSettingView,
  type UpsertInterestPartySettingInput,
  type UpsertStockInterestSettingInput,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditContext } from '../../platform/audit/audit-context.js';
import { AppError } from '../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { JobRunner } from '../../platform/jobs/job-runner.service.js';
import type { Principal } from '../../platform/rbac/principal.js';
import { epochDay } from '../../platform/receivables/bill-series.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import {
  calculateAdvanceTransitInterest,
  calculateHoldingInterest,
  isNonMoving,
} from './interest-math.js';
import { readInterestPolicy } from './interest-policy.js';

/**
 * The configuration half of the interest module (D-22): the per-party
 * overrides that beat the Tally projection, and the on-demand recompute.
 * The projection itself is never written — an override is a Vyuha-side row
 * beside it, and clearing the override falls back to Tally's figure.
 */

type SettingRow = {
  party_id: string;
  party_name: string;
  parent_group: string;
  tally_credit_days: number | null;
  credit_days_override: number | null;
  interest_rate_override: string | null;
};

type StockSettingRow = {
  id: string;
  target_type: 'item' | 'category' | 'group';
  target_id: string | null;
  target_name: string;
  interest_rate_override: string | null;
  holding_period_days_override: number | null;
};

function viewOf(row: SettingRow): InterestPartySettingView {
  return {
    partyId: row.party_id,
    partyName: row.party_name,
    parentGroup: row.parent_group,
    tallyCreditDays: row.tally_credit_days,
    creditDaysOverride: row.credit_days_override,
    interestRateOverride: row.interest_rate_override,
    creditTermsMissing: row.tally_credit_days === null && row.credit_days_override === null,
  };
}

function stockSettingViewOf(row: StockSettingRow): StockInterestSettingView {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    interestRateOverride: row.interest_rate_override,
    holdingPeriodDaysOverride: row.holding_period_days_override,
  };
}

export interface StockReportQuery {
  asOf?: string;
  category?: string;
  group?: string;
  isNonMoving?: boolean;
  search?: string;
}

interface StockItemLayer {
  inwardDate: string;
  initialQty: number;
  remainingQty: number;
  rate: number;
  advanceDate: string | null;
}

@Injectable()
export class InterestService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly jobs: JobRunner,
  ) {}

  /** Every party carrying an override, plus the flagged ones with no terms at all. */
  async listPartySettings(principal: Principal): Promise<InterestPartySettingView[]> {
    const rows = await this.db.execute<SettingRow>(sql`
      SELECT p.id AS party_id, p.name AS party_name, p.parent_group,
             p.credit_days AS tally_credit_days, s.credit_days_override, s.interest_rate_override::text AS interest_rate_override
        FROM parties p
        LEFT JOIN interest_party_settings s
          ON s.org_id = p.org_id AND s.party_id = p.id AND s.deleted_at IS NULL
       WHERE p.org_id = ${principal.orgId}
         AND (lower(p.parent_group) LIKE 'sundry debtors%' OR lower(p.parent_group) LIKE 'sundry creditors%')
         AND (s.id IS NOT NULL OR p.credit_days IS NULL)
       ORDER BY p.name
    `);
    return rows.rows.map(viewOf);
  }

  async upsertPartySetting(
    principal: Principal,
    partyId: string,
    input: UpsertInterestPartySettingInput,
  ): Promise<InterestPartySettingView> {
    const before = await this.readParty(principal, partyId);

    const existing = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM interest_party_settings
       WHERE org_id = ${principal.orgId} AND party_id = ${partyId} AND deleted_at IS NULL
    `);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      await this.db.execute(sql`
        INSERT INTO interest_party_settings (org_id, party_id, interest_rate_override, credit_days_override, created_by, updated_by)
        VALUES (${principal.orgId}, ${partyId}, ${input.interestRateOverride ?? null}, ${input.creditDaysOverride ?? null}, ${principal.userId}, ${principal.userId})
      `);
    } else {
      // Absent means unchanged; null clears. The two-write shape mirrors the
      // settings PATCH for the same reason it exists there.
      await this.db.execute(sql`
        UPDATE interest_party_settings
           SET interest_rate_override = ${input.interestRateOverride === undefined ? sql`interest_rate_override` : (input.interestRateOverride ?? null)},
               credit_days_override = ${input.creditDaysOverride === undefined ? sql`credit_days_override` : (input.creditDaysOverride ?? null)},
               updated_at = now(), updated_by = ${principal.userId}
         WHERE id = ${existingRow.id} AND org_id = ${principal.orgId}
      `);
    }

    const after = await this.readParty(principal, partyId);
    this.auditContext.record({
      action: 'interest.party_setting.upserted',
      entityType: 'interest_party_setting',
      entityId: partyId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  async removePartySetting(principal: Principal, partyId: string): Promise<InterestPartySettingView> {
    const before = await this.readParty(principal, partyId);
    await this.db.execute(sql`
      UPDATE interest_party_settings
         SET deleted_at = now(), updated_at = now(), updated_by = ${principal.userId}
       WHERE org_id = ${principal.orgId} AND party_id = ${partyId} AND deleted_at IS NULL
    `);
    const after = await this.readParty(principal, partyId);
    this.auditContext.record({
      action: 'interest.party_setting.removed',
      entityType: 'interest_party_setting',
      entityId: partyId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  // ------------------------------------------------------------- stock settings

  async listStockSettings(principal: Principal): Promise<StockInterestSettingView[]> {
    const rows = await this.db.execute<StockSettingRow>(sql`
      SELECT id, target_type, target_id, target_name,
             interest_rate_override::text AS interest_rate_override,
             holding_period_days_override
        FROM interest_stock_settings
       WHERE org_id = ${principal.orgId} AND deleted_at IS NULL
       ORDER BY target_type, target_name
    `);
    return rows.rows.map(stockSettingViewOf);
  }

  async upsertStockSetting(
    principal: Principal,
    input: UpsertStockInterestSettingInput,
  ): Promise<StockInterestSettingView> {
    const existing = await this.db.execute<StockSettingRow>(sql`
      SELECT id, target_type, target_id, target_name,
             interest_rate_override::text AS interest_rate_override,
             holding_period_days_override
        FROM interest_stock_settings
       WHERE org_id = ${principal.orgId} AND target_type = ${input.targetType}
         AND lower(target_name) = lower(${input.targetName}) AND deleted_at IS NULL
    `);
    const existingRow = existing.rows[0];

    if (existingRow === undefined) {
      const inserted = await this.db.execute<StockSettingRow>(sql`
        INSERT INTO interest_stock_settings (
          org_id, target_type, target_id, target_name, interest_rate_override,
          holding_period_days_override, created_by, updated_by
        ) VALUES (
          ${principal.orgId}, ${input.targetType}, ${input.targetId ?? null}, ${input.targetName},
          ${input.interestRateOverride ?? null}, ${input.holdingPeriodDaysOverride ?? null},
          ${principal.userId}, ${principal.userId}
        )
        RETURNING id, target_type, target_id, target_name, interest_rate_override::text, holding_period_days_override
      `);
      const row = inserted.rows[0];
      if (!row) throw new Error('Failed to create stock setting override');
      this.auditContext.record({
        action: 'interest.stock_setting.upserted',
        entityType: 'interest_stock_setting',
        entityId: row.id,
        before: null,
        after: stockSettingViewOf(row),
      });
      return stockSettingViewOf(row);
    }

    const updated = await this.db.execute<StockSettingRow>(sql`
      UPDATE interest_stock_settings
         SET target_id = coalesce(${input.targetId ?? null}, target_id),
             target_name = ${input.targetName},
             interest_rate_override = ${input.interestRateOverride === undefined ? sql`interest_rate_override` : (input.interestRateOverride ?? null)},
             holding_period_days_override = ${input.holdingPeriodDaysOverride === undefined ? sql`holding_period_days_override` : (input.holdingPeriodDaysOverride ?? null)},
             updated_at = now(), updated_by = ${principal.userId}
       WHERE id = ${existingRow.id} AND org_id = ${principal.orgId}
       RETURNING id, target_type, target_id, target_name, interest_rate_override::text, holding_period_days_override
    `);
    const row = updated.rows[0];
    if (!row) throw new Error('Failed to update stock setting override');
    this.auditContext.record({
      action: 'interest.stock_setting.upserted',
      entityType: 'interest_stock_setting',
      entityId: row.id,
      before: stockSettingViewOf(existingRow),
      after: stockSettingViewOf(row),
    });
    return stockSettingViewOf(row);
  }

  async removeStockSetting(principal: Principal, id: string): Promise<StockInterestSettingView> {
    const existing = await this.db.execute<StockSettingRow>(sql`
      SELECT id, target_type, target_id, target_name,
             interest_rate_override::text AS interest_rate_override,
             holding_period_days_override
        FROM interest_stock_settings
       WHERE org_id = ${principal.orgId} AND id = ${id} AND deleted_at IS NULL
    `);
    const row = existing.rows[0];
    if (row === undefined) throw AppError.notFound('Stock setting override', id);

    await this.db.execute(sql`
      UPDATE interest_stock_settings
         SET deleted_at = now(), updated_at = now(), updated_by = ${principal.userId}
       WHERE id = ${id} AND org_id = ${principal.orgId}
    `);

    this.auditContext.record({
      action: 'interest.stock_setting.removed',
      entityType: 'interest_stock_setting',
      entityId: id,
      before: stockSettingViewOf(row),
      after: null,
    });
    return stockSettingViewOf(row);
  }

  // ------------------------------------------------------------- stock report

  async getStockReport(principal: Principal, query: StockReportQuery = {}): Promise<StockInterestReportSummary> {
    const policy = await readInterestPolicy(this.db, principal.orgId);
    const asOf = query.asOf ?? istDateOf(new Date().toISOString());
    const asOfDay = epochDay(asOf);

    const stockOverrides = await this.db.execute<StockSettingRow>(sql`
      SELECT id, target_type, target_id, target_name,
             interest_rate_override::text AS interest_rate_override,
             holding_period_days_override
        FROM interest_stock_settings
       WHERE org_id = ${principal.orgId} AND deleted_at IS NULL
    `);

    const itemOverrides = new Map<string, { rate: number | null; days: number | null }>();
    const itemNameOverrides = new Map<string, { rate: number | null; days: number | null }>();
    const categoryOverrides = new Map<string, { rate: number | null; days: number | null }>();
    const groupOverrides = new Map<string, { rate: number | null; days: number | null }>();

    for (const row of stockOverrides.rows) {
      const entry = {
        rate: row.interest_rate_override !== null ? Number(row.interest_rate_override) : null,
        days: row.holding_period_days_override,
      };
      if (row.target_type === 'item') {
        if (row.target_id) itemOverrides.set(row.target_id, entry);
        itemNameOverrides.set(row.target_name.toLowerCase(), entry);
      } else if (row.target_type === 'category') {
        categoryOverrides.set(row.target_name.toLowerCase(), entry);
      } else if (row.target_type === 'group') {
        groupOverrides.set(row.target_name.toLowerCase(), entry);
      }
    }

    const stockItems = await this.db.execute<{
      id: string;
      name: string;
      unit: string | null;
      parent_group: string | null;
      gst_rate: string | null;
      closing_qty: string | null;
      cost_price: string | null;
      sale_price: string | null;
      created_at: string;
      min_voucher_date: string | null;
      max_voucher_date: string | null;
    }>(sql`
      SELECT si.id, si.name, si.unit, si.parent_group, si.gst_rate::text AS gst_rate,
             si.closing_qty::text AS closing_qty,
             si.cost_price::text AS cost_price,
             si.sale_price::text AS sale_price,
             si.created_at::date::text AS created_at,
             min(v.voucher_date)::date::text AS min_voucher_date,
             max(v.voucher_date)::date::text AS max_voucher_date
        FROM stock_items si
        LEFT JOIN voucher_lines vl ON vl.stock_item_id = si.id
        LEFT JOIN vouchers v ON v.id = vl.voucher_id AND NOT v.is_cancelled
       WHERE si.org_id = ${principal.orgId}
       GROUP BY si.id, si.name, si.unit, si.parent_group, si.gst_rate, si.closing_qty, si.cost_price, si.sale_price, si.created_at
    `);

    const lines = await this.db.execute<{
      stock_item_id: string;
      item_name: string;
      unit: string;
      parent_group: string;
      voucher_date: string;
      voucher_kind: string | null;
      buyer_order_date: string | null;
      reference_date: string | null;
      qty: string;
      rate: string | null;
      amount: string;
      gst_rate: string | null;
    }>(sql`
      SELECT vl.stock_item_id, si.name AS item_name, si.unit, si.parent_group,
             v.voucher_date::text AS voucher_date, v.voucher_kind,
             v.buyer_order_date::text AS buyer_order_date, v.reference_date::text AS reference_date,
             abs(coalesce(substring(coalesce(vl.billed_qty, vl.actual_qty) FROM '^\\s*-?[0-9]+\\.?[0-9]*')::numeric, 0))::text AS qty,
             vl.rate::text AS rate, vl.amount::text AS amount, si.gst_rate::text AS gst_rate
        FROM voucher_lines vl
        JOIN vouchers v ON v.id = vl.voucher_id
        JOIN stock_items si ON si.id = vl.stock_item_id
       WHERE v.org_id = ${principal.orgId} AND NOT v.is_cancelled AND vl.kind = 'inventory' AND vl.stock_item_id IS NOT NULL
         AND v.voucher_kind IN ('Purchase', 'Sales', 'Debit Note')
         AND v.voucher_date <= ${asOf}::date
       ORDER BY v.voucher_date, v.created_at, vl.line_no
    `);

    type ItemAccumulator = {
      id: string;
      name: string;
      unit: string;
      parentGroup: string;
      category: string;
      closingQty: number;
      costPrice: number;
      createdDate: string;
      minVoucherDate: string | null;
      layers: StockItemLayer[];
      lastOutwardDate: string | null;
    };

    const itemMap = new Map<string, ItemAccumulator>();

    for (const item of stockItems.rows) {
      const closingQty = Number(item.closing_qty ?? 0);
      const costPrice =
        Number(item.cost_price ?? 0) > 0
          ? Number(item.cost_price)
          : Number(item.sale_price ?? 0) > 0
            ? Number(item.sale_price) * 0.7
            : 0;

      itemMap.set(item.id, {
        id: item.id,
        name: item.name,
        unit: item.unit ?? 'Nos',
        parentGroup: item.parent_group ?? 'General',
        category: categoryOf(item.name),
        closingQty,
        costPrice,
        createdDate: item.created_at,
        minVoucherDate: item.min_voucher_date,
        layers: [],
        lastOutwardDate: item.max_voucher_date,
      });
    }

    for (const line of lines.rows) {
      const qty = Number(line.qty);
      if (qty === 0) continue;

      let acc = itemMap.get(line.stock_item_id);
      if (!acc) {
        acc = {
          id: line.stock_item_id,
          name: line.item_name,
          unit: line.unit ?? 'Nos',
          parentGroup: line.parent_group ?? 'General',
          category: categoryOf(line.item_name),
          closingQty: 0,
          costPrice: 0,
          createdDate: line.voucher_date,
          minVoucherDate: line.voucher_date,
          layers: [],
          lastOutwardDate: null,
        };
        itemMap.set(line.stock_item_id, acc);
      }

      if (line.voucher_kind === 'Purchase') {
        const baseRate = line.rate !== null ? Math.abs(Number(line.rate)) : Math.abs(Number(line.amount)) / qty;
        const gstFactor =
          policy.includeGstInStock && line.gst_rate !== null ? 1 + Number(line.gst_rate) / 100 : 1;
        const effectiveRate = baseRate * gstFactor;
        const advanceDate =
          line.buyer_order_date ??
          (line.reference_date && line.reference_date < line.voucher_date ? line.reference_date : null);

        acc.layers.push({
          inwardDate: line.voucher_date,
          initialQty: qty,
          remainingQty: qty,
          rate: effectiveRate,
          advanceDate,
        });
      } else {
        acc.lastOutwardDate = line.voucher_date;
        let toConsume = qty;
        for (const layer of acc.layers) {
          if (toConsume <= 0) break;
          const consumed = Math.min(layer.remainingQty, toConsume);
          layer.remainingQty -= consumed;
          toConsume -= consumed;
        }
      }
    }

    // Attach baseline opening stock layer for items with remaining closing quantity not covered by purchase vouchers
    for (const acc of itemMap.values()) {
      const purchaseRemaining = acc.layers.reduce((sum, l) => sum + l.remainingQty, 0);
      const neededQty = acc.closingQty - purchaseRemaining;
      if (neededQty > 0.0001 && acc.costPrice > 0) {
        const baselineInwardDate = acc.minVoucherDate ?? acc.createdDate;
        acc.layers.unshift({
          inwardDate: baselineInwardDate,
          initialQty: neededQty,
          remainingQty: neededQty,
          rate: acc.costPrice,
          advanceDate: null,
        });
      }
    }

    const reportItems: StockInterestReportItem[] = [];
    let totalStockValue = 0;
    let fundedStockValue = 0;
    let totalTransitInterest = 0;
    let totalHoldingInterest = 0;
    let nonMovingItemsCount = 0;

    for (const item of itemMap.values()) {
      const activeLayers = item.layers.filter((layer) => layer.remainingQty > 0.0001);
      if (activeLayers.length === 0) continue;

      const itemOverride = itemOverrides.get(item.id) ?? itemNameOverrides.get(item.name.toLowerCase());
      const catOverride = categoryOverrides.get(item.category.toLowerCase());
      const grpOverride = groupOverrides.get(item.parentGroup.toLowerCase());

      const annualRatePct =
        itemOverride?.rate ??
        catOverride?.rate ??
        grpOverride?.rate ??
        policy.stockAnnualRatePct ??
        policy.annualRatePct ??
        12;

      const holdingPeriodDays =
        itemOverride?.days ??
        catOverride?.days ??
        grpOverride?.days ??
        policy.stockHoldingPeriodDays ??
        90;

      const daysSinceOutward =
        item.lastOutwardDate !== null ? Math.max(0, asOfDay - epochDay(item.lastOutwardDate)) : null;
      const nonMoving = isNonMoving(daysSinceOutward, policy.nonMovingDays);
      if (nonMoving) nonMovingItemsCount += 1;

      for (const layer of activeLayers) {
        const inwardDay = epochDay(layer.inwardDate);
        const shelfDays = Math.max(0, asOfDay - inwardDay);
        const closingVal = layer.remainingQty * layer.rate;

        const advanceTransitDays =
          layer.advanceDate !== null ? Math.max(0, inwardDay - epochDay(layer.advanceDate)) : 0;
        const advanceAmount = advanceTransitDays > 0 ? closingVal : 0;
        const transitInterest = calculateAdvanceTransitInterest(
          advanceAmount,
          advanceTransitDays,
          annualRatePct,
          policy.dayBasis,
        );

        const overdueHoldingDays = Math.max(0, shelfDays - holdingPeriodDays);
        const isFunded = overdueHoldingDays > 0;
        const fundedRupeeDays = isFunded ? closingVal * overdueHoldingDays : 0;
        const holdingInterest = calculateHoldingInterest(
          fundedRupeeDays,
          annualRatePct,
          policy.dayBasis,
        );

        const totalInterest = transitInterest + holdingInterest;

        totalStockValue += closingVal;
        if (isFunded) fundedStockValue += closingVal;
        totalTransitInterest += transitInterest;
        totalHoldingInterest += holdingInterest;

        // Apply filters
        if (query.category && item.category.toLowerCase() !== query.category.toLowerCase()) continue;
        if (query.group && item.parentGroup.toLowerCase() !== query.group.toLowerCase()) continue;
        if (query.isNonMoving !== undefined && nonMoving !== query.isNonMoving) continue;
        if (query.search) {
          const s = query.search.toLowerCase();
          const match =
            item.name.toLowerCase().includes(s) ||
            item.parentGroup.toLowerCase().includes(s) ||
            item.category.toLowerCase().includes(s);
          if (!match) continue;
        }

        reportItems.push({
          stockItemId: item.id,
          stockItemName: item.name,
          category: item.category,
          parentGroup: item.parentGroup,
          inwardDate: layer.inwardDate,
          quantity: Number(layer.remainingQty.toFixed(3)),
          unit: item.unit,
          purchaseRate: layer.rate.toFixed(2),
          closingValue: closingVal.toFixed(2),
          advanceAmount: advanceAmount.toFixed(2),
          advanceTransitDays,
          transitInterestAmount: transitInterest.toFixed(2),
          shelfDays,
          holdingPeriodDays,
          holdingInterestAmount: holdingInterest.toFixed(2),
          totalInterestAmount: totalInterest.toFixed(2),
          isNonMoving: nonMoving,
        });
      }
    }

    reportItems.sort((a, b) => b.shelfDays - a.shelfDays || b.stockItemName.localeCompare(a.stockItemName));

    return {
      totalStockValue: totalStockValue.toFixed(2),
      fundedStockValue: fundedStockValue.toFixed(2),
      totalTransitInterest: totalTransitInterest.toFixed(2),
      totalHoldingInterest: totalHoldingInterest.toFixed(2),
      totalAccumulatedInterest: (totalTransitInterest + totalHoldingInterest).toFixed(2),
      nonMovingItemsCount,
      items: reportItems,
    };
  }

  /**
   * Queues the rebuild rather than running it inline: a full walk is minutes
   * of voucher replay on a real ledger, and the request that asked for it
   * deserves an answer now and a snapshot soon.
   */
  async recompute(principal: Principal, input: RecomputeInterestInput): Promise<RecomputeInterestReceipt> {
    if (input.partyId !== undefined) await this.readParty(principal, input.partyId);
    if (input.stockItemId !== undefined) {
      const item = await this.db.execute<{ id: string }>(sql`
        SELECT id FROM stock_items WHERE org_id = ${principal.orgId} AND id = ${input.stockItemId}
      `);
      if (item.rows[0] === undefined) throw AppError.notFound('Stock item', input.stockItemId);
    }

    const jobId = await this.jobs.enqueue('build-interest-snapshots', {
      now: new Date().toISOString(),
      orgId: principal.orgId,
      ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
      ...(input.stockItemId === undefined ? {} : { stockItemId: input.stockItemId }),
      ...(input.from === undefined ? {} : { from: input.from }),
    });

    this.auditContext.record({
      action: 'interest.recompute_requested',
      entityType: 'interest_build_state',
      entityId: principal.orgId,
      before: null,
      after: { jobId, ...input },
    });
    return { jobId };
  }

  private async readParty(principal: Principal, partyId: string): Promise<InterestPartySettingView> {
    const rows = await this.db.execute<SettingRow>(sql`
      SELECT p.id AS party_id, p.name AS party_name, p.parent_group,
             p.credit_days AS tally_credit_days, s.credit_days_override, s.interest_rate_override::text AS interest_rate_override
        FROM parties p
        LEFT JOIN interest_party_settings s
          ON s.org_id = p.org_id AND s.party_id = p.id AND s.deleted_at IS NULL
       WHERE p.org_id = ${principal.orgId} AND p.id = ${partyId}
    `);
    const row = rows.rows[0];
    if (row === undefined) throw AppError.notFound('Party', partyId);
    return viewOf(row);
  }
}

