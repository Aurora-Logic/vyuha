import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { env } from '../common/env.js';

/**
 * The signature on a disk-driver file URL, in one place so the side that
 * mints it and the side that checks it cannot drift apart. They were two
 * copies of the same `createHmac` expression, and a change to either would
 * have invalidated every live link with no test able to say which half was
 * wrong.
 *
 * The key is **derived**, not `JWT_ACCESS_SECRET` itself. Both were the same
 * bytes, which put one secret in two unrelated signing schemes -- a rotation
 * forced for one reason silently invalidates the other, and any future
 * weakness in either becomes a weakness in both. `secret-box.ts` already
 * establishes the pattern this follows: HKDF from the root secret with a
 * purpose string in the info, so the derived key can never collide with any
 * other use of that root. No new environment variable, and nothing to
 * configure at a deployment that is already running.
 *
 * Links are minted with a five-minute TTL, so changing the derivation only
 * ever invalidates links that were about to expire anyway.
 */

const PURPOSE = 'v1:file-url';

function signingKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', env.JWT_ACCESS_SECRET, 'vyuha-file-url', PURPOSE, 32));
}

/** The bytes the signature covers: bucket, key and expiry, in that order. */
function payload(bucket: string, key: string, expires: string): string {
  return `${bucket}:${key}:${expires}`;
}

export function signFileUrl(bucket: string, key: string, expires: string): string {
  return createHmac('sha256', signingKey()).update(payload(bucket, key, expires)).digest('hex');
}

/**
 * Constant-time, and length-checked first because `timingSafeEqual` throws on
 * a length mismatch rather than returning false.
 */
export function verifyFileUrlSignature(
  bucket: string,
  key: string,
  expires: string,
  presented: string,
): boolean {
  const expected = Buffer.from(signFileUrl(bucket, key, expires), 'utf8');
  const offered = Buffer.from(presented, 'utf8');
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}
