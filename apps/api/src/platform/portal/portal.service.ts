import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  PORTAL_KEY_DAYS,
  type IssuePortalKeyInput,
  type IssuedPortalKey,
  type PortalKeyState,
  type PortalKeyView,
  type PortalView,
} from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { LoginRateLimiter } from '../auth/login-rate-limit.service.js';
import { AuditContext } from '../audit/audit-context.js';
import { env } from '../common/env.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { FileService } from '../files/file.service.js';
import { hasPermission, type Principal } from '../rbac/principal.js';
import { PortalRepository } from './portal.repository.js';

/**
 * Area AL. The portal shows nothing new; what is new is that somebody with
 * no account can see it, so everything here is about the key.
 *
 * The key is 32 random bytes, base64url, stored only as a SHA-256 hash
 * (REQ-AL-03: "random and non-sequential", and a key list must not be a
 * key). Resolution reads the row on every request rather than caching it,
 * because REQ-AL-07 wants a withdrawal to take effect now.
 *
 * Every arrival is logged with what was viewed and from where (REQ-AL-06),
 * including the refusals: a run of them from one address is the signal the
 * log exists for, and it is also what the throttle counts (REQ-AL-05).
 */

const KEY_BYTES = 32;

/**
 * REQ-AL-05's other half. The address throttle is the standard one and
 * catches a spray of invalid keys; this catches the other shape of abuse,
 * which is one *valid* link that has been forwarded or scraped. It is
 * counted from the access log the requirement already asks for rather than
 * from a second store.
 *
 * Generous on purpose: a portal view plus a signed link for every
 * photograph on a dispatch is a dozen requests, and a customer refreshing
 * while a lorry is being loaded is not an attacker. Four hundred an hour is
 * roughly one every nine seconds, sustained, which no person does.
 */
const KEY_VIEWS_PER_HOUR = 400;

/** A shape the reader is never given: which of the four ways a key failed. */
type Resolution = { readonly ok: true; readonly keyId: string; readonly orgId: string; readonly partyId: string; readonly expiresAt: Date } | { readonly ok: false };

export interface PortalRequestContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly files: FileService,
    private readonly limiter: LoginRateLimiter,
  ) {}

  // ------------------------------------------------------------------ staff side

  /**
   * REQ-AL-01/AL-03: one link per party, ninety days by default (D-53).
   * Issuing again while one is live is not an error — it is how a link is
   * rotated — but the old one is withdrawn in the same transaction, so a
   * party never has two live keys and nobody has to remember to kill one.
   */
  async issue(principal: Principal, input: IssuePortalKeyInput): Promise<IssuedPortalKey> {
    this.requireManage(principal);
    const party = await this.db.execute<{ name: string }>(sql`
      SELECT name FROM parties WHERE org_id = ${principal.orgId} AND id = ${input.partyId}
    `);
    if (party.rows[0] === undefined) throw AppError.notFound('Party', input.partyId);

    const key = randomBytes(KEY_BYTES).toString('base64url');
    const days = input.days ?? PORTAL_KEY_DAYS;
    const id = await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE portal_link_keys SET revoked_at = now(), revoked_by = ${principal.userId}, revoke_reason = 'Replaced by a new link', updated_at = now(), updated_by = ${principal.userId}
         WHERE org_id = ${principal.orgId} AND party_id = ${input.partyId} AND revoked_at IS NULL AND deleted_at IS NULL
      `);
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO portal_link_keys (org_id, party_id, key_hash, issued_by, expires_at, note, created_by, updated_by)
        VALUES (${principal.orgId}, ${input.partyId}, ${hashOf(key)}, ${principal.userId}, now() + ${`${String(days)} days`}::interval, ${input.note ?? null}, ${principal.userId}, ${principal.userId})
        RETURNING id
      `);
      const row = inserted.rows[0]?.id;
      if (row === undefined) throw new Error('Portal key insert returned no row.');
      return row;
    });

    this.auditContext.record({
      action: 'portal.key.issued',
      entityType: 'portal_link_key',
      entityId: id,
      before: null,
      // The key itself is never audited: an audit reader is not a portal reader.
      after: { partyId: input.partyId, partyName: party.rows[0].name, days },
    });
    const view = await this.keyById(principal.orgId, id);
    if (view === null) throw new Error('Portal key vanished after insert.');
    return { ...view, key, url: `${env.WEB_BASE_URL.replace(/\/+$/u, '')}/portal/${key}` };
  }

  /** REQ-AL-07: now, not at the next expiry. */
  async revoke(principal: Principal, id: string, reason: string): Promise<PortalKeyView> {
    this.requireManage(principal);
    const existing = await this.keyById(principal.orgId, id);
    if (existing === null) throw AppError.notFound('Portal link', id);
    if (existing.revokedAt !== null) throw AppError.conflict(`${existing.partyName}'s link was already withdrawn.`);
    await this.db.execute(sql`
      UPDATE portal_link_keys SET revoked_at = now(), revoked_by = ${principal.userId}, revoke_reason = ${reason}, updated_at = now(), updated_by = ${principal.userId}
       WHERE org_id = ${principal.orgId} AND id = ${id}
    `);
    this.auditContext.record({ action: 'portal.key.revoked', entityType: 'portal_link_key', entityId: id, before: { state: existing.state }, after: { reason, partyName: existing.partyName } });
    const view = await this.keyById(principal.orgId, id);
    if (view === null) throw new Error('Portal key vanished after revoke.');
    return view;
  }

  async list(principal: Principal, partyId?: string): Promise<PortalKeyView[]> {
    if (!hasPermission(principal, PERMISSIONS.PORTAL_MANAGE) && !hasPermission(principal, PERMISSIONS.RECEIVABLES_VIEW)) {
      throw AppError.forbidden('Seeing customer portal links needs portal.manage.');
    }
    const rows = await this.db.execute<KeyRow>(sql`
      ${KEY_SELECT}
       WHERE k.org_id = ${principal.orgId} AND k.deleted_at IS NULL
         ${partyId === undefined ? sql`` : sql`AND k.party_id = ${partyId}`}
       ORDER BY k.created_at DESC
       LIMIT 200
    `);
    return rows.rows.map(toKeyView);
  }

  // ------------------------------------------------------------------ the portal

  /**
   * REQ-AL-01: one reply, because most readers are on a phone on a mobile
   * connection and four round trips is four chances to fail.
   */
  async view(key: string, context: PortalRequestContext): Promise<PortalView> {
    const resolved = await this.resolve(key, context, 'portal');
    const repository = new PortalRepository(this.db, resolved.orgId, resolved.partyId);
    const partyName = await repository.partyName();
    // The party was deleted after the key was issued. Same answer as a bad
    // key: the reader learns nothing either way.
    if (partyName === null) throw notFound();
    const [orders, dispatches, invoices, statement, promises, organisation] = await Promise.all([
      repository.orders(),
      repository.dispatches(),
      repository.invoices(),
      repository.statement(),
      repository.promises(),
      this.organisationName(resolved.orgId),
    ]);
    return {
      partyName,
      organisationName: organisation,
      expiresAt: resolved.expiresAt.toISOString(),
      asOf: new Date().toISOString(),
      orders,
      dispatches,
      invoices,
      statement: statement.rows,
      outstanding: statement.outstanding,
      promises,
    };
  }

  /** REQ-AL-08: minted per request, and only for a photograph of this party's own dispatch. */
  async media(key: string, fileId: string, context: PortalRequestContext): Promise<{ url: string; expiresInSeconds: number }> {
    const resolved = await this.resolve(key, context, 'media');
    const repository = new PortalRepository(this.db, resolved.orgId, resolved.partyId);
    if (!(await repository.ownsPhoto(fileId))) throw notFound();
    return this.files.signedUrlForPortal(resolved.orgId, fileId);
  }

  // ---------------------------------------------------------------- internals

  /**
   * The key, the throttle, the log, in that order.
   *
   * The throttle is claimed **before** the key is looked up (REQ-AL-05), so
   * a spray of invalid keys costs budget rather than database work; a
   * request that resolves hands its slot straight back, so a customer
   * refreshing their own page never runs out. Every outcome reaches the
   * access log, and a refusal says nothing about which of the four reasons
   * applied — expired, withdrawn, unknown, or wrong organisation all answer
   * "not found".
   */
  private async resolve(key: string, context: PortalRequestContext, view: string): Promise<Extract<Resolution, { ok: true }>> {
    const claim = await this.limiter.claimAttempt(context.ip, Date.now(), 'portal');
    const resolution = await this.lookUp(key);
    if (!resolution.ok) {
      await this.log(null, null, view, 'refused', context);
      throw notFound();
    }
    // Only a refusal costs a slot, exactly as a failed sign-in does.
    await this.limiter.release(claim);
    await this.assertKeyWithinBudget(resolution.keyId, view, context, resolution.orgId, resolution.partyId);
    await this.db.execute(sql`
      UPDATE portal_link_keys SET last_used_at = now(), view_count = view_count + 1 WHERE id = ${resolution.keyId}
    `);
    await this.log(resolution.keyId, resolution.partyId, view, 'served', context, resolution.orgId);
    return resolution;
  }

  /** Counted from the log, per key, per hour (REQ-AL-05). */
  private async assertKeyWithinBudget(keyId: string, view: string, context: PortalRequestContext, orgId: string, partyId: string): Promise<void> {
    const rows = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM portal_access_log
       WHERE link_key_id = ${keyId} AND outcome = 'served' AND at > now() - interval '1 hour'
    `);
    if (Number(rows.rows[0]?.n ?? 0) < KEY_VIEWS_PER_HOUR) return;
    await this.log(keyId, partyId, view, 'throttled', context, orgId);
    throw new AppError(ERROR_CODES.RATE_LIMITED, 'This link has been opened too many times in the last hour. Try again shortly.');
  }

  private async lookUp(key: string): Promise<Resolution> {
    // Shape first: a key of the wrong length never reaches the database.
    if (typeof key !== 'string' || key.length < 20 || key.length > 200) return { ok: false };
    const rows = await this.db.execute<{ id: string; org_id: string; party_id: string; key_hash: string; expires_at: Date | string; revoked_at: Date | string | null }>(sql`
      SELECT id, org_id, party_id, key_hash, expires_at, revoked_at
        FROM portal_link_keys
       WHERE key_hash = ${hashOf(key)} AND deleted_at IS NULL
       LIMIT 1
    `);
    const row = rows.rows[0];
    if (row === undefined) return { ok: false };
    // The hash is what was matched on, so this only guards against a lookup
    // that ever becomes non-exact; it costs nothing and it cannot be the
    // thing that leaks a timing difference.
    if (!sameDigest(row.key_hash, hashOf(key))) return { ok: false };
    if (row.revoked_at !== null) return { ok: false };
    const expiresAt = new Date(row.expires_at);
    if (expiresAt.getTime() <= Date.now()) return { ok: false };
    return { ok: true, keyId: row.id, orgId: row.org_id, partyId: row.party_id, expiresAt };
  }

  /** REQ-AL-06. Never allowed to be the reason a portal request fails. */
  private async log(linkKeyId: string | null, partyId: string | null, view: string, outcome: string, context: PortalRequestContext, orgId?: string): Promise<void> {
    if (orgId === undefined && linkKeyId === null) {
      // A refusal with no key has no organisation to file under. Logged to
      // the process, where the throttle's own lines already are.
      this.logger.warn({ msg: 'Portal request refused', view, ip: context.ip });
      return;
    }
    try {
      await this.db.execute(sql`
        INSERT INTO portal_access_log (org_id, link_key_id, party_id, view, outcome, ip, user_agent)
        VALUES (${orgId ?? sql`(SELECT org_id FROM portal_link_keys WHERE id = ${linkKeyId})`}, ${linkKeyId}, ${partyId}, ${view}, ${outcome}, ${context.ip}, ${context.userAgent})
      `);
    } catch (error: unknown) {
      this.logger.error({ msg: 'Portal access log write failed; the request was served anyway', view, error });
    }
  }

  private async organisationName(orgId: string): Promise<string> {
    const rows = await this.db.execute<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}`);
    return rows.rows[0]?.name ?? '';
  }

  private async keyById(orgId: string, id: string): Promise<PortalKeyView | null> {
    const rows = await this.db.execute<KeyRow>(sql`${KEY_SELECT} WHERE k.org_id = ${orgId} AND k.id = ${id} AND k.deleted_at IS NULL`);
    const row = rows.rows[0];
    return row === undefined ? null : toKeyView(row);
  }

  private requireManage(principal: Principal): void {
    if (!hasPermission(principal, PERMISSIONS.PORTAL_MANAGE)) throw AppError.forbidden('Issuing or withdrawing a customer portal link needs portal.manage.');
  }
}

type KeyRow = {
  id: string;
  party_id: string;
  party_name: string;
  created_at: Date | string;
  issued_by_name: string | null;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
  last_used_at: Date | string | null;
  view_count: number;
  note: string | null;
};

const KEY_SELECT = sql`
  SELECT k.id, k.party_id, p.name AS party_name, k.created_at,
         nullif(concat_ws(' ', ie.first_name, ie.last_name), '') AS issued_by_name,
         k.expires_at, k.revoked_at,
         nullif(concat_ws(' ', re.first_name, re.last_name), '') AS revoked_by_name,
         k.revoke_reason, k.last_used_at, k.view_count, k.note
    FROM portal_link_keys k
    JOIN parties p ON p.id = k.party_id
    LEFT JOIN users iu ON iu.id = k.issued_by
    LEFT JOIN employees ie ON ie.id = iu.employee_id
    LEFT JOIN users ru ON ru.id = k.revoked_by
    LEFT JOIN employees re ON re.id = ru.employee_id
`;

function toKeyView(row: KeyRow): PortalKeyView {
  const expiresAt = new Date(row.expires_at);
  const state: PortalKeyState = row.revoked_at !== null ? 'revoked' : expiresAt.getTime() <= Date.now() ? 'expired' : 'active';
  return {
    id: row.id,
    partyId: row.party_id,
    partyName: row.party_name,
    issuedAt: new Date(row.created_at).toISOString(),
    issuedByName: row.issued_by_name,
    expiresAt: expiresAt.toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    revokedByName: row.revoked_by_name,
    revokeReason: row.revoke_reason,
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    viewCount: Number(row.view_count),
    note: row.note,
    state,
  };
}

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One answer for every way a key can fail, so the reader learns nothing. */
function notFound(): AppError {
  return AppError.notFound('Portal link', 'that link');
}
