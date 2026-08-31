import { Injectable } from '@nestjs/common';
import {
  COMPANY_SORT_FIELDS,
  CONTACT_SORT_FIELDS,
  DATA_SCOPES,
  DEFAULT_COMPANY_SORT,
  DEFAULT_CONTACT_SORT,
  PERMISSIONS,
  normalizePhone,
  pageSlice,
  paginated,
  parseSort,
  type CompanyListQuery,
  type CompanyView,
  type ContactDuplicate,
  type ContactDuplicateQuery,
  type ContactListQuery,
  type ContactView,
  type CreateCompanyInput,
  type CreateContactInput,
  type LinkCompanyPartyInput,
  type Paginated,
  type UpdateCompanyInput,
  type UpdateContactInput,
  REALTIME_RESOURCES,
  type RealtimeResource,
} from '@vyuha/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { employees } from '../../../platform/db/schema/index.js';
import { orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { RealtimeService } from '../../../platform/realtime/realtime.service.js';
import { ScopeService, type ScopeGrants } from '../../../platform/rbac/scope.service.js';
import { crmCompanies, crmContacts } from '../schema/index.js';
import { CompanyRepository, ContactRepository } from './crm.repository.js';

/**
 * Contacts and companies (REQ-U-01, REQ-U-02, REQ-U-08).
 *
 * One permission family covers both records — 08 §2.2 has `crm.contact.*`
 * and no `crm.company.*` — so a company is read and written under the
 * contact keys, and scoped by its own `owner_id` through the same grants.
 *
 * Ownership is the whole of the access model here. A `view.self` holder sees
 * what they own; a `view.all` holder sees everything; and only the latter may
 * hand a record to somebody else, because a salesperson who could assign
 * their contacts to a colleague could equally assign a colleague's to
 * themselves — the write would be a read-scope escape wearing a different hat.
 */

const CONTACT_GRANTS: ScopeGrants = {
  self: PERMISSIONS.CRM_CONTACT_VIEW_SELF,
  all: PERMISSIONS.CRM_CONTACT_VIEW_ALL,
};

@Injectable()
export class CrmService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly scopes: ScopeService,
    private readonly realtime: RealtimeService,
  ) {}

  // -------------------------------------------------------------- contacts

  async listContacts(principal: Principal, query: ContactListQuery): Promise<Paginated<ContactView>> {
    const { where } = this.scopes.resolve(principal, CONTACT_GRANTS, crmContacts.ownerId);
    const { limit, offset } = pageSlice(query);
    const { rows, total } = await this.contacts(principal).list(where, {
      q: query.q,
      companyId: query.companyId,
      ownerId: query.ownerId,
      sort: parseSort(query.sort ?? DEFAULT_CONTACT_SORT, CONTACT_SORT_FIELDS),
      limit,
      offset,
    });
    return paginated(rows, query, total);
  }

  async findContact(principal: Principal, id: string): Promise<ContactView> {
    const { where } = this.scopes.resolve(principal, CONTACT_GRANTS, crmContacts.ownerId);
    const contact = await this.contacts(principal).view(where, id);
    if (contact === null) throw AppError.notFound('Contact', id);
    return contact;
  }

  async createContact(principal: Principal, input: CreateContactInput): Promise<ContactView> {
    const repository = this.contacts(principal);
    const ownerId = await this.resolveOwner(principal, input.ownerId);
    if (input.companyId !== undefined && input.companyId !== null) {
      await this.assertCompanyVisible(principal, input.companyId);
    }

    const created = await repository.insert({
      name: input.name,
      phone: input.phone ?? null,
      phoneKey: phoneKeyOf(input.phone),
      email: input.email ?? null,
      designation: input.designation ?? null,
      companyId: input.companyId ?? null,
      ownerId,
      source: input.source ?? null,
      notes: input.notes ?? null,
    });

    // Read back unscoped by ownership: the creator may have handed the record
    // to somebody whose rows they cannot otherwise see, and the response
    // still has to say what was created.
    const contact = await repository.view(SQL_TRUE, created.id);
    if (contact === null) throw new Error(`Contact ${created.id} vanished between insert and read-back.`);

    this.auditContext.record({
      action: 'crm.contact.created',
      entityType: 'crm_contact',
      entityId: contact.id,
      before: null,
      after: contactAuditView(contact),
    });
    this.announce(principal, REALTIME_RESOURCES.CRM_CONTACT, 'created', contact.id);
    return contact;
  }

  async updateContact(principal: Principal, id: string, input: UpdateContactInput): Promise<ContactView> {
    const repository = this.contacts(principal);
    const existing = await this.findContact(principal, id);

    const patch: Parameters<ContactRepository['update']>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.phone !== undefined) {
      patch.phone = input.phone;
      patch.phoneKey = phoneKeyOf(input.phone);
    }
    if (input.email !== undefined) patch.email = input.email;
    if (input.designation !== undefined) patch.designation = input.designation;
    if (input.source !== undefined) patch.source = input.source;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.companyId !== undefined) {
      if (input.companyId !== null) await this.assertCompanyVisible(principal, input.companyId);
      patch.companyId = input.companyId;
    }
    if (input.ownerId !== undefined && input.ownerId !== existing.ownerId) {
      patch.ownerId = await this.resolveOwner(principal, input.ownerId);
    }

    const updated = await repository.update(id, patch);
    if (updated === null) throw AppError.notFound('Contact', id);

    const contact = await repository.view(SQL_TRUE, id);
    if (contact === null) throw AppError.notFound('Contact', id);

    this.auditContext.record({
      action: 'crm.contact.updated',
      entityType: 'crm_contact',
      entityId: id,
      before: contactAuditView(existing),
      after: contactAuditView(contact),
    });
    this.announce(principal, REALTIME_RESOURCES.CRM_CONTACT, 'updated', id);
    return contact;
  }

  async deleteContact(principal: Principal, id: string): Promise<void> {
    const existing = await this.findContact(principal, id);
    const deleted = await this.contacts(principal).softDelete(id);
    if (!deleted) throw AppError.notFound('Contact', id);
    this.auditContext.record({
      action: 'crm.contact.deleted',
      entityType: 'crm_contact',
      entityId: id,
      before: contactAuditView(existing),
      after: null,
    });
    this.announce(principal, REALTIME_RESOURCES.CRM_CONTACT, 'deleted', id);
  }

  /** REQ-U-08. Any holder of the family may ask; see the repository for why the answer ignores scope. */
  async contactDuplicates(principal: Principal, query: ContactDuplicateQuery): Promise<ContactDuplicate[]> {
    return this.contacts(principal).duplicates({
      phoneKey: phoneKeyOf(query.phone) ?? undefined,
      email: query.email,
      excludeId: query.excludeId,
    });
  }

  // ------------------------------------------------------------- companies

  async listCompanies(principal: Principal, query: CompanyListQuery): Promise<Paginated<CompanyView>> {
    const { where } = this.scopes.resolve(principal, CONTACT_GRANTS, crmCompanies.ownerId);
    const { limit, offset } = pageSlice(query);
    const { rows, total } = await this.companies(principal).list(where, {
      q: query.q,
      ownerId: query.ownerId,
      sort: parseSort(query.sort ?? DEFAULT_COMPANY_SORT, COMPANY_SORT_FIELDS),
      limit,
      offset,
    });
    return paginated(rows, query, total);
  }

  async findCompany(principal: Principal, id: string): Promise<CompanyView> {
    const { where } = this.scopes.resolve(principal, CONTACT_GRANTS, crmCompanies.ownerId);
    const company = await this.companies(principal).view(where, id);
    if (company === null) throw AppError.notFound('Company', id);
    return company;
  }

  async createCompany(principal: Principal, input: CreateCompanyInput): Promise<CompanyView> {
    const repository = this.companies(principal);
    const ownerId = await this.resolveOwner(principal, input.ownerId);

    const created = await repository.insert({
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      city: input.city ?? null,
      notes: input.notes ?? null,
      ownerId,
      partyId: null,
    });
    const company = await repository.view(SQL_TRUE, created.id);
    if (company === null) throw new Error(`Company ${created.id} vanished between insert and read-back.`);

    this.auditContext.record({
      action: 'crm.company.created',
      entityType: 'crm_company',
      entityId: company.id,
      before: null,
      after: companyAuditView(company),
    });
    this.announce(principal, REALTIME_RESOURCES.CRM_COMPANY, 'created', company.id);
    return company;
  }

  async updateCompany(principal: Principal, id: string, input: UpdateCompanyInput): Promise<CompanyView> {
    const repository = this.companies(principal);
    const existing = await this.findCompany(principal, id);

    const patch: Parameters<CompanyRepository['update']>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.email !== undefined) patch.email = input.email;
    if (input.website !== undefined) patch.website = input.website;
    if (input.city !== undefined) patch.city = input.city;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.ownerId !== undefined && input.ownerId !== existing.ownerId) {
      patch.ownerId = await this.resolveOwner(principal, input.ownerId);
    }

    const updated = await repository.update(id, patch);
    if (updated === null) throw AppError.notFound('Company', id);
    const company = await repository.view(SQL_TRUE, id);
    if (company === null) throw AppError.notFound('Company', id);

    this.auditContext.record({
      action: 'crm.company.updated',
      entityType: 'crm_company',
      entityId: id,
      before: companyAuditView(existing),
      after: companyAuditView(company),
    });
    this.announce(principal, REALTIME_RESOURCES.CRM_COMPANY, 'updated', id);
    return company;
  }

  /**
   * REQ-U-03: the link to the Tally party a company became, made by a person
   * on conversion and never inferred (technical design §14.2: a name match is
   * a suggestion, not a link). Leads are never pushed; this is the one place
   * the CRM touches the projection, and it only points at a row that Tally
   * already owns.
   */
  async linkParty(principal: Principal, id: string, input: LinkCompanyPartyInput): Promise<CompanyView> {
    const repository = this.companies(principal);
    const existing = await this.findCompany(principal, id);
    if (input.partyId !== null) {
      // A projection row: no deleted_at — a party removed in Tally is marked
      // absent and retained (REQ-R-06), and linking to an absent one is still
      // linking to the party it was.
      const rows = await this.db.execute<{ id: string }>(
        sql`SELECT id FROM parties WHERE org_id = ${principal.orgId} AND id = ${input.partyId} LIMIT 1`,
      );
      if (rows.rows.length === 0) throw AppError.validation('The party was not found.', { partyId: input.partyId });
    }
    const updated = await repository.update(id, { partyId: input.partyId });
    if (updated === null) throw AppError.notFound('Company', id);
    const company = await repository.view(SQL_TRUE, id);
    if (company === null) throw AppError.notFound('Company', id);
    this.auditContext.record({
      action: input.partyId === null ? 'crm.company.party_unlinked' : 'crm.company.party_linked',
      entityType: 'crm_company',
      entityId: id,
      before: companyAuditView(existing),
      after: companyAuditView(company),
    });
    return company;
  }

  /**
   * A company with live contacts refuses to go: they would silently lose
   * their company (the FK is SET NULL) and nobody would be told. Move or
   * delete the contacts first — the count in the message says how many.
   */
  async deleteCompany(principal: Principal, id: string): Promise<void> {
    const existing = await this.findCompany(principal, id);
    if (existing.contactCount > 0) {
      throw AppError.conflict(
        `${existing.name} still has ${existing.contactCount} contact${existing.contactCount === 1 ? '' : 's'}. Move or delete them first.`,
        { contactCount: existing.contactCount },
      );
    }
    const deleted = await this.companies(principal).softDelete(id);
    if (!deleted) throw AppError.notFound('Company', id);
    this.auditContext.record({
      action: 'crm.company.deleted',
      entityType: 'crm_company',
      entityId: id,
      before: companyAuditView(existing),
      after: null,
    });
    this.announce(principal, REALTIME_RESOURCES.CRM_COMPANY, 'deleted', id);
  }


  /**
   * Tell everyone else's open screens. Never awaited and never able to throw:
   * the record is written and audited by the time this runs, and a live
   * update that fails must not turn a saved record into a failed request.
   */
  private announce(
    principal: Principal,
    resource: RealtimeResource,
    action: 'created' | 'updated' | 'deleted',
    recordId: string | null,
  ): void {
    this.realtime.publish(principal.orgId, { resource, action, recordId, actorUserId: principal.userId });
  }

  // --------------------------------------------------------------- helpers

  /**
   * Who the record belongs to after this write. Absent means "me"; naming
   * somebody else needs the `all` breadth (see the class comment). Either way
   * the owner has to be a live employee of this organisation — an id from
   * another org would otherwise sit in the column and match nobody's scope.
   */
  private async resolveOwner(principal: Principal, requested: string | null | undefined): Promise<string | null> {
    if (requested === undefined || requested === null) return principal.employeeId;
    if (requested === principal.employeeId) return requested;

    if (this.scopes.breadth(principal, CONTACT_GRANTS) !== DATA_SCOPES.ALL) {
      throw AppError.forbidden('Only a holder of crm.contact.view.all may assign a record to somebody else.');
    }
    const rows = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.orgId, principal.orgId), eq(employees.id, requested), isNull(employees.deletedAt)))
      .limit(1);
    if (rows.length === 0) throw AppError.validation('The owner must be a current employee.', { ownerId: requested });
    return requested;
  }

  private async assertCompanyVisible(principal: Principal, companyId: string): Promise<void> {
    const { where } = this.scopes.resolve(principal, CONTACT_GRANTS, crmCompanies.ownerId);
    const company = await this.companies(principal).view(where, companyId);
    if (company === null) throw AppError.validation('The company was not found.', { companyId });
  }

  private contacts(principal: Principal): ContactRepository {
    return new ContactRepository(this.db, orgContextOf(principal));
  }

  private companies(principal: Principal): CompanyRepository {
    return new CompanyRepository(this.db, orgContextOf(principal));
  }
}

/** The `all` breadth's own fragment, for a read-back that must not depend on who owns the row. */
const SQL_TRUE = sql`true`;

function phoneKeyOf(phone: string | null | undefined): string | null {
  if (phone === undefined || phone === null) return null;
  const key = normalizePhone(phone);
  return key === '' ? null : key;
}

function contactAuditView(contact: ContactView): Record<string, unknown> {
  return {
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    designation: contact.designation,
    companyId: contact.companyId,
    ownerId: contact.ownerId,
    source: contact.source,
    notes: contact.notes,
  };
}

function companyAuditView(company: CompanyView): Record<string, unknown> {
  return {
    name: company.name,
    phone: company.phone,
    email: company.email,
    website: company.website,
    city: company.city,
    ownerId: company.ownerId,
    partyId: company.partyId,
    notes: company.notes,
  };
}
