import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { Pool } from 'pg';
import QRCode from 'qrcode';

import { loadDotEnvFiles } from '../src/platform/common/dotenv.js';
import { openSecret, sealSecret } from '../src/platform/auth/secret-box.js';
import { users } from '../src/platform/db/schema/index.js';

loadDotEnvFiles();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
if (!jwtRefreshSecret) {
  console.error('JWT_REFRESH_SECRET is not set in environment.');
  process.exit(1);
}
const refreshSecret: string = jwtRefreshSecret;

const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

function getTotpIssuer(customIssuer?: string): string {
  if (customIssuer && customIssuer.trim() !== '') return customIssuer.trim();
  if (process.env.NODE_ENV === 'production') return 'Vyuha';
  if (process.env.NODE_ENV === 'staging') return 'Vyuha (Staging)';
  return 'Vyuha (Dev)';
}

function totpFor(secret: Secret, email: string, issuer: string): TOTP {
  return new TOTP({
    issuer,
    label: email,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool);

  try {
    const args = process.argv.slice(2);
    const emailArgIndex = args.indexOf('--email');
    const targetEmail = emailArgIndex !== -1 ? args[emailArgIndex + 1] : undefined;
    const issuerArgIndex = args.indexOf('--issuer');
    const customIssuer = issuerArgIndex !== -1 ? args[issuerArgIndex + 1] : undefined;
    const shouldReset = args.includes('--reset');
    const shouldDisable = args.includes('--disable');

    const issuer = getTotpIssuer(customIssuer);

    if (targetEmail) {
      const existing = await pool.query<{
        id: string;
        email: string;
        status: string;
        totp_secret: string | null;
        totp_confirmed_at: Date | null;
      }>(
        'SELECT id, email, status, totp_secret, totp_confirmed_at FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL',
        [targetEmail],
      );

      const targetUser = existing.rows[0];
      if (targetUser === undefined) {
        console.error(`\nFailed: User with email "${targetEmail}" was not found.\n`);
        process.exit(1);
      }

      if (shouldDisable) {
        await db
          .update(users)
          .set({
            totpSecret: null,
            totpConfirmedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetUser.id));

        console.log(`\nDone: Successfully disabled MFA for ${targetUser.email}\n`);
        return;
      }

      let secret: Secret;
      let isNewSecret = false;

      if (shouldReset || !targetUser.totp_secret) {
        // Generate a fresh 20-byte secret
        secret = new Secret({ size: 20 });
        const sealed = sealSecret(secret.base32, refreshSecret, 'totp');
        await db
          .update(users)
          .set({
            totpSecret: sealed,
            totpConfirmedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetUser.id));
        isNewSecret = true;
      } else {
        try {
          const plainBase32 = openSecret(targetUser.totp_secret, refreshSecret, 'totp');
          secret = Secret.fromBase32(plainBase32);
        } catch (err) {
          console.warn(`Warning: Could not decrypt existing TOTP secret (${(err instanceof Error ? err.message : String(err))}). Generating a fresh secret...`);
          secret = new Secret({ size: 20 });
          const sealed = sealSecret(secret.base32, refreshSecret, 'totp');
          await db
            .update(users)
            .set({
              totpSecret: sealed,
              totpConfirmedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(users.id, targetUser.id));
          isNewSecret = true;
        }
      }

      const totp = totpFor(secret, targetUser.email, issuer);
      const otpauthUri = totp.toString();
      const currentToken = totp.generate();
      const secondsRemaining = TOTP_PERIOD_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_PERIOD_SECONDS);

      // Generate terminal QR Code
      const qrAscii = await QRCode.toString(otpauthUri, {
        type: 'terminal',
        small: true,
      });

      console.log('\n' + '='.repeat(60));
      console.log(` 2FA / TOTP Authenticator Setup for ${targetUser.email}`);
      console.log('='.repeat(60));
      console.log(qrAscii);
      console.log('='.repeat(60));
      console.log(`User Email:      ${targetUser.email}`);
      console.log(`App / Issuer:    ${issuer}`);
      console.log(`Secret Key:      ${secret.base32}  (for manual entry)`);
      console.log(`Current OTP:     ${currentToken}  (valid for ${secondsRemaining}s)`);
      console.log(`State:           ${isNewSecret ? 'New secret generated & activated' : 'Retrieved existing active secret'}`);
      console.log(`OTPAuth URI:     ${otpauthUri}`);
      console.log('='.repeat(60) + '\n');
      console.log('Scan the QR code above with Google Authenticator, Authy, or 1Password.');
      console.log('If your terminal has display issues, use the Secret Key for manual setup.\n');
    } else {
      console.log('\n=== CURRENT USERS IN DATABASE & MFA STATUS ===\n');
      const result = await pool.query(`
        SELECT 
          u.id, 
          u.email, 
          u.status, 
          COALESCE(r.name, 'No Role') as role,
          CASE 
            WHEN u.totp_secret IS NOT NULL AND u.totp_confirmed_at IS NOT NULL THEN 'Enrolled (Active)'
            WHEN u.totp_secret IS NOT NULL AND u.totp_confirmed_at IS NULL THEN 'Enrolled (Pending Confirmation)'
            ELSE ' Disabled'
          END as mfa_status,
          COALESCE(e.first_name || ' ' || e.last_name, 'Not Linked') as employee_name
        FROM users u
        LEFT JOIN user_roles ur ON u.id = ur.user_id
        LEFT JOIN roles r ON ur.role_id = r.id
        LEFT JOIN employees e ON u.employee_id = e.id
        WHERE u.deleted_at IS NULL
        ORDER BY r.name ASC NULLS LAST, u.email ASC;
      `);

      console.table(result.rows);

      console.log(`\nActive Environment: ${process.env.NODE_ENV ?? 'development'} (Issuer: "${issuer}")\n`);
      console.log('Commands to manage MFA:');
      console.log('1. View / retrieve QR code for a user:');
      console.log('pnpm --filter @vyuha/api user:mfa -- --email <email>');
      console.log('pnpm --filter @vyuha/api user:mfa -- --email <email> --issuer "Vyuha Local"\n');
      console.log('2. Reset and generate a new 2FA secret:');
      console.log('pnpm --filter @vyuha/api user:mfa -- --email <email> --reset\n');
      console.log('3. Disable 2FA for a user:');
      console.log('pnpm --filter @vyuha/api user:mfa -- --email <email> --disable\n');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
