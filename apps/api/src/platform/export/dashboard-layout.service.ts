import { Injectable } from '@nestjs/common';
import {
  dashboardLayoutSchema,
  isDashboardKey,
  type DashboardKey,
  type DashboardLayout,
  type DashboardLayoutView,
} from '@vyuha/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { dashboardLayouts } from '../db/schema/index.js';
import { ScopedRepository } from '../db/scoped-repository.js';
import { orgContextOf, type Principal } from '../rbac/principal.js';

/**
 * Customisable dashboards (owner, 25 Aug 2026).
 *
 * Layouts are data, presets are code: this service never renders a tile, it
 * only keeps the person's choice per board. A layout is stored per user --
 * nothing here is shared, because a board is a working surface, not a report
 * -- and the rows a tile eventually shows are still resolved through the
 * report endpoints for whoever is looking, so keeping a layout grants nothing.
 *
 * No stored layout means the shipped preset renders, which is why `reset` is
 * a soft delete rather than a write of the default: the default lives in
 * code, and a copy of it in a row would keep rendering the old preset after
 * the preset improved.
 */
@Injectable()
export class DashboardLayoutService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
  ) {}

  async listFor(principal: Principal): Promise<DashboardLayoutView[]> {
    const rows = await this.db
      .select({
        dashboard: dashboardLayouts.dashboard,
        config: dashboardLayouts.config,
        updatedAt: dashboardLayouts.updatedAt,
      })
      .from(dashboardLayouts)
      .where(
        and(
          eq(dashboardLayouts.orgId, principal.orgId),
          isNull(dashboardLayouts.deletedAt),
          eq(dashboardLayouts.userId, principal.userId),
        ),
      )
      .orderBy(asc(dashboardLayouts.dashboard));

    const views: DashboardLayoutView[] = [];
    for (const row of rows) {
      // A config read back out of jsonb is untrusted input even though this
      // code wrote it: an older release may have stored a shape this one no
      // longer understands. An unreadable layout is treated as absent -- the
      // preset renders -- rather than crashing the board over a stale row.
      if (!isDashboardKey(row.dashboard)) continue;
      const parsed = dashboardLayoutSchema.safeParse(row.config);
      if (!parsed.success) continue;
      views.push({
        dashboard: row.dashboard,
        config: parsed.data,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return views;
  }

  /** Creates, or replaces the caller's layout for the same board. */
  async put(
    principal: Principal,
    dashboard: DashboardKey,
    config: DashboardLayout,
  ): Promise<DashboardLayoutView> {
    const existing = await this.db
      .select({ id: dashboardLayouts.id })
      .from(dashboardLayouts)
      .where(
        and(
          eq(dashboardLayouts.orgId, principal.orgId),
          isNull(dashboardLayouts.deletedAt),
          eq(dashboardLayouts.userId, principal.userId),
          eq(dashboardLayouts.dashboard, dashboard),
        ),
      )
      .limit(1);

    const repository = new ScopedRepository(this.db, dashboardLayouts, orgContextOf(principal));
    const values = { userId: principal.userId, dashboard, config };

    const previousId = existing[0]?.id;
    const row =
      previousId === undefined
        ? await repository.insert(values)
        : await repository.update(previousId, values);

    if (row === null) {
      throw new Error(`Dashboard layout ${previousId ?? 'new'} could not be written.`);
    }

    this.auditContext.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: previousId === undefined ? 'report.dashboard.created' : 'report.dashboard.updated',
      entityType: 'dashboard_layout',
      entityId: row.id,
      // The tile list itself would be an unbounded blob in the trail; what an
      // auditor needs is which board changed and how much of it.
      after: { dashboard, tiles: config.tiles.length },
    });

    return { dashboard, config, updatedAt: row.updatedAt.toISOString() };
  }

  /** Back to the shipped preset, by removing the stored choice. */
  async reset(principal: Principal, dashboard: DashboardKey): Promise<void> {
    const rows = await this.db
      .select({ id: dashboardLayouts.id })
      .from(dashboardLayouts)
      .where(
        and(
          eq(dashboardLayouts.orgId, principal.orgId),
          isNull(dashboardLayouts.deletedAt),
          eq(dashboardLayouts.userId, principal.userId),
          eq(dashboardLayouts.dashboard, dashboard),
        ),
      )
      .limit(1);

    const row = rows[0];
    // A board already on the preset is not an error: the caller asked for the
    // default and has it, so resetting twice reads the same as resetting once.
    if (row === undefined) return;

    await new ScopedRepository(this.db, dashboardLayouts, orgContextOf(principal)).softDelete(
      row.id,
    );

    this.auditContext.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'report.dashboard.reset',
      entityType: 'dashboard_layout',
      entityId: row.id,
      before: { dashboard },
      after: null,
    });
  }
}
