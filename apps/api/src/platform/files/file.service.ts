import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, isUuid, uuidv7, type FilePurpose } from '@vyuha/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { env } from '../common/env.js';
import { AppError, describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { fileCleanupTasks, files } from '../db/schema/index.js';
import { ScopedRepository } from '../db/scoped-repository.js';
import type { Principal } from '../rbac/principal.js';
import { orgContextOf } from '../rbac/principal.js';
import { BUCKETS, ObjectStore, type BucketName } from '../storage/object-store.js';
import { mayReadFile, requiredPermissionsFor } from './file-access.policy.js';
import { sanitizeImage } from './image-sanitizer.js';
import { sniffDocument } from './magic-bytes.js';

/**
 * Technical design §7 and NFR-09. Everything that puts bytes into object
 * storage goes through here, and the invariants are enforced in this file
 * rather than asked of the caller:
 *
 * 1. The type is decided by the bytes, not by the client (`magic-bytes.ts`).
 * 2. Images are decoded and re-encoded, so nothing a client supplied is ever
 *    stored verbatim and EXIF cannot survive (`image-sanitizer.ts`).
 * 3. A row in `files` records the key, media type, size, checksum, and
 *    purpose, so an object with no provenance is a detectable anomaly.
 * 4. Reads happen only through a short-lived signed URL, issued after a
 *    permission check (`file-access.policy.ts`).
 */

/** Technical design §7: "Reject uploads over 3MB". */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const PHOTO_JPEG_QUALITY = 82;

/**
 * The longest edge kept for each kind of file.
 *
 * REQ-D-03a: the client already downscales a punch photo to 1280, and this is
 * the server's backstop; the 256px thumbnail is the same requirement's "used
 * everywhere except the full-size viewer". REQ-L-01's logo is rendered small
 * in a page header.
 *
 * A `Record<FilePurpose, ...>` so a new purpose cannot be added without
 * deciding how large its images may be.
 */
const MAX_EDGE_BY_PURPOSE: Record<FilePurpose, number> = {
  PUNCH_PHOTO: 1280,
  PUNCH_PHOTO_THUMB: 256,
  ATTACHMENT: 1280,
  ORG_LOGO: 256,
  EXPORT: 1280,
  IMPORT: 1280,
  // An LR photograph must stay legible: the widest edge a phone camera gives is kept.
  DISPATCH_PHOTO: 1600,
  // A drawing or a site photograph on a deal: legible when opened full size.
  CRM_ATTACHMENT: 1600,
  // The same thing on a task, for the same reason.
  TASK_ATTACHMENT: 1600,
};

const BUCKET_BY_PURPOSE: Record<FilePurpose, BucketName> = {
  PUNCH_PHOTO: BUCKETS.PHOTOS,
  PUNCH_PHOTO_THUMB: BUCKETS.PHOTOS,
  ATTACHMENT: BUCKETS.PHOTOS,
  ORG_LOGO: BUCKETS.PHOTOS,
  EXPORT: BUCKETS.EXPORTS,
  IMPORT: BUCKETS.EXPORTS,
  DISPATCH_PHOTO: BUCKETS.PHOTOS,
  CRM_ATTACHMENT: BUCKETS.PHOTOS,
  TASK_ATTACHMENT: BUCKETS.PHOTOS,
};

/** The leading path segment, so a bucket listing is readable by a human. */
const PREFIX_BY_PURPOSE: Record<FilePurpose, string> = {
  PUNCH_PHOTO: 'photos',
  PUNCH_PHOTO_THUMB: 'thumbs',
  ATTACHMENT: 'attachments',
  ORG_LOGO: 'logos',
  EXPORT: 'exports',
  IMPORT: 'imports',
  DISPATCH_PHOTO: 'dispatches',
  CRM_ATTACHMENT: 'crm',
  TASK_ATTACHMENT: 'tasks',
};

export interface StoreImageInput {
  readonly orgId: string;
  /** Null for a system-generated file; the audit trail names the actor. */
  readonly uploadedBy: string | null;
  readonly purpose: FilePurpose;
  readonly bytes: Buffer;
  /**
   * Extra key segments, e.g. the employee id and punch id from §7. Each must
   * be a UUID -- a caller-supplied string in a storage key is a path traversal
   * waiting to be written, and there is no legitimate non-id segment.
   */
  readonly pathSegments?: readonly string[];
  /** REQ-L-03: when the retention job may remove this. */
  readonly expiresAt?: Date | null;
  /**
   * A storage budget in bytes. The image is re-encoded at falling quality
   * until it fits (REQ-D-03a's 80-150 KB band for a punch photo). Omitted, the
   * image is encoded once at the standard quality.
   */
  readonly maxBytes?: number;
}

/**
 * A file this server generated, rather than one a client uploaded.
 *
 * Separate from `StoreImageInput` because the guarantee is different in both
 * directions. An upload is untrusted and is decoded and re-encoded before it
 * is stored; a generated file is bytes this process just produced and must be
 * stored verbatim -- a CSV put through the image sanitiser is not a CSV. The
 * purpose is narrowed to the two server-authored kinds so no upload path can
 * reach this method and skip the sanitiser by naming a different purpose.
 */
export interface StoreUploadInput {
  readonly orgId: string;
  readonly uploadedBy: string;
  /**
   * Narrowed on purpose: this is the one entry point that stores bytes a
   * person chose, so every purpose that uses it is a deliberate decision
   * rather than a default. A deal's attachment and a task's are both files
   * somebody picked off their own machine (REQ-U-05, REQ-V-12).
   */
  readonly purpose: Extract<FilePurpose, 'CRM_ATTACHMENT' | 'TASK_ATTACHMENT'>;
  readonly bytes: Buffer;
  /** The browser's filename: evidence for which Office type, never for whether. */
  readonly filename: string;
  readonly pathSegments?: readonly string[];
}

export interface StoreDocumentInput {
  readonly orgId: string;
  /** The user the file was produced for; null for a system-wide artefact. */
  readonly createdBy: string | null;
  readonly purpose: Extract<FilePurpose, 'EXPORT' | 'IMPORT'>;
  readonly bytes: Buffer;
  readonly mime: string;
  /** Key suffix only; the browser filename is the caller's business. */
  readonly extension: string;
  /** REQ-L-03 and REQ-J-03: when the retention job may remove this. */
  readonly expiresAt?: Date | null;
}

export interface StoredFile {
  readonly id: string;
  readonly storageKey: string;
  readonly mime: string;
  readonly bytes: number;
  readonly checksum: string;
  readonly purpose: FilePurpose;
}

/**
 * A caller writing the file reference in its own transaction passes that
 * executor and defers finalisation until the transaction has committed.
 */
export interface FileWriteOptions {
  readonly executor?: Database;
  readonly deferFinalization?: boolean;
}

export interface SignedFileUrl {
  readonly url: string;
  readonly expiresInSeconds: number;
}

export interface PurgeResult {
  readonly scanned: number;
  readonly purged: number;
  /** Rows whose object had already gone; the row is still closed out. */
  readonly alreadyAbsent: number;
  /** Still due when the run stopped: nought means the backlog was cleared. */
  readonly remaining: number;
}

export interface FileCleanupResult {
  readonly scanned: number;
  readonly removed: number;
  readonly protected: number;
  readonly failed: number;
  readonly remaining: number;
}

/** One batch keeps a backlog from holding a transaction open for hours. */
const PURGE_BATCH_SIZE = 500;

/**
 * The most one run will purge before stopping and saying what is left.
 *
 * The run used to be a single batch. REQ-L-03 promises photographs are gone
 * after the retention window, and the job runs weekly -- so an organisation
 * expiring more than five hundred files a week never caught up, the backlog
 * grew for ever, and nothing said so. It drains now, in batches, and reports
 * what it could not reach rather than stopping quietly.
 */
const PURGE_RUN_LIMIT = 50_000;

/** Long enough that a live 3 MB request cannot race its own recovery task. */
const WRITE_CLEANUP_GRACE_MS = 15 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 500;

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly objects: ObjectStore,
    private readonly auditContext: AuditContext,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- write

  async storeImage(
    input: StoreImageInput,
    options: FileWriteOptions = {},
  ): Promise<StoredFile> {
    if (input.bytes.length === 0) {
      throw new AppError(ERROR_CODES.PUNCH_PHOTO_REQUIRED, 'No image was uploaded.');
    }
    if (input.bytes.length > MAX_UPLOAD_BYTES) {
      throw new AppError(
        ERROR_CODES.PUNCH_PHOTO_INVALID,
        `That image is larger than ${String(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        { details: { bytes: input.bytes.length, limit: MAX_UPLOAD_BYTES } },
      );
    }

    const wantsPng = input.purpose === 'ORG_LOGO';
    const sanitized = await sanitizeImage(input.bytes, {
      format: wantsPng ? 'png' : 'jpeg',
      maxEdge: MAX_EDGE_BY_PURPOSE[input.purpose],
      quality: PHOTO_JPEG_QUALITY,
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    });

    // Belt and braces against a future edit to the sanitiser that adds a
    // pass-through branch. Storing the client's bytes is the one thing this
    // service exists to prevent, so it is asserted rather than assumed.
    if (sanitized.bytes.equals(input.bytes)) {
      throw new Error(
        'The sanitiser returned the input buffer unchanged; client bytes must never be stored.',
      );
    }

    const fileId = uuidv7();
    const digest = createHash('sha256').update(sanitized.bytes).digest();
    const storageKey = this.buildKey(input, fileId, sanitized.extension);
    const bucket = BUCKET_BY_PURPOSE[input.purpose];

    await this.stageCleanup(input.orgId, input.purpose, storageKey);
    try {
      await this.objects.put(
        bucket,
        storageKey,
        sanitized.bytes,
        sanitized.mime,
        digest.toString('base64'),
      );

      const inserted = await (options.executor ?? this.db)
        .insert(files)
        .values({
          id: fileId,
          orgId: input.orgId,
          storageKey,
          mime: sanitized.mime,
          bytes: sanitized.bytes.length,
          checksum: digest.toString('hex'),
          purpose: input.purpose,
          uploadedBy: input.uploadedBy,
          expiresAt: input.expiresAt ?? null,
          createdBy: input.uploadedBy,
          updatedBy: input.uploadedBy,
        })
        .returning({ id: files.id });
      if (inserted[0] === undefined) {
        throw new Error(`File row insert returned nothing for object ${storageKey}.`);
      }
    } catch (error) {
      await this.abandonObject(input.purpose, storageKey, error);
      throw error;
    }

    if (!options.deferFinalization) await this.finalizeObject(input.purpose, storageKey);

    // Enrichment, not a write: the interceptor turns this into a row on the
    // request that uploaded the file. Outside a request it is a silent no-op,
    // which is correct -- a job that generates a file audits its own run.
    this.auditContext.record({
      orgId: input.orgId,
      action: 'file.stored',
      entityType: 'file',
      entityId: fileId,
      after: {
        purpose: input.purpose,
        mime: sanitized.mime,
        bytes: sanitized.bytes.length,
        storageKey,
        // Recorded because "what did they upload" and "what did we keep" are
        // different questions during an incident.
        sourceMime: sanitized.sourceType.mime,
        sourceBytes: input.bytes.length,
      },
    });

    return {
      id: fileId,
      storageKey,
      mime: sanitized.mime,
      bytes: sanitized.bytes.length,
      checksum: digest.toString('hex'),
      purpose: input.purpose,
    };
  }

  /**
   * A document a person uploaded (REQ-U-05, owner 31 Aug 2026).
   *
   * Deliberately not `storeDocument`, which fixes the type from the caller
   * because there the caller is this process. Here the bytes came off the
   * wire, so they are sniffed: a PDF by its header, an Office file by the
   * OOXML marker inside the ZIP. Anything else is refused by content, and
   * the browser's filename only ever decides which Office type it is, never
   * whether the thing is acceptable. Images do not come here -- they go
   * through `storeImage`, which re-encodes them.
   */
  async storeUpload(
    input: StoreUploadInput,
    options: FileWriteOptions = {},
  ): Promise<StoredFile> {
    if (input.bytes.length === 0) {
      throw AppError.validation('No file was uploaded.');
    }
    if (input.bytes.length > MAX_UPLOAD_BYTES) {
      throw AppError.validation(
        `That file is larger than ${String(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        { fields: [{ path: 'file', message: 'too large' }] },
      );
    }
    const document = sniffDocument(input.bytes, input.filename);
    if (document === null) {
      throw AppError.validation('That file is not a PDF, an Office document or an image this product stores.');
    }

    const fileId = uuidv7();
    const digest = createHash('sha256').update(input.bytes).digest();
    const storageKey = this.buildKey(
      { orgId: input.orgId, purpose: input.purpose, pathSegments: input.pathSegments },
      fileId,
      document.extension,
    );

    await this.stageCleanup(input.orgId, input.purpose, storageKey);
    try {
      await this.objects.put(
        BUCKET_BY_PURPOSE[input.purpose],
        storageKey,
        input.bytes,
        document.mime,
        digest.toString('base64'),
      );

      const inserted = await (options.executor ?? this.db)
        .insert(files)
        .values({
          id: fileId,
          orgId: input.orgId,
          storageKey,
          mime: document.mime,
          bytes: input.bytes.length,
          checksum: digest.toString('hex'),
          purpose: input.purpose,
          uploadedBy: input.uploadedBy,
          createdBy: input.uploadedBy,
          updatedBy: input.uploadedBy,
        })
        .returning({ id: files.id });
      if (inserted[0] === undefined) {
        throw new Error(`File row insert returned nothing for object ${storageKey}.`);
      }
    } catch (error) {
      await this.abandonObject(input.purpose, storageKey, error);
      throw error;
    }
    if (!options.deferFinalization) await this.finalizeObject(input.purpose, storageKey);

    return {
      id: fileId,
      storageKey,
      mime: document.mime,
      bytes: input.bytes.length,
      checksum: digest.toString('hex'),
      purpose: input.purpose,
    };
  }

  /**
   * Stores bytes this server produced, unaltered.
   *
   * The three invariants at the top of this file still hold, with one
   * substitution: the type is fixed by the caller rather than sniffed from the
   * bytes, because the caller is this process and the alternative is asking
   * `magic-bytes` to recognise CSV, which has no magic bytes and never will.
   * Provenance, checksum and signed-URL-only access are unchanged, and so is
   * the retention column that REQ-J-03's seven days rides on.
   */
  async storeDocument(
    input: StoreDocumentInput,
    options: FileWriteOptions = {},
  ): Promise<StoredFile> {
    if (input.bytes.length === 0) {
      throw new Error('Refusing to store an empty document.');
    }

    const fileId = uuidv7();
    const digest = createHash('sha256').update(input.bytes).digest();
    const storageKey = this.buildKey(
      { orgId: input.orgId, purpose: input.purpose },
      fileId,
      input.extension,
    );

    await this.stageCleanup(input.orgId, input.purpose, storageKey);
    try {
      await this.objects.put(
        BUCKET_BY_PURPOSE[input.purpose],
        storageKey,
        input.bytes,
        input.mime,
        digest.toString('base64'),
      );

      const inserted = await (options.executor ?? this.db)
        .insert(files)
        .values({
          id: fileId,
          orgId: input.orgId,
          storageKey,
          mime: input.mime,
          bytes: input.bytes.length,
          checksum: digest.toString('hex'),
          purpose: input.purpose,
          // The requester, so `mayReadFile`'s uploader rule lets them read back
          // the file they asked for even if their permissions narrow afterwards.
          uploadedBy: input.createdBy,
          expiresAt: input.expiresAt ?? null,
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })
        .returning({ id: files.id });

      if (inserted[0] === undefined) {
        throw new Error(`File row insert returned nothing for object ${storageKey}.`);
      }
    } catch (error) {
      await this.abandonObject(input.purpose, storageKey, error);
      throw error;
    }
    if (!options.deferFinalization) await this.finalizeObject(input.purpose, storageKey);

    // No `auditContext.record` here: this runs in a job, where there is no
    // request to enrich. The job writes its own audit row (REQ-J-06).
    this.logger.log({
      msg: 'Document stored',
      fileId,
      purpose: input.purpose,
      bytes: input.bytes.length,
      expiresAt: input.expiresAt?.toISOString() ?? null,
    });

    return {
      id: fileId,
      storageKey,
      mime: input.mime,
      bytes: input.bytes.length,
      checksum: digest.toString('hex'),
      purpose: input.purpose,
    };
  }

  private buildKey(
    input: { orgId: string; purpose: FilePurpose; pathSegments?: readonly string[] },
    fileId: string,
    extension: string,
  ): string {
    for (const segment of input.pathSegments ?? []) {
      if (!isUuid(segment)) {
        throw new Error(`Storage key segment "${segment}" is not an id; refusing to build a key.`);
      }
    }

    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    return [
      PREFIX_BY_PURPOSE[input.purpose],
      input.orgId,
      year,
      month,
      ...(input.pathSegments ?? []),
      `${fileId}.${extension}`,
    ].join('/');
  }

  /**
   * Commits recovery metadata before object storage is touched. The task is
   * intentionally written through the service database even when the file row
   * will be part of a caller transaction: a rollback must not erase the only
   * record of the object it left behind.
   */
  private async stageCleanup(
    orgId: string,
    purpose: FilePurpose,
    storageKey: string,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(fileCleanupTasks)
      .values({
        orgId,
        purpose,
        storageKey,
        runAfter: new Date(now.getTime() + WRITE_CLEANUP_GRACE_MS),
      })
      .onConflictDoUpdate({
        target: [fileCleanupTasks.purpose, fileCleanupTasks.storageKey],
        set: {
          orgId,
          runAfter: new Date(now.getTime() + WRITE_CLEANUP_GRACE_MS),
          lastError: null,
          updatedAt: now,
        },
      });
  }

  /**
   * A committed outer transaction calls this for its file ids. Failure is not
   * surfaced as a false failure after commit: a leftover task is safe, because
   * the worker proves the metadata row still exists before deleting anything.
   */
  async finalizeStoredFiles(fileIds: readonly string[]): Promise<void> {
    if (fileIds.length === 0) return;
    try {
      const committed = await this.db
        .select({ purpose: files.purpose, storageKey: files.storageKey })
        .from(files)
        .where(inArray(files.id, [...fileIds]));
      for (const file of committed) await this.finalizeObject(file.purpose, file.storageKey);
    } catch (error: unknown) {
      this.logger.warn({
        msg: 'Stored file recovery intents could not be finalised; cleanup will recheck them.',
        fileIds,
        reason: describeError(error),
      });
    }
  }

  private async finalizeObject(purpose: FilePurpose, storageKey: string): Promise<void> {
    try {
      await this.db
        .delete(fileCleanupTasks)
        .where(
          and(
            eq(fileCleanupTasks.purpose, purpose),
            eq(fileCleanupTasks.storageKey, storageKey),
          ),
        );
    } catch (error: unknown) {
      this.logger.warn({
        msg: 'File recovery intent remains after metadata committed; cleanup will recheck it.',
        purpose,
        storageKey,
        reason: describeError(error),
      });
    }
  }

  /** Makes the pre-write task immediately eligible, then attempts it once. */
  private async abandonObject(
    purpose: FilePurpose,
    storageKey: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.db
        .update(fileCleanupTasks)
        .set({ runAfter: new Date(), lastError: describeError(cause).slice(0, 500), updatedAt: new Date() })
        .where(
          and(
            eq(fileCleanupTasks.purpose, purpose),
            eq(fileCleanupTasks.storageKey, storageKey),
          ),
        );
    } catch (error: unknown) {
      this.logger.error({
        msg: 'Could not make a failed file write immediately eligible for cleanup.',
        purpose,
        storageKey,
        writeError: describeError(cause),
        recoveryError: describeError(error),
      });
    }

    await this.cleanupOne({ purpose, storageKey }).catch((error: unknown) => {
      // `cleanupOne` has already preserved/incremented the durable task where
      // possible. The original storage failure remains the caller's error.
      this.logger.error({
        msg: 'Immediate object compensation failed; durable cleanup will retry it.',
        purpose,
        storageKey,
        writeError: describeError(cause),
        cleanupError: describeError(error),
      });
    });
  }

  /**
   * Marks a file as due for the retention sweep.
   *
   * For the case where a record stops pointing at an object -- REQ-L-01's logo
   * being replaced or removed -- and the object would otherwise sit in the
   * bucket forever with nothing referencing it. Deleting it here instead would
   * mean a failed transaction on the caller's side left a live row pointing at
   * a key that no longer exists; handing it to `purgeExpiredFiles` keeps
   * deletion in the one place that is idempotent and audited.
   *
   * Returns false when the id is not this organisation's, which the caller may
   * ignore: a logo key that names nothing is already the state being aimed at.
   */
  async expireFile(orgId: string, fileId: string, at: Date = new Date()): Promise<boolean> {
    if (!isUuid(fileId)) return false;

    const repository = new ScopedRepository(this.db, files, { orgId, actorUserId: null });
    const file = await repository.findById(fileId);
    if (file === null || file.purgedAt !== null) return false;

    // Never pushes an expiry further out. A file already due is left due --
    // the point is to bring an unreferenced object into the sweep, not to
    // renegotiate a retention window somebody else set (REQ-L-03).
    if (file.expiresAt !== null && file.expiresAt.getTime() <= at.getTime()) return true;

    await this.db
      .update(files)
      .set({ expiresAt: at, updatedAt: at })
      .where(and(eq(files.id, fileId), eq(files.orgId, orgId), isNull(files.purgedAt)));

    this.logger.log({ msg: 'File marked for purge', fileId, orgId, purpose: file.purpose });
    return true;
  }

  // ----------------------------------------------------------------- read

  /**
   * NFR-09. Throws NOT_FOUND for another organisation's file -- the repository
   * never sees it -- and FORBIDDEN when the purpose demands a permission the
   * caller does not hold.
   *
   * `ttlSecondsOverride` can only *shorten* the link. A caller asking for a
   * day gets `S3_SIGNED_URL_TTL_SECONDS`, because a signed URL that outlives
   * its purpose is a public URL with extra steps.
   */
  async signedUrlFor(
    principal: Principal,
    fileId: string,
    ttlSecondsOverride?: number,
  ): Promise<SignedFileUrl> {
    const repository = new ScopedRepository(this.db, files, orgContextOf(principal));
    const file = await repository.findById(fileId);

    if (file === null || file.purgedAt !== null) throw AppError.notFound('File', fileId);

    if (!mayReadFile(principal, file)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'You do not have permission to view that file.', {
        details: { requiredAnyOf: [...requiredPermissionsFor(file.purpose)] },
      });
    }

    if (file.expiresAt !== null && file.expiresAt.getTime() <= Date.now()) {
      // Past retention but not yet swept. Handing out a link would serve a
      // photo the employee was told had been deleted (REQ-L-03).
      throw AppError.notFound('File', fileId);
    }

    const ttlSeconds = Math.min(
      ttlSecondsOverride ?? env.S3_SIGNED_URL_TTL_SECONDS,
      env.S3_SIGNED_URL_TTL_SECONDS,
    );

    const url = await this.objects.signedUrl(
      BUCKET_BY_PURPOSE[file.purpose],
      file.storageKey,
      ttlSeconds,
    );

    // Logged, not audited. A muster page issues one of these per row, so a
    // table write here would put five hundred rows into `audit_logs` for a
    // single report render and bury REQ-M-01's actual content. The log line
    // carries the same facts for an investigation.
    this.logger.log({
      msg: 'Signed URL issued',
      fileId,
      purpose: file.purpose,
      actorUserId: principal.userId,
      ttlSeconds,
    });

    return { url, expiresInSeconds: ttlSeconds };
  }

  /**
   * A signed link for a file the caller names, restricted to one purpose.
   *
   * `mayReadFile` is a breadth check by purpose and says so in as many words:
   * row-level scope is the caller's job. Every other caller does that work --
   * the punch service loads the punch through the principal's scope and 404s
   * one outside it before signing. A route that takes a bare file id and signs
   * whatever comes back skips it, so a manager holding
   * `attendance.view.team` could read any punch photograph in the
   * organisation given its id, not merely their own team's.
   *
   * Naming the purpose is what makes that impossible for routes that serve
   * one kind of file: the logo route signs logos, and a punch photo id
   * offered to it is simply not found.
   */
  async signedUrlForPurpose(principal: Principal, fileId: string, purpose: FilePurpose): Promise<SignedFileUrl> {
    const repository = new ScopedRepository(this.db, files, orgContextOf(principal));
    const file = await repository.findById(fileId);
    if (file === null || file.purpose !== purpose) throw AppError.notFound('File', fileId);
    return this.signedUrlFor(principal, fileId);
  }

  /**
   * 15 REQ-AL-08: a short-lived link for a reader who has no principal.
   *
   * The customer portal has no user and no permissions, so `signedUrlFor`'s
   * check cannot apply. Two things stand in its place, and both are here
   * rather than at the call site so that a second caller cannot forget them:
   * the file must belong to the named organisation, and its purpose must be
   * a dispatch photograph. The *ownership* check — that this file hangs off
   * a dispatch of the reader's own party — belongs to `PortalRepository`,
   * which is the only thing that knows which party is reading; this method
   * refuses to be the place that decides it, and the caller passes a file id
   * it has already proved.
   *
   * The link is the standard short expiry. A durable object-storage URL is
   * never handed out, which is the whole of REQ-AL-08.
   */
  async signedUrlForPortal(orgId: string, fileId: string): Promise<SignedFileUrl> {
    const rows = await this.db.execute<{ storage_key: string; purpose: FilePurpose; expires_at: Date | string | null; purged_at: Date | string | null }>(
      sql`SELECT storage_key, purpose, expires_at, purged_at FROM files WHERE id = ${fileId} AND org_id = ${orgId} AND deleted_at IS NULL`,
    );
    const file = rows.rows[0];
    if (file === undefined || file.purged_at !== null) throw AppError.notFound('File', fileId);
    if (file.purpose !== 'DISPATCH_PHOTO') throw AppError.notFound('File', fileId);
    if (file.expires_at !== null && new Date(file.expires_at).getTime() <= Date.now()) throw AppError.notFound('File', fileId);

    const ttlSeconds = env.S3_SIGNED_URL_TTL_SECONDS;
    const url = await this.objects.signedUrl(BUCKET_BY_PURPOSE[file.purpose], file.storage_key, ttlSeconds);
    this.logger.log({ msg: 'Signed URL issued to a portal reader', fileId, purpose: file.purpose, orgId, ttlSeconds });
    return { url, expiresInSeconds: ttlSeconds };
  }

  // ------------------------------------------------------------- retention

  /**
   * Retries object removals whose database half could not complete. A live
   * metadata row always wins: it proves the write committed, so only the stale
   * recovery task is removed. Without that recheck, a crash after the file row
   * committed but before its task was cleared could turn recovery into data
   * loss.
   */
  async cleanupPendingObjects(now: Date = new Date()): Promise<FileCleanupResult> {
    const due = await this.db
      .select({ purpose: fileCleanupTasks.purpose, storageKey: fileCleanupTasks.storageKey })
      .from(fileCleanupTasks)
      .where(lte(fileCleanupTasks.runAfter, now))
      .orderBy(asc(fileCleanupTasks.runAfter))
      .limit(CLEANUP_BATCH_SIZE);

    let removed = 0;
    let protectedCount = 0;
    let failed = 0;
    for (const task of due) {
      try {
        const result = await this.cleanupOne(task);
        if (result === 'removed') removed += 1;
        else protectedCount += 1;
      } catch {
        failed += 1;
      }
    }

    const remainingRows = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(fileCleanupTasks)
      .where(lte(fileCleanupTasks.runAfter, now));
    const remaining = remainingRows[0]?.value ?? 0;

    if (due.length > 0 || remaining > 0) {
      this.logger.log({
        msg: 'Pending file-object cleanup processed',
        scanned: due.length,
        removed,
        protected: protectedCount,
        failed,
        remaining,
      });
    }
    return { scanned: due.length, removed, protected: protectedCount, failed, remaining };
  }

  private async cleanupOne(task: {
    readonly purpose: FilePurpose;
    readonly storageKey: string;
  }): Promise<'removed' | 'protected'> {
    const metadata = await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.purpose, task.purpose), eq(files.storageKey, task.storageKey)))
      .limit(1);

    if (metadata.length > 0) {
      await this.db
        .delete(fileCleanupTasks)
        .where(
          and(
            eq(fileCleanupTasks.purpose, task.purpose),
            eq(fileCleanupTasks.storageKey, task.storageKey),
          ),
        );
      return 'protected';
    }

    try {
      await this.objects.delete(BUCKET_BY_PURPOSE[task.purpose], task.storageKey);
      await this.db
        .delete(fileCleanupTasks)
        .where(
          and(
            eq(fileCleanupTasks.purpose, task.purpose),
            eq(fileCleanupTasks.storageKey, task.storageKey),
          ),
        );
      return 'removed';
    } catch (error: unknown) {
      try {
        await this.db
          .update(fileCleanupTasks)
          .set({
            attempts: sql`${fileCleanupTasks.attempts} + 1`,
            lastError: describeError(error).slice(0, 500),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(fileCleanupTasks.purpose, task.purpose),
              eq(fileCleanupTasks.storageKey, task.storageKey),
            ),
          );
      } catch (recordError: unknown) {
        this.logger.error({
          msg: 'Could not record a failed object cleanup attempt.',
          purpose: task.purpose,
          storageKey: task.storageKey,
          cleanupError: describeError(error),
          recordError: describeError(recordError),
        });
      }
      this.logger.error({
        msg: 'Could not remove an orphaned object; its durable cleanup task remains.',
        purpose: task.purpose,
        storageKey: task.storageKey,
        reason: describeError(error),
      });
      throw error;
    }
  }

  /**
   * REQ-L-03: "A retention job purges photos older than the configured window
   * and nulls `photo_file_id`, leaving the punch record intact." The second
   * half belongs to Phase 1, which owns `punches`; this half deletes the
   * object and closes out the row.
   *
   * Idempotent by construction, not by convention. The selection predicate is
   * `purged_at IS NULL`, and the very last thing done to a row is to set it,
   * so a second run selects nothing. A crash halfway leaves the rows it did
   * not reach still selectable, which is exactly what re-running should fix.
   */
  async purgeExpiredFiles(now: Date = new Date()): Promise<PurgeResult> {
    let scanned = 0;
    let purged = 0;
    let alreadyAbsent = 0;
    for (;;) {
      const batch = await this.purgeBatch(now);
      scanned += batch.scanned;
      purged += batch.purged;
      alreadyAbsent += batch.alreadyAbsent;
      // A batch that purged nothing cannot be improved by running it again:
      // every row it saw either failed against the object store or was taken
      // by another run, and both stay selectable for next time.
      if (batch.purged === 0 || batch.scanned < PURGE_BATCH_SIZE || purged >= PURGE_RUN_LIMIT) break;
    }
    const remaining = await this.countDue(now);
    if (purged > 0 || remaining > 0) {
      this.logger.log({ msg: 'Expired files purged', scanned, purged, alreadyAbsent, remaining });
    }
    return { scanned, purged, alreadyAbsent, remaining };
  }

  /** Files past their retention window that no run has closed out yet. */
  private async countDue(now: Date): Promise<number> {
    const rows = await this.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM files WHERE expires_at IS NOT NULL AND expires_at <= ${now} AND purged_at IS NULL`,
    );
    return rows.rows[0]?.count ?? 0;
  }

  private async purgeBatch(now: Date): Promise<PurgeResult> {
    const due = await this.db
      .select({
        id: files.id,
        orgId: files.orgId,
        storageKey: files.storageKey,
        purpose: files.purpose,
      })
      .from(files)
      .where(
        and(isNotNull(files.expiresAt), lte(files.expiresAt, now), isNull(files.purgedAt)),
      )
      .orderBy(asc(files.expiresAt))
      .limit(PURGE_BATCH_SIZE);

    let purged = 0;
    let alreadyAbsent = 0;
    const purgedByOrg = new Map<string, number>();

    for (const file of due) {
      const bucket = BUCKET_BY_PURPOSE[file.purpose];

      let present: boolean;
      try {
        present = await this.objects.exists(bucket, file.storageKey);
        await this.objects.delete(bucket, file.storageKey);
      } catch (error: unknown) {
        // One unreachable object must not abandon the rest of the batch, and
        // the row stays selectable so the next run retries it.
        this.logger.error({
          msg: 'Could not remove an expired object; the file row is left for the next run.',
          fileId: file.id,
          storageKey: file.storageKey,
          reason: describeError(error),
        });
        continue;
      }

      if (!present) alreadyAbsent += 1;

      await this.db
        .update(files)
        .set({ purgedAt: now, updatedAt: now })
        .where(and(eq(files.id, file.id), isNull(files.purgedAt)));

      purged += 1;
      purgedByOrg.set(file.orgId, (purgedByOrg.get(file.orgId) ?? 0) + 1);
    }

    // Written directly rather than through `AuditContext`: there is no request
    // here, and REQ-M-01 wants the deletion of employee photographs in the
    // trail regardless of what triggered it.
    for (const [orgId, count] of purgedByOrg) {
      await this.audit.write({
        orgId,
        actorUserId: null,
        action: 'file.purged',
        entityType: 'file',
        after: { purged: count, reason: 'retention', at: now.toISOString() },
      });
    }

    return { scanned: due.length, purged, alreadyAbsent, remaining: 0 };
  }

  /**
   * Removes files that were stored for something that then did not happen.
   *
   * The punch path is why this exists. A punch stores its photo and thumbnail
   * before it can know whether it will win the ordering lock, so the loser of
   * a race -- and the losing half of a concurrent retry of one idempotency key
   * -- ends up holding two objects and two rows that no punch will ever
   * reference. Leaving them is not merely untidy: `purgeExpiredFiles` sweeps
   * `files`, so an object whose row is gone is unreachable forever, and a row
   * that survives is an employee's photograph kept for the whole retention
   * window for a punch that was never recorded, which is the opposite of what
   * REQ-M-03's notice promises.
   *
   * The row goes first and the object second, deliberately. `punches` points
   * at `files` with RESTRICT, so a caller that passes an id something *does*
   * reference gets a foreign-key error here with the object still in place,
   * rather than a punch whose evidence has been deleted underneath it.
   */
  async discardUnreferenced(orgId: string, fileIds: readonly string[]): Promise<number> {
    if (fileIds.length === 0) return 0;

    const removed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(files)
        .where(and(eq(files.orgId, orgId), inArray(files.id, [...fileIds])))
        .returning({ id: files.id, storageKey: files.storageKey, purpose: files.purpose });

      if (rows.length > 0) {
        await tx
          .insert(fileCleanupTasks)
          .values(
            rows.map((file) => ({
              orgId,
              purpose: file.purpose,
              storageKey: file.storageKey,
              runAfter: new Date(),
            })),
          )
          .onConflictDoUpdate({
            target: [fileCleanupTasks.purpose, fileCleanupTasks.storageKey],
            set: { runAfter: new Date(), lastError: null, updatedAt: new Date() },
          });
      }
      return rows;
    });

    for (const file of removed) {
      try {
        await this.cleanupOne(file);
      } catch (error: unknown) {
        // The durable task remains. This path is commonly already handling a
        // failed/replayed business operation, so object-store downtime must
        // not turn its original answer into a different one.
        this.logger.warn({
          msg: 'Discarded file is awaiting a later object-cleanup retry.',
          fileId: file.id,
          storageKey: file.storageKey,
          reason: describeError(error),
        });
      }
    }

    if (removed.length > 0) {
      this.auditContext.record({
        orgId,
        action: 'file.discarded',
        entityType: 'file',
        entityId: removed[0]?.id ?? null,
        before: { fileIds: removed.map((file) => file.id) },
      });
    }

    return removed.length;
  }

  /** How many rows a purge run would take. Used by the job monitor and tests. */
  async countDueForPurge(now: Date = new Date()): Promise<number> {
    const rows = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(files)
      .where(and(isNotNull(files.expiresAt), lte(files.expiresAt, now), isNull(files.purgedAt)));
    return rows[0]?.value ?? 0;
  }
}
