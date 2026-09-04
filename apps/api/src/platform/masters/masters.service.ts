import { Injectable } from '@nestjs/common';
import {
  DEFAULT_PARTY_SORT,
  DEFAULT_STOCK_ITEM_SORT,
  DEFAULT_VOUCHER_SORT,
  pageSlice,
  paginated,
  parseSort,
  PARTY_SORT_FIELDS,
  STOCK_ITEM_SORT_FIELDS,
  VOUCHER_SORT_FIELDS,
  type Paginated,
  type PartyListQuery,
  type PartyView,
  type PriceListEntryView,
  type PriceListListQuery,
  type StockItemListQuery,
  type StockItemView,
  type VoucherDetailView,
  type VoucherLineView,
  type VoucherListQuery,
  type VoucherTypeFacet,
  type VoucherView, type DuplicateFlag } from '@vyuha/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { type PgColumn } from 'drizzle-orm/pg-core';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { DuplicatesService } from './duplicates.service.js';
import { employees, parties, partyManagers, priceListEntries, stockItems, voucherLines, vouchers } from '../db/schema/index.js';
import { masterOrderBy, masterSearch, withRelevance } from '../org/master-query.js';
import { orgContextOf, type Principal } from '../rbac/principal.js';

/**
 * Reads over the parties projection (REQ-R-01). Reads only — the projection
 * has exactly one writer, `SyncWriterService`, and this service exists so
 * screens never touch the table directly.
 *
 * No `ScopeService` here, deliberately: 08 §2.2 gives `masters.tally.view`
 * as a single organisation-wide key with no self/team breadths. A party is
 * the organisation's customer, not somebody's record; holders see the list.
 */
@Injectable()
export class MastersService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly duplicates: DuplicatesService,
    private readonly auditContext: AuditContext,
  ) {}

  private attachPartyFlags(orgId: string, views: readonly PartyView[]): Promise<PartyView[]> {
    return attachFlags(this.duplicates, orgId, 'party', views);
  }

  private attachItemFlags(orgId: string, views: readonly StockItemView[]): Promise<StockItemView[]> {
    return attachFlags(this.duplicates, orgId, 'stock_item', views);
  }

  async listParties(principal: Principal, query: PartyListQuery): Promise<Paginated<PartyView>> {
    const { limit, offset } = pageSlice(query);
    const where = this.partyPredicate(principal, query);

    // Independent statements; paying two round trips in sequence would
    // double the endpoint's latency for nothing.
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(parties)
        .where(where)
        // Relevance first when something was typed, then the requested sort:
        // a forgiving filter with an alphabetical order buries the row the
        // person is typing towards behind every other row containing a "c".
        .orderBy(
          ...withRelevance(
            query.q,
            parties.name,
            masterOrderBy(parseSort(query.sort ?? DEFAULT_PARTY_SORT, PARTY_SORT_FIELDS), { name: parties.name, creditLimit: parties.creditLimit, creditDays: parties.creditDays, openingBalance: parties.openingBalance, closingBalance: parties.closingBalance }, parties.name, parties.id),
          ),
        )
        .limit(limit)
        .offset(offset),
      this.db.select({ value: sql<number>`count(*)::int` }).from(parties).where(where),
    ]);

    const flagged = await this.attachPartyFlags(principal.orgId, rows.map(toView));
    return paginated(await this.attachManagers(principal.orgId, flagged), query, total[0]?.value ?? 0);
  }

  async findParty(principal: Principal, id: string): Promise<PartyView> {
    const rows = await this.db
      .select()
      .from(parties)
      .where(and(eq(parties.orgId, principal.orgId), eq(parties.id, id)))
      .limit(1);
    const row = rows[0];
    // Cross-org and non-existent are one answer, as everywhere else.
    if (row === undefined) throw AppError.notFound('Party', id);
    const flagged = (await this.attachPartyFlags(principal.orgId, [toView(row)]))[0] ?? toView(row);
    return (await this.attachManagers(principal.orgId, [flagged]))[0] ?? flagged;
  }

  /** The relationship manager on each party, in one query, so a page is one round trip. */
  private async attachManagers(orgId: string, views: PartyView[]): Promise<PartyView[]> {
    if (views.length === 0) return views;
    const rows = await this.db
      .select({ partyId: partyManagers.partyId, managerId: employees.id, first: employees.firstName, last: employees.lastName })
      .from(partyManagers)
      .innerJoin(employees, eq(employees.id, partyManagers.managerId))
      .where(and(eq(partyManagers.orgId, orgId), isNull(partyManagers.deletedAt), inArray(partyManagers.partyId, views.map((v) => v.id))));
    const byParty = new Map(rows.map((r) => [r.partyId, { id: r.managerId, name: [r.first, r.last].filter((p) => p !== null && p !== '').join(' ') }]));
    return views.map((view) => ({ ...view, manager: byParty.get(view.id) ?? null }));
  }

  /**
   * Set or clear a customer's relationship manager (parties.rm.assign). A
   * Vyuha-owned assignment: soft-close the current one and open the new, so the
   * one-RM-per-party rule holds and the change is audited before-and-after.
   */
  async assignManager(principal: Principal, partyId: string, managerId: string | null): Promise<PartyView> {
    const ctx = orgContextOf(principal);
    // The party must exist in this org; cross-org and missing are one answer.
    await this.findParty(principal, partyId);
    let previous: { manager_id: string } | undefined;
    await this.db.transaction(async (tx) => {
      const prev = await tx
        .execute<{ id: string; manager_id: string }>(sql`SELECT id, manager_id FROM party_managers WHERE org_id = ${ctx.orgId} AND party_id = ${partyId} AND deleted_at IS NULL`)
        .then((r) => r.rows[0]);
      previous = prev;
      if (prev !== undefined) {
        await tx.execute(sql`UPDATE party_managers SET deleted_at = now(), updated_at = now(), updated_by = ${ctx.actorUserId} WHERE id = ${prev.id}`);
      }
      if (managerId !== null) {
        const emp = await tx
          .execute<{ id: string }>(sql`SELECT id FROM employees WHERE org_id = ${ctx.orgId} AND id = ${managerId} AND deleted_at IS NULL`)
          .then((r) => r.rows[0]);
        if (emp === undefined) throw AppError.notFound('Employee', managerId);
        await tx.execute(sql`INSERT INTO party_managers (org_id, party_id, manager_id, created_by, updated_by) VALUES (${ctx.orgId}, ${partyId}, ${managerId}, ${ctx.actorUserId}, ${ctx.actorUserId})`);
      }
    });
    this.auditContext.record({
      action: 'parties.rm.assigned',
      entityType: 'party_manager',
      entityId: partyId,
      before: previous === undefined ? null : { managerId: previous.manager_id },
      after: managerId === null ? null : { managerId },
    });
    return this.findParty(principal, partyId);
  }

  /** REQ-R-02, read side: same shape as parties, columns per the PRD's list. */
  async listStockItems(
    principal: Principal,
    query: StockItemListQuery,
  ): Promise<Paginated<StockItemView>> {
    const { limit, offset } = pageSlice(query);

    const parts: (SQL | undefined)[] = [eq(stockItems.orgId, principal.orgId)];
    if (query.connectionId !== undefined) {
      parts.push(eq(stockItems.connectionId, query.connectionId));
    }
    if (query.parentGroup !== undefined) {
      parts.push(eq(stockItems.parentGroup, query.parentGroup));
    }
    if (query.q !== undefined) {
      parts.push(masterSearch(query.q, [stockItems.name, stockItems.alias]));
    }
    const where = and(...parts);
    if (where === undefined) {
      throw new Error('Stock item predicate collapsed to undefined; refusing an unscoped query.');
    }

    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(stockItems)
        .where(where)
        .orderBy(
          ...withRelevance(
            query.q,
            stockItems.name,
            masterOrderBy(parseSort(query.sort ?? DEFAULT_STOCK_ITEM_SORT, STOCK_ITEM_SORT_FIELDS), { name: stockItems.name, gstRate: stockItems.gstRate }, stockItems.name, stockItems.id),
          ),
        )
        .limit(limit)
        .offset(offset),
      this.db.select({ value: sql<number>`count(*)::int` }).from(stockItems).where(where),
    ]);

    return paginated(
      await this.attachItemFlags(principal.orgId, rows.map((row) => ({
        id: row.id,
        connectionId: row.connectionId,
        name: row.name,
        alias: row.alias,
        unit: row.unit,
        parentGroup: row.parentGroup,
        gstRate: row.gstRate,
        closingQty: row.closingQty,
        salePrice: row.salePrice,
        costPrice: row.costPrice,
        absentInTally: row.absentInTally,
        lastPulledAt: row.lastPulledAt.toISOString(),
        duplicate: null,
      }))),
      query,
      total[0]?.value ?? 0,
    );
  }

  /**
   * REQ-R-03, read side. The item name is joined in because a rate without
   * its item is a number without a noun; sorted by item then level so one
   * item's levels read together.
   */
  async findStockItem(principal: Principal, id: string): Promise<StockItemView> {
    const rows = await this.db
      .select()
      .from(stockItems)
      .where(and(eq(stockItems.orgId, principal.orgId), eq(stockItems.id, id)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Stock item', id);
    const view: StockItemView = {
      id: row.id,
      connectionId: row.connectionId,
      name: row.name,
      alias: row.alias,
      unit: row.unit,
      parentGroup: row.parentGroup,
      gstRate: row.gstRate,
      closingQty: row.closingQty,
      salePrice: row.salePrice,
      costPrice: row.costPrice,
      absentInTally: row.absentInTally,
      lastPulledAt: row.lastPulledAt.toISOString(),
      duplicate: null,
    };
    return (await this.attachItemFlags(principal.orgId, [view]))[0] ?? view;
  }

  async listPriceListEntries(
    principal: Principal,
    query: PriceListListQuery,
  ): Promise<Paginated<PriceListEntryView>> {
    const { limit, offset } = pageSlice(query);

    const parts: (SQL | undefined)[] = [eq(priceListEntries.orgId, principal.orgId)];
    if (query.priceLevel !== undefined) {
      parts.push(eq(priceListEntries.priceLevel, query.priceLevel));
    }
    if (query.q !== undefined) {
      parts.push(masterSearch(query.q, [stockItems.name]));
    }
    const where = and(...parts);
    if (where === undefined) {
      throw new Error('Price list predicate collapsed to undefined; refusing an unscoped query.');
    }

    const base = this.db
      .select({
        id: priceListEntries.id,
        connectionId: priceListEntries.connectionId,
        stockItemName: stockItems.name,
        priceLevel: priceListEntries.priceLevel,
        rate: priceListEntries.rate,
        unit: priceListEntries.unit,
        lastPulledAt: priceListEntries.lastPulledAt,
      })
      .from(priceListEntries)
      .innerJoin(stockItems, eq(stockItems.id, priceListEntries.stockItemId));

    const [rows, total] = await Promise.all([
      base
        .where(where)
        .orderBy(asc(stockItems.name), asc(priceListEntries.priceLevel), asc(priceListEntries.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ value: sql<number>`count(*)::int` })
        .from(priceListEntries)
        .innerJoin(stockItems, eq(stockItems.id, priceListEntries.stockItemId))
        .where(where),
    ]);

    return paginated(
      rows.map((row) => ({
        id: row.id,
        connectionId: row.connectionId,
        stockItemName: row.stockItemName,
        priceLevel: row.priceLevel,
        rate: row.rate,
        unit: row.unit,
        lastPulledAt: row.lastPulledAt.toISOString(),
      })),
      query,
      total[0]?.value ?? 0,
    );
  }

  /**
   * Phase 6c, read side. Newest first — the books are read from today
   * backwards — with the cancelled hidden unless asked for, because a
   * cancelled voucher is a fact about history, not a line in the ledger.
   */
  async listVouchers(principal: Principal, query: VoucherListQuery): Promise<Paginated<VoucherView>> {
    const { limit, offset } = pageSlice(query);
    const where = this.voucherPredicate(principal, query);

    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(vouchers)
        .where(where)
        .orderBy(...voucherOrderBy(query.sort))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: sql<number>`count(*)::int` }).from(vouchers).where(where),
    ]);

    return paginated(rows.map(toVoucherView), query, total[0]?.value ?? 0);
  }

  /**
   * Every voucher type this organisation has, commonest first.
   *
   * The filter above the register needs options, and Tally's voucher types
   * are configured per company (REQ-R-04) -- so they cannot be a list held
   * here, only the distinct set of what has actually arrived. Cancelled
   * vouchers count: they are still in the register when the switch is on, and
   * a type that offers no rows would read as a broken filter.
   */
  async listVoucherTypes(principal: Principal): Promise<VoucherTypeFacet[]> {
    const rows = await this.db
      .select({ voucherType: vouchers.voucherType, count: sql<number>`count(*)::int` })
      .from(vouchers)
      .where(eq(vouchers.orgId, principal.orgId))
      .groupBy(vouchers.voucherType)
      .orderBy(desc(sql`count(*)`), asc(vouchers.voucherType));

    return rows.map((row) => ({ voucherType: row.voucherType, count: row.count }));
  }

  async findVoucher(principal: Principal, id: string): Promise<VoucherDetailView> {
    const rows = await this.db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.orgId, principal.orgId), eq(vouchers.id, id)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Voucher', id);

    const lines = await this.db
      .select()
      .from(voucherLines)
      .where(eq(voucherLines.voucherId, row.id))
      .orderBy(asc(voucherLines.lineNo));

    return {
      ...toVoucherView(row),
      lines: lines.map(
        (line): VoucherLineView => ({
          lineNo: line.lineNo,
          kind: line.kind,
          ledgerName: line.ledgerName,
          isDeemedPositive: line.isDeemedPositive,
          stockItemName: line.stockItemName,
          stockItemId: line.stockItemId,
          actualQty: line.actualQty,
          billedQty: line.billedQty,
          rate: line.rate,
          amount: line.amount,
        }),
      ),
    };
  }

  private voucherPredicate(principal: Principal, query: VoucherListQuery): SQL {
    const parts: (SQL | undefined)[] = [eq(vouchers.orgId, principal.orgId)];
    if (query.connectionId !== undefined) parts.push(eq(vouchers.connectionId, query.connectionId));
    if (query.voucherType !== undefined) parts.push(eq(vouchers.voucherType, query.voucherType));
    if (query.partyId !== undefined) parts.push(eq(vouchers.partyId, query.partyId));
    if (query.from !== undefined) parts.push(gte(vouchers.voucherDate, query.from));
    if (query.to !== undefined) parts.push(lte(vouchers.voucherDate, query.to));
    if (query.includeCancelled !== true) parts.push(eq(vouchers.isCancelled, false));
    if (query.q !== undefined) {
      parts.push(masterSearch(query.q, [vouchers.voucherNumber, vouchers.partyName, vouchers.narration]));
    }
    const predicate = and(...parts);
    if (predicate === undefined) {
      throw new Error('Voucher predicate collapsed to undefined; refusing an unscoped query.');
    }
    return predicate;
  }

  private partyPredicate(principal: Principal, query: PartyListQuery): SQL {
    const parts: (SQL | undefined)[] = [eq(parties.orgId, principal.orgId)];
    if (query.connectionId !== undefined) parts.push(eq(parties.connectionId, query.connectionId));
    if (query.parentGroup !== undefined) {
      parts.push(eq(parties.parentGroup, query.parentGroup));
    }
    if (query.q !== undefined) {
      // The one master-search helper, so the escaping rule cannot fork:
      // NULL columns are simply not-ILIKE-matched, which is the same answer
      // the coalesce dance gave at more length.
      parts.push(masterSearch(query.q, [parties.name, parties.alias, parties.gstin]));
    }

    // "My customers", or a manager reviewing one RM's book: the parties that RM
    // is assigned on. `mine` with no employee behind the login is an empty book.
    const managerId = query.mine === true ? principal.employeeId : query.managerId;
    if (query.mine === true && principal.employeeId === null) {
      parts.push(sql`false`);
    } else if (managerId !== undefined && managerId !== null) {
      parts.push(sql`EXISTS (SELECT 1 FROM party_managers pm WHERE pm.org_id = ${principal.orgId} AND pm.party_id = ${parties.id} AND pm.manager_id = ${managerId} AND pm.deleted_at IS NULL)`);
    }

    const predicate = and(...parts);
    if (predicate === undefined) {
      throw new Error('Party predicate collapsed to undefined; refusing an unscoped query.');
    }
    return predicate;
  }
}

/** 15 REQ-AO-06: one join for a page of ids; the flag rides on the view wherever the record is listed. */
async function attachFlags<T extends { id: string; duplicate: DuplicateFlag | null }>(duplicates: DuplicatesService, orgId: string, entityType: 'party' | 'stock_item', views: readonly T[]): Promise<T[]> {
  const flags = await duplicates.flagsFor(orgId, entityType, views.map((v) => v.id));
  return views.map((v) => ({ ...v, duplicate: flags.get(v.id) ?? null }));
}

const VOUCHER_SORT_COLUMNS: Readonly<Record<string, PgColumn>> = {
  date: vouchers.voucherDate,
  type: vouchers.voucherType,
  number: vouchers.voucherNumber,
  party: vouchers.partyName,
  amount: vouchers.amount,
};

/**
 * The register's order: what was asked for, then the two tiebreaks.
 *
 * `createdAt` descending keeps a day's vouchers in the order they arrived,
 * which is the order Tally itself lists them in; `id` last makes paging
 * deterministic, without which a row can appear on two pages while another
 * appears on none. Both survive whatever column the reader sorted by, so the
 * tiebreaks never move.
 *
 * `amount` is a numeric column, so Postgres orders it as a number -- sorting
 * Tally's exact-decimal text lexically would put 9 above 10.
 */
function voucherOrderBy(sort: string | undefined): (SQL | PgColumn)[] {
  const clauses: (SQL | PgColumn)[] = [];
  for (const term of parseSort(sort ?? DEFAULT_VOUCHER_SORT, VOUCHER_SORT_FIELDS)) {
    const column = VOUCHER_SORT_COLUMNS[term.field];
    if (column === undefined) continue;
    clauses.push(term.direction === 'desc' ? desc(column) : asc(column));
  }
  if (clauses.length === 0) clauses.push(desc(vouchers.voucherDate));
  clauses.push(desc(vouchers.createdAt), asc(vouchers.id));
  return clauses;
}

function toView(row: typeof parties.$inferSelect): PartyView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    name: row.name,
    alias: row.alias,
    parentGroup: row.parentGroup,
    gstin: row.gstin,
    email: row.email,
    phone: row.phone,
    address: row.address,
    creditLimit: row.creditLimit,
    creditDays: row.creditDays,
    openingBalance: row.openingBalance,
    closingBalance: row.closingBalance,
    absentInTally: row.absentInTally,
    lastPulledAt: row.lastPulledAt.toISOString(),
    manager: null,
    duplicate: null,
  };
}

function toVoucherView(row: typeof vouchers.$inferSelect): VoucherView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    date: row.voucherDate,
    voucherType: row.voucherType,
    voucherNumber: row.voucherNumber,
    partyName: row.partyName,
    partyId: row.partyId,
    narration: row.narration,
    isCancelled: row.isCancelled,
    amount: row.amount,
    lastPulledAt: row.lastPulledAt.toISOString(),
    reference: row.reference ?? null,
    referenceDate: row.referenceDate ?? null,
    orderRef: row.orderRef ?? null,
    buyerOrderNumber: row.buyerOrderNumber ?? null,
    buyerOrderDate: row.buyerOrderDate ?? null,
    paymentTerms: row.paymentTerms ?? null,
    deliveryTerms: row.deliveryTerms ?? null,
    dispatchedThrough: row.dispatchedThrough ?? null,
    dispatchDocNo: row.dispatchDocNo ?? null,
    vehicleNumber: row.vehicleNumber ?? null,
    destination: row.destination ?? null,
    buyerName: row.buyerName ?? null,
    buyerAddress: row.buyerAddress ?? null,
    partyGstin: row.partyGstin ?? null,
    partyState: row.partyState ?? null,
    placeOfSupply: row.placeOfSupply ?? null,
    consigneeName: row.consigneeName ?? null,
    consigneeState: row.consigneeState ?? null,
    consigneePincode: row.consigneePincode ?? null,
    consigneeGstin: row.consigneeGstin ?? null,
  };
}
