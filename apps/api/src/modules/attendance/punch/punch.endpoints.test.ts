import {
  SYSTEM_ROLES,
  uuidv7,
  type AttendanceDayDetail,
  type AttendanceDaySummary,
  type CursorPaginated,
  type Paginated,
  type PunchContext,
  type PunchReceipt,
  type PunchRecord,
  type PunchSyncReport,
  type SignedPhotoUrl,
} from '@vyuha/shared';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, FIXTURE_OFFICE, scopedEmail } from '../../../test-support/api-harness.js';
import { consentAcceptances, employees, files } from '../../../platform/db/schema/index.js';
import { localDateIn } from '../day-engine/calendar-date.js';
import { attendanceDays, punches, shiftAssignments, shifts } from '../schema/index.js';
import { DEFAULT_PUNCH_SETTINGS, photoExpiry } from './punch-settings.js';

/**
 * The punch endpoints (REQ-D-01 … REQ-D-13) over real HTTP against the real
 * application: guard, multipart parsing, sharp pipeline, MinIO, the punch
 * trigger, and the inline day engine all in the loop.
 *
 * Started with `preservePeople`: a punch makes its employee permanently
 * undeletable (REQ-D-12 plus RESTRICT), so this file mints new people with
 * unique codes on every run rather than resetting them. The shift is likewise
 * per-run, with its window opened around the wall clock, because the server
 * under test punches at real "now" and a fixed fixture date would put every
 * punch outside every window.
 *
 * The three security assertions the brief calls out -- no photo means no
 * punch, one idempotency key means one punch, alternating IN/OUT -- each live
 * in exactly one test here, so removing the corresponding server-side check
 * fails exactly one named test.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d1';
const TIMEZONE = 'Asia/Kolkata';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let harness: ApiHarness;
let runId: string;
let today: string;

let employeeAId: string;
let employeeBId: string;
let consentEmployeeId: string;
let syncEmployeeId: string;
let tokenA: string;
let employeeRoleId = '';
let probeShiftId = '';
let tokenB: string;
let hrToken: string;
let noPunchToken: string;
let consentToken: string;
let syncToken: string;
let consentUserId: string;
let syncUserId: string;

let photoWithExifBytes: Buffer;
let firstPunchId = '';
let employeeBPunchId = '';

/** `HH:MM:SS` on the IST wall clock, `offsetMinutes` from now. */
function istTime(offsetMinutes: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(Date.now() + offsetMinutes * 60_000));
}

function isoAgo(milliseconds: number): string {
  return new Date(Date.now() - milliseconds).toISOString();
}

interface MultipartResult<T> {
  readonly status: number;
  readonly body: T;
}

/**
 * The harness speaks JSON; this endpoint speaks multipart, so the request is
 * built here with the same fetch the harness uses underneath.
 */
async function multipart<T>(
  path: string,
  token: string,
  parts: {
    readonly payload: unknown;
    readonly photos?: readonly { field: string; bytes: Buffer }[];
    readonly idempotencyKey?: string | null;
  },
): Promise<MultipartResult<T>> {
  const form = new FormData();
  for (const photo of parts.photos ?? []) {
    form.append(photo.field, new Blob([new Uint8Array(photo.bytes)], { type: 'image/jpeg' }), 'punch.jpg');
  }
  form.append('payload', JSON.stringify(parts.payload));

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (parts.idempotencyKey != null) headers['idempotency-key'] = parts.idempotencyKey;

  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : null) as T };
}

function punchIn(
  token: string,
  key: string,
  overrides: Record<string, unknown> = {},
): Promise<MultipartResult<PunchReceipt & ErrorBody>> {
  return multipart('/punches', token, {
    idempotencyKey: key,
    photos: [{ field: 'photo', bytes: photoWithExifBytes }],
    // `consentAccepted: true`, as the shipped client sends on every punch
    // (REQ-M-03): the tick when the notice is showing, the server's own
    // record otherwise. The no-row-no-tick refusal has its own describe.
    payload: {
      type: 'IN',
      clientTime: new Date().toISOString(),
      source: 'MOBILE',
      consentAccepted: true,
      // At the fixture office, with a tight fix: the geofence is enforced on
      // every punch, so a punch with no position is refused.
      latitude: FIXTURE_OFFICE.latitude,
      longitude: FIXTURE_OFFICE.longitude,
      gpsAccuracyM: 8,
      ...overrides,
    },
  });
}

async function countAcceptances(userId: string): Promise<number> {
  const rows = await harness.db
    .select({ id: consentAcceptances.id })
    .from(consentAcceptances)
    .where(and(eq(consentAcceptances.orgId, ORG_ID), eq(consentAcceptances.userId, userId)));
  return rows.length;
}

async function countPunches(employeeId: string): Promise<number> {
  const rows = await harness.db
    .select({ value: sql<number>`count(*)::int` })
    .from(punches)
    .where(and(eq(punches.orgId, ORG_ID), eq(punches.employeeId, employeeId)));
  return rows[0]?.value ?? 0;
}

async function fetchPhoto(
  token: string,
  punchId: string,
  variant: 'full' | 'thumbnail',
): Promise<Buffer> {
  const signed = await harness.get<SignedPhotoUrl>(`/punches/${punchId}/photo?variant=${variant}`, {
    token,
  });
  expect(signed.status, signed.text).toBe(200);
  const object = await fetch(signed.body.url);
  expect(object.status).toBe(200);
  return Buffer.from(await object.arrayBuffer());
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Punch Endpoints Fixture Org', { preservePeople: true });
  runId = uuidv7().slice(-8);
  today = localDateIn(new Date(), TIMEZONE);

  // What a phone actually uploads: larger than the 1280 cap, EXIF attached.
  photoWithExifBytes = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 40, g: 110, b: 170 } },
  })
    .withExif({
      IFD0: { Make: 'ProbePhone', Model: 'X1', Software: 'probe' },
      IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  employeeRoleId = await harness.createSystemRole(SYSTEM_ROLES.EMPLOYEE);
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR);
  // Holds a view key but not punch.self, so the 403 test refuses for exactly
  // the permission this endpoint requires rather than for having none at all.
  const viewerRoleId = await harness.createRole('Punch Viewer Only', ['attendance.view.self']);

  employeeAId = await harness.createEmployee({ code: `PT-A-${runId}`, firstName: 'Punya' });
  employeeBId = await harness.createEmployee({ code: `PT-B-${runId}`, firstName: 'Bala' });
  // Fresh people for the consent gate: their users must start with no
  // acceptance row, which A and B stop being true for after their first punch.
  consentEmployeeId = await harness.createEmployee({ code: `PT-C-${runId}`, firstName: 'Chetan' });
  syncEmployeeId = await harness.createEmployee({ code: `PT-D-${runId}`, firstName: 'Divya' });

  // The shift window has to contain the wall clock: opened two minutes ago so
  // an IN right now is inside grace, closing hours away so an OUT right now is
  // outside its window and exercises the reason path. Clamped to the same
  // calendar day -- crossesMidnight stays false.
  //
  // Both ends are clamped, not just the end. `istTime(-2)` wraps to the
  // previous day between 00:00 and 00:02 IST, which produced a start of 23:5x
  // against an end of 04:59 on a shift declaring it does not cross midnight -
  // a two-minute window each night in which this file failed for a reason that
  // had nothing to do with punching. Migration 0006 added
  // shifts_schedule_ordered, which now refuses the row outright, so the
  // latent bug became a hard failure. Comparing the two strings detects the
  // wrap without any date arithmetic: they are same-length zero-padded clocks,
  // so a start that sorts after "now" can only have come from wrapping.
  const startCandidate = istTime(-2);
  const startTime = startCandidate > istTime(0) ? '00:00:00' : startCandidate;
  const endHour = Math.min(Number(istTime(0).slice(0, 2)) + 4, 23);
  const endTime = `${String(endHour).padStart(2, '0')}:59:00`;

  const shiftRows = await harness.db
    .insert(shifts)
    .values({
      orgId: ORG_ID,
      code: `PT-${runId}`,
      name: 'Punch Probe Shift (test only)',
      startTime,
      endTime,
      breakMinutes: 0,
    })
    .returning({ id: shifts.id });
  const shiftId = shiftRows[0]?.id;
  if (shiftId === undefined) throw new Error('shift fixture insert returned no row');
  probeShiftId = shiftId;

  await harness.db.insert(shiftAssignments).values(
    [employeeAId, employeeBId, consentEmployeeId, syncEmployeeId].map((employeeId) => ({
      orgId: ORG_ID,
      employeeId,
      shiftId,
      effectiveFrom: today,
      effectiveTo: today,
    })),
  );

  const userA = await harness.createUser({
    email: scopedEmail('punch-a'),
    roleIds: [employeeRoleId],
    employeeId: employeeAId,
  });
  const userB = await harness.createUser({
    email: scopedEmail('punch-b'),
    roleIds: [employeeRoleId],
    employeeId: employeeBId,
  });
  const hrUser = await harness.createUser({
    email: scopedEmail('punch-hr'),
    roleIds: [hrRoleId],
  });
  // No employee link: one login per employee (`users_employee_uq`), and the
  // 403 this account exists for is about the missing key, not about identity.
  const viewerUser = await harness.createUser({
    email: scopedEmail('punch-viewer'),
    roleIds: [viewerRoleId],
  });
  const consentUser = await harness.createUser({
    email: scopedEmail('punch-consent'),
    roleIds: [employeeRoleId],
    employeeId: consentEmployeeId,
  });
  const syncUser = await harness.createUser({
    email: scopedEmail('punch-consent-sync'),
    roleIds: [employeeRoleId],
    employeeId: syncEmployeeId,
  });
  consentUserId = consentUser.id;
  syncUserId = syncUser.id;

  tokenA = (await harness.login(userA.email, userA.password)).token;
  tokenB = (await harness.login(userB.email, userB.password)).token;
  hrToken = (await harness.login(hrUser.email, hrUser.password)).token;
  noPunchToken = (await harness.login(viewerUser.email, viewerUser.password)).token;
  consentToken = (await harness.login(consentUser.email, consentUser.password)).token;
  syncToken = (await harness.login(syncUser.email, syncUser.password)).token;
  expect(
    [tokenA, tokenB, hrToken, noPunchToken, consentToken, syncToken].every(
      (token) => token !== '',
    ),
  ).toBe(true);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('access control', () => {
  it('refuses an unauthenticated request on every route', async () => {
    for (const [method, path] of [
      ['POST', '/punches'],
      ['POST', '/punches/sync'],
      ['GET', '/punches'],
      ['GET', '/me/today'],
      ['GET', '/attendance/days'],
    ] as const) {
      const result = await harness.request(method, path);
      expect(result.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a punch to an account without punch.self, naming the key', async () => {
    const result = await punchIn(noPunchToken, `pt-403-${runId}`);
    expect(result.status).toBe(403);
    expect(result.body.error.details?.requiredAnyOf).toEqual(['punch.self']);
  });

  it('refuses a punch with no Idempotency-Key header (REQ-D-11)', async () => {
    const result = await multipart<ErrorBody>('/punches', tokenA, {
      photos: [{ field: 'photo', bytes: photoWithExifBytes }],
      payload: {
        type: 'IN',
        clientTime: new Date().toISOString(),
        source: 'MOBILE',
        consentAccepted: true,
        latitude: FIXTURE_OFFICE.latitude,
        longitude: FIXTURE_OFFICE.longitude,
        gpsAccuracyM: 8,
      },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.message).toContain('Idempotency-Key');
  });
});

describe('POST /punches (REQ-D-01 … REQ-D-13)', () => {
  it('refuses a punch with no photo, before anything is stored (REQ-D-02)', async () => {
    const before = await countPunches(employeeAId);
    const result = await multipart<ErrorBody>('/punches', tokenA, {
      idempotencyKey: `pt-nophoto-${runId}`,
      payload: {
        type: 'IN',
        clientTime: new Date().toISOString(),
        source: 'MOBILE',
        consentAccepted: true,
        latitude: FIXTURE_OFFICE.latitude,
        longitude: FIXTURE_OFFICE.longitude,
        gpsAccuracyM: 8,
      },
    });

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('PUNCH_PHOTO_REQUIRED');
    expect(await countPunches(employeeAId)).toBe(before);
  });

  it('records an IN and computes the day inline (technical design §5)', async () => {
    const result = await punchIn(tokenA, `pt-in-${runId}`);

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.replayed).toBe(false);
    expect(result.body.punch.type).toBe('IN');
    expect(result.body.punch.attendanceDate).toBe(today);
    expect(result.body.punch.employee.id).toBe(employeeAId);
    // Two objects per punch, and they are different objects (REQ-D-03a).
    expect(result.body.punch.photo).not.toBeNull();
    expect(result.body.punch.photo?.thumbnailFileId).not.toBe(result.body.punch.photo?.fileId);
    // Taken at the fixture office with a tight fix: inside, and nothing flagged about it.
    expect(result.body.punch.flags).not.toContain('outside_geofence');
    expect(result.body.punch.flags).not.toContain('low_gps_accuracy');

    // The receipt's day is the engine's inline run, not a cached view.
    expect(result.body.day).not.toBeNull();
    expect(result.body.day?.status).toBe('PENDING');
    // `tokenA` is an Employee, so the day embedded here is subject to the same
    // field visibility as the muster row. A figure withheld from
    // `GET /attendance/days` that arrives in a punch receipt instead is not
    // withheld at all -- see `attendance-day-visibility.endpoints.test.ts`.
    expect(result.body.day === null || Object.hasOwn(result.body.day, 'otMinutes')).toBe(false);

    const rows = await harness.db
      .select({ firstIn: attendanceDays.firstInPunchId, status: attendanceDays.status })
      .from(attendanceDays)
      .where(
        and(
          eq(attendanceDays.orgId, ORG_ID),
          eq(attendanceDays.employeeId, employeeAId),
          eq(attendanceDays.date, today),
        ),
      );
    expect(rows[0]?.firstIn).toBe(result.body.punch.id);
    expect(rows[0]?.status).toBe('PENDING');

    firstPunchId = result.body.punch.id;
  });

  it('stores a stamped, EXIF-free photo and a smaller 256px thumbnail (REQ-D-03/03a)', async () => {
    const full = await fetchPhoto(tokenA, firstPunchId, 'full');
    const thumbnail = await fetchPhoto(tokenA, firstPunchId, 'thumbnail');

    // Never the client's bytes.
    expect(full.equals(photoWithExifBytes)).toBe(false);

    const fullMeta = await sharp(full).metadata();
    expect(fullMeta.exif).toBeUndefined();
    expect(fullMeta.width).toBeLessThanOrEqual(1280);

    const thumbMeta = await sharp(thumbnail).metadata();
    expect(thumbMeta.exif).toBeUndefined();
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(256);
    expect(thumbnail.length).toBeLessThan(full.length);

    // The stamp is pixels, so it is measured as pixels: bright glyphs over the
    // dark band in the bottom sixth of the image. An unstamped photo of this
    // fixture's flat blue background has zero pixels over the threshold there,
    // so this cannot pass by accident.
    const width = fullMeta.width ?? 0;
    const height = fullMeta.height ?? 0;
    const bandHeight = Math.max(44, Math.round(height * 0.155));
    const band = await sharp(full)
      .extract({ left: 0, top: height - bandHeight, width, height: bandHeight })
      .greyscale()
      .raw()
      .toBuffer();
    let bright = 0;
    for (const value of band) if (value > 200) bright += 1;
    expect(bright).toBeGreaterThan(100);
  });

  it('stamps expires_at on the photo and its thumbnail from the retention setting (REQ-L-03)', async () => {
    const rows = await harness.db
      .select({
        purpose: files.purpose,
        expiresAt: files.expiresAt,
        punchServerTime: punches.serverTime,
      })
      .from(files)
      .innerJoin(
        punches,
        sql`${punches.photoFileId} = ${files.id} OR ${punches.thumbnailFileId} = ${files.id}`,
      )
      .where(and(eq(files.orgId, ORG_ID), eq(punches.id, firstPunchId)));

    // Both objects, not just the full image: a purged photo whose thumbnail
    // survives is not purged.
    expect(rows.map((row) => row.purpose).sort()).toEqual(['PUNCH_PHOTO', 'PUNCH_PHOTO_THUMB']);

    for (const row of rows) {
      // No org setting is installed, so the default 12 months applies. The
      // expected instant is derived from the punch's own server time -- the
      // `now` the pipeline stamped from -- so the assertion is exact, not a
      // tolerance window.
      expect(row.expiresAt).not.toBeNull();
      expect(row.expiresAt?.getTime()).toBe(
        photoExpiry(row.punchServerTime, DEFAULT_PUNCH_SETTINGS.photoRetentionMonths).getTime(),
      );
    }
  });

  it('returns the same punch for a replayed Idempotency-Key (REQ-D-11)', async () => {
    const before = await countPunches(employeeAId);
    const replay = await punchIn(tokenA, `pt-in-${runId}`);

    // 200, not 201: nothing was created the second time.
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.punch.id).toBe(firstPunchId);
    expect(await countPunches(employeeAId)).toBe(before);
  });

  it('refuses a second IN while one is open (REQ-D-01)', async () => {
    const result = await punchIn(tokenA, `pt-in2-${runId}`);

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('PUNCH_OUT_OF_ORDER');
    expect(result.body.error.details?.expected).toBe('OUT');
  });

  it('records an out-of-window punch, flags it, and raises it into Approvals (owner, 21 Aug 2026)', async () => {
    // The shift runs for hours yet, so an OUT now is outside its window.
    // No reason is asked for and nothing is blocked: the flag goes to an
    // admin, who decides there.
    const accepted = await multipart<PunchReceipt>('/punches', tokenA, {
      idempotencyKey: `pt-out-${runId}`,
      photos: [{ field: 'photo', bytes: photoWithExifBytes }],
      payload: {
        type: 'OUT',
        clientTime: new Date().toISOString(),
        source: 'MOBILE',
        consentAccepted: true,
        latitude: FIXTURE_OFFICE.latitude,
        longitude: FIXTURE_OFFICE.longitude,
        gpsAccuracyM: 8,
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.punch.flags).toContain('outside_window');
    expect(accepted.body.punch.flagReview).toBeNull();
    expect(accepted.body.day?.firstInAt).not.toBeNull();
    expect(accepted.body.day?.lastOutAt).not.toBeNull();
    expect(accepted.body.day?.flags).toContain('outside_window');

    const inbox = await harness.get<{ data: { id: string; type: string; subjectType: string; subject: string; status: string }[] }>(
      '/approvals?status=PENDING',
      { token: hrToken },
    );
    expect(inbox.status, inbox.text).toBe(200);
    const raised = inbox.body.data.find((row) => row.subjectType === 'punch' && row.subject.includes('Punya'));
    expect(raised, JSON.stringify(inbox.body.data)).toBeDefined();
    expect(raised?.type).toBe('FLAGGED_PUNCH');
  });

  it('accepts a half day chosen at IN and reflects it on the day (REQ-D-07)', async () => {
    const result = await multipart<PunchReceipt>('/punches', tokenB, {
      idempotencyKey: `pt-b-in-${runId}`,
      photos: [{ field: 'photo', bytes: photoWithExifBytes }],
      payload: {
        type: 'IN',
        clientTime: new Date().toISOString(),
        source: 'MOBILE',
        consentAccepted: true,
        latitude: FIXTURE_OFFICE.latitude,
        longitude: FIXTURE_OFFICE.longitude,
        gpsAccuracyM: 8,
        isHalfDay: true,
        halfDayPart: 'SECOND_HALF',
      },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.punch.isHalfDayMarked).toBe(true);
    expect(result.body.punch.halfDayPart).toBe('SECOND_HALF');
    // REQ-E-02: marked at punch, the day derives HALF_DAY regardless of hours.
    expect(result.body.day?.status).toBe('HALF_DAY');
    employeeBPunchId = result.body.punch.id;
  });
});

describe('POST /punches/sync (REQ-D-10)', () => {
  it('drains a queue: fresh accepted with its delay, stale rejected, one bad entry loses nothing', async () => {
    const result = await multipart<PunchSyncReport>('/punches/sync', tokenA, {
      photos: [
        { field: 'photos', bytes: photoWithExifBytes },
        { field: 'photos', bytes: photoWithExifBytes },
      ],
      payload: {
        punches: [
          {
            idempotencyKey: `pt-sync-stale-${runId}`,
            photoIndex: 0,
            latitude: FIXTURE_OFFICE.latitude,
            longitude: FIXTURE_OFFICE.longitude,
            gpsAccuracyM: 8,
            type: 'IN',
            clientTime: isoAgo(72 * 3600 * 1000),
            consentAccepted: true,
            reason: 'Queued while the site had no signal.',
          },
          {
            idempotencyKey: `pt-sync-fresh-${runId}`,
            photoIndex: 1,
            latitude: FIXTURE_OFFICE.latitude,
            longitude: FIXTURE_OFFICE.longitude,
            gpsAccuracyM: 8,
            type: 'IN',
            clientTime: isoAgo(7 * 60 * 1000),
            consentAccepted: true,
            reason: 'Queued while the site had no signal.',
          },
        ],
      },
    });

    expect(result.status).toBe(200);
    expect(result.body.created).toBe(1);
    expect(result.body.rejected).toBe(1);

    const stale = result.body.results.find((entry) => entry.idempotencyKey.includes('stale'));
    expect(stale?.outcome).toBe('rejected');
    expect(stale?.error?.code).toBe('PUNCH_QUEUED_TOO_OLD');

    const fresh = result.body.results.find((entry) => entry.idempotencyKey.includes('fresh'));
    expect(fresh?.outcome).toBe('created');
    expect(fresh?.punch?.source).toBe('OFFLINE_SYNC');
    expect(fresh?.punch?.flags).toContain('offline_sync');
    // REQ-D-10: the delay is recorded -- about seven minutes, and filed as
    // sync delay rather than as a broken clock.
    expect(fresh?.punch?.syncDelaySeconds).toBeGreaterThan(300);
    expect(fresh?.punch?.syncDelaySeconds).toBeLessThan(600);
    expect(fresh?.punch?.clockSkewSeconds).toBeNull();
  });

  it('replays the whole batch without creating anything (REQ-D-11)', async () => {
    const before = await countPunches(employeeAId);
    const result = await multipart<PunchSyncReport>('/punches/sync', tokenA, {
      photos: [
        { field: 'photos', bytes: photoWithExifBytes },
        { field: 'photos', bytes: photoWithExifBytes },
      ],
      payload: {
        punches: [
          {
            idempotencyKey: `pt-sync-stale-${runId}`,
            photoIndex: 0,
            latitude: FIXTURE_OFFICE.latitude,
            longitude: FIXTURE_OFFICE.longitude,
            gpsAccuracyM: 8,
            type: 'IN',
            clientTime: isoAgo(72 * 3600 * 1000),
            consentAccepted: true,
            reason: 'Queued while the site had no signal.',
          },
          {
            idempotencyKey: `pt-sync-fresh-${runId}`,
            photoIndex: 1,
            latitude: FIXTURE_OFFICE.latitude,
            longitude: FIXTURE_OFFICE.longitude,
            gpsAccuracyM: 8,
            type: 'IN',
            clientTime: isoAgo(7 * 60 * 1000),
            consentAccepted: true,
            reason: 'Queued while the site had no signal.',
          },
        ],
      },
    });

    expect(result.status).toBe(200);
    expect(result.body.replayed).toBe(1);
    expect(result.body.created).toBe(0);
    expect(result.body.rejected).toBe(1);
    expect(await countPunches(employeeAId)).toBe(before);
  });
});

describe('consent gate (REQ-M-03)', () => {
  it('refuses a photo punch with no acceptance on record and no assertion', async () => {
    const before = await countPunches(consentEmployeeId);

    const result = await multipart<ErrorBody>('/punches', consentToken, {
      idempotencyKey: `pt-consent-none-${runId}`,
      photos: [{ field: 'photo', bytes: photoWithExifBytes }],
      payload: {
        type: 'IN',
        clientTime: new Date().toISOString(),
        source: 'MOBILE',
        consentAccepted: false,
      },
    });

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('CONSENT_REQUIRED');
    // Refused before anything was written: no punch, and no acceptance the
    // person never gave.
    expect(await countPunches(consentEmployeeId)).toBe(before);
    expect(await countAcceptances(consentUserId)).toBe(0);
  });

  it('records the acceptance with the punch when the body carries the tick', async () => {
    const result = await punchIn(consentToken, `pt-consent-tick-${runId}`);

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.replayed).toBe(false);

    // The same transaction outcome: the punch landed, so the acceptance row
    // exists -- stamped with what the notice promised (migration 0013).
    const rows = await harness.db
      .select({
        consentKey: consentAcceptances.consentKey,
        noticeVersion: consentAcceptances.noticeVersion,
        retentionMonthsQuoted: consentAcceptances.retentionMonthsQuoted,
      })
      .from(consentAcceptances)
      .where(
        and(eq(consentAcceptances.orgId, ORG_ID), eq(consentAcceptances.userId, consentUserId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consentKey).toBe('attendance.punch_capture');
    expect(rows[0]?.noticeVersion).toBe(1);
    // No org setting installed, so the notice quoted the default 12 months.
    expect(rows[0]?.retentionMonthsQuoted).toBe(12);
  });

  it('replays the key without a second punch or a second acceptance (REQ-D-11)', async () => {
    const before = await countPunches(consentEmployeeId);
    const replay = await punchIn(consentToken, `pt-consent-tick-${runId}`);

    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(await countPunches(consentEmployeeId)).toBe(before);
    expect(await countAcceptances(consentUserId)).toBe(1);
  });

  it('gates the offline queue at sync time, entry by entry', async () => {
    // A queued punch from a build (or a session) that never ticked: refused
    // per entry with the code the client maps to re-showing the notice, and
    // nothing about the batch as a whole fails.
    const refused = await multipart<PunchSyncReport>('/punches/sync', syncToken, {
      photos: [{ field: 'photos', bytes: photoWithExifBytes }],
      payload: {
        punches: [
          {
            idempotencyKey: `pt-consent-sync-no-${runId}`,
            photoIndex: 0,
            latitude: FIXTURE_OFFICE.latitude,
            longitude: FIXTURE_OFFICE.longitude,
            gpsAccuracyM: 8,
            type: 'IN',
            clientTime: isoAgo(5 * 60 * 1000),
          },
        ],
      },
    });

    expect(refused.status).toBe(200);
    expect(refused.body.rejected).toBe(1);
    expect(refused.body.results[0]?.error?.code).toBe('CONSENT_REQUIRED');
    expect(await countAcceptances(syncUserId)).toBe(0);

    // The tick travelled with the queued punch: the sync records the punch
    // and the acceptance together, which is what makes the offline first
    // punch correct rather than fire-and-forget.
    const synced = await multipart<PunchSyncReport>('/punches/sync', syncToken, {
      photos: [{ field: 'photos', bytes: photoWithExifBytes }],
      payload: {
        punches: [
          {
            idempotencyKey: `pt-consent-sync-yes-${runId}`,
            photoIndex: 0,
            latitude: FIXTURE_OFFICE.latitude,
            longitude: FIXTURE_OFFICE.longitude,
            gpsAccuracyM: 8,
            type: 'IN',
            clientTime: isoAgo(5 * 60 * 1000),
            consentAccepted: true,
          },
        ],
      },
    });

    expect(synced.status).toBe(200);
    expect(synced.body.created, JSON.stringify(synced.body.results)).toBe(1);
    expect(await countAcceptances(syncUserId)).toBe(1);
  });
});

describe('reads and scope', () => {
  it('shows an employee only their own feed, and a filter cannot widen it', async () => {
    const own = await harness.get<CursorPaginated<PunchRecord>>('/punches', { token: tokenA });
    expect(own.status).toBe(200);
    expect(own.body.data.length).toBeGreaterThan(0);
    expect(own.body.data.every((punch) => punch.employee.id === employeeAId)).toBe(true);

    const widened = await harness.get<CursorPaginated<PunchRecord>>(
      `/punches?employeeId=${employeeBId}`,
      { token: tokenA },
    );
    expect(widened.status).toBe(200);
    expect(widened.body.data).toEqual([]);
  });

  it('pages the feed by cursor without repeating a row', async () => {
    const first = await harness.get<CursorPaginated<PunchRecord>>('/punches?limit=1', {
      token: hrToken,
    });
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.hasMore).toBe(true);
    expect(first.body.meta.nextCursor).not.toBeNull();

    const second = await harness.get<CursorPaginated<PunchRecord>>(
      `/punches?limit=1&cursor=${first.body.meta.nextCursor ?? ''}`,
      { token: hrToken },
    );
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0]?.id).not.toBe(first.body.data[0]?.id);
  });

  it('answers 404, not 403, for a photo outside the caller`s scope', async () => {
    const denied = await harness.get<ErrorBody>(`/punches/${employeeBPunchId}/photo`, {
      token: tokenA,
    });
    expect(denied.status).toBe(404);

    const allowed = await harness.get<SignedPhotoUrl>(`/punches/${employeeBPunchId}/photo`, {
      token: hrToken,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.expiresInSeconds).toBeLessThanOrEqual(300);
  });

  it('serves the muster as { data, meta } with employee refs (GET /attendance/days)', async () => {
    const page = await harness.get<Paginated<AttendanceDaySummary>>(
      `/attendance/days?from=${today}&to=${today}&employeeId=${employeeAId}`,
      { token: hrToken },
    );

    expect(page.status).toBe(200);
    expect(page.body.meta).toEqual({ page: 1, pageSize: 50, total: 1 });
    const day = page.body.data[0];
    expect(day?.employee).toEqual({ id: employeeAId, name: 'Punya' });
    expect(day?.shift?.name).toBe('Punch Probe Shift (test only)');
    expect(day?.date).toBe(today);
  });

  it('filters the muster by flag', async () => {
    const flagged = await harness.get<Paginated<AttendanceDaySummary>>(
      `/attendance/days?from=${today}&to=${today}&flags=outside_window`,
      { token: hrToken },
    );
    expect(flagged.status).toBe(200);
    expect(flagged.body.data.some((day) => day.employee.id === employeeAId)).toBe(true);
    expect(flagged.body.data.every((day) => day.flags.includes('outside_window'))).toBe(true);
  });

  it('serves one day with its punches, in time order', async () => {
    const detail = await harness.get<AttendanceDayDetail>(
      `/attendance/days/${employeeAId}/${today}`,
      { token: tokenA },
    );

    expect(detail.status).toBe(200);
    expect(detail.body.punches.length).toBeGreaterThanOrEqual(3);
    const times = detail.body.punches.map((punch) => punch.serverTime);
    expect([...times].sort()).toEqual(times);
    // Lists carry the thumbnail id; rendering the full image here is the
    // review failure REQ-D-03a names.
    expect(detail.body.punches.every((punch) => (punch.photo?.thumbnailFileId.length ?? 0) > 0)).toBe(true);
  });

  it('hides another employee`s day behind 404 (IDOR)', async () => {
    const result = await harness.get<ErrorBody>(`/attendance/days/${employeeAId}/${today}`, {
      token: tokenB,
    });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a malformed date before it reaches the driver', async () => {
    const result = await harness.get<ErrorBody>(`/attendance/days/${employeeAId}/12-08-2026`, {
      token: hrToken,
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('answers the punch screen`s pre-punch questions (GET /me/today, REQ-D-13)', async () => {
    const context = await harness.get<PunchContext>('/me/today', { token: tokenA });

    expect(context.status).toBe(200);
    expect(context.body.photoRequired).toBe(true);
    expect(context.body.timezone).toBe(TIMEZONE);
    expect(context.body.attendanceDate).toBe(today);
    expect(new Date(context.body.serverTime).getTime()).toBeGreaterThan(0);
    expect(context.body.employee?.id).toBe(employeeAId);
    expect(context.body.shift?.name).toBe('Punch Probe Shift (test only)');
    // The offline-sync IN left the day open, so the next punch must be OUT.
    expect(context.body.canPunch).toBe(true);
    expect(context.body.nextPunchType).toBe('OUT');
    expect(context.body.lastPunch?.type).toBe('IN');
    expect(context.body.day).not.toBeNull();
    // The geofence is always enforced; the allowlist is not configured yet
    // (OPEN-QUESTIONS 3) and the screen is told so.
    expect(context.body.geofence.enforced).toBe(true);
    expect(context.body.geofence.exempt).toBe(false);
    expect(context.body.ipAllowlist.enforced).toBe(false);
  });

  it('left an audit row for the punches (REQ-M-01)', async () => {
    expect(await harness.waitForAuditAction('punch.created')).toBe(true);
    expect(await harness.waitForAuditAction('punch.replayed')).toBe(true);
    expect(await harness.waitForAuditAction('attendance.day.computed')).toBe(true);
  });
});

describe('immutability (REQ-D-12)', () => {
  // Drizzle reports a failed statement as "Failed query: ..." and files the
  // database's own words under `cause`, so the trigger's message is asserted
  // through `describeError` -- the same flattening production logging uses.
  it('lets nothing update or delete a punch, including this test', async () => {
    const { describeError } = await import('../../../platform/common/errors.js');

    const updateError = await harness.db
      .update(punches)
      .set({ reason: 'edited' })
      .where(eq(punches.id, firstPunchId))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(updateError, 'the update was accepted').not.toBeNull();
    expect(describeError(updateError)).toContain('append-only');

    const deleteError = await harness.db
      .delete(punches)
      .where(eq(punches.id, firstPunchId))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(deleteError, 'the delete was accepted').not.toBeNull();
    expect(describeError(deleteError)).toContain('append-only');
  });
});

describe('fixture hygiene', () => {
  it('created this run`s people fresh, as preservePeople requires', async () => {
    const rows = await harness.db
      .select({ code: employees.employeeCode })
      .from(employees)
      .where(and(eq(employees.orgId, ORG_ID), eq(employees.employeeCode, `PT-A-${runId}`)));
    expect(rows).toHaveLength(1);
  });
});

describe('the geofence is enforced on the server (owner, 21 Aug 2026)', () => {
  beforeAll(async () => {
    // B was left punched in by the half-day test, and ordering is checked
    // before location: close the day so each probe below is judged on where
    // it stands, not on what came before.
    const closed = await punchIn(tokenB, `pt-geo-close-${runId}`, {
      type: 'OUT',
      reason: 'Closing the day before the geofence probes',
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
  });

  it('refuses a punch from outside the radius, and leaves no punch behind', async () => {
    const before = await countPunches(employeeBId);
    const result = await punchIn(tokenB, `pt-geo-out-${runId}`, {
      // About 1.1 km north of the fixture office, with a tight fix.
      latitude: FIXTURE_OFFICE.latitude + 0.01,
      longitude: FIXTURE_OFFICE.longitude,
      gpsAccuracyM: 5,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(result.body.error.code).toBe('PUNCH_OUTSIDE_GEOFENCE');
    expect(result.body.error.message).toMatch(/outside the 100 m punch area/u);
    expect(await countPunches(employeeBId)).toBe(before);
  });

  it('P2-2: the behaviour setting is consulted -- flag, reason, then block again', async () => {
    const setBehaviour = async (value: string) => harness.db.execute(sql`
      INSERT INTO settings (org_id, scope, scope_id, key, value, created_by, updated_by)
      VALUES (${ORG_ID}, 'ORG', NULL, 'attendance.geofence_behaviour', ${JSON.stringify(value)}::jsonb, NULL, NULL)
      ON CONFLICT (org_id, scope, (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)), key) WHERE deleted_at IS NULL
      DO UPDATE SET value = EXCLUDED.value
    `);
    const outside = { latitude: FIXTURE_OFFICE.latitude + 0.01, longitude: FIXTURE_OFFICE.longitude, gpsAccuracyM: 5 };
    try {
      // ALLOW_AND_FLAG: recorded, flagged, Approvals decides -- the
      // out-of-window rule, applied to place.
      await setBehaviour('ALLOW_AND_FLAG');
      const flagged = await punchIn(tokenB, `pt-geo-flag-${runId}`, { ...outside });
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
      expect(flagged.body.punch.flags).toContain('outside_geofence');

      // ALLOW_WITH_REASON: no reason is a 422 asking for one, not a recorded
      // punch; with a reason it records and still wears the flag.
      await setBehaviour('ALLOW_WITH_REASON');
      const asked = await punchIn(tokenB, `pt-geo-noreason-${runId}`, { ...outside, type: 'OUT' });
      expect(asked.status, JSON.stringify(asked.body)).toBe(422);
      expect(asked.body.error.code).toBe('PUNCH_REASON_REQUIRED');
      const reasoned = await punchIn(tokenB, `pt-geo-reason-${runId}`, { ...outside, type: 'OUT', reason: 'Customer visit at Ambad MIDC' });
      expect(reasoned.status, JSON.stringify(reasoned.body)).toBe(201);
      expect(reasoned.body.punch.flags).toContain('outside_geofence');
    } finally {
      await setBehaviour('BLOCK');
    }
    // And with BLOCK restored the refusal is exactly the first test's.
    const refused = await punchIn(tokenB, `pt-geo-block-again-${runId}`, { ...outside });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PUNCH_OUTSIDE_GEOFENCE');
  });

  it('refuses a punch that carries no position at all', async () => {
    const result = await punchIn(tokenB, `pt-geo-none-${runId}`, {
      latitude: undefined,
      longitude: undefined,
      gpsAccuracyM: undefined,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(result.body.error.code).toBe('PUNCH_LOCATION_REQUIRED');
  });

  it('refuses every punch at an office whose coordinates are not set, and says so in the context', async () => {
    await harness.db.execute(
      sql`UPDATE locations SET geofence_lat = NULL, geofence_lng = NULL WHERE org_id = ${ORG_ID}`,
    );
    try {
      const context = await harness.get<PunchContext>('/me/today', { token: tokenB });
      expect(context.body.canPunch).toBe(false);
      expect(context.body.blockedReason?.code).toBe('PUNCH_GEOFENCE_NOT_CONFIGURED');
      const result = await punchIn(tokenB, `pt-geo-unset-${runId}`);
      expect(result.status, JSON.stringify(result.body)).toBe(422);
      expect(result.body.error.code).toBe('PUNCH_GEOFENCE_NOT_CONFIGURED');
    } finally {
      await harness.db.execute(
        sql`UPDATE locations SET geofence_lat = ${FIXTURE_OFFICE.latitude}, geofence_lng = ${FIXTURE_OFFICE.longitude} WHERE org_id = ${ORG_ID}`,
      );
    }
  });

  it('tolerates a fix that is outside by less than its own accuracy, flagged', async () => {
    const result = await punchIn(tokenB, `pt-geo-weak-${runId}`, {
      // About 110 m away with a 60 m accuracy: 110 - 60 < 100, so inside the doubt.
      latitude: FIXTURE_OFFICE.latitude + 0.001,
      longitude: FIXTURE_OFFICE.longitude,
      gpsAccuracyM: 60,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.punch.flags).toContain('low_gps_accuracy');
  });
});

describe('acting on a flagged punch from Approvals (owner, 21 Aug 2026)', () => {
  // An employee of their own, so the only flag on the day is the one being
  // acted on. A's day also carries an offline-sync punch the engine's
  // independent time check flags, which no review of another punch can clear.
  let reviewEmployeeId = '';
  let reviewToken = '';
  let reviewPunchId = '';
  let reviewApprovalId = '';

  beforeAll(async () => {
    reviewEmployeeId = await harness.createEmployee({ code: `PT-E-${runId}`, firstName: 'Esha' });
    const user = await harness.createUser({
      email: scopedEmail('punch-e'),
      roleIds: [employeeRoleId],
      employeeId: reviewEmployeeId,
    });
    await harness.db.insert(shiftAssignments).values({
      orgId: ORG_ID,
      employeeId: reviewEmployeeId,
      shiftId: probeShiftId,
      effectiveFrom: today,
      effectiveTo: today,
    });
    reviewToken = (await harness.login(user.email, user.password)).token;
    const punchedIn = await punchIn(reviewToken, `pt-e-in-${runId}`);
    expect(punchedIn.status, JSON.stringify(punchedIn.body)).toBe(201);
    // The shift runs for hours yet, so this OUT is outside its window: flagged, and raised.
    const punchedOut = await punchIn(reviewToken, `pt-e-out-${runId}`, { type: 'OUT' });
    expect(punchedOut.status, JSON.stringify(punchedOut.body)).toBe(201);
    expect(punchedOut.body.punch.flags).toContain('outside_window');
    expect(punchedOut.body.day?.flags).toContain('outside_window');
    reviewPunchId = punchedOut.body.punch.id;
    const inbox = await harness.get<{ data: { id: string; subjectType: string; subjectId: string }[] }>('/approvals?status=PENDING', { token: hrToken });
    reviewApprovalId = inbox.body.data.find((row) => row.subjectType === 'punch' && row.subjectId === reviewPunchId)?.id ?? '';
    expect(reviewApprovalId).not.toBe('');
  });

  it('refuses a caller who cannot edit attendance', async () => {
    const refused = await harness.post<ErrorBody>(`/punches/${reviewPunchId}/flag-review`, {
      token: reviewToken,
      body: { action: 'ACCEPT' },
    });
    expect(refused.status).toBe(403);
  });

  it('a note closes nothing, and needs its text', async () => {
    const noteless = await harness.post<ErrorBody>(`/punches/${reviewPunchId}/flag-review`, {
      token: hrToken,
      body: { action: 'NOTE' },
    });
    expect(noteless.status).toBe(400);
    const noted = await harness.post<PunchRecord>(`/punches/${reviewPunchId}/flag-review`, {
      token: hrToken,
      body: { action: 'NOTE', note: 'Spoke to them; waiting on the shift roster.' },
    });
    expect(noted.status, JSON.stringify(noted.body)).toBe(200);
    // A note is not a decision: the punch still reads unreviewed.
    expect(noted.body.flagReview).toBeNull();
    const still = await harness.get<{ status: string }>(`/approvals/${reviewApprovalId}`, { token: hrToken });
    expect(still.body.status).toBe('PENDING');
  });

  it('accept clears the flag from the day, settles the approval, and is audited', async () => {
    const accepted = await harness.post<PunchRecord>(`/punches/${reviewPunchId}/flag-review`, {
      token: hrToken,
      body: { action: 'ACCEPT', note: 'Stayed back to finish the dispatch.' },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.flagReview?.action).toBe('ACCEPT');
    expect(accepted.body.flagReview?.decidedBy).not.toBeNull();

    const approval = await harness.get<{ status: string }>(`/approvals/${reviewApprovalId}`, { token: hrToken });
    expect(approval.body.status).toBe('APPROVED');

    const day = await harness.get<AttendanceDayDetail>(`/attendance/days/${reviewEmployeeId}/${today}`, { token: hrToken });
    expect(day.status).toBe(200);
    expect(day.body.flags).not.toContain('outside_window');
    expect(await harness.waitForAuditAction('punch.flag_reviewed')).toBe(true);
  });

  it('an admin records an IN for the employee: a separate event, counted in the day, audited', async () => {
    const at = new Date().toISOString();
    const refused = await harness.post<ErrorBody>('/punches/admin', {
      token: reviewToken,
      body: { employeeId: reviewEmployeeId, type: 'IN', at, reason: 'Forgot to punch in after the site visit.' },
    });
    expect(refused.status).toBe(403);

    const tooShort = await harness.post<ErrorBody>('/punches/admin', {
      token: hrToken,
      body: { employeeId: reviewEmployeeId, type: 'IN', at, reason: 'forgot' },
    });
    expect(tooShort.status).toBe(400);

    const recorded = await harness.post<PunchReceipt>('/punches/admin', {
      token: hrToken,
      body: { employeeId: reviewEmployeeId, type: 'IN', at, reason: 'Forgot to punch in after the site visit.' },
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.punch.source).toBe('ADMIN_ENTRY');
    expect(recorded.body.punch.photo).toBeNull();
    expect(recorded.body.punch.recordedBy).not.toBeNull();
    expect(recorded.body.punch.reason).toContain('site visit');
    // The day counts it: the employee's own IN and OUT are still there beside it.
    const day = await harness.get<AttendanceDayDetail>(`/attendance/days/${reviewEmployeeId}/${today}`, { token: hrToken });
    expect(day.body.punches.map((punch) => punch.source)).toEqual(['MOBILE', 'MOBILE', 'ADMIN_ENTRY']);
    expect(day.body.firstInAt).not.toBeNull();
    // No photograph to serve, and that is a 404 rather than a 500.
    const photo = await harness.get<ErrorBody>(`/punches/${recorded.body.punch.id}/photo`, { token: hrToken });
    expect(photo.status).toBe(404);
    expect(await harness.waitForAuditAction('punch.admin_recorded')).toBe(true);

    // Ordering still holds for an admin: a second IN on an open day is refused.
    const again = await harness.post<ErrorBody>('/punches/admin', {
      token: hrToken,
      body: { employeeId: reviewEmployeeId, type: 'IN', at, reason: 'A second IN that should be refused.' },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PUNCH_OUT_OF_ORDER');
  });

  it('marks a half day through the same override HR already uses', async () => {
    const marked = await harness.post<PunchRecord>(`/punches/${reviewPunchId}/flag-review`, {
      token: hrToken,
      body: { action: 'HALF_DAY', halfDayPart: 'SECOND_HALF', note: 'Left at lunch, counted as a half day.' },
    });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(marked.body.flagReview?.action).toBe('HALF_DAY');
    const day = await harness.get<AttendanceDayDetail>(`/attendance/days/${reviewEmployeeId}/${today}`, { token: hrToken });
    expect(day.body.status).toBe('HALF_DAY');
    expect(day.body.flags).toContain('manual_override');
  });
});


/**
 * Owner, 1 Sep 2026: "once someone is late why do I have to accept it 3, 4 or
 * 5 times, once is fine."
 *
 * A request was opened for every flagged punch, and a person punches several
 * times a day -- so one bad morning put four rows in the inbox about the same
 * morning, and the four answers could disagree. Found in the live database:
 * one employee, one day, four pending FLAGGED_PUNCH requests.
 *
 * The day is what a human decides about, so the day is the unit of the
 * request. Last in the file and with its own employee: it deliberately makes
 * several punches, and the describes above assert on their own days' counts.
 */
describe('one flagged day, one question', () => {
  let token = '';
  const punchIds: string[] = [];

  const pendingForThisEmployee = async (): Promise<number> => {
    const inbox = await harness.get<{ data: { subjectType: string; subjectId: string }[] }>(
      '/approvals?status=PENDING',
      { token: hrToken },
    );
    const mine = new Set(punchIds);
    return inbox.body.data.filter((row) => row.subjectType === 'punch' && mine.has(row.subjectId)).length;
  };

  beforeAll(async () => {
    const employeeId = await harness.createEmployee({ code: `PT-F-${runId}`, firstName: 'Farida' });
    const user = await harness.createUser({
      email: scopedEmail('punch-f'),
      roleIds: [employeeRoleId],
      employeeId,
    });
    await harness.db.insert(shiftAssignments).values({
      orgId: ORG_ID,
      employeeId,
      shiftId: probeShiftId,
      effectiveFrom: today,
      effectiveTo: today,
    });
    token = (await harness.login(user.email, user.password)).token;
  }, 60_000);

  it('opens one request however many punches on the day are flagged', async () => {
    // In is inside the window and unflagged; the shift runs for hours yet, so
    // every OUT is outside it and flagged.
    const first = await punchIn(token, `pt-f-in-${runId}`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    punchIds.push(first.body.punch.id);

    const firstOut = await punchIn(token, `pt-f-out-${runId}`, { type: 'OUT' });
    expect(firstOut.status, JSON.stringify(firstOut.body)).toBe(201);
    expect(firstOut.body.punch.flags).toContain('outside_window');
    punchIds.push(firstOut.body.punch.id);

    expect(await pendingForThisEmployee()).toBe(1);

    const backIn = await punchIn(token, `pt-f-in2-${runId}`);
    expect(backIn.status, JSON.stringify(backIn.body)).toBe(201);
    punchIds.push(backIn.body.punch.id);

    const secondOut = await punchIn(token, `pt-f-out2-${runId}`, { type: 'OUT' });
    expect(secondOut.status, JSON.stringify(secondOut.body)).toBe(201);
    // Flagged exactly like the first, and about the same day.
    expect(secondOut.body.punch.flags).toContain('outside_window');
    punchIds.push(secondOut.body.punch.id);

    expect(await pendingForThisEmployee()).toBe(1);
  });

  it('one accept settles the whole day, and the day stops showing the flag', async () => {
    const flagged = punchIds[1] ?? '';
    const accepted = await harness.post<PunchRecord>(`/punches/${flagged}/flag-review`, {
      token: hrToken,
      body: { action: 'ACCEPT', note: 'Approved for the day' },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    // Nothing of this employee's is left waiting for a second answer.
    expect(await pendingForThisEmployee()).toBe(0);

    // And the day agrees with the decision that was just taken. Settling the
    // inbox alone left it still showing the flag, because the engine clears a
    // flag by reading the reviews and the other punches had none.
    const day = await harness.get<{ flags: string[] }>(
      `/attendance/days/${accepted.body.employee.id}/${accepted.body.attendanceDate}`,
      { token: hrToken },
    );
    expect(day.status, day.text).toBe(200);
    expect(day.body.flags).not.toContain('outside_window');
  });
});
