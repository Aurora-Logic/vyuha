import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@vyuha/shared';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

import { checkViolationConstraint, constraintMessage, isCheckViolation, isPoolConnectionTimeout } from '../db/pg-error.js';
import { AppError, describeError, toErrorBody } from './errors.js';
import { captureUnexpectedError } from './error-monitoring.js';
import { redactUrl } from './redact-url.js';
import { REQUEST_ID_HEADER, requestIdOf } from './request-id.js';

/**
 * The single exit for every error (technical design §6). Nothing else in the
 * codebase writes an error response body.
 *
 * The rule that shapes this file: a client learns only what we chose to tell
 * it. An `AppError` was written for the client and is passed through; anything
 * else is a bug, and its message is logged in full but replaced in the
 * response, because unexpected errors carry connection strings, SQL, and file
 * paths.
 */

/**
 * Statuses raised by the framework itself — a 404 for an unmatched route, a
 * 413 from the body parser. Mapped to codes so the client sees the same
 * envelope it does for a deliberate error.
 */
const CODE_BY_HTTP_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.TOKEN_INVALID,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  413: ERROR_CODES.VALIDATION_FAILED,
  415: ERROR_CODES.VALIDATION_FAILED,
  422: ERROR_CODES.VALIDATION_FAILED,
  429: ERROR_CODES.RATE_LIMITED,
};

interface Resolved {
  status: number;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown> | undefined;
  /** False for anything the client was not meant to see. */
  expected: boolean;
  /**
   * A dependency refused to serve this request. Neither a caller's mistake nor
   * a bug in this code, so the client is told precisely what happened and the
   * driver's own words are still logged in full -- that is the difference
   * between "the pool is saturated" and "the database is gone".
   */
  dependency?: boolean;
}

const GENERIC_INTERNAL_MESSAGE =
  'Something went wrong on our side. Quote the request id if you report this.';

/**
 * How long a client is told to wait after a dependency failure. Deliberately
 * short: the pool frees up as soon as the queries holding it finish, and the
 * punch outbox (REQ-D-10) re-sends on its own triggers regardless.
 */
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

/** `HttpException.getStatus()` returns a plain number, not the HttpStatus enum. */
const SERVER_ERROR_FLOOR = 500;

/**
 * Zod is installed in both `apps/api` and `packages/shared`. pnpm dedupes them
 * today, but a version drift would give two constructors and `instanceof`
 * would start returning false for errors thrown by shared schemas — silently
 * turning every validation failure into a 500. The structural check costs
 * nothing and cannot drift.
 */
function isZodError(value: unknown): value is ZodError {
  if (value instanceof ZodError) return true;
  if (!(value instanceof Error) || value.name !== 'ZodError') return false;
  return 'issues' in value && Array.isArray(value.issues);
}

function zodFieldDetails(error: ZodError): Record<string, unknown> {
  return {
    fields: error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  };
}

/** Nest packs its exception payload as a string or an object of unknown shape. */
function messageFromHttpException(exception: HttpException): string {
  const response: unknown = exception.getResponse();
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message: unknown = response.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return exception.message;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = requestIdOf(req);

    const resolved = this.resolve(exception);
    this.log(exception, resolved, req);
    if (!resolved.expected && resolved.status >= SERVER_ERROR_FLOOR) {
      captureUnexpectedError(exception, requestId, resolved.status, resolved.code);
    }

    if (res.headersSent) {
      // Express has already flushed a status line; writing a second body would
      // corrupt the response. The log line above is the only record left.
      return;
    }

    const body = toErrorBody(resolved.code, resolved.message, requestId, resolved.details);

    res.setHeader(REQUEST_ID_HEADER, requestId);
    // Every error that carries a retry hint in its details states it as a
    // header too, so a client that never parses the body -- a browser, a
    // proxy, a service worker -- still learns it may try again. The details
    // stay: they are what the screen shows a person.
    const retryAfter = resolved.details?.retryAfterSeconds;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
    }
    res.status(resolved.status).json(body);
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
        expected: true,
      };
    }

    // Ahead of the generic fallback and after `AppError`, which is a decision
    // already made. A saturated connection pool is the one database failure a
    // caller can act on, and answering it 500 tells a punching client the
    // opposite of the truth: the offline outbox holds a punch and re-sends it
    // when a request comes back unanswered, and abandons it on a refusal.
    if (isPoolConnectionTimeout(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
        message: 'The service is busy right now. Try again in a moment.',
        details: { retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS },
        expected: true,
        dependency: true,
      };
    }

    // A CHECK constraint is a rule the database keeps; tripping it means the
    // screen was behind the data, which is a conflict the person can resolve
    // by looking again, not a fault of ours. The module that owns the rule
    // supplies the sentence; an unregistered one still answers 409.
    if (isCheckViolation(exception)) {
      const constraint = checkViolationConstraint(exception);
      const known = constraint === null ? null : constraintMessage(constraint);
      return {
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.CONFLICT,
        message: known ?? 'The change breaks a rule the records keep. Refresh and look again.',
        details: constraint === null ? undefined : { constraint },
        expected: true,
      };
    }

    if (isZodError(exception)) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'One or more fields are invalid.',
        details: zodFieldDetails(exception),
        expected: true,
      };
    }

    if (isEntityTooLarge(exception)) {
      // body-parser's refusal, thrown before any guard or handler runs. It
      // is not a Nest HttpException, so it used to fall through to a 500 --
      // which also means the old 15 MB limit was never hit in a test (H-02).
      return {
        status: 413,
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'The request body is larger than this route accepts.',
        details: undefined,
        expected: true,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // A 5xx HttpException is still a server fault, so it is treated like an
      // unknown error: generic message out, full detail to the log.
      if (status >= SERVER_ERROR_FLOOR) {
        return {
          status,
          code: ERROR_CODES.INTERNAL_ERROR,
          message: GENERIC_INTERNAL_MESSAGE,
          details: undefined,
          expected: false,
        };
      }
      return {
        status,
        code: CODE_BY_HTTP_STATUS[status] ?? ERROR_CODES.VALIDATION_FAILED,
        message: messageFromHttpException(exception),
        details: undefined,
        expected: true,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: GENERIC_INTERNAL_MESSAGE,
      details: undefined,
      expected: false,
    };
  }

  /**
   * The message travels inside the object as `msg` rather than as a second
   * argument. Nest's `Logger` appends its own context to the argument list and
   * nestjs-pino reads the last argument as that context, so a positional
   * message would be swallowed and the log line would arrive empty.
   */
  private log(exception: unknown, resolved: Resolved, req: Request): void {
    const where = `${req.method ?? 'UNKNOWN'} ${redactUrl(req.originalUrl ?? req.url ?? '')}`;
    // No `requestId` here: pino-http already binds it to the request's child
    // logger, and repeating it emits the key twice in one JSON object.
    const base = { status: resolved.status, code: resolved.code, where };

    if (!resolved.expected || resolved.dependency === true) {
      this.logger.error({
        ...base,
        msg:
          resolved.dependency === true
            ? `Dependency failure on ${where}`
            : `Unhandled error on ${where}`,
        // Everything withheld from the client, kept here in full. Without it
        // the generic response message would make the bug unfindable.
        //
        // `reason` is the flattened one-liner and `err` the raw error: pino's
        // serializer produces the better stack and cause chain from the real
        // object, but its output for an AggregateError depends on the version,
        // and the reason must not depend on that.
        reason: describeError(exception),
        ...(exception instanceof Error
          ? { err: exception }
          : { thrown: serialiseNonError(exception) }),
      });
      return;
    }

    this.logger.warn({ ...base, msg: `${resolved.code} on ${where}` });
  }
}

/**
 * JavaScript lets any value be thrown, and a string or a plain object reaches
 * the filter with no stack at all. Recording its type alongside its contents is
 * usually the only clue to where it came from.
 */
function serialiseNonError(value: unknown): Record<string, unknown> {
  return { thrown: typeof value, value: safeStringify(value) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular or BigInt-bearing payload must not take down the error path
    // that exists to report other failures.
    return '[unserialisable]';
  }
}

/** body-parser marks the oversize case by `type`; the status alone is not enough to know it was ours. */
function isEntityTooLarge(exception: unknown): boolean {
  return typeof exception === 'object' && exception !== null && (exception as { type?: unknown }).type === 'entity.too.large';
}
