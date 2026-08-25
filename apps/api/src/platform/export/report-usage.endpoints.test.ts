import { PERMISSIONS } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * `GET /reports/usage/recent` over real HTTP (REQ-AD-09's read side).
 *
 * The row this feeds is a shortcut, and a shortcut that lies is worse than
 * none: a key the caller can no longer open would render as a chip that
 * answers 403, and a neighbour's history would leak what they read. So the
 * contract under test is exactly those two narrowings — the caller's own
 * opens, filtered to the catalogue their keys can serve — plus the ordering
 * and distinctness the word "recent" promises.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f0df';

let harness: ApiHarness;
let started = false;

let viewerToken = '';
let viewerId = '';
let otherViewerToken = '';
let outsiderToken = '';

type Listing = { data: string[] };

async function recent(token: string): Promise<string[]> {
  const response = await harness.get<Listing>('/reports/usage/recent', { token });
  expect(response.status, response.text).toBe(200);
  return response.body.data;
}

/** One open, `agoMinutes` in the past, written the way the rows endpoint writes it. */
async function opened(userId: string, reportKey: string, agoMinutes: number): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO report_usage (org_id, user_id, report_key, opened_at)
        VALUES (${ORG_ID}, ${userId}, ${reportKey}, now() - make_interval(mins => ${agoMinutes}))`,
  );
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Report Usage Fixture Org');
  // `user_id` carries no foreign key, so the organisation reset does not sweep
  // these rows. Users are minted fresh per run, which keeps stale rows out of
  // the assertions, but not out of the table.
  await harness.db.execute(sql`DELETE FROM report_usage WHERE org_id = ${ORG_ID}`);

  // Attendance breadth only: the catalogue offers this viewer the attendance
  // reports and withholds the Tally group, which is what lets the narrowing
  // test below prove the filter rather than an empty history.
  const viewerRoleId = await harness.createRole('Usage viewer', [
    PERMISSIONS.REPORT_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW_ALL,
  ]);
  const outsiderRoleId = await harness.createRole('No reports', []);

  const viewer = await harness.createUser({
    email: scopedEmail('usage-viewer'),
    roleIds: [viewerRoleId],
  });
  const otherViewer = await harness.createUser({
    email: scopedEmail('usage-other'),
    roleIds: [viewerRoleId],
  });
  const outsider = await harness.createUser({
    email: scopedEmail('usage-outsider'),
    roleIds: [outsiderRoleId],
  });

  viewerId = viewer.id;
  viewerToken = (await harness.login(viewer.email, viewer.password)).token;
  otherViewerToken = (await harness.login(otherViewer.email, otherViewer.password)).token;
  outsiderToken = (await harness.login(outsider.email, outsider.password)).token;
  expect(viewerToken).not.toBe('');
  started = true;
}, 60_000);

afterAll(async () => {
  if (!started) return;
  await harness.db.execute(sql`DELETE FROM report_usage WHERE org_id = ${ORG_ID}`);
  await harness.close();
}, 60_000);

describe('recently used reports', () => {
  it('returns the caller\'s keys most recent first, each key once', async () => {
    await opened(viewerId, 'monthly-muster', 4 * 24 * 60);
    await opened(viewerId, 'attendance-register', 3 * 24 * 60);
    await opened(viewerId, 'punch-audit', 2 * 24 * 60);
    // A re-open moves the key to the front rather than listing it twice.
    await opened(viewerId, 'attendance-register', 24 * 60);

    expect(await recent(viewerToken)).toEqual([
      'attendance-register',
      'punch-audit',
      'monthly-muster',
    ]);
  });

  it('never hands back a key the caller\'s catalogue cannot serve', async () => {
    // The most recent open of all — but day-book needs receivables.view,
    // which this viewer does not hold, and payroll-input is a key this build
    // dropped entirely. Neither may surface as a chip that cannot open.
    await opened(viewerId, 'day-book', 10);
    await opened(viewerId, 'payroll-input', 5);

    const keys = await recent(viewerToken);
    expect(keys).not.toContain('day-book');
    expect(keys).not.toContain('payroll-input');
    expect(keys[0]).toBe('attendance-register');
  });

  it('caps the list at eight, filled from what survives the narrowing', async () => {
    const attendance = [
      'daily-muster',
      'late-arrivals',
      'early-exits',
      'absenteeism',
      'missing-punch',
      'overtime',
    ];
    for (const [index, key] of attendance.entries()) {
      await opened(viewerId, key, index + 1);
    }

    const keys = await recent(viewerToken);
    expect(keys).toHaveLength(8);
    // Six fresh opens, then the survivors of the earlier tests by recency;
    // monthly-muster is ninth and falls off the end.
    expect(keys).toEqual([...attendance, 'attendance-register', 'punch-audit']);
  });

  it('shows each person their own history only', async () => {
    // Same role, no opens: an empty list, not a colleague's reading habits.
    expect(await recent(otherViewerToken)).toEqual([]);
  });

  it('is refused without report.view', async () => {
    const forbidden = await harness.get('/reports/usage/recent', { token: outsiderToken });
    expect(forbidden.status).toBe(403);

    const anonymous = await harness.get('/reports/usage/recent');
    expect(anonymous.status).toBe(401);
  });
});
