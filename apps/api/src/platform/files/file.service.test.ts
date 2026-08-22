import { createHash } from 'node:crypto';

import { PERMISSIONS, uuidv7 } from '@vyuha/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { principalFixture } from '../../test-support/principal-fixture.js';
import { env } from '../common/env.js';
import { AppError } from '../common/errors.js';
import { files } from '../db/schema/index.js';
import { FileService } from './file.service.js';

/**
 * Against real MinIO. Nothing is stubbed, because every claim this suite makes
 * is a claim about the storage server's behaviour rather than about our code:
 * that an object is not readable without a signature, that a signature stops
 * working when it expires, and that what came back out is byte-identical to
 * what the checksum recorded. A fake object store would answer all three the
 * way we wrote it to.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000f1';

let harness: ApiHarness;
let service: FileService;
let uploaderId: string;
let managerId: string;

/** A real JPEG carrying GPS EXIF, which is what a phone actually uploads. */
async function photoWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .withExif({
      IFD0: { Make: 'ProbePhone', Model: 'X1', Software: 'probe' },
      IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    })
    .jpeg()
    .toBuffer();
}

const createdFileIds: string[] = [];

async function store(purpose: 'PUNCH_PHOTO' | 'ORG_LOGO', bytes: Buffer, expiresAt?: Date) {
  const stored = await service.storeImage({
    orgId: ORG_ID,
    uploadedBy: uploaderId,
    purpose,
    bytes,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  createdFileIds.push(stored.id);
  return stored;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Vyuha File Service Test');
  service = harness.resolve(FileService);

  const uploader = await harness.createUser({ email: scopedEmail('file.uploader') });
  const manager = await harness.createUser({ email: scopedEmail('file.manager') });
  uploaderId = uploader.id;
  managerId = manager.id;
}, 60_000);

afterAll(async () => {
  if (createdFileIds.length > 0) {
    await harness.db.delete(files).where(inArray(files.id, createdFileIds));
  }
  await harness.close();
});

describe('storing an image', () => {
  it('refuses a payload whose bytes are not an image, whatever it is called', async () => {
    const disguised = Buffer.concat([
      Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary'),
      Buffer.alloc(2048, 0x41),
    ]);

    // The service is never told a filename or a content type, and that is the
    // point: there is no field a client could set to change this outcome.
    await expect(
      service.storeImage({
        orgId: ORG_ID,
        uploadedBy: uploaderId,
        purpose: 'PUNCH_PHOTO',
        bytes: disguised,
      }),
    ).rejects.toMatchObject({ code: 'PUNCH_PHOTO_INVALID' });
  });

  it('refuses a payload that begins as a JPEG but is not one', async () => {
    // Correct magic bytes, no image behind them. Only the decoder catches it.
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 0x41)]);

    await expect(
      service.storeImage({
        orgId: ORG_ID,
        uploadedBy: uploaderId,
        purpose: 'PUNCH_PHOTO',
        bytes: fake,
      }),
    ).rejects.toMatchObject({ code: 'PUNCH_PHOTO_INVALID' });
  });

  /**
   * The load-bearing test for the magic-byte whitelist, and the reason it is
   * written with formats sharp is perfectly happy to decode.
   *
   * A PDF or a truncated JPEG is refused by the decoder whether or not the
   * whitelist exists, so neither of those cases can tell the two controls
   * apart -- deleting the whitelist entirely left every other test in this
   * file passing. A real GIF and a real WebP are valid images that sharp would
   * cheerfully re-encode into a JPEG, so the *only* thing that can refuse them
   * is the decision in `magic-bytes.ts` about which formats are accepted
   * (technical design §7: JPEG and PNG).
   */
  it.each([
    ['GIF', async () => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).gif().toBuffer()],
    ['WebP', async () => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp().toBuffer()],
    ['TIFF', async () => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).tiff().toBuffer()],
  ])('refuses a decodable %s, which only the format whitelist can catch', async (_label, make) => {
    const image = await make();

    // Proves the premise: sharp can read it, so a rejection cannot be the
    // decoder giving up.
    await expect(sharp(image).metadata()).resolves.toBeDefined();

    await expect(
      service.storeImage({
        orgId: ORG_ID,
        uploadedBy: uploaderId,
        purpose: 'PUNCH_PHOTO',
        bytes: image,
      }),
    ).rejects.toMatchObject({ code: 'PUNCH_PHOTO_INVALID' });
  });

  it('refuses an image over the 3 MB cap', async () => {
    const huge = await sharp({
      create: { width: 4000, height: 4000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(huge.length).toBeGreaterThan(3 * 1024 * 1024);

    await expect(
      service.storeImage({
        orgId: ORG_ID,
        uploadedBy: uploaderId,
        purpose: 'PUNCH_PHOTO',
        bytes: huge,
      }),
    ).rejects.toMatchObject({ code: 'PUNCH_PHOTO_INVALID' });
  });

  it('writes a row whose checksum matches the bytes actually in the bucket', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());

    const rows = await harness.db.select().from(files).where(eq(files.id, stored.id));
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.mime).toBe('image/jpeg');
    expect(row?.purpose).toBe('PUNCH_PHOTO');
    expect(row?.bytes).toBe(stored.bytes);
    expect(row?.storageKey).toContain(`/${ORG_ID}/`);

    const principal = principalFixture({ userId: uploaderId, orgId: ORG_ID });
    const { url } = await service.signedUrlFor(principal, stored.id);
    const response = await fetch(url);
    expect(response.status).toBe(200);

    const fetched = Buffer.from(await response.arrayBuffer());
    // The recorded checksum is of the stored object, so this is the assertion
    // that would catch a service that hashed the input and stored the output.
    expect(createHash('sha256').update(fetched).digest('hex')).toBe(row?.checksum);
    expect(fetched.length).toBe(row?.bytes);
  });

  it('never stores the bytes the client supplied, and strips EXIF doing it', async () => {
    const input = await photoWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const stored = await store('PUNCH_PHOTO', input);
    const principal = principalFixture({ userId: uploaderId, orgId: ORG_ID });
    const { url } = await service.signedUrlFor(principal, stored.id);
    const output = Buffer.from(await (await fetch(url)).arrayBuffer());

    expect(output.equals(input)).toBe(false);
    const metadata = await sharp(output).metadata();
    expect(metadata.exif).toBeUndefined();
    // Downscaled to the REQ-D-03a long edge, which also proves the pixels went
    // through a decode rather than a metadata edit.
    expect(metadata.width).toBe(1280);
  });
});

describe('signed URLs', () => {
  it('refuses an unsigned request for the same object', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());

    const rows = await harness.db
      .select({ storageKey: files.storageKey })
      .from(files)
      .where(eq(files.id, stored.id));
    const key = rows[0]?.storageKey ?? '';
    expect(key.length).toBeGreaterThan(0);

    const unsigned = `${env.S3_ENDPOINT}/${env.S3_BUCKET_PHOTOS}/${key}`;
    const response = await fetch(unsigned);

    // Not "not 200": a 404 would also not be 200 and would mean the object was
    // never written, which would make this test pass for the wrong reason.
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('AccessDenied');

    // ...and the very same key is readable once signed, which is what proves
    // the 403 above was about the signature and not about the key.
    const principal = principalFixture({ userId: uploaderId, orgId: ORG_ID });
    const { url } = await service.signedUrlFor(principal, stored.id);
    expect((await fetch(url)).status).toBe(200);
  });

  it('stops working once the link expires', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());
    const principal = principalFixture({ userId: uploaderId, orgId: ORG_ID });

    const { url, expiresInSeconds } = await service.signedUrlFor(principal, stored.id, 1);
    expect(expiresInSeconds).toBe(1);
    expect((await fetch(url)).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const afterExpiry = await fetch(url);
    expect(afterExpiry.status).toBe(403);
    // The specific message, not just the 403. An unsigned request is also a
    // 403, so asserting the status alone would pass even if the signature had
    // been dropped from the URL entirely and expiry were never enforced.
    expect(await afterExpiry.text()).toContain('Request has expired');
  }, 20_000);

  it('clamps a caller asking for a longer link than the configured maximum', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());
    const principal = principalFixture({ userId: uploaderId, orgId: ORG_ID });

    const { expiresInSeconds } = await service.signedUrlFor(principal, stored.id, 86_400);
    expect(expiresInSeconds).toBe(env.S3_SIGNED_URL_TTL_SECONDS);
  });
});

describe('permission to read', () => {
  it('refuses a punch photo to someone holding only their own attendance view', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());
    const nosy = principalFixture({
      userId: managerId,
      orgId: ORG_ID,
      permissions: [PERMISSIONS.ATTENDANCE_VIEW_SELF, PERMISSIONS.PUNCH_SELF],
    });

    await expect(service.signedUrlFor(nosy, stored.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows it to someone who can see the team', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());
    const supervisor = principalFixture({
      userId: managerId,
      orgId: ORG_ID,
      permissions: [PERMISSIONS.ATTENDANCE_VIEW_TEAM],
    });

    await expect(service.signedUrlFor(supervisor, stored.id)).resolves.toMatchObject({
      expiresInSeconds: env.S3_SIGNED_URL_TTL_SECONDS,
    });
  });

  it('allows the uploader their own file with no permission at all', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());
    const self = principalFixture({ userId: uploaderId, orgId: ORG_ID });
    await expect(service.signedUrlFor(self, stored.id)).resolves.toBeDefined();
  });

  it('does not find a file belonging to another organisation', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif());
    const outsider = principalFixture({
      userId: uploaderId,
      orgId: uuidv7(),
      permissions: [PERMISSIONS.ATTENDANCE_VIEW_ALL],
    });

    // NOT_FOUND rather than FORBIDDEN: a refusal would confirm the id exists.
    await expect(service.signedUrlFor(outsider, stored.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('will not sign a file that is past its retention date but not yet swept', async () => {
    const stored = await store('PUNCH_PHOTO', await photoWithExif(), new Date(Date.now() - 1_000));
    const self = principalFixture({ userId: uploaderId, orgId: ORG_ID });

    const error = await service.signedUrlFor(self, stored.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('NOT_FOUND');
  });
});

describe('the retention sweep (audit 5)', () => {
  /**
   * REQ-L-03 promises photographs are gone after the retention window, and
   * the sweep runs weekly. It purged one batch of five hundred and stopped,
   * so an organisation expiring more than that in a week never caught up and
   * nothing said so -- the backlog simply grew.
   *
   * Rows are written straight into `files` with keys that were never stored:
   * the object store answers "absent" for each, which is exactly the path a
   * photograph already removed by hand takes, and it keeps the fixture to one
   * statement rather than five hundred uploads.
   */
  it('drains past a single batch and reports nothing left behind', async () => {
    const marker = `purge-drain-${uuidv7()}`;
    await harness.db.execute(sql`
      INSERT INTO files (org_id, storage_key, mime, bytes, checksum, purpose, uploaded_by, expires_at)
      SELECT ${ORG_ID}, ${marker} || '/' || g::text, 'image/webp', 10, repeat('0', 64), 'DISPATCH_PHOTO', ${uploaderId}, now() - interval '1 day'
        FROM generate_series(1, 501) AS g
    `);

    const result = await service.purgeExpiredFiles();
    expect(result.purged).toBeGreaterThanOrEqual(501);
    // Nothing waiting for next week: the run kept going until the query was
    // empty. One batch would have left one row behind.
    expect(result.remaining).toBe(0);

    const left = await harness.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM files WHERE storage_key LIKE ${`${marker}/%`} AND purged_at IS NULL
    `);
    expect(left.rows[0]?.count).toBe(0);

    await harness.db.execute(sql`DELETE FROM files WHERE storage_key LIKE ${`${marker}/%`}`);
  }, 120_000);
});
