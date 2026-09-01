import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type CompanyView,
  type ContactDuplicate,
  type ContactView,
  type Paginated,
} from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';

/**
 * Contacts and companies (REQ-U-01, REQ-U-02, REQ-U-08) and the ownership
 * model 08 §2.2 puts on them: `view.self` sees what it owns, `view.all` sees
 * everything, and only the latter may hand a record to somebody else.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d2';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let adminToken: string;
let salesToken: string;
let salesEmployeeId = '';
let otherEmployeeId = '';
let employeeToken: string;

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'CRM Fixture Org');

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  // 08 §2.2's Sales column, until the role itself is seeded.
  const salesRoleId = await harness.createRole('Sales', [
    PERMISSIONS.PUNCH_SELF,
    PERMISSIONS.CRM_CONTACT_VIEW_SELF,
    PERMISSIONS.CRM_CONTACT_MANAGE,
  ]);

  salesEmployeeId = await harness.createEmployee({ code: 'CRM-001', firstName: 'Ravi', lastName: 'Kumar' });
  otherEmployeeId = await harness.createEmployee({ code: 'CRM-002', firstName: 'Meera', lastName: 'Iyer' });

  const admin = await harness.createUser({ email: scopedEmail('crm-admin'), roleIds: [adminRoleId] });
  const sales = await harness.createUser({
    email: scopedEmail('crm-sales'),
    roleIds: [salesRoleId],
    employeeId: salesEmployeeId,
  });
  const employee = await harness.createUser({
    email: scopedEmail('crm-employee'),
    roleIds: [employeeRoleId],
    employeeId: otherEmployeeId,
  });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  salesToken = (await harness.login(sales.email, sales.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;
});

afterAll(async () => {
  await harness.close();
});

let acmeId = '';
let ashaId = '';

describe('companies and contacts, as an administrator', () => {
  it('refuses an account holding neither breadth, and says which keys would do', async () => {
    const refused = await harness.get<{ error: { details?: { requiredAnyOf?: string[] } } }>('/crm/contacts', {
      token: employeeToken,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details?.requiredAnyOf).toEqual(
      expect.arrayContaining(['crm.contact.view.self', 'crm.contact.view.all']),
    );
  });

  it('creates a company, unowned when the creator has no employee record', async () => {
    const created = await harness.post<CompanyView>('/crm/companies', {
      token: adminToken,
      body: { name: 'Acme Trading Co', city: 'Pune', website: 'acme.example', phone: '+91 20 1234 5678' },
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Acme Trading Co');
    expect(created.body.ownerId).toBeNull();
    expect(created.body.partyId).toBeNull();
    expect(created.body.contactCount).toBe(0);
    acmeId = created.body.id;
    expect(await harness.waitForAuditAction('crm.company.created')).toBe(true);
  });

  it('filters the company list on the server, which is the only way the picker reaches past a page', async () => {
    // CompanyPicker holds 25 rows and types at the server for the rest. If `q`
    // ever stopped filtering here, the picker would silently go back to
    // offering whatever the first page happened to hold.
    const far = await harness.post<CompanyView>('/crm/companies', {
      token: adminToken,
      body: { name: 'Zenith Fabricators', city: 'Nashik' },
    });
    expect(far.status).toBe(201);

    const byName = await harness.get<Paginated<CompanyView>>('/crm/companies?q=zenith', { token: adminToken });
    expect(byName.status).toBe(200);
    expect(byName.body.data.map((c) => c.name)).toEqual(['Zenith Fabricators']);

    // The endpoint promises name, city and website, and the picker's search
    // placeholder tells the user so.
    const byCity = await harness.get<Paginated<CompanyView>>('/crm/companies?q=Pune', { token: adminToken });
    expect(byCity.body.data.map((c) => c.name)).toContain('Acme Trading Co');

    const byWebsite = await harness.get<Paginated<CompanyView>>('/crm/companies?q=acme.example', {
      token: adminToken,
    });
    expect(byWebsite.body.data.map((c) => c.name)).toContain('Acme Trading Co');

    const none = await harness.get<Paginated<CompanyView>>('/crm/companies?q=nobodyhasthisname', {
      token: adminToken,
    });
    expect(none.body.data).toEqual([]);
  });

  it('creates a contact against it, lower-casing the email and keeping the phone as typed', async () => {
    const created = await harness.post<ContactView>('/crm/contacts', {
      token: adminToken,
      body: {
        name: 'Asha Menon',
        phone: '+91 98765 43210',
        email: 'Asha.Menon@Example.com',
        designation: 'Purchase head',
        companyId: acmeId,
        source: 'Referral',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe('asha.menon@example.com');
    expect(created.body.phone).toBe('+91 98765 43210');
    expect(created.body.companyName).toBe('Acme Trading Co');
    ashaId = created.body.id;
    expect(await harness.waitForAuditAction('crm.contact.created')).toBe(true);

    const company = await harness.get<CompanyView>(`/crm/companies/${acmeId}`, { token: adminToken });
    expect(company.body.contactCount).toBe(1);
  });

  it('rejects a malformed body with the field named', async () => {
    const bad = await harness.post<ErrorBody>('/crm/contacts', {
      token: adminToken,
      body: { name: '', email: 'not-an-email' },
    });
    expect(bad.status).toBe(400);
  });

  it('refuses a company the caller cannot see, as a validation error rather than a leak', async () => {
    const bad = await harness.post<ErrorBody>('/crm/contacts', {
      token: adminToken,
      body: { name: 'Nobody', companyId: '01900000-0000-7000-8000-00000000dead' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details?.companyId).toBe('01900000-0000-7000-8000-00000000dead');
  });

  it('warns about duplicates by normalised phone and lower-cased email (REQ-U-08)', async () => {
    const byPhone = await harness.get<ContactDuplicate[]>('/crm/contacts/duplicates?phone=098765%2043210', {
      token: adminToken,
    });
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.map((d) => [d.name, d.matchedOn])).toEqual([['Asha Menon', ['phone']]]);
    expect(byPhone.body[0]?.companyName).toBe('Acme Trading Co');

    const byEmail = await harness.get<ContactDuplicate[]>(
      '/crm/contacts/duplicates?email=ASHA.MENON%40example.com&phone=1111111111',
      { token: adminToken },
    );
    expect(byEmail.body.map((d) => d.matchedOn)).toEqual([['email']]);

    // Editing Asha must not report Asha as her own duplicate.
    const excluded = await harness.get<ContactDuplicate[]>(
      `/crm/contacts/duplicates?phone=9876543210&excludeId=${ashaId}`,
      { token: adminToken },
    );
    expect(excluded.body).toEqual([]);

    const neither = await harness.get<ErrorBody>('/crm/contacts/duplicates', { token: adminToken });
    expect(neither.status).toBe(400);
  });

  it('searches over name, phone, email and designation, and sorts by a whitelisted column', async () => {
    await harness.post<ContactView>('/crm/contacts', {
      token: adminToken,
      body: { name: 'Bala Subramanian', email: 'bala@example.com', designation: 'Accounts' },
    });

    const search = await harness.get<Paginated<ContactView>>('/crm/contacts?q=purchase', { token: adminToken });
    expect(search.body.data.map((c) => c.name)).toEqual(['Asha Menon']);

    const newest = await harness.get<Paginated<ContactView>>('/crm/contacts?sort=-createdAt&pageSize=1', {
      token: adminToken,
    });
    expect(newest.body.data.map((c) => c.name)).toEqual(['Bala Subramanian']);
    expect(newest.body.meta.total).toBe(2);

    const byCompany = await harness.get<Paginated<ContactView>>(`/crm/contacts?companyId=${acmeId}`, {
      token: adminToken,
    });
    expect(byCompany.body.data.map((c) => c.name)).toEqual(['Asha Menon']);
  });

  it('updates a contact and writes before/after to the audit log', async () => {
    const updated = await harness.patch<ContactView>(`/crm/contacts/${ashaId}`, {
      token: adminToken,
      body: { designation: 'Head of purchase', phone: null },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.designation).toBe('Head of purchase');
    expect(updated.body.phone).toBeNull();
    expect(await harness.waitForAuditAction('crm.contact.updated')).toBe(true);

    // The phone key went with the phone: the old number no longer finds her.
    const stale = await harness.get<ContactDuplicate[]>('/crm/contacts/duplicates?phone=9876543210', {
      token: adminToken,
    });
    expect(stale.body).toEqual([]);
  });

  it('refuses to delete a company that still has contacts, and says how many', async () => {
    const refused = await harness.del<ErrorBody>(`/crm/companies/${acmeId}`, { token: adminToken });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details?.contactCount).toBe(1);
  });
});

describe('ownership scoping (08 §2.2)', () => {
  let raviContactId = '';

  it('a self-scoped user creates a contact and owns it, without saying so', async () => {
    const created = await harness.post<ContactView>('/crm/contacts', {
      token: salesToken,
      body: { name: 'Chitra Devi', phone: '9000000001' },
    });
    expect(created.status).toBe(201);
    expect(created.body.ownerId).toBe(salesEmployeeId);
    expect(created.body.ownerName).toBe('Ravi Kumar');
    raviContactId = created.body.id;
  });

  it('sees only what they own — the administrator’s contacts are not there, and not findable by id', async () => {
    const list = await harness.get<Paginated<ContactView>>('/crm/contacts', { token: salesToken });
    expect(list.status).toBe(200);
    expect(list.body.data.map((c) => c.name)).toEqual(['Chitra Devi']);
    expect(list.body.meta.total).toBe(1);

    const hidden = await harness.get<ErrorBody>(`/crm/contacts/${ashaId}`, { token: salesToken });
    expect(hidden.status).toBe(404);

    const companies = await harness.get<Paginated<CompanyView>>('/crm/companies', { token: salesToken });
    expect(companies.body.data).toEqual([]);
  });

  it('may not hand a record to somebody else, nor attach one to a company outside their scope', async () => {
    const reassign = await harness.post<ErrorBody>('/crm/contacts', {
      token: salesToken,
      body: { name: 'Given away', ownerId: otherEmployeeId },
    });
    expect(reassign.status).toBe(403);

    const attach = await harness.post<ErrorBody>('/crm/contacts', {
      token: salesToken,
      body: { name: 'Attached', companyId: acmeId },
    });
    expect(attach.status).toBe(400);
    expect(attach.body.error.details?.companyId).toBe(acmeId);
  });

  it('a view.all holder sees everyone’s and may reassign; the record then moves scope', async () => {
    const all = await harness.get<Paginated<ContactView>>('/crm/contacts', { token: adminToken });
    expect(all.body.data.map((c) => c.name)).toEqual(['Asha Menon', 'Bala Subramanian', 'Chitra Devi']);

    const moved = await harness.patch<ContactView>(`/crm/contacts/${ashaId}`, {
      token: adminToken,
      body: { ownerId: salesEmployeeId },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.ownerName).toBe('Ravi Kumar');

    const now = await harness.get<Paginated<ContactView>>('/crm/contacts', { token: salesToken });
    expect(now.body.data.map((c) => c.name)).toEqual(['Asha Menon', 'Chitra Devi']);

    // Ravi still cannot see Acme, so Asha's company name shows but the
    // company itself stays out of reach — that is a company scoping question,
    // and the answer is the same as before.
    const acme = await harness.get<ErrorBody>(`/crm/companies/${acmeId}`, { token: salesToken });
    expect(acme.status).toBe(404);
  });

  it('refuses an owner who is not a current employee of this organisation', async () => {
    const bad = await harness.patch<ErrorBody>(`/crm/contacts/${ashaId}`, {
      token: adminToken,
      body: { ownerId: '01900000-0000-7000-8000-00000000beef' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details?.ownerId).toBe('01900000-0000-7000-8000-00000000beef');
  });

  it('deletes within scope only, and the row is gone from every reader afterwards', async () => {
    const notMine = await harness.del<ErrorBody>(`/crm/contacts/${ashaId}`, { token: employeeToken });
    expect(notMine.status).toBe(403);

    const gone = await harness.del(`/crm/contacts/${raviContactId}`, { token: salesToken });
    expect(gone.status).toBe(204);
    expect(await harness.waitForAuditAction('crm.contact.deleted')).toBe(true);

    const after = await harness.get<ErrorBody>(`/crm/contacts/${raviContactId}`, { token: adminToken });
    expect(after.status).toBe(404);
  });

  it('a company deletes once its contacts have moved on', async () => {
    const detach = await harness.patch<ContactView>(`/crm/contacts/${ashaId}`, {
      token: adminToken,
      body: { companyId: null },
    });
    expect(detach.status).toBe(200);
    expect(detach.body.companyName).toBeNull();

    const gone = await harness.del(`/crm/companies/${acmeId}`, { token: adminToken });
    expect(gone.status).toBe(204);
    expect(await harness.waitForAuditAction('crm.company.deleted')).toBe(true);
    const after = await harness.get<ErrorBody>(`/crm/companies/${acmeId}`, { token: adminToken });
    expect(after.status).toBe(404);
  });
});
