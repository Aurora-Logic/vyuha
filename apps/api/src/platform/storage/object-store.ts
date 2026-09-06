import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../common/env.js';
import { describeError } from '../common/errors.js';
import { signFileUrl } from './file-url-signature.js';

/**
 * The object storage layer (NFR-09).
 * Supports local disk storage or S3/MinIO/R2 depending on STORAGE_DRIVER.
 *
 * Two buckets, named rather than passed as strings, because "which bucket"
 * is a security boundary: an export written into the photo bucket would
 * inherit the photo bucket's lifecycle rules and outlive its retention.
 *
 * **No object is ever public.** There is no ACL argument on `put`, no
 * `public-read`, and no method that returns a plain URL. The only way to read
 * an object is `signedUrl`, and the only caller of that is `FileService`,
 * after a permission check.
 */

export const BUCKETS = { PHOTOS: 'photos', EXPORTS: 'exports' } as const;
export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

@Injectable()
export class ObjectStore implements OnApplicationShutdown {
  private readonly logger = new Logger(ObjectStore.name);
  private readonly s3Client: S3Client | null = null;
  private readonly diskBaseDir: string;

  constructor() {
    this.diskBaseDir = path.resolve(process.cwd(), env.STORAGE_DISK_PATH);

    if (env.STORAGE_DRIVER === 's3') {
      this.s3Client = new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      });
      this.logger.log({ msg: 'Object store configured with S3 driver.', endpoint: env.S3_ENDPOINT });
    } else {
      this.logger.log({ msg: 'Object store configured with disk driver.', path: this.diskBaseDir });
    }
  }

  private bucketFor(bucket: BucketName): string {
    return bucket === BUCKETS.PHOTOS ? env.S3_BUCKET_PHOTOS : env.S3_BUCKET_EXPORTS;
  }

  private diskPathFor(bucket: BucketName, key: string): string {
    const safeKey = key.replace(/^\/+/u, '');
    const bucketRoot = path.resolve(this.diskBaseDir, bucket);
    const resolved = path.resolve(bucketRoot, safeKey);
    if (!resolved.startsWith(`${bucketRoot}${path.sep}`)) {
      throw new Error(`Path traversal attempt detected in storage key: ${key}`);
    }
    return resolved;
  }

  async put(
    bucket: BucketName,
    key: string,
    body: Buffer,
    contentType: string,
    checksumSha256Base64: string,
  ): Promise<void> {
    if (this.s3Client) {
      try {
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketFor(bucket),
            Key: key,
            Body: body,
            ContentType: contentType,
            ChecksumSHA256: checksumSha256Base64,
          }),
        );
      } catch (error: unknown) {
        throw new Error(`Could not write object ${bucket}/${key}: ${describeError(error)}`, {
          cause: error,
        });
      }
      return;
    }

    try {
      const destination = this.diskPathFor(bucket, key);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, body);
    } catch (error: unknown) {
      throw new Error(`Could not write disk object ${bucket}/${key}: ${describeError(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Deletes, and treats an already-absent object as success.
   */
  async delete(bucket: BucketName, key: string): Promise<void> {
    if (this.s3Client) {
      try {
        await this.s3Client.send(
          new DeleteObjectCommand({ Bucket: this.bucketFor(bucket), Key: key }),
        );
      } catch (error: unknown) {
        throw new Error(`Could not delete object ${bucket}/${key}: ${describeError(error)}`, {
          cause: error,
        });
      }
      return;
    }

    try {
      const target = this.diskPathFor(bucket, key);
      if (existsSync(target)) {
        await fs.unlink(target);
      }
    } catch (error: unknown) {
      throw new Error(`Could not delete disk object ${bucket}/${key}: ${describeError(error)}`, {
        cause: error,
      });
    }
  }

  async exists(bucket: BucketName, key: string): Promise<boolean> {
    if (this.s3Client) {
      try {
        await this.s3Client.send(
          new HeadObjectCommand({ Bucket: this.bucketFor(bucket), Key: key }),
        );
        return true;
      } catch (error: unknown) {
        if (isNotFound(error)) return false;
        throw new Error(`Could not stat object ${bucket}/${key}: ${describeError(error)}`, {
          cause: error,
        });
      }
    }

    const target = this.diskPathFor(bucket, key);
    return existsSync(target);
  }

  /**
   * A time-limited GET URL.
   */
  async signedUrl(bucket: BucketName, key: string, ttlSeconds: number): Promise<string> {
    if (this.s3Client) {
      return getSignedUrl(
        this.s3Client,
        new GetObjectCommand({ Bucket: this.bucketFor(bucket), Key: key }),
        { expiresIn: ttlSeconds },
      );
    }

    const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
    const signature = signFileUrl(bucket, key, expires);

    const encodedPath = key.split('/').map(encodeURIComponent).join('/');
    return `${env.API_BASE_URL}/api/v1/files/raw/${bucket}/${encodedPath}?expires=${expires}&signature=${signature}`;
  }

  onApplicationShutdown(): void {
    if (this.s3Client) {
      this.s3Client.destroy();
      this.logger.log({ msg: 'S3 object store client closed.' });
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (named.name === 'NotFound' || named.name === 'NoSuchKey') return true;
  return named.$metadata?.httpStatusCode === 404;
}
