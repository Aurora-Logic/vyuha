import { PERMISSIONS, type DashboardLayoutView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * Customisable dashboards (owner, 25 Aug 2026) over real HTTP.
 *
 * The contract under test is small but easy to get subtly wrong: a layout is
 * one row per (user, board) that PUT replaces rather than accumulates, that
 * nobody else can see, and whose absence -- the fresh state and the state
 * after a reset -- is what makes the shipped preset render. A duplicate row
 * or a leaked one would not error anywhere; the board would just quietly
 * show the wrong person's choice.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f0dc';

let harness: ApiHarness;
let viewerToken = '';
let otherViewerToken = '';
let outsiderToken = '';
let started = false;

interface ErrorBody {
  readonly error: { readonly message: string };
}

type Listing = { data: DashboardLayoutView[] };

async function layouts(token: string): Promise<DashboardLayoutView[]> {
  const response = await harness.get<Listing>('/reports/dashboards', { token });
  expect(response.status, response.text).toBe(200);
  return response.body.data;
}

async function auditCount(action: string): Promise<number> {
  const result = await harness.db.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM audit_logs
         WHERE org_id = ${ORG_ID} AND action = ${action} AND entity_type = 'dashboard_layout'`,
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * The interceptor deliberately does not make the response wait on the audit
 * insert, so the row can land after the PUT returns. Polling briefly is the
 * honest assertion; reading immediately made the auth suite flake.
 */
async function waitForAudit(action: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const count = await auditCount(action);
    if (count > 0) return count;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return 0;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Dashboard Layout Fixture Org');

  const viewerRoleId = await harness.createRole('Report viewer', [PERMISSIONS.REPORT_VIEW]);
  // No keys at all, so the 403s below prove the guard rather than a missing
  // adjacent permission.
  const outsiderRoleId = await harness.createRole('No reports', []);

  const viewer = await harness.createUser({
    email: scopedEmail('dash-viewer'),
    roleIds: [viewerRoleId],
  });
  const otherViewer = await harness.createUser({
    email: scopedEmail('dash-other'),
    roleIds: [viewerRoleId],
  });
  const outsider = await harness.createUser({
    email: scopedEmail('dash-outsider'),
    roleIds: [outsiderRoleId],
  });

  viewerToken = (await harness.login(viewer.email, viewer.password)).token;
  otherViewerToken = (await harness.login(otherViewer.email, otherViewer.password)).token;
  outsiderToken = (await harness.login(outsider.email, outsider.password)).token;
  expect(viewerToken).not.toBe('');
  started = true;
}, 60_000);

afterAll(async () => {
  if (!started) return;
  await harness.close();
}, 60_000);

describe('saving and reading a layout', () => {
  it('PUT then GET roundtrips the tiles, with the schema defaults filled in', async () => {
    const saved = await harness.put<DashboardLayoutView & ErrorBody>(
      '/reports/dashboards/overview',
      {
        token: viewerToken,
        body: {
          tiles: [
            {
              reportKey: 'attendance-register',
              label: 'Register',
              form: 'hbar',
      kind: 'chart',
              wide: true,
              filters: { from: '2026-08-01', to: '2026-08-31' },
            },
            { reportKey: 'headcount' },
          ],
        },
      },
    );
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.dashboard).toBe('overview');
    expect(saved.body.updatedAt).toBeTruthy();
    expect(saved.body.config.tiles).toHaveLength(2);
    expect(saved.body.config.tiles[0]).toEqual({
      reportKey: 'attendance-register',
      label: 'Register',
      form: 'hbar',
      kind: 'chart',
      wide: true,
      filters: { from: '2026-08-01', to: '2026-08-31' },
    });
    // The bare tile comes back with its defaults made explicit, so the client
    // never has to know what "unset" means.
    expect(saved.body.config.tiles[1]).toEqual({
      reportKey: 'headcount',
      form: 'auto',
      wide: false,
      filters: {},
    });

    const listed = await layouts(viewerToken);
    const overview = listed.find((layout) => layout.dashboard === 'overview');
    expect(overview?.config).toEqual(saved.body.config);
  });

  it('writes an audit row for the save', async () => {
    expect(await waitForAudit('report.dashboard.created')).toBeGreaterThanOrEqual(1);
  });

  it('PUT replaces the stored layout rather than duplicating it', async () => {
    const replaced = await harness.put<DashboardLayoutView & ErrorBody>(
      '/reports/dashboards/overview',
      {
        token: viewerToken,
        body: { tiles: [{ reportKey: 'headcount', form: 'donut' }] },
      },
    );
    expect(replaced.status, replaced.text).toBe(200);
    expect(replaced.body.config.tiles).toHaveLength(1);

    const listed = await layouts(viewerToken);
    const overviews = listed.filter((layout) => layout.dashboard === 'overview');
    expect(overviews).toHaveLength(1);
    expect(overviews[0]?.config.tiles[0]?.reportKey).toBe('headcount');

    // The listing hides duplicates by construction, so the table is asked
    // directly: one living row, not a pile the unique index happens to mask.
    const rows = await harness.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM dashboard_layouts
           WHERE org_id = ${ORG_ID} AND dashboard = 'overview' AND deleted_at IS NULL`,
    );
    expect(rows.rows[0]?.count).toBe(1);

    expect(await waitForAudit('report.dashboard.updated')).toBeGreaterThanOrEqual(1);
  });

  it('does not show one person another person\'s layout', async () => {
    expect(await layouts(otherViewerToken)).toEqual([]);
  });
});

describe('resetting a layout', () => {
  it('DELETE removes the stored choice, so the preset renders again', async () => {
    const removed = await harness.del('/reports/dashboards/overview', { token: viewerToken });
    expect(removed.status).toBe(204);
    expect(await layouts(viewerToken)).toEqual([]);
    expect(await waitForAudit('report.dashboard.reset')).toBeGreaterThanOrEqual(1);
  });

  it('resetting a board already on the preset is success, not an error', async () => {
    const removed = await harness.del('/reports/dashboards/overview', { token: viewerToken });
    expect(removed.status).toBe(204);
  });
});

describe('what the schema refuses', () => {
  it('refuses a tile naming a report that does not exist', async () => {
    const refused = await harness.put<ErrorBody>('/reports/dashboards/overview', {
      token: viewerToken,
      body: { tiles: [{ reportKey: 'nonsense' }] },
    });
    expect(refused.status).toBe(400);
  });

  it('refuses an empty board, which would render as nothing rather than the preset', async () => {
    const refused = await harness.put<ErrorBody>('/reports/dashboards/overview', {
      token: viewerToken,
      body: { tiles: [] },
    });
    expect(refused.status).toBe(400);
  });

  it('refuses a board this product does not have', async () => {
    const refused = await harness.put<ErrorBody>('/reports/dashboards/pipeline', {
      token: viewerToken,
      body: { tiles: [{ reportKey: 'headcount' }] },
    });
    expect(refused.status).toBe(400);
  });
});

describe('who may touch a layout', () => {
  it('refuses every route to a caller without report.view', async () => {
    const listed = await harness.get('/reports/dashboards', { token: outsiderToken });
    expect(listed.status).toBe(403);

    const saved = await harness.put('/reports/dashboards/overview', {
      token: outsiderToken,
      body: { tiles: [{ reportKey: 'headcount' }] },
    });
    expect(saved.status).toBe(403);

    const removed = await harness.del('/reports/dashboards/overview', { token: outsiderToken });
    expect(removed.status).toBe(403);
  });
});
