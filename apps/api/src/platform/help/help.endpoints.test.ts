import { PERMISSIONS, SYSTEM_ROLES, type HelpCardsResponse } from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';

import { NotificationDispatcher } from '../notifications/notification.dispatcher.js';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { HELP_CARDS } from './help.cards.js';

/**
 * REQ-AJ-01 and REQ-AJ-03 (proposed) over real HTTP.
 *
 * The assertion that matters is the third one. A corpus is a disclosure
 * surface — these cards name which controls exist and what an administrator
 * can do — and `docker/Caddyfile` leaves the static bundle unauthenticated,
 * so this endpoint is the only thing standing between the corpus and anyone
 * who resolves the domain. So it is probed twice: that signing out closes it
 * entirely, and that a caller holding three permissions receives nothing
 * gated on a fourth.
 *
 * Written as a property over the whole response rather than as a check for
 * two known card ids, because the interesting failure is a card added later
 * with a permission nobody remembered to filter on.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000fa';

let harness: ApiHarness;
let adminToken: string;
let employeeToken: string;

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Help Fixture Org');

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  // Exactly what a seeded Employee holds after A-01 removed the two
  // regularization keys, so the breadth probe below is the real one.
  const employeeRoleId = await harness.createRole('Help Employee', [
    PERMISSIONS.PUNCH_SELF,
    PERMISSIONS.ATTENDANCE_VIEW_SELF,
    PERMISSIONS.LEAVE_APPLY_SELF,
  ]);

  const admin = await harness.createUser({
    email: scopedEmail('help-admin'),
    roleIds: [adminRoleId],
  });
  const employee = await harness.createUser({
    email: scopedEmail('help-employee'),
    roleIds: [employeeRoleId],
  });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  employeeToken = (await harness.login(employee.email, employee.password)).token;
});

afterAll(async () => {
  await harness.close();
});

function cards(token: string) {
  return harness.get<HelpCardsResponse>('/help/cards', { token });
}

describe('GET /help/cards', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await harness.get('/help/cards');
    expect(response.status).toBe(401);
  });

  it('answers an employee with the cards that need no permission and the three they hold', async () => {
    const response = await cards(employeeToken);
    expect(response.status).toBe(200);
    expect(response.body.cards.length).toBeGreaterThan(0);

    const ids = response.body.cards.map((card) => card.id);
    // Everyone punches, so the geofence refusal — the highest-volume question
    // in the product after A-05 made it a block rather than a flag — must reach
    // the person it happens to.
    expect(ids).toContain('punch.outside-geofence');
    // Gated on attendance.edit, which an employee does not hold.
    expect(ids).not.toContain('attendance.record-for-someone');
  });

  it('never sends a card gated on a permission the caller lacks', async () => {
    const held = new Set<string>([
      PERMISSIONS.PUNCH_SELF,
      PERMISSIONS.ATTENDANCE_VIEW_SELF,
      PERMISSIONS.LEAVE_APPLY_SELF,
    ]);

    const response = await cards(employeeToken);
    const leaked = response.body.cards
      .filter((card) => card.permission !== null && !held.has(card.permission))
      .map((card) => `${card.id} needs ${card.permission ?? ''}`);

    expect(leaked).toEqual([]);
  });

  it('gives an administrator strictly more than an employee, and never more than exists', async () => {
    const adminResponse = await cards(adminToken);
    const employeeResponse = await cards(employeeToken);

    expect(adminResponse.body.cards.length).toBeGreaterThan(
      employeeResponse.body.cards.length,
    );
    expect(adminResponse.body.cards.length).toBeLessThanOrEqual(HELP_CARDS.length);
  });

  it('returns cards whole, so the panel never has to ask a second time', async () => {
    const response = await cards(employeeToken);
    const card = response.body.cards.find((entry) => entry.id === 'punch.outside-geofence');

    expect(card).toBeDefined();
    expect(card?.answer.length).toBeGreaterThan(20);
    expect(card?.aliases.length).toBeGreaterThan(2);
    expect(card?.errorCodes).toContain('PUNCH_OUTSIDE_GEOFENCE');
    expect(card?.tourStep).toBe('screen.punch');
  });
});

describe('POST /help/questions (REQ-AJ-05)', () => {
  it('records the question, tells settings.manage holders, and refuses junk', async () => {
    // The spy replaces the BullMQ enqueue, the way the staleness suite does:
    // this test owns who is addressed, not delivery.
    const emitted: { type: string; audience: unknown; payload?: Record<string, unknown> }[] = [];
    const dispatcher = harness.resolve(NotificationDispatcher);
    vi.spyOn(dispatcher, 'emit').mockImplementation((event) => {
      emitted.push(event);
      return Promise.resolve('spied');
    });

    const sent = await harness.post('/help/questions', {
      token: employeeToken,
      body: { question: 'How do I change my weekly off day?' },
    });
    expect(sent.status).toBe(201);

    const rows = await harness.db.execute<{ question: string }>(sql`
      SELECT question FROM help_questions WHERE org_id = ${ORG_ID}
    `);
    expect(rows.rows.map((r) => r.question)).toContain('How do I change my weekly off day?');
    expect(await harness.waitForAuditAction('help.question_asked')).toBe(true);

    // Addressed to settings.manage holders, carrying the question itself.
    const event = emitted.find((e) => e.type === 'help.question_asked');
    expect(event?.audience).toEqual({ kind: 'permission', key: 'settings.manage' });
    expect(event?.payload?.question).toBe('How do I change my weekly off day?');

    const junk = await harness.post('/help/questions', { token: employeeToken, body: { question: '  ' } });
    expect(junk.status).toBe(400);
  });
});
