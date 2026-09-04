import {
  SYSTEM_ROLES,
  uuidv7,
  type AttendanceDayDetail,
  type PunchSyncReport,
} from '@vyuha/shared';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { locations } from '../../../platform/db/schema/index.js';
import { ApiHarness, FIXTURE_OFFICE, scopedEmail } from '../../../test-support/api-harness.js';
import { punches, shiftAssignments, shifts } from '../schema/index.js';

/**
 * REQ-D-10 against REQ-E-02 and REQ-E-03: a shift punched offline and drained
 * in one request has to produce the day the employee actually worked.
 *
 * `PunchService.sync` takes one `new Date()` for the whole batch and stamps it
 * on every entry, and `compute-day.ts` derives the day from `server_time`
 * alone. The two together made a drained shift compute as a zero-length day --
 * ABSENT, 0 worked minutes -- while every punch, every photo and every audit
 * row said the drain had succeeded. Nothing failed, and the muster was wrong,
 * which is the one thing this product cannot be. Phase 1's acceptance list
 * names "offline punch synced 6 hours later" as a case that must work
 * (`docs/03-scope-and-delivery-plan.md`).
 *
 * What would make this file pass while the bug is still there:
 *
 * - Punching live and asserting the day. Every punch here arrives through
 *   `POST /punches/sync`, which is the only door that produces OFFLINE_SYNC.
 * - Draining the IN and the OUT in two requests. Two requests take two
 *   `new Date()`s and the span appears by accident; both entries travel in one
 *   batch, as a real drain does.
 * - Asserting only the status. `worked_minutes` is asserted to the minute
 *   against the client times the queue recorded, so a day that is PRESENT for
 *   the wrong reason still fails.
 * - Reading `server_time` back and calling it the punch time. The two rows are
 *   asserted to share a `server_time` -- they genuinely were recorded in the
 *   same instant -- and to differ in the instant the day is computed from.
 *
 * The employee's timezone is chosen at run time so that "now" is 16:00 local,
 * whatever the wall clock in the room is. An eight-hour-old queued punch then
 * always lands on the same local date as its drain, and the file cannot pass
 * all afternoon and fail at two in the morning.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000b6';

const SHIFT_BREAK_MINUTES = 60;
/** Low enough that the drained span below clears it; REQ-E-02's PRESENT arm. */
const SHIFT_MIN_FULL_DAY_MINUTES = 400;

/** The queue: an IN eight hours old and the OUT that closes it. */
const IN_AGE_MS = 8 * 60 * 60 * 1000;
const OUT_AGE_MS = 60 * 1000;
const EXPECTED_SPAN_MINUTES = (IN_AGE_MS - OUT_AGE_MS) / 60_000;
const EXPECTED_WORKED_MINUTES = EXPECTED_SPAN_MINUTES - SHIFT_BREAK_MINUTES;

let harness: ApiHarness;
let runId: string;
let timezone: string;
let localDate: string;

let shiftEmployeeId: string;
let shiftToken: string;
let manyEmployeeId: string;
let manyToken: string;

let photoBytes: Buffer;
let smallPhotoBytes: Buffer;

/**
 * An IANA zone in which `at` reads as 16:00 local.
 *
 * `Etc/GMT+n` is inverted -- the sign is the one the POSIX TZ syntax uses, not
 * the one a UTC offset uses -- so the conversion happens once, here.
 */
function middayZone(at: Date): string {
  let offsetHours = 16 - at.getUTCHours();
  if (offsetHours > 14) offsetHours -= 24;
  if (offsetHours < -12) offsetHours += 24;
  return offsetHours >= 0 ? `Etc/GMT-${String(offsetHours)}` : `Etc/GMT+${String(-offsetHours)}`;
}

function localParts(at: Date, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

interface QueuedPunch {
  readonly key: string;
  readonly type: 'IN' | 'OUT';
  readonly clientTime: Date;
  readonly photoIndex: number;
  readonly ownerUserId?: string;
}

async function drain(
  token: string,
  queue: readonly QueuedPunch[],
  bytes: Buffer,
): Promise<{ status: number; body: PunchSyncReport }> {
  const form = new FormData();
  for (const _entry of queue) {
    form.append('photos', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'punch.jpg');
  }
  form.append(
    'payload',
    JSON.stringify({
      punches: queue.map((entry) => ({
        idempotencyKey: entry.key,
        photoIndex: entry.photoIndex,
        ...(entry.ownerUserId === undefined ? {} : { ownerUserId: entry.ownerUserId }),
        type: entry.type,
        clientTime: entry.clientTime.toISOString(),
        consentAccepted: true,
        latitude: FIXTURE_OFFICE.latitude,
        longitude: FIXTURE_OFFICE.longitude,
        gpsAccuracyM: 8,
        reason: 'Queued on the shop floor with no signal.',
      })),
    }),
  );

  const response = await fetch(`${harness.baseUrl}/punches/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as PunchSyncReport };
}

async function storedTimes(
  employeeId: string,
): Promise<{ type: string; serverTime: Date; effectiveTime: Date | null }[]> {
  const rows = await harness.db
    .select({
      type: punches.punchType,
      serverTime: punches.serverTime,
      effectiveTime: punches.effectiveTime,
    })
    .from(punches)
    .where(and(eq(punches.orgId, ORG_ID), eq(punches.employeeId, employeeId)))
    .orderBy(punches.serverTime, punches.id);
  return rows;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Punch Offline Day Fixture Org', {
    preservePeople: true,
  });
  runId = uuidv7().slice(-8);

  const now = new Date();
  timezone = middayZone(now);
  localDate = localParts(now, timezone).date;

  photoBytes = await sharp({
    create: { width: 1280, height: 960, channels: 3, background: { r: 30, g: 90, b: 140 } },
  })
    .jpeg({ quality: 82 })
    .toBuffer();
  smallPhotoBytes = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 60, g: 60, b: 120 } },
  })
    .jpeg({ quality: 70 })
    .toBuffer();

  const locationRows = await harness.db
    .insert(locations)
    .values({
      orgId: ORG_ID,
      code: `OFD-${runId}`,
      name: 'Offline Day Site (test only)',
      timezone,
      geofenceLat: FIXTURE_OFFICE.latitude,
      geofenceLng: FIXTURE_OFFICE.longitude,
    })
    .returning({ id: locations.id });
  const locationId = locationRows[0]?.id;
  if (locationId === undefined) throw new Error('location fixture insert returned no row');

  const employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
  shiftEmployeeId = await harness.createEmployee({
    code: `OFD-S-${runId}`,
    firstName: 'Suresh',
    locationId,
  });
  manyEmployeeId = await harness.createEmployee({
    code: `OFD-M-${runId}`,
    firstName: 'Meena',
    locationId,
  });

  // The shift the queue belongs to: it starts when the IN was taken and ends
  // when the OUT was, so the drained day is an ordinary full shift rather than
  // a fixture that only the assertion understands.
  const startTime = localParts(new Date(now.getTime() - IN_AGE_MS), timezone).time;
  const endTime = localParts(new Date(now.getTime() - OUT_AGE_MS), timezone).time;

  const shiftRows = await harness.db
    .insert(shifts)
    .values({
      orgId: ORG_ID,
      code: `OFD-${runId}`,
      name: 'Offline Day Probe Shift (test only)',
      startTime,
      endTime,
      breakMinutes: SHIFT_BREAK_MINUTES,
      minFullDayMinutes: SHIFT_MIN_FULL_DAY_MINUTES,
    })
    .returning({ id: shifts.id });
  const shiftId = shiftRows[0]?.id;
  if (shiftId === undefined) throw new Error('shift fixture insert returned no row');

  await harness.db.insert(shiftAssignments).values(
    [shiftEmployeeId, manyEmployeeId].map((employeeId) => ({
      orgId: ORG_ID,
      employeeId,
      shiftId,
      effectiveFrom: localDate,
      effectiveTo: localDate,
    })),
  );

  const logins = await Promise.all(
    [
      ['ofd-shift', shiftEmployeeId],
      ['ofd-many', manyEmployeeId],
    ].map(async ([label, employeeId]) => {
      const user = await harness.createUser({
        email: scopedEmail(label ?? ''),
        roleIds: [employeeRoleId],
        employeeId,
      });
      return (await harness.login(user.email, user.password)).token;
    }),
  );
  [shiftToken, manyToken] = logins as [string, string];
  expect([shiftToken, manyToken].every((token) => token !== '')).toBe(true);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('a shift drained from the offline queue (REQ-D-10)', () => {
  it('computes the day from the queued client times, not from the instant of the drain', async () => {
    const now = Date.now();
    const inAt = new Date(now - IN_AGE_MS);
    const outAt = new Date(now - OUT_AGE_MS);

    const result = await drain(
      shiftToken,
      [
        { key: `ofd-in-${runId}`, type: 'IN', clientTime: inAt, photoIndex: 0 },
        { key: `ofd-out-${runId}`, type: 'OUT', clientTime: outAt, photoIndex: 1 },
      ],
      photoBytes,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.created, JSON.stringify(result.body.results)).toBe(2);
    expect(result.body.rejected).toBe(0);

    // Both rows were genuinely written in the same instant, and the drain does
    // not pretend otherwise. What must differ is the instant the day is
    // computed from.
    const rows = await storedTimes(shiftEmployeeId);
    expect(rows.map((row) => row.type)).toEqual(['IN', 'OUT']);
    const [firstRow, secondRow] = rows;
    expect(firstRow?.serverTime.getTime()).toBe(secondRow?.serverTime.getTime());

    const spanMinutes =
      firstRow === undefined || secondRow === undefined
        ? 0
        : Math.round(
            ((secondRow.effectiveTime ?? secondRow.serverTime).getTime() -
              (firstRow.effectiveTime ?? firstRow.serverTime).getTime()) /
              60_000,
          );
    expect(spanMinutes, JSON.stringify(rows)).toBe(EXPECTED_SPAN_MINUTES);

    // REQ-D-10 says the delay is recorded, and it still is: the derivation
    // does not overwrite the queue delay with zero.
    const inEntry = result.body.results.find((entry) => entry.idempotencyKey.includes('-in-'));
    expect(inEntry?.punch?.syncDelaySeconds).toBeGreaterThan(IN_AGE_MS / 1000 - 120);
    expect(inEntry?.punch?.clockSkewSeconds).toBeNull();

    // The derivation is visible rather than silent: the punch says the time it
    // was judged on came from the queue, not from the server's clock.
    expect(inEntry?.punch?.flags, JSON.stringify(inEntry?.punch?.flags)).toContain('offline_sync');
    expect(inEntry?.punch?.flags, JSON.stringify(inEntry?.punch?.flags)).toContain('derived_time');

    const day = await harness.get<AttendanceDayDetail>(
      `/attendance/days/${shiftEmployeeId}/${localDate}`,
      { token: shiftToken },
    );
    expect(day.status, day.text).toBe(200);
    expect(day.body.workedMinutes, JSON.stringify(day.body)).toBe(EXPECTED_WORKED_MINUTES);
    expect(day.body.breakMinutes).toBe(SHIFT_BREAK_MINUTES);
    expect(day.body.status, JSON.stringify(day.body)).toBe('PRESENT');
    expect(day.body.flags).toContain('offline_sync');
  }, 90_000);

  it('keeps a fourteen-punch offline day in order and spans it end to end', async () => {
    const now = Date.now();
    // Seven IN/OUT pairs across the same eight hours: a shop-floor day with
    // breaks, drained in one request when the phone finds a network.
    const queue: QueuedPunch[] = [];
    const pairs = 7;
    const stretchMs = 44 * 60_000;
    // Spaced so the first IN and the last OUT sit on the same eight hours as
    // the two-punch day above: the same span through fourteen punches must
    // produce the same day, or REQ-C-01's single break deduction is not what
    // is being applied.
    const stepMs = (IN_AGE_MS - OUT_AGE_MS - stretchMs) / (pairs - 1);
    for (let pair = 0; pair < pairs; pair += 1) {
      const inOffsetMs = IN_AGE_MS - pair * stepMs;
      queue.push({
        key: `ofd-many-in-${String(pair)}-${runId}`,
        type: 'IN',
        clientTime: new Date(now - inOffsetMs),
        photoIndex: queue.length,
      });
      queue.push({
        key: `ofd-many-out-${String(pair)}-${runId}`,
        type: 'OUT',
        clientTime: new Date(now - inOffsetMs + stretchMs),
        photoIndex: queue.length,
      });
    }

    const result = await drain(manyToken, queue, smallPhotoBytes);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.created, JSON.stringify(result.body.results.map((r) => r.error))).toBe(14);

    const rows = await storedTimes(manyEmployeeId);
    expect(rows).toHaveLength(14);

    const effective = rows.map((row) => (row.effectiveTime ?? row.serverTime).getTime());
    // Strictly increasing: fourteen punches sharing one instant is exactly the
    // failure this file exists for, and a sort would hide it.
    for (let index = 1; index < effective.length; index += 1) {
      expect(
        (effective[index] ?? 0) - (effective[index - 1] ?? 0),
        `punch ${String(index)} of ${JSON.stringify(rows)}`,
      ).toBeGreaterThan(0);
    }

    const firstIn = effective[0] ?? 0;
    const lastOut = effective[effective.length - 1] ?? 0;
    const expectedWorked = Math.round((lastOut - firstIn) / 60_000) - SHIFT_BREAK_MINUTES;

    const day = await harness.get<AttendanceDayDetail>(
      `/attendance/days/${manyEmployeeId}/${localDate}`,
      { token: manyToken },
    );
    expect(day.status, day.text).toBe(200);
    // REQ-C-01: the agreed break is deducted once, not once per gap. Fourteen
    // punches and two must give the same day for the same span.
    expect(day.body.workedMinutes, JSON.stringify(day.body)).toBe(expectedWorked);
    expect(expectedWorked, JSON.stringify(day.body)).toBe(EXPECTED_WORKED_MINUTES);
    expect(day.body.status, JSON.stringify(day.body)).toBe('PRESENT');
  }, 120_000);
});

/**
 * C-01. The queue on a shared browser is origin-wide, and a row used to carry
 * no owner, so whoever signed in next drained everybody's punches under their
 * own name. The client now stamps and filters by owner; this is the server's
 * half, for a client that does not.
 */
describe('a punch queued by another account (C-01)', () => {
  it('is refused rather than recorded under the account that drained it', async () => {
    const key = `ofd-stranger-${runId}`;
    const result = await drain(
      shiftToken,
      [{ key, type: 'IN', clientTime: new Date(Date.now() - IN_AGE_MS), photoIndex: 0, ownerUserId: uuidv7() }],
      photoBytes,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.rejected).toBe(1);
    expect(result.body.results[0]?.error?.code).toBe('PUNCH_OWNER_MISMATCH');
    const rows = await harness.db.select({ id: punches.id }).from(punches).where(eq(punches.idempotencyKey, key));
    expect(rows).toHaveLength(0);
  });
});
