import { DATA_SCOPES, type SalesLineInput } from '@vyuha/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { AppError } from '../common/errors.js';
import type { Database } from '../db/db.provider.js';
import { employees, organizations, parties, stockItems } from '../db/schema/index.js';
import type { Principal } from '../rbac/principal.js';
import type { ScopeGrants, ScopeService } from '../rbac/scope.service.js';

/**
 * What every sales document shares before it becomes a particular one:
 * who owns it, whom it is for, and what its lines resolve to. Estimates and
 * sales orders both go through here, so the two never disagree about what
 * an item line means.
 */

export async function resolveDocumentOwner(
  db: Database,
  scopes: ScopeService,
  grants: ScopeGrants,
  principal: Principal,
  requested: string | null | undefined,
): Promise<string | null> {
  if (requested === undefined || requested === null) return principal.employeeId;
  if (requested === principal.employeeId) return requested;
  if (scopes.breadth(principal, grants) !== DATA_SCOPES.ALL) {
    throw AppError.forbidden('Only a holder of sales.document.view.all may assign a document to somebody else.');
  }
  const rows = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.orgId, principal.orgId), eq(employees.id, requested), isNull(employees.deletedAt)))
    .limit(1);
  if (rows.length === 0) throw AppError.validation('The owner must be a current employee.', { ownerId: requested });
  return requested;
}

/** A party wins over a company when both are given: the party is who invoices go to. */
export async function resolveDocumentCustomer(
  db: Database,
  principal: Principal,
  partyId: string | null,
  companyId: string | null,
  customerName: string | null,
): Promise<{ partyId: string | null; companyId: string | null; name: string }> {
  let name = customerName;
  if (partyId !== null) {
    const rows = await db
      .select({ name: parties.name })
      .from(parties)
      .where(and(eq(parties.orgId, principal.orgId), eq(parties.id, partyId)))
      .limit(1);
    const party = rows[0];
    if (party === undefined) throw AppError.validation('The party was not found.', { partyId });
    name ??= party.name;
  }
  if (companyId !== null) {
    // Raw SQL, not the CRM schema: this module may not import that one (technical design §1).
    const rows = await db.execute<{ name: string; party_id: string | null }>(
      sql`SELECT name, party_id FROM crm_companies WHERE org_id = ${principal.orgId} AND id = ${companyId} AND deleted_at IS NULL LIMIT 1`,
    );
    const company = rows.rows[0];
    if (company === undefined) throw AppError.validation('The company was not found.', { companyId });
    name ??= company.name;
  }
  if (name === null || name === '') throw AppError.validation('A party, a company, or a customer name is required.');
  return { partyId, companyId, name };
}

/**
 * Lines with a stock item take the item's name as description when none
 * was typed, and its GST rate as tax when none was given; a free-text line
 * stands as typed. An item id from another organisation is refused.
 *
 * "None was given" is `undefined`, not zero. It used to be zero, because the
 * schema defaulted the field -- so a line deliberately zero-rated, an exempt
 * supply or a zero-rated export, was silently rewritten to the item's 18% and
 * the customer was charged tax the salesperson had said not to charge. Every
 * line comes back with a tax percentage, which is what `ResolvedLine` says.
 */
export type ResolvedLine = SalesLineInput & { readonly taxPct: string };

export async function resolveDocumentLines(db: Database, principal: Principal, lines: readonly SalesLineInput[]): Promise<ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    if (line.stockItemId === undefined || line.stockItemId === null) {
      resolved.push({ ...line, stockItemId: null, taxPct: line.taxPct ?? '0' });
      continue;
    }
    const rows = await db
      .select({ name: stockItems.name, unit: stockItems.unit, gstRate: stockItems.gstRate })
      .from(stockItems)
      .where(and(eq(stockItems.orgId, principal.orgId), eq(stockItems.id, line.stockItemId)))
      .limit(1);
    const item = rows[0];
    if (item === undefined) throw AppError.validation('A line names a stock item that was not found.', { stockItemId: line.stockItemId });
    resolved.push({
      ...line,
      description: line.description === '' ? item.name : line.description,
      unit: line.unit ?? item.unit,
      taxPct: line.taxPct ?? (item.gstRate === null ? '0' : String(Number(item.gstRate))),
    });
  }
  return resolved;
}

export async function orgToday(db: Database, orgId: string): Promise<string> {
  const rows = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: rows[0]?.timezone ?? 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
