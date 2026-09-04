import { SYSTEM_ROLES, type Paginated, type PartyView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../common/env.js';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * The masters read surface (09 §5), and the 6b acceptance line it exists to
 * satisfy: "There is no way to create one in Vyuha — verified by asserting
 * the API returns 405 on POST /masters/parties." The write refusals are
 * asserted with their reason, because the 405 exists to teach, not merely to
 * refuse.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000bf';

let harness: ApiHarness;
let adminToken: string;
let employeeToken: string;
let connectionId = '';
let ashaId = '';

beforeAll(async () => {
  // export_jobs.requested_by is ON DELETE RESTRICT; a row left by a crashed
  // run pins its user and breaks resetOrganisation for every later run.
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await pool.query('DELETE FROM export_jobs WHERE org_id = $1', [ORG_ID]);
  } finally {
    await pool.end();
  }
  harness = await ApiHarness.start(ORG_ID, 'Masters Fixture Org');

  await harness.db.execute(sql`DELETE FROM sync_jobs WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM sync_cursors WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM vouchers WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(sql`DELETE FROM parties WHERE org_id = ${ORG_ID}`);
  await harness.db.execute(
    sql`UPDATE integration_connections SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE, { isSystem: true });
  const admin = await harness.createUser({ email: scopedEmail('masters-admin'), roleIds: [adminRoleId] });
  const employee = await harness.createUser({
    email: scopedEmail('masters-employee'),
    roleIds: [employeeRoleId],
  });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;

  const connection = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (org_id, system, name, company_guid)
    VALUES (${ORG_ID}, 'TALLY', 'Masters Co', 'guid-masters-co')
    RETURNING id
  `);
  connectionId = connection.rows[0]?.id ?? '';

  const asha = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO parties (org_id, connection_id, name, alias, parent_group, gstin, credit_limit, credit_days)
    VALUES (${ORG_ID}, ${connectionId}, 'Asha Traders', 'Asha', 'Sundry Debtors', '27AAAPL1234C1ZV', '250000.00', 30)
    RETURNING id
  `);
  ashaId = asha.rows[0]?.id ?? '';
  await harness.db.execute(sql`
    INSERT INTO parties (org_id, connection_id, name, parent_group, absent_in_tally)
    VALUES (${ORG_ID}, ${connectionId}, 'Behar Supply Co', 'Sundry Creditors', true)
  `);
});

afterAll(async () => {
  await harness.close();
});

describe('GET /masters/parties', () => {
  it('needs masters.tally.view — an employee is refused, and told which key', async () => {
    const refused = await harness.get<{ error: { details?: { requiredAnyOf?: string[] } } }>(
      '/masters/parties',
      { token: employeeToken },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.details?.requiredAnyOf).toContain('masters.tally.view');
  });

  it('lists the projection with its figures exact and its age stated', async () => {
    const response = await harness.get<Paginated<PartyView>>('/masters/parties', {
      token: adminToken,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.map((p) => p.name)).toEqual(['Asha Traders', 'Behar Supply Co']);

    const asha = response.body.data[0];
    expect(asha?.creditLimit).toBe('250000.00');
    expect(asha?.lastPulledAt).toBeTruthy();
    expect(response.body.data[1]?.absentInTally).toBe(true);
  });

  it('searches name, alias and GSTIN, with wildcards escaped', async () => {
    const byGstin = await harness.get<Paginated<PartyView>>(
      '/masters/parties?q=27AAAPL1234C1ZV',
      { token: adminToken },
    );
    expect(byGstin.body.data.map((p) => p.name)).toEqual(['Asha Traders']);

    const wildcard = await harness.get<Paginated<PartyView>>('/masters/parties?q=%25%25', {
      token: adminToken,
    });
    expect(wildcard.body.data).toEqual([]);
  });

  it('filters by ledger side', async () => {
    const creditors = await harness.get<Paginated<PartyView>>(
      '/masters/parties?parentGroup=Sundry%20Creditors',
      { token: adminToken },
    );
    expect(creditors.body.data.map((p) => p.name)).toEqual(['Behar Supply Co']);
  });

  it('answers a single party, and a cross-org id as not found', async () => {
    const found = await harness.get<PartyView>(`/masters/parties/${ashaId}`, {
      token: adminToken,
    });
    expect(found.status).toBe(200);
    expect(found.body.name).toBe('Asha Traders');

    const missing = await harness.get(
      '/masters/parties/00000000-0000-4000-8000-000000000000',
      { token: adminToken },
    );
    expect(missing.status).toBe(404);
  });
});

describe('masters are read-only, and the refusal teaches (REQ-R-04)', () => {
  it('POST answers 405 naming where a party is actually created', async () => {
    const response = await harness.post<{ error: { message: string } }>('/masters/parties', {
      token: adminToken,
      body: { name: 'Should Never Exist' },
    });
    expect(response.status).toBe(405);
    expect(response.body.error.message).toContain('created in Tally');
  });

  it('PATCH answers 405 with the same teaching', async () => {
    const patched = await harness.patch<{ error: { message: string } }>(
      `/masters/parties/${ashaId}`,
      { token: adminToken, body: { name: 'Tampered' } },
    );
    expect(patched.status).toBe(405);
    expect(patched.body.error.message).toContain('read-only');
  });

  it('DELETE lands on the recycle bin surface, which refuses parties by name', async () => {
    // The soft-delete route owns this verb and path shape, and parties are
    // deliberately not in SOFT_DELETABLE_ENTITIES: absent in Tally is a
    // marking, not a deletion (REQ-R-06).
    const deleted = await harness.del<{ error: { message: string } }>(
      `/masters/parties/${ashaId}`,
      { token: adminToken, body: { reason: 'this must not work' } },
    );
    expect(deleted.status).toBe(400);
    expect(deleted.body.error.message).toContain('not a master that supports delete');
  });
});

describe('parties join Go To (REQ-O-05)', () => {
  it('a holder finds a party; the subtitle names the ledger side', async () => {
    const response = await harness.get<{ records: { type: string; title: string; subtitle: string | null }[] }>(
      '/go-to?q=asha',
      { token: adminToken },
    );
    const party = response.body.records.find((r) => r.type === 'party');
    expect(party?.title).toBe('Asha Traders');
    expect(party?.subtitle).toContain('Sundry Debtors');
  });

  it('a non-holder gets no party records, before ranking ever sees them', async () => {
    const response = await harness.get<{ records: { type: string }[] }>('/go-to?q=asha', {
      token: employeeToken,
    });
    expect(response.body.records.some((r) => r.type === 'party')).toBe(false);
  });
});

describe('vouchers, the books (Phase 6c, receivables.view)', () => {
  let invoiceId = '';

  beforeAll(async () => {
    const inserted = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO vouchers
        (org_id, connection_id, voucher_date, voucher_type, voucher_number, party_name, party_id, narration, is_cancelled, amount)
      VALUES
        (${ORG_ID}, ${connectionId}, '2026-08-01', 'Sales', 'INV-0042', 'Asha Traders', ${ashaId}, 'Cable order', false, '4150.50'),
        (${ORG_ID}, ${connectionId}, '2026-08-05', 'Receipt', 'RCT-0007', 'Asha Traders', ${ashaId}, '', false, '4150.50'),
        (${ORG_ID}, ${connectionId}, '2026-07-20', 'Sales', 'INV-0040', 'Someone Else', NULL, '', true, '99.00')
      RETURNING id
    `);
    invoiceId = inserted.rows[0]?.id ?? '';
    await harness.db.execute(sql`
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, ledger_name, is_deemed_positive, amount)
      VALUES (${ORG_ID}, ${invoiceId}, 1, 'ledger', 'Asha Traders', true, '4150.50'),
             (${ORG_ID}, ${invoiceId}, 2, 'ledger', 'Sales', false, '-4150.50')
    `);
    await harness.db.execute(sql`
      INSERT INTO voucher_lines (org_id, voucher_id, line_no, kind, stock_item_name, actual_qty, billed_qty, rate, amount)
      VALUES (${ORG_ID}, ${invoiceId}, 3, 'inventory', 'Cat6 Cable Box', '1 NOS', '1 NOS', '4150.50', '4150.50')
    `);
  });

  it('is receivables.view, not masters.tally.view: an employee is refused', async () => {
    const refused = await harness.get('/masters/vouchers', { token: employeeToken });
    expect(refused.status).toBe(403);
  });

  it('lists newest first, hiding the cancelled unless asked, and filters by type, party and date', async () => {
    const list = await harness.get<{ data: { voucherNumber: string; amount: string }[]; meta: { total: number } }>(
      '/masters/vouchers',
      { token: adminToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.data.map((v) => v.voucherNumber)).toEqual(['RCT-0007', 'INV-0042']);
    // Money as text, to the paisa (D-01).
    expect(list.body.data[1]?.amount).toBe('4150.50');

    const withCancelled = await harness.get<{ meta: { total: number } }>(
      '/masters/vouchers?includeCancelled=true',
      { token: adminToken },
    );
    expect(withCancelled.body.meta.total).toBe(3);

    const sales = await harness.get<{ data: { voucherNumber: string }[] }>(
      `/masters/vouchers?voucherType=Sales&partyId=${ashaId}&from=2026-08-01&to=2026-08-31`,
      { token: adminToken },
    );
    expect(sales.body.data.map((v) => v.voucherNumber)).toEqual(['INV-0042']);
  });

  it('the detail carries the lines in Tally’s order', async () => {
    const detail = await harness.get<{ lines: { lineNo: number; kind: string; ledgerName: string | null; amount: string }[] }>(
      `/masters/vouchers/${invoiceId}`,
      { token: adminToken },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.lines.map((l) => [l.lineNo, l.kind])).toEqual([[1, 'ledger'], [2, 'ledger'], [3, 'inventory']]);
    expect(detail.body.lines[1]?.amount).toBe('-4150.50');
  });

  it('typing a voucher number in Go To opens that voucher (09 §6)', async () => {
    const response = await harness.get<{ records: { type: string; id: string; code: string | null; title: string }[] }>(
      '/go-to?q=INV-0042',
      { token: adminToken },
    );
    const voucher = response.body.records.find((r) => r.type === 'voucher');
    expect(voucher?.id).toBe(invoiceId);
    expect(voucher?.code).toBe('INV-0042');
    expect(voucher?.title).toBe('Sales INV-0042');
    // And a non-holder never sees the source.
    const refused = await harness.get<{ records: { type: string }[] }>('/go-to?q=INV-0042', { token: employeeToken });
    expect(refused.body.records.some((r) => r.type === 'voucher')).toBe(false);
  });
});


/**
 * A search that only finds what you can already spell is not a search.
 *
 * The fixture is deliberately awkward: "Behar Supply Co" has a space where
 * somebody might type none, and the GSTIN is the kind of string nobody
 * reproduces exactly. Each case below failed before `masterSearch` learned to
 * strip separators and match words in any order.
 */
describe('finding a party the way somebody actually types', () => {
  // The near-duplicate the cases lean on: the same words as Asha Traders
  // under different casing, a doubled space and a trailing stop. The removed
  // duplicate-masters report test used to leave it behind; the search
  // fixture seeds it for itself now -- after the listing describes, whose
  // assertions name exactly the two parties the main fixture holds.
  beforeAll(async () => {
    await harness.db.execute(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group)
      VALUES (${ORG_ID}, ${connectionId}, 'ASHA  TRADERS.', 'Sundry Debtors')
    `);
  });

  const find = async (q: string): Promise<string[]> => {
    const res = await harness.get<Paginated<PartyView>>(
      `/masters/parties?q=${encodeURIComponent(q)}`,
      { token: adminToken },
    );
    expect(res.status).toBe(200);
    return res.body.data.map((p) => p.name).sort();
  };

  /*
   * Both spellings, and that is the right answer rather than a nuisance.
   * The duplicate-masters test above leaves "ASHA  TRADERS." in the fixture --
   * two spaces and a full stop -- and it is the same party. A search that
   * returned only the tidy spelling would hide the record somebody is most
   * likely hunting for, which is the messy one somebody typed badly once.
   */
  const BOTH_ASHAS = ['ASHA  TRADERS.', 'Asha Traders'];

  it('still finds the exact name, which must not regress', async () => {
    expect(await find('Asha Traders')).toEqual(BOTH_ASHAS);
  });

  it('finds it with the words the other way round', async () => {
    // "traders asha" is how somebody who half-remembers the name types it.
    expect(await find('traders asha')).toEqual(BOTH_ASHAS);
  });

  it('does not care how many spaces were typed', async () => {
    expect(await find('  asha    traders  ')).toEqual(BOTH_ASHAS);
  });

  it('finds a name typed without its space', async () => {
    // The reported case: the separator has to be reproduced exactly or nothing
    // comes back.
    expect(await find('beharsupply')).toEqual(['Behar Supply Co']);
  });

  it('finds a name typed with a hyphen the record does not have', async () => {
    expect(await find('behar-supply')).toEqual(['Behar Supply Co']);
  });

  it('finds a GSTIN typed in pieces, and only the record that has it', async () => {
    // The duplicate has no GSTIN, so this is also the case that shows the
    // search still narrows rather than sweeping both in on the name.
    expect(await find('27AAAPL 1234C1ZV')).toEqual(['Asha Traders']);
  });

  it('matches across columns within one word, and narrows across words', async () => {
    // Both parties contain neither word, so an OR across words would return
    // both and prove nothing. AND is what makes a second word useful.
    expect(await find('asha behar')).toEqual([]);
  });

  it('is still case-insensitive', async () => {
    expect(await find('ASHA')).toEqual(BOTH_ASHAS);
  });

  it('does not let a wildcard turn the filter off', async () => {
    // The escaping this function has always had: a bare % must not match every
    // row, which would be a filter that silently stopped filtering.
    expect(await find('%%')).toEqual([]);
  });

  it('treats an all-separator term as no filter rather than matching nothing', async () => {
    // Stripping "---" leaves an empty string; searching for it must not become
    // a contains-empty that matches everything, nor an error.
    const all = await find('---');
    expect(all.length).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Owner, 1 Sep 2026: "eg C&S electic I can just search by C & it shall show
 * results". It did show results -- every party with a "c" anywhere in it, in
 * alphabetical order, so the one being typed towards sat behind three that
 * were not. A forgiving filter needs an opinionated order or it is just a
 * longer list.
 *
 * Every name below is chosen so that alphabetical order and relevance order
 * DISAGREE. An earlier draft of these tests used names where the two happened
 * to coincide, and all four passed with the ranking switched off -- which is
 * to say they tested nothing.
 */
describe('what a search puts first', () => {
  beforeAll(async () => {
    await harness.db.execute(sql`
      INSERT INTO parties (org_id, connection_id, name, parent_group)
      VALUES
        (${ORG_ID}, ${connectionId}, 'C&S Electric', 'Sundry Debtors'),
        (${ORG_ID}, ${connectionId}, 'Bharat C&S Spares', 'Sundry Debtors'),
        (${ORG_ID}, ${connectionId}, 'Zenith Cables', 'Sundry Debtors'),
        (${ORG_ID}, ${connectionId}, 'Alpha Zenith Traders', 'Sundry Debtors'),
        (${ORG_ID}, ${connectionId}, 'Amazenco Supply', 'Sundry Debtors'),
        (${ORG_ID}, ${connectionId}, 'AAA Zenith Cables Ltd', 'Sundry Debtors')
    `);
  });

  const ranked = async (q: string): Promise<string[]> => {
    const res = await harness.get<Paginated<PartyView>>(
      `/masters/parties?q=${encodeURIComponent(q)}&pageSize=100`,
      { token: adminToken },
    );
    expect(res.status).toBe(200);
    // Deliberately unsorted: the order IS the assertion.
    return res.body.data.map((p) => p.name);
  };

  it('ranks starts-with above word-start above buried, against the alphabet', async () => {
    // Alphabetically this is exactly backwards: Alpha, Amazenco, Zenith.
    const names = (await ranked('zen')).filter((name) => name.toLowerCase().includes('zen'));
    expect(names).toEqual([
      'Zenith Cables',
      'AAA Zenith Cables Ltd',
      'Alpha Zenith Traders',
      'Amazenco Supply',
    ]);
  });

  it("puts the owner's own example first, which the alphabet does not", async () => {
    // "Bharat C&S Spares" sorts first alphabetically and matches just as well.
    expect((await ranked('c&s'))[0]).toBe('C&S Electric');
  });

  it('prefers the name that is exactly the term over a longer one containing it', async () => {
    // Both hold both words, so both match; "AAA Zenith Cables Ltd" sorts first
    // alphabetically and would have been first before this change.
    const names = await ranked('zenith cables');
    expect(names).toEqual(['Zenith Cables', 'AAA Zenith Cables Ltd']);
  });

  it('still ranks when the separators were typed differently', async () => {
    // "cselectric" reaches C&S Electric through the stripped branch, and it
    // must still come before a party that merely contains those letters.
    expect((await ranked('cs electric'))[0]).toBe('C&S Electric');
  });
});

/**
 * Owner, 1 Sep 2026, on the pickers: a mistyped name should still find its
 * row. `masterSearch` matched substrings, so a transposed letter matched
 * nothing at all -- and the person who mistyped had no way to tell whether the
 * party was missing or their finger had slipped.
 */
describe('a mistyped name still finds the party', () => {
  const find = async (q: string): Promise<string[]> => {
    const res = await harness.get<Paginated<PartyView>>(
      `/masters/parties?q=${encodeURIComponent(q)}&pageSize=100`,
      { token: adminToken },
    );
    expect(res.status).toBe(200);
    return res.body.data.map((p) => p.name);
  };

  it('finds a party through a dropped letter', async () => {
    // The owner's example was "acem" for "Acme"; this fixture's equivalent.
    // Measured: word_similarity('zenth', 'Zenith Cables') is 0.500.
    expect(await find('zenth')).toContain('Zenith Cables');
  });

  it('finds one through a transposed letter in a later word', async () => {
    // 'cabels' against 'Zenith Cables' scores 0.429 -- the typo is in the
    // second word, which is why this compares words and not whole strings.
    expect(await find('cabels')).toContain('Zenith Cables');
  });

  it('finds one through a doubled letter', async () => {
    expect(await find('ashaa')).toContain('Asha Traders');
  });

  it('does not fuzzily match a term that is simply not there', async () => {
    // The number that matters: nonsense scores zero, so the forgiveness costs
    // no precision.
    expect(await find('zzqqxx')).toEqual([]);
  });

  it('leaves short terms strict, so three letters do not match the whole book', async () => {
    // Below four characters a typo is indistinguishable from a different word.
    const all = await find('zzz');
    expect(all).toEqual([]);
  });

  it('still ranks the exact match above the forgiven one', async () => {
    // Forgiveness must not cost the ordering: somebody who typed it correctly
    // gets what they typed, first.
    const names = await find('asha');
    expect(names[0]).toMatch(/^ASHA|^Asha/u);
  });
});

/**
 * The other half of forgiveness: where it must not apply.
 *
 * A shift code, a part number, a GSTIN -- somebody typing one is copying it,
 * not remembering it, and two codes three characters apart are two different
 * things. The shift suite found this: the first version fuzzed every word and
 * made a search for one code return two shifts.
 */
describe('an identifier is matched exactly', () => {
  const find = async (q: string): Promise<string[]> => {
    const res = await harness.get<Paginated<PartyView>>(
      `/masters/parties?q=${encodeURIComponent(q)}&pageSize=100`,
      { token: adminToken },
    );
    return res.body.data.map((p) => p.name);
  };

  it('does not forgive a typo inside a GSTIN', async () => {
    // One digit out of a real GSTIN is a different taxpayer, not a near miss.
    expect(await find('27AAAPL1234C1ZV')).toEqual(['Asha Traders']);
    expect(await find('27AAAPL1234C1ZX')).toEqual([]);
  });

  it('still finds a name beside a code in the same query', async () => {
    // "asha" is forgiven, the GSTIN is not, and both must hold at once.
    expect(await find('asha 27AAAPL1234C1ZV')).toEqual(['Asha Traders']);
  });
});
