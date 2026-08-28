import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { customWidgetSchema, type CustomReportShare, type CustomReportView, type CustomReportWrite, type CustomWidget } from '@vyuha/shared';
import { z } from 'zod';

import { AppError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { customReports } from '../db/schema/index.js';
import { users } from '../db/schema/index.js';
import { type Principal } from '../rbac/principal.js';

/**
 * Custom reports (owner, 26 Aug 2026): personal by default, org-visible when
 * the author shares one. The widgets themselves are pointers at area metrics;
 * a shared report never smuggles data past area permissions, because every
 * widget fetches through the area endpoint under the viewer's own key.
 *
 * Only the author edits or deletes. A shared report someone else depends on
 * being rewritten under them is the wiki problem; one author per report is
 * the answer this size of team needs.
 */
@Injectable()
export class CustomReportsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(principal: Principal): Promise<CustomReportView[]> {
    const rows = await this.db
      .select({ report: customReports, ownerEmail: users.email })
      .from(customReports)
      .innerJoin(users, eq(users.id, customReports.ownerUserId))
      .where(
        and(
          eq(customReports.orgId, principal.orgId),
          or(
            eq(customReports.ownerUserId, principal.userId),
            eq(customReports.shared, true),
            sql`${customReports.sharedWith} @> ${JSON.stringify([principal.userId])}::jsonb`,
          ),
        ),
      )
      .orderBy(desc(customReports.updatedAt));

    const shares = await this.shareViews(principal, rows.map((r) => r.report));
    return rows.map((row) => this.toView(principal, row.report, row.ownerEmail, shares.get(row.report.id) ?? []));
  }

  async find(principal: Principal, id: string): Promise<CustomReportView> {
    const rows = await this.db
      .select({ report: customReports, ownerEmail: users.email })
      .from(customReports)
      .innerJoin(users, eq(users.id, customReports.ownerUserId))
      .where(and(eq(customReports.orgId, principal.orgId), eq(customReports.id, id)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Report', id);
    // A personal report is its author's: reading someone else's unshared
    // layout is refused as not-found, which does not confirm it exists.
    const listed = Array.isArray(row.report.sharedWith) && (row.report.sharedWith as string[]).includes(principal.userId);
    if (!row.report.shared && !listed && row.report.ownerUserId !== principal.userId) {
      throw AppError.notFound('Report', id);
    }
    const shares = await this.shareViews(principal, [row.report]);
    return this.toView(principal, row.report, row.ownerEmail, shares.get(row.report.id) ?? []);
  }

  async create(principal: Principal, body: CustomReportWrite): Promise<CustomReportView> {
    const sharedWith = await this.resolveShares(principal, body.sharedWith ?? []);
    const inserted = await this.db
      .insert(customReports)
      .values({
        orgId: principal.orgId,
        ownerUserId: principal.userId,
        name: body.name,
        description: body.description,
        shared: body.shared,
        sharedWith: sharedWith.map((share) => share.userId),
        widgets: body.widgets,
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw AppError.conflict(`You already have a report named "${body.name}".`);
    }
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'custom_report.created',
      entityType: 'custom_report',
      entityId: row.id,
      after: { name: body.name, shared: body.shared, sharedWith: sharedWith.map((share) => share.email), widgets: body.widgets.length },
    });
    return this.find(principal, row.id);
  }

  async update(principal: Principal, id: string, body: CustomReportWrite): Promise<CustomReportView> {
    const before = await this.owned(principal, id);
    // Absent means unchanged: a rename or layout save must not quietly
    // revoke the colleagues the author named last month.
    const sharedWith = body.sharedWith === undefined ? null : await this.resolveShares(principal, body.sharedWith);
    const updated = await this.db
      .update(customReports)
      .set({
        name: body.name,
        description: body.description,
        shared: body.shared,
        ...(sharedWith === null ? {} : { sharedWith: sharedWith.map((share) => share.userId) }),
        widgets: body.widgets,
        updatedAt: sql`now()`,
      })
      .where(and(eq(customReports.id, id), eq(customReports.orgId, principal.orgId)))
      .returning();
    if (updated[0] === undefined) throw AppError.notFound('Report', id);
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'custom_report.updated',
      entityType: 'custom_report',
      entityId: id,
      before: { name: before.name, shared: before.shared, widgets: this.widgetCount(before.widgets) },
      after: { name: body.name, shared: body.shared, ...(sharedWith === null ? {} : { sharedWith: sharedWith.map((share) => share.email) }), widgets: body.widgets.length },
    });
    return this.find(principal, id);
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const before = await this.owned(principal, id);
    await this.db
      .delete(customReports)
      .where(and(eq(customReports.id, id), eq(customReports.orgId, principal.orgId)));
    await this.audit.write({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'custom_report.deleted',
      entityType: 'custom_report',
      entityId: id,
      before: { name: before.name, shared: before.shared },
    });
  }

  private async owned(principal: Principal, id: string): Promise<typeof customReports.$inferSelect> {
    const rows = await this.db
      .select()
      .from(customReports)
      .where(and(eq(customReports.orgId, principal.orgId), eq(customReports.id, id)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Report', id);
    if (row.ownerUserId !== principal.userId) {
      throw AppError.forbidden('Only the report’s author can change it.');
    }
    return row;
  }

  /**
   * Emails typed in the share dialog become user ids here, or a refusal:
   * silently dropping a typo would leave the author believing a colleague
   * can see a report they cannot.
   */
  private async resolveShares(principal: Principal, emails: readonly string[]): Promise<CustomReportShare[]> {
    const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()))].filter((email) => email !== '');
    if (wanted.length === 0) return [];
    const rows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.orgId, principal.orgId), sql`lower(${users.email}) in ${wanted}`));
    const byEmail = new Map(rows.map((row) => [row.email.toLowerCase(), row]));
    const unknown = wanted.filter((email) => !byEmail.has(email));
    if (unknown.length > 0) {
      throw AppError.validation(`No colleague here has ${unknown.join(', ')}. Sharing is by exact work email.`);
    }
    return wanted
      .map((email) => byEmail.get(email))
      .filter((row): row is { id: string; email: string } => row !== undefined && row.id !== principal.userId)
      .map((row) => ({ userId: row.id, email: row.email }));
  }

  /** The author sees who a report is shared with; everyone else sees nothing. */
  private async shareViews(principal: Principal, rows: (typeof customReports.$inferSelect)[]): Promise<Map<string, CustomReportShare[]>> {
    const owned = rows.filter((row) => row.ownerUserId === principal.userId);
    const ids = [...new Set(owned.flatMap((row) => (Array.isArray(row.sharedWith) ? (row.sharedWith as string[]) : [])))];
    if (ids.length === 0) return new Map();
    const found = await this.db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids));
    const byId = new Map(found.map((row) => [row.id, row.email]));
    return new Map(
      owned.map((row) => [
        row.id,
        (Array.isArray(row.sharedWith) ? (row.sharedWith as string[]) : [])
          .flatMap((userId) => {
            const email = byId.get(userId);
            return email === undefined ? [] : [{ userId, email }];
          }),
      ]),
    );
  }

  private widgetCount(widgets: unknown): number {
    return Array.isArray(widgets) ? widgets.length : 0;
  }

  private toView(principal: Principal, row: typeof customReports.$inferSelect, ownerEmail: string, sharedWith: CustomReportShare[]): CustomReportView {
    // Stored widgets re-validate on the way out: a row written by an older
    // build must not crash today's page, so anything unreadable is dropped.
    const widgets: CustomWidget[] = z.array(customWidgetSchema).catch([]).parse(row.widgets);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      shared: row.shared,
      sharedWith,
      ownerUserId: row.ownerUserId,
      ownerName: ownerEmail,
      editable: row.ownerUserId === principal.userId,
      widgets,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
