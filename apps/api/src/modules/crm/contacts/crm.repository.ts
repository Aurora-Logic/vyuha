import type { CompanyView, ContactDuplicate, ContactView, SortTerm } from '@vyuha/shared';
import { and, asc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../../../platform/db/db.provider.js';
import { employees } from '../../../platform/db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../../../platform/db/scoped-repository.js';
import { masterOrderBy, masterSearch, withRelevance } from '../../../platform/org/master-query.js';
import { crmCompanies, crmContacts } from '../schema/index.js';

/**
 * Contacts and companies (REQ-U-01, REQ-U-02, REQ-U-08).
 *
 * Two `ScopedRepository` subclasses over one file because every read of one
 * table joins the other — a contact shows its company's name, a company shows
 * how many contacts it has — and the ownership predicate the service resolves
 * through `ScopeService` is threaded into both the same way: as an extra
 * argument to `scoped()`, never as a replacement for it.
 */

const CONTACT_SORT_COLUMNS = {
  name: crmContacts.name,
  createdAt: crmContacts.createdAt,
  updatedAt: crmContacts.updatedAt,
} as const;

const COMPANY_SORT_COLUMNS = {
  name: crmCompanies.name,
  createdAt: crmCompanies.createdAt,
  updatedAt: crmCompanies.updatedAt,
} as const;

/** `first last`, or null when the owner column is null. */
const ownerName = (owner: {
  id: PgColumn;
  firstName: PgColumn;
  lastName: PgColumn;
}): SQL<string | null> =>
  sql<string | null>`CASE WHEN ${owner.id} IS NULL THEN NULL ELSE concat_ws(' ', ${owner.firstName}, ${owner.lastName}) END`;

export interface ContactListFilters {
  readonly q?: string | undefined;
  readonly companyId?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly sort: readonly SortTerm[];
  readonly limit: number;
  readonly offset: number;
}

export interface CompanyListFilters {
  readonly q?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly sort: readonly SortTerm[];
  readonly limit: number;
  readonly offset: number;
}

const contactOwner = alias(employees, 'contact_owner');

export class ContactRepository extends ScopedRepository<typeof crmContacts> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, crmContacts, ctx);
  }

  private contactSelection() {
    return {
      id: crmContacts.id,
      name: crmContacts.name,
      phone: crmContacts.phone,
      email: crmContacts.email,
      designation: crmContacts.designation,
      companyId: crmContacts.companyId,
      companyName: crmCompanies.name,
      ownerId: crmContacts.ownerId,
      ownerName: ownerName(contactOwner),
      source: crmContacts.source,
      notes: crmContacts.notes,
      createdAt: crmContacts.createdAt,
      updatedAt: crmContacts.updatedAt,
    };
  }

  private contactQuery(where: SQL) {
    return this.db
      .select(this.contactSelection())
      .from(crmContacts)
      // Alive companies only: a deleted company's name would keep showing on
      // its contacts as though it were still there.
      .leftJoin(
        crmCompanies,
        and(eq(crmCompanies.id, crmContacts.companyId), isNull(crmCompanies.deletedAt)),
      )
      .leftJoin(contactOwner, eq(contactOwner.id, crmContacts.ownerId))
      .where(where);
  }

  async list(
    scope: SQL,
    filters: ContactListFilters,
  ): Promise<{ rows: ContactView[]; total: number }> {
    const where = this.scoped(
      scope,
      filters.companyId === undefined ? undefined : eq(crmContacts.companyId, filters.companyId),
      filters.ownerId === undefined ? undefined : eq(crmContacts.ownerId, filters.ownerId),
      filters.q === undefined
        ? undefined
        : masterSearch(filters.q, [
            crmContacts.name,
            crmContacts.phone,
            crmContacts.email,
            crmContacts.designation,
          ]),
    );

    const rows = await this.contactQuery(where)
      .orderBy(
        ...withRelevance(filters.q, crmContacts.name, masterOrderBy(filters.sort, CONTACT_SORT_COLUMNS, crmContacts.name, crmContacts.id)),
      )
      .limit(filters.limit)
      .offset(filters.offset);

    const total = await this.count(
      and(
        scope,
        filters.companyId === undefined ? undefined : eq(crmContacts.companyId, filters.companyId),
        filters.ownerId === undefined ? undefined : eq(crmContacts.ownerId, filters.ownerId),
        filters.q === undefined
          ? undefined
          : masterSearch(filters.q, [
              crmContacts.name,
              crmContacts.phone,
              crmContacts.email,
              crmContacts.designation,
            ]),
      ),
    );

    return { rows: rows.map(toContactView), total };
  }

  async view(scope: SQL, id: string): Promise<ContactView | null> {
    const rows = await this.contactQuery(this.scoped(scope, eq(crmContacts.id, id))).limit(1);
    const row = rows[0];
    return row === undefined ? null : toContactView(row);
  }

  /**
   * REQ-U-08. Matches on the normalised phone key or the lower-cased email,
   * across the whole organisation rather than the caller's scope: a duplicate
   * owned by a colleague is exactly the one worth warning about, and the
   * answer carries only what the warning needs to say — a name, a company,
   * whose it is — not the record itself.
   */
  async duplicates(input: {
    phoneKey?: string | undefined;
    email?: string | undefined;
    excludeId?: string | undefined;
  }): Promise<ContactDuplicate[]> {
    const branches: SQL[] = [];
    if (input.phoneKey !== undefined && input.phoneKey !== '') {
      branches.push(eq(crmContacts.phoneKey, input.phoneKey));
    }
    if (input.email !== undefined) branches.push(eq(crmContacts.email, input.email));
    if (branches.length === 0) return [];

    const rows = await this.db
      .select({
        id: crmContacts.id,
        name: crmContacts.name,
        companyName: crmCompanies.name,
        ownerName: ownerName(contactOwner),
        phoneKey: crmContacts.phoneKey,
        email: crmContacts.email,
      })
      .from(crmContacts)
      .leftJoin(
        crmCompanies,
        and(eq(crmCompanies.id, crmContacts.companyId), isNull(crmCompanies.deletedAt)),
      )
      .leftJoin(contactOwner, eq(contactOwner.id, crmContacts.ownerId))
      .where(
        this.scoped(
          or(...branches),
          input.excludeId === undefined ? undefined : ne(crmContacts.id, input.excludeId),
        ),
      )
      .orderBy(asc(crmContacts.name), asc(crmContacts.id))
      .limit(10);

    return rows.map((row) => {
      const matchedOn: ('phone' | 'email')[] = [];
      if (input.phoneKey !== undefined && row.phoneKey === input.phoneKey) matchedOn.push('phone');
      if (input.email !== undefined && row.email === input.email) matchedOn.push('email');
      return {
        id: row.id,
        name: row.name,
        companyName: row.companyName,
        ownerName: row.ownerName,
        matchedOn,
      };
    });
  }
}

const companyOwner = alias(employees, 'company_owner');

export class CompanyRepository extends ScopedRepository<typeof crmCompanies> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, crmCompanies, ctx);
  }

  private companyQuery(where: SQL) {
    const contactCount = this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(crmContacts)
      .where(
        and(
          eq(crmContacts.companyId, crmCompanies.id),
          eq(crmContacts.orgId, this.ctx.orgId),
          isNull(crmContacts.deletedAt),
        ),
      );

    return this.db
      .select({
        id: crmCompanies.id,
        name: crmCompanies.name,
        phone: crmCompanies.phone,
        email: crmCompanies.email,
        website: crmCompanies.website,
        city: crmCompanies.city,
        notes: crmCompanies.notes,
        ownerId: crmCompanies.ownerId,
        ownerName: ownerName(companyOwner),
        partyId: crmCompanies.partyId,
        contactCount: sql<number>`(${contactCount})`,
        createdAt: crmCompanies.createdAt,
        updatedAt: crmCompanies.updatedAt,
      })
      .from(crmCompanies)
      .leftJoin(companyOwner, eq(companyOwner.id, crmCompanies.ownerId))
      .where(where);
  }

  private filterPredicate(filters: CompanyListFilters): SQL | undefined {
    return and(
      filters.ownerId === undefined ? undefined : eq(crmCompanies.ownerId, filters.ownerId),
      filters.q === undefined
        ? undefined
        : masterSearch(filters.q, [crmCompanies.name, crmCompanies.city, crmCompanies.website]),
    );
  }

  async list(
    scope: SQL,
    filters: CompanyListFilters,
  ): Promise<{ rows: CompanyView[]; total: number }> {
    const rows = await this.companyQuery(this.scoped(scope, this.filterPredicate(filters)))
      .orderBy(
        ...withRelevance(filters.q, crmCompanies.name, masterOrderBy(filters.sort, COMPANY_SORT_COLUMNS, crmCompanies.name, crmCompanies.id)),
      )
      .limit(filters.limit)
      .offset(filters.offset);
    const total = await this.count(and(scope, this.filterPredicate(filters)));
    return { rows: rows.map(toCompanyView), total };
  }

  async view(scope: SQL, id: string): Promise<CompanyView | null> {
    const rows = await this.companyQuery(this.scoped(scope, eq(crmCompanies.id, id))).limit(1);
    const row = rows[0];
    return row === undefined ? null : toCompanyView(row);
  }

  /** Whether the id names a live company of this org — the FK check a form needs before it saves. */
  async existsAlive(id: string): Promise<boolean> {
    return this.exists(id);
  }
}

interface ContactRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  designation: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  source: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toContactView(row: ContactRow): ContactView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    designation: row.designation,
    companyId: row.companyId,
    companyName: row.companyName,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    source: row.source,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface CompanyRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  city: string | null;
  notes: string | null;
  ownerId: string | null;
  ownerName: string | null;
  partyId: string | null;
  contactCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function toCompanyView(row: CompanyRow): CompanyView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    website: row.website,
    city: row.city,
    notes: row.notes,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    partyId: row.partyId,
    contactCount: row.contactCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
