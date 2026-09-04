import { PERMISSIONS } from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * REQ-E-02 backfill (owner, 1 Sep 2026: "apply to the old data as well").
 *
 * What this endpoint refuses, and who may call it. Deliberately three things
 * this file does NOT do:
 *
 * - It does not start the BullMQ workers. `jobs.test.ts` does, and adding a
 *   describe to that file made the suite hang; this needs a real HTTP request
 *   and a real permission check, not a consumer.
 * - It does not assert the happy path. A successful call queues one real sweep
 *   per date, and when the workers are running those compute a day for every
 *   active employee in every organisation the shared test database has
 *   accumulated. An earlier draft did exactly that: the suite hung and 357
 *   attendance rows were written as a side effect of running a test.
 * - It does not re-test the range arithmetic. `backfillDates` and the schema
 *   are unit-tested in `@vyuha/shared`, without a queue behind them.
 *
 * What is left is what only an integration test can say: the route exists, it
 * validates, and it is Admin-only.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000fb01';

let harness: ApiHarness;
let adminToken = '';
let onlookerToken = '';

/** Refused before anything is queued, so no request here reaches the queue. */
const BACKWARDS = { from: '2026-08-10', to: '2026-08-01' };

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Absent Backfill Fixture Org');
  await harness.ensurePermissionCatalogue();

  const withKey = await harness.createRole('Backfill admin', [PERMISSIONS.SETTINGS_MANAGE]);
  const withoutKey = await harness.createRole('Backfill onlooker', [PERMISSIONS.CRM_TASK_VIEW_SELF]);
  const admin = await harness.createUser({ email: scopedEmail('backfill.admin'), roleIds: [withKey] });
  const onlooker = await harness.createUser({ email: scopedEmail('backfill.onlooker'), roleIds: [withoutKey] });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  onlookerToken = (await harness.login(onlooker.email, onlooker.password)).token;
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('backfilling absent days', () => {
  it('refuses a range that runs backwards', async () => {
    const response = await harness.post('/jobs/mark-absent/backfill', {
      token: adminToken,
      body: BACKWARDS,
    });
    expect(response.status).toBe(400);
  });

  it('refuses a range too long to have been meant', async () => {
    // Somebody typing the wrong year should get an error, not years of jobs.
    const response = await harness.post('/jobs/mark-absent/backfill', {
      token: adminToken,
      body: { from: '2020-01-01', to: '2026-08-01' },
    });
    expect(response.status).toBe(400);
  });

  it('refuses something that is not a date', async () => {
    const response = await harness.post('/jobs/mark-absent/backfill', {
      token: adminToken,
      body: { from: 'yesterday', to: '2026-08-01' },
    });
    expect(response.status).toBe(400);
  });

  it('needs settings.manage, and says which key it wanted', async () => {
    const denied = await harness.post<{ error: { details: { requiredAnyOf: string[] } } }>(
      '/jobs/mark-absent/backfill',
      { token: onlookerToken, body: BACKWARDS },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.requiredAnyOf).toContain(PERMISSIONS.SETTINGS_MANAGE);
  });

  it('is refused entirely without a token', async () => {
    const anonymous = await harness.post('/jobs/mark-absent/backfill', { body: BACKWARDS });
    expect(anonymous.status).toBe(401);
  });
});
