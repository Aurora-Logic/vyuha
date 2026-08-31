import type { CookieOptions, Request, Response } from 'express';

import { TRUSTED_DEVICE_DAYS } from '@vyuha/shared';

import { API_PREFIX_PATH } from '../common/constants.js';
import { isProduction } from '../common/env.js';
import { readCookie } from './refresh-cookie.js';

/**
 * REQ-B-09: the browser a person chose to remember after a correct code.
 * Presented with the password on the next sign-in, it stands in for the
 * code for thirty days. It is an opaque token looked up by hash, like the
 * refresh token, and carries the same attributes: httpOnly, strict, scoped
 * to the auth routes. Revocation is a row, not a cookie, so a stolen cookie
 * dies with the row.
 */
export const TRUST_COOKIE_NAME = 'vyuha_trust';

const COOKIE_PATH = `${API_PREFIX_PATH}/auth`;

export function trustCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000,
  };
}

export function setTrustCookie(res: Response, token: string): void {
  res.cookie(TRUST_COOKIE_NAME, token, trustCookieOptions());
}

export function readTrustCookie(req: Request): string | null {
  return readCookie(req, TRUST_COOKIE_NAME);
}
