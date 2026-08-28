import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PERMISSIONS } from '@vyuha/shared';

import { AppError } from '../../platform/common/errors.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import { istDateOf } from '../../platform/tasks/local-date.js';
import { CATEGORY_CASE_SQL } from './category.js';
import { readDelta, type DeltaReading } from './robustness.js';
import { sameDayLastYear } from './period/period-resolver.js';
import { TeamService } from './team.service.js';

/**
 * Brand performance (brief G2) -- where a switchgear distributor actually
 * earns. Per principal: sales against the same days last year, margin on
 * the proxy where the caller may see rupees (K3), the category split,
 * price realisation, target against achievement, and the slabs: distance
 * to the next one in rupees and days, because a push in the last week can
 * be worth more than the month's trading margin. Slabs are all-or-nothing
 * at the boundary; the basis is sales until purchases join the projection.
 */

export interface SlabRow {
  readonly id: string;
  readonly brand: string;
  readonly label: string;
  readonly threshold: string;
  readonly basis: string;
  readonly period: string;
  readonly reward: string;
  readonly active: boolean;
  readonly progress: string;
  readonly distance: string;
  readonly attainedPct: number;
  readonly daysLeft: number;
}

export interface BrandRow {
  readonly brand: string;
  readonly net: string;
  readonly lastYear: string;
  readonly delta: DeltaReading;
  readonly sharePct: number;
  readonly qty: string;
  readonly realisation: string | null;
  readonly realisationLy: string | null;
  readonly margin: string | null;
  readonly marginPct: number | null;
  readonly target: string | null;
  readonly achievementPct: number | null;
  readonly categories: readonly { category: string; net: string }[];
  readonly slabs: readonly SlabRow[];
}

const MATERIALITY_FLOOR = 25_000;

const fyStartOf = (day: string): string => {
  const [y = 0, m = 1] = day.split('-').map(Number);
  return `${String(m >= 4 ? y : y - 1)}-04-01`;
};
const fyEndOf = (day: string): string => {
  const [y = 0, m = 1] = day.split('-').map(Number);
  return `${String(m >= 4 ? y + 1 : y)}-03-31`;
};

@Injectable()
export class BrandService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly team: TeamService,
  ) {}

  async read(principal: Principal, from: string, to: string): Promise<{ brands: readonly BrandRow[]; asOf: string }> {
    const lyFrom = sameDayLastYear(from);
    const lyTo = sameDayLastYear(to);
    const canRupees = hasPermission(principal, PERMISSIONS.CFO_MARGIN_VIEW);
    const rows = await this.db.execute<{
      brand: string; net: string; ly: string; qty: string; qtyLy: string; margin: string | null; costedNet: string | null;
    }>(sql`
      SELECT brand,
             sum(net) FILTER (WHERE date BETWEEN ${from} AND ${to})::numeric(16,2)::text AS net,
             sum(net) FILTER (WHERE date BETWEEN ${lyFrom} AND ${lyTo})::numeric(16,2)::text AS ly,
             sum(qty) FILTER (WHERE date BETWEEN ${from} AND ${to})::numeric(16,3)::text AS qty,
             sum(qty) FILTER (WHERE date BETWEEN ${lyFrom} AND ${lyTo})::numeric(16,3)::text AS "qtyLy",
             sum(pocket_margin) FILTER (WHERE date BETWEEN ${from} AND ${to})::numeric(16,2)::text AS margin,
             sum(net) FILTER (WHERE date BETWEEN ${from} AND ${to} AND pocket_margin IS NOT NULL)::numeric(16,2)::text AS "costedNet"
      FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND (date BETWEEN ${from} AND ${to} OR date BETWEEN ${lyFrom} AND ${lyTo})
      GROUP BY 1 ORDER BY 2 DESC NULLS LAST
    `);
    const categories = await this.db.execute<{ brand: string; category: string; net: string }>(sql`
      SELECT brand, (${sql.raw(CATEGORY_CASE_SQL)}) AS category, sum(net)::numeric(16,2)::text AS net
      FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${from} AND ${to}
      GROUP BY 1, 2
    `);
    const slabs = await this.slabRows(principal, to);
    const companyNet = rows.rows.reduce((sum, r) => sum + Number(r.net ?? 0), 0);

    const brands: BrandRow[] = [];
    for (const r of rows.rows) {
      const net = Number(r.net ?? 0);
      const ly = Number(r.ly ?? 0);
      const qty = Number(r.qty ?? 0);
      const qtyLy = Number(r.qtyLy ?? 0);
      const target = await this.team.targetForRange(principal, `brand:${r.brand}`, from, to);
      const costedNet = Number(r.costedNet ?? 0);
      brands.push({
        brand: r.brand,
        net: net.toFixed(2),
        lastYear: ly.toFixed(2),
        delta: readDelta(net, ly, MATERIALITY_FLOOR),
        sharePct: companyNet === 0 ? 0 : Math.round((net / companyNet) * 1000) / 10,
        qty: qty.toFixed(3),
        realisation: qty === 0 ? null : (net / qty).toFixed(2),
        realisationLy: qtyLy === 0 ? null : (ly / qtyLy).toFixed(2),
        margin: canRupees ? (r.margin === null ? null : Number(r.margin).toFixed(2)) : null,
        marginPct: r.margin === null || costedNet === 0 ? null : Math.round((Number(r.margin) / costedNet) * 1000) / 10,
        target,
        achievementPct: target === null || Number(target) === 0 ? null : Math.round((net / Number(target)) * 100),
        categories: categories.rows.filter((c) => c.brand === r.brand).sort((a, b) => Number(b.net) - Number(a.net)),
        slabs: slabs.filter((slab) => slab.brand === r.brand),
      });
    }
    return { brands, asOf: istDateOf(new Date().toISOString()) };
  }

  async slabRows(principal: Principal, asOf?: string): Promise<SlabRow[]> {
    const day = asOf ?? istDateOf(new Date().toISOString());
    const fyStart = fyStartOf(day);
    const fyEnd = fyEndOf(day);
    const slabs = await this.db.execute<{
      id: string; brand: string; label: string; threshold: string; basis: string; period: string; reward: string; active: boolean;
    }>(sql`
      SELECT id, brand, label, threshold::text AS threshold, basis, period, reward, active
      FROM cfo_brand_slabs WHERE org_id = ${principal.orgId} ORDER BY brand, threshold
    `);
    if (slabs.rows.length === 0) return [];
    const progress = await this.db.execute<{ brand: string; net: string }>(sql`
      SELECT brand, sum(net)::numeric(16,2)::text AS net FROM fact_sales_daily
      WHERE org_id = ${principal.orgId} AND date BETWEEN ${fyStart} AND ${day}
      GROUP BY 1
    `);
    const progressOf = new Map(progress.rows.map((r) => [r.brand, Number(r.net)]));
    const daysLeft = Math.max(0, Math.round((Date.parse(fyEnd) - Date.parse(day)) / 86_400_000));
    return slabs.rows.map((slab) => {
      const done = progressOf.get(slab.brand) ?? 0;
      const threshold = Number(slab.threshold);
      return {
        ...slab,
        progress: done.toFixed(2),
        distance: Math.max(0, threshold - done).toFixed(2),
        attainedPct: threshold === 0 ? 0 : Math.min(999, Math.round((done / threshold) * 100)),
        daysLeft,
      };
    });
  }

  async saveSlab(principal: Principal, row: { id?: string; brand: string; label: string; threshold: string; reward: string; active: boolean }): Promise<void> {
    if (row.id !== undefined) {
      const updated = await this.db.execute<{ id: string }>(sql`
        UPDATE cfo_brand_slabs SET brand = ${row.brand}, label = ${row.label}, threshold = ${row.threshold}::numeric,
               reward = ${row.reward}, active = ${row.active}, updated_at = now()
        WHERE org_id = ${principal.orgId} AND id = ${row.id} RETURNING id
      `);
      if (updated.rows[0] === undefined) throw AppError.notFound('slab', row.id);
    } else {
      await this.db.execute(sql`
        INSERT INTO cfo_brand_slabs (org_id, brand, label, threshold, reward, active)
        VALUES (${principal.orgId}, ${row.brand}, ${row.label}, ${row.threshold}::numeric, ${row.reward}, ${row.active})
      `);
    }
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'cfo.slab.saved',
      entityType: 'cfo_brand_slab',
      entityId: `${row.brand}:${row.label}`,
      before: null,
      after: { brand: row.brand, label: row.label, threshold: row.threshold, active: row.active },
    });
  }

  async deleteSlab(principal: Principal, id: string): Promise<void> {
    const gone = await this.db.execute<{ id: string }>(sql`
      DELETE FROM cfo_brand_slabs WHERE org_id = ${principal.orgId} AND id = ${id} RETURNING id
    `);
    if (gone.rows[0] === undefined) throw AppError.notFound('slab', id);
    await this.audit.write({ orgId: principal.orgId, actorUserId: principal.userId, action: 'cfo.slab.deleted', entityType: 'cfo_brand_slab', entityId: id, before: null, after: null });
  }
}
