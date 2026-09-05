import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Sealing for credentials Vyuha must be able to read back: webhook/TOTP
 * secrets and short-lived refresh replay entries. Other credentials are stored
 * as a keyed hash because the *client* presents it and Vyuha only compares
 * (`opaque-token.ts`). A webhook is the other way round — OpsTally presents
 * an HMAC over the body, and Vyuha must recompute it, which needs the secret
 * itself. Purpose-separated sealing is deliberately reversible where needed.
 *
 * AES-256-GCM under a key derived with HKDF from the app's refresh secret —
 * the same root the opaque-token HMACs already trust — with a purpose string
 * in the info, so this key can never be the same bytes as any other use of
 * that secret. No new environment variable, no key file: a leaked database
 * on its own yields nothing usable, and rotating JWT_REFRESH_SECRET is the
 * documented way to rotate everything derived from it (re-enter the webhook
 * secrets afterwards; they cannot be re-derived, which is the point).
 *
 * Wire form: base64url( iv[12] || tag[16] || ciphertext ), prefixed with a
 * version so a future algorithm change can read old rows.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFor(rootSecret: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', rootSecret, 'vyuha-secret-box', `${VERSION}:${purpose}`, 32),
  );
}

export function sealSecret(plain: string, rootSecret: string, purpose: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFor(rootSecret, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

/** Throws on tamper or a wrong root secret — GCM refuses, it does not garble. */
export function openSecret(sealed: string, rootSecret: string, purpose: string): string {
  const [version, body] = sealed.split('.');
  if (version !== VERSION || body === undefined) {
    throw new Error(`Sealed secret has an unknown format (${version ?? 'empty'}).`);
  }
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed secret is truncated.');
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keyFor(rootSecret, purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
