import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Controller, Get, Logger, Param, Query, Req, Res } from '@nestjs/common';
import { ERROR_CODES } from '@vyuha/shared';
import type { Request, Response } from 'express';

import { env } from '../common/env.js';
import { AppError, describeError, statusForCode, toErrorBody } from '../common/errors.js';
import { REQUEST_ID_HEADER, requestIdOf } from '../common/request-id.js';
import { Public } from '../rbac/route-policy.js';
import { verifyFileUrlSignature } from '../storage/file-url-signature.js';
import { BUCKETS } from '../storage/object-store.js';

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Serves disk-stored files using signed URLs.
 *
 * Only mounted under `STORAGE_DRIVER=disk` (see `FileModule`): under `s3` the
 * signed URL points at object storage and nothing ever mints a link to this
 * route, so registering it there would be an unauthenticated door onto the
 * filesystem that no configured deployment has a use for.
 *
 * The signature is the whole credential -- there is no principal on a
 * `@Public()` route -- so it is verified before anything touches the disk,
 * through the same module that mints it (`file-url-signature.ts`).
 */
@Controller('files')
export class RawFilesController {
  private readonly logger = new Logger(RawFilesController.name);

  @Get('raw/:bucket/*path')
  @Public()
  async serveFile(
    @Param('bucket') bucket: string,
    // Express 5's named wildcard (`*path`) captures the remaining segments as
    // an array, each already URL-decoded -- unlike Express 4's `*`, which gave
    // a single raw string under the numeric key `req.params['0']`.
    @Param('path') pathSegments: string[],
    @Query('expires') expiresStr: string | undefined,
    @Query('signature') signature: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (bucket !== BUCKETS.PHOTOS && bucket !== BUCKETS.EXPORTS) {
      throw AppError.forbidden('Invalid storage bucket.');
    }

    if (!expiresStr || !signature) {
      throw AppError.forbidden('Missing signature or expiration in file URL.');
    }

    const expires = Number(expiresStr);
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) {
      throw AppError.forbidden('This file link has expired.');
    }

    const key = (pathSegments ?? []).join('/');

    if (!verifyFileUrlSignature(bucket, key, expiresStr, signature)) {
      throw AppError.forbidden('Invalid file signature.');
    }

    /*
     * The signature already spoke for the key, so this is defence in depth
     * rather than the control -- but it is written to hold on its own.
     *
     * The comparison is against the *bucket* directory and includes the
     * separator. Against the base alone, `../exports/x` under the photos
     * bucket resolved inside the base and passed; without the separator,
     * a sibling directory whose name merely starts with the base's --
     * `/var/app/storage-backup` beside `/var/app/storage` -- passed too.
     */
    const bucketDir = path.resolve(process.cwd(), env.STORAGE_DISK_PATH, bucket);
    const resolvedPath = path.resolve(bucketDir, key.replace(/^\/+/u, ''));

    if (resolvedPath !== bucketDir && !resolvedPath.startsWith(bucketDir + path.sep)) {
      throw AppError.forbidden('Invalid path traversal detected.');
    }

    // `stat` rather than `existsSync`: synchronous filesystem calls block the
    // event loop for every other request in flight, and the answer was stale
    // the moment it returned anyway -- the retention sweep unlinks objects,
    // so the open below is the only check that means anything.
    let size: number;
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) throw AppError.notFound('File', key);
      size = stat.size;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.notFound('File', key);
    }

    res.setHeader('Content-Type', mimeForPath(resolvedPath));
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'private, max-age=300');

    const stream = createReadStream(resolvedPath);

    /*
     * An unhandled `error` on a read stream is not a failed request -- it is
     * an uncaught exception, and this process installs no handler for one, so
     * it ends the API for everybody. It is reachable without an attacker:
     * `FileService.purgeExpiredFiles` unlinks objects, and a sweep landing
     * between the `stat` above and the open here is an ordinary Tuesday.
     *
     * Nest's exception filter cannot see this -- the handler has already
     * returned by the time it fires -- so the refusal is written out here in
     * the same envelope the filter would have produced.
     */
    stream.on('error', (error: unknown) => {
      this.logger.warn({
        msg: 'Read stream failed while serving a file',
        bucket,
        key,
        err: describeError(error),
      });
      if (res.headersSent) {
        // Bytes are already on the wire; a second status line would corrupt
        // the response, so the truncated body is all the client can be told.
        res.destroy();
        return;
      }
      const requestId = requestIdOf(req);
      // The success headers were staged before the stream opened, and Express
      // only sets a Content-Type when none is present -- so without this the
      // JSON refusal goes out typed `image/jpeg` and, worse, carries the
      // `max-age=300` meant for the image: the browser and any shared proxy
      // then cache the error against that signed URL for five minutes.
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(REQUEST_ID_HEADER, requestId);
      res
        .status(statusForCode(ERROR_CODES.NOT_FOUND))
        .json(toErrorBody(ERROR_CODES.NOT_FOUND, 'That file is no longer available.', requestId));
    });

    // A client that navigates away mid-download leaves the descriptor open
    // otherwise, and a few thousand of those is the process's file limit.
    res.on('close', () => {
      stream.destroy();
    });

    stream.pipe(res);
  }
}
