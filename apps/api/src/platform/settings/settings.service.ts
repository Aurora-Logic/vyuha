import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, isUuid, type OrgBranding } from '@vyuha/shared';
import { z } from 'zod';

import { AuditContext } from '../audit/audit-context.js';
import { AppError, describeError } from '../common/errors.js';
import { env } from '../common/env.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { FileService } from '../files/file.service.js';
import { Mailer } from '../mail/mailer.js';
import { orgContextOf, type Principal } from '../rbac/principal.js';
import {
  ATTENDANCE_SETTINGS,
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_PHOTO_POLICY,
  PHOTO_SETTINGS,
  attendancePolicySchema,
  photoPolicySchema,
  resolveGroup,
  type AttendancePolicy,
  type PhotoPolicy,
  type SettingConsumer,
  DEFAULT_SECURITY_POLICY,
  SECURITY_SETTINGS,
  securityPolicySchema,
  type SecurityPolicy,
  APPEARANCE_SETTINGS,
  DEFAULT_APPEARANCE_POLICY,
  appearancePolicySchema,
  type AppearancePolicy,
  LOCALE_SETTINGS,
  DEFAULT_LOCALE_POLICY,
  localePolicySchema,
  type LocalePolicy,
  RETENTION_SETTINGS,
  DUPLICATES_SETTINGS,
  RETURNS_SETTINGS,
  DEFAULT_DUPLICATES_POLICY_ROW,
  DEFAULT_RETURN_REASONS_POLICY_ROW,
  duplicatesPolicyRowSchema,
  returnReasonsPolicyRowSchema,
  type DuplicatesPolicyRow,
  type ReturnReasonsPolicyRow,
  DEFAULT_RETENTION_POLICY,
  retentionPolicySchema,
  type RetentionPolicyRow,
} from './settings.catalogue.js';
import type { UpdateSettingsInput } from './settings.dto.js';
import { SettingsRepository, type OrgProfilePatch, type OrgProfileRow } from './settings.repository.js';

/**
 * REQ-L-01 to REQ-L-05: read and change organisation settings, and audit the
 * change with before and after values.
 *
 * The audit entry is built from a read taken *before* the write and a read
 * taken after it, rather than from the request body. The body says what was
 * asked for; two reads say what happened, which is the only version worth
 * keeping when a partial patch, a default, and a stored value all disagree.
 */

export interface EmailSettingsView {
  /** `smtp` sends; `log` writes the message to the application log instead. */
  readonly transport: 'smtp' | 'log';
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly from: string;
  /** Whether a username and password are configured. Neither is ever returned. */
  readonly credentialsConfigured: boolean;
}

export interface OrgSettingsView {
  readonly organisation: OrgProfileRow;
  readonly attendance: AttendancePolicy;
  readonly photo: PhotoPolicy;
  /** REQ-B-09: who must sign in with an authenticator. */
  readonly security: SecurityPolicy;
  /** The workspace's accent, base and density. */
  readonly appearance: AppearancePolicy;
  readonly locale: LocalePolicy;
  readonly retention: RetentionPolicyRow;
  readonly duplicates: DuplicatesPolicyRow;
  readonly returns: ReturnReasonsPolicyRow;
  readonly email: EmailSettingsView;
  /**
   * What reads each policy field today, or null when nothing does. The screen
   * says so beside the field; see the note in `settings.catalogue.ts`.
   */
  readonly enforcement: {
    readonly attendance: Readonly<Record<string, SettingConsumer>>;
    readonly photo: Readonly<Record<string, SettingConsumer>>;
    readonly security: Readonly<Record<string, SettingConsumer>>;
    readonly appearance: Readonly<Record<string, SettingConsumer>>;
    readonly locale: Readonly<Record<string, SettingConsumer>>;
    readonly retention: Readonly<Record<string, SettingConsumer>>;
    readonly duplicates: Readonly<Record<string, SettingConsumer>>;
    readonly returns: Readonly<Record<string, SettingConsumer>>;
  };
  /**
   * Stored rows that no longer satisfy their schema. The screen shows the
   * default it fell back to and names the key, because the settings screen is
   * the only place a corrupt row can be repaired.
   */
  readonly unreadableKeys: readonly string[];
}

export interface TestEmailResult {
  readonly sentTo: string;
  readonly transport: 'smtp' | 'log';
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly mailer: Mailer,
    private readonly files: FileService,
  ) {}

  async read(principal: Principal): Promise<OrgSettingsView> {
    return this.compose(this.repository(principal));
  }

  async update(principal: Principal, input: UpdateSettingsInput): Promise<OrgSettingsView> {
    const repository = this.repository(principal);
    const before = await this.compose(repository);

    const profile = profilePatchOf(input);
    const values = this.valuePatchOf(before, input);

    await repository.write({ profile, values });

    const after = await this.compose(repository);

    // REQ-L-05. `diffJson` in the audit service narrows this to the fields
    // that actually moved, so sending the whole view costs nothing and means a
    // field added later is audited without anyone remembering to add it here.
    this.auditContext.record({
      action: 'settings.updated',
      entityType: 'settings',
      entityId: before.organisation.id,
      before: auditShape(before),
      after: auditShape(after),
    });

    return after;
  }

  // --------------------------------------------------------------- branding

  /**
   * REQ-L-01's logo and the organisation's name, for anybody who is signed in.
   *
   * Deliberately not gated on `settings.manage` like the rest of this service:
   * the logo is rendered in the sidebar of every screen, and a permission here
   * would mean every employee saw the monogram while the administrator who
   * uploaded it saw the mark. `FILE_READ_RULES` already says the same thing --
   * `ORG_LOGO` is readable by any authenticated principal and nothing else in
   * `files` is.
   */
  async branding(principal: Principal): Promise<OrgBranding> {
    const profile = await this.requireProfile(this.repository(principal));
    const link = await this.signLogo(principal, profile.logoKey);

    // The accent and base ride with the logo: every signed-in client reads
    // this, and the shell colours itself from it before any screen mounts.
    const rows = await this.repository(principal).readValues();
    const appearance = resolveGroup(appearancePolicySchema, APPEARANCE_SETTINGS, DEFAULT_APPEARANCE_POLICY, rows);
    const locale = resolveGroup(localePolicySchema, LOCALE_SETTINGS, DEFAULT_LOCALE_POLICY, rows);

    return {
      name: profile.name,
      logoUrl: link?.url ?? null,
      logoUrlExpiresInSeconds: link?.expiresInSeconds ?? null,
      appearance: appearance.value,
      locale: locale.value,
    };
  }

  /**
   * Stores an uploaded logo and points the organisation at it (REQ-L-01,
   * OPEN-QUESTIONS P0-7).
   *
   * Nothing here inspects the bytes. `FileService.storeImage` sniffs the type
   * by magic bytes -- never the declared content type, which the same party
   * that supplied the bytes chose -- and re-encodes through sharp, so what is
   * stored is written from decoded pixels and not from anything the client
   * sent. That is the identical pipeline a punch photo goes through, and using
   * it rather than a second one is the point.
   */
  async replaceLogo(principal: Principal, bytes: Buffer): Promise<OrgBranding> {
    const repository = this.repository(principal);
    const before = await this.requireProfile(repository);

    const stored = await this.files.storeImage({
      orgId: principal.orgId,
      uploadedBy: principal.userId,
      purpose: 'ORG_LOGO',
      bytes,
    });

    await repository.write({ profile: { logoKey: stored.id }, values: new Map() });

    // The object the organisation has just stopped pointing at. Handed to the
    // retention sweep rather than deleted inline: an unreferenced object in a
    // bucket forever is a slow leak, and deleting it here would risk removing
    // the file that the row above still names if that write had failed.
    await this.retireLogo(principal.orgId, before.logoKey);

    this.auditContext.record({
      action: 'settings.logo_updated',
      entityType: 'settings',
      entityId: before.id,
      before: { logoKey: before.logoKey },
      after: { logoKey: stored.id, mime: stored.mime, bytes: stored.bytes },
    });

    return this.branding(principal);
  }

  /** REQ-L-01: back to the monogram, everywhere, for everybody. */
  async removeLogo(principal: Principal): Promise<OrgBranding> {
    const repository = this.repository(principal);
    const before = await this.requireProfile(repository);

    if (before.logoKey === null) {
      // Idempotent rather than a 404. "There is no logo" is the state the
      // caller asked for, and refusing would make a double press an error.
      return this.branding(principal);
    }

    await repository.write({ profile: { logoKey: null }, values: new Map() });
    await this.retireLogo(principal.orgId, before.logoKey);

    this.auditContext.record({
      action: 'settings.logo_removed',
      entityType: 'settings',
      entityId: before.id,
      before: { logoKey: before.logoKey },
      after: { logoKey: null },
    });

    return this.branding(principal);
  }

  /**
   * A signed URL for the stored logo, or null.
   *
   * Every failure here is null rather than a throw, and that is the whole
   * reason this is a method. A purged object, a row from a restored database
   * that no longer has its file, or a `logo_key` that is not an id at all,
   * would each otherwise take down the one endpoint that every screen calls on
   * every load. The monogram is a perfectly good answer; a 500 is not.
   */
  private async signLogo(
    principal: Principal,
    logoKey: string | null,
  ): Promise<{ url: string; expiresInSeconds: number } | null> {
    if (logoKey === null || !isUuid(logoKey)) return null;

    try {
      return await this.files.signedUrlFor(principal, logoKey);
    } catch (error: unknown) {
      // Not swallowed: the log carries it, and the caller gets the honest
      // "there is no logo to show" rather than a broken image.
      this.logger.warn({
        msg: 'Organisation logo could not be signed; falling back to the monogram.',
        orgId: principal.orgId,
        logoKey,
        reason: describeError(error),
      });
      return null;
    }
  }

  private async retireLogo(orgId: string, logoKey: string | null): Promise<void> {
    if (logoKey === null) return;
    await this.files.expireFile(orgId, logoKey);
  }

  /**
   * REQ-L-04's test send.
   *
   * The recipient is the caller's own address and cannot be chosen. A test-send
   * that accepts an arbitrary address is a mail relay with an admin login in
   * front of it, and "does our SMTP work" is answered just as well by a message
   * the administrator can read in their own inbox.
   */
  async sendTestEmail(principal: Principal): Promise<TestEmailResult> {
    const profile = await this.requireProfile(this.repository(principal));

    try {
      await this.mailer.send({
        to: principal.email,
        subject: `${profile.name}: test message`,
        body:
          'This is a test message sent from the Settings screen. ' +
          'Receiving it means outbound email is configured correctly. ' +
          'Nothing was changed by sending it.',
      });
    } catch (error: unknown) {
      this.logger.error({
        msg: 'Test email failed to send.',
        reason: describeError(error),
        orgId: principal.orgId,
        actorUserId: principal.userId,
      });
      // Rethrown with context rather than swallowed: the whole point of the
      // button is to report the transport's answer.
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        'The message could not be sent. The mail server refused it or could not be reached.',
        { cause: error },
      );
    }

    this.auditContext.record({
      action: 'settings.email_tested',
      entityType: 'settings',
      entityId: profile.id,
      after: { sentTo: principal.email, transport: env.MAIL_TRANSPORT },
    });

    return { sentTo: principal.email, transport: env.MAIL_TRANSPORT };
  }

  // ------------------------------------------------------------- internals

  private repository(principal: Principal): SettingsRepository {
    return new SettingsRepository(this.db, orgContextOf(principal));
  }

  private async compose(repository: SettingsRepository): Promise<OrgSettingsView> {
    const [organisation, rows] = await Promise.all([
      this.requireProfile(repository),
      repository.readValues(),
    ]);

    const attendance = resolveGroup(
      attendancePolicySchema,
      ATTENDANCE_SETTINGS,
      DEFAULT_ATTENDANCE_POLICY,
      rows,
    );
    const photo = resolveGroup(photoPolicySchema, PHOTO_SETTINGS, DEFAULT_PHOTO_POLICY, rows);
    const security = resolveGroup(securityPolicySchema, SECURITY_SETTINGS, DEFAULT_SECURITY_POLICY, rows);
    const appearance = resolveGroup(appearancePolicySchema, APPEARANCE_SETTINGS, DEFAULT_APPEARANCE_POLICY, rows);
    const locale = resolveGroup(localePolicySchema, LOCALE_SETTINGS, DEFAULT_LOCALE_POLICY, rows);
    const retention = resolveGroup(retentionPolicySchema, RETENTION_SETTINGS, DEFAULT_RETENTION_POLICY, rows);
    const duplicates = resolveGroup(duplicatesPolicyRowSchema, DUPLICATES_SETTINGS, DEFAULT_DUPLICATES_POLICY_ROW, rows);
    const returns = resolveGroup(returnReasonsPolicyRowSchema, RETURNS_SETTINGS, DEFAULT_RETURN_REASONS_POLICY_ROW, rows);

    return {
      organisation,
      attendance: attendance.value,
      photo: photo.value,
      security: security.value,
      appearance: appearance.value,
      locale: locale.value,
      retention: retention.value,
      duplicates: duplicates.value,
      returns: returns.value,
      email: emailView(),
      enforcement: {
        attendance: enforcementOf(ATTENDANCE_SETTINGS),
        photo: enforcementOf(PHOTO_SETTINGS),
        security: enforcementOf(SECURITY_SETTINGS),
        appearance: enforcementOf(APPEARANCE_SETTINGS),
        locale: enforcementOf(LOCALE_SETTINGS),
        retention: enforcementOf(RETENTION_SETTINGS),
        duplicates: enforcementOf(DUPLICATES_SETTINGS),
        returns: enforcementOf(RETURNS_SETTINGS),
      },
      unreadableKeys: [...attendance.unreadable, ...photo.unreadable, ...security.unreadable, ...appearance.unreadable, ...locale.unreadable, ...retention.unreadable, ...duplicates.unreadable, ...returns.unreadable],
    };
  }

  private async requireProfile(repository: SettingsRepository): Promise<OrgProfileRow> {
    const profile = await repository.readProfile();
    if (profile === null) {
      // The principal carries an org id the guard already resolved, so a
      // missing row is a deleted organisation rather than a bad request.
      throw AppError.notFound('Organisation');
    }
    return profile;
  }

  /**
   * The rows to write, validated against the *merged* policy rather than
   * against the patch.
   *
   * `photoPolicySchema` refuses an inverted size band, and that rule can be
   * broken by a body that sends only `maxBytes`. Merging first is what makes
   * the cross-field rules mean anything.
   */
  private valuePatchOf(
    current: OrgSettingsView,
    input: UpdateSettingsInput,
  ): Map<string, unknown> {
    const values = new Map<string, unknown>();

    if (input.attendance !== undefined) {
      const merged = parseMerged(
        attendancePolicySchema,
        { ...current.attendance, ...input.attendance },
        'attendance',
      );
      for (const [field, descriptor] of Object.entries(ATTENDANCE_SETTINGS)) {
        if (!(field in input.attendance)) continue;
        values.set(descriptor.key, merged[field as keyof AttendancePolicy]);
      }
    }

    if (input.photo !== undefined) {
      const merged = parseMerged(
        photoPolicySchema,
        { ...current.photo, ...input.photo },
        'photo',
      );
      for (const [field, descriptor] of Object.entries(PHOTO_SETTINGS)) {
        if (!(field in input.photo)) continue;
        values.set(descriptor.key, merged[field as keyof PhotoPolicy]);
      }
    }

    if (input.security !== undefined) {
      const merged = parseMerged(
        securityPolicySchema,
        { ...current.security, ...input.security },
        'security',
      );
      for (const [field, descriptor] of Object.entries(SECURITY_SETTINGS)) {
        if (!(field in input.security)) continue;
        values.set(descriptor.key, merged[field as keyof SecurityPolicy]);
      }
    }

    if (input.appearance !== undefined) {
      const merged = parseMerged(
        appearancePolicySchema,
        { ...current.appearance, ...input.appearance },
        'appearance',
      );
      for (const [field, descriptor] of Object.entries(APPEARANCE_SETTINGS)) {
        if (!(field in input.appearance)) continue;
        values.set(descriptor.key, merged[field as keyof AppearancePolicy]);
      }
    }

    if (input.locale !== undefined) {
      const merged = parseMerged(localePolicySchema, { ...current.locale, ...input.locale }, 'locale');
      for (const [field, descriptor] of Object.entries(LOCALE_SETTINGS)) {
        if (!(field in input.locale)) continue;
        values.set(descriptor.key, merged[field as keyof LocalePolicy]);
      }
    }

    if (input.retention !== undefined) {
      const merged = parseMerged(retentionPolicySchema, { ...current.retention, ...input.retention }, 'retention');
      for (const [field, descriptor] of Object.entries(RETENTION_SETTINGS)) {
        if (!(field in input.retention)) continue;
        values.set(descriptor.key, merged[field as keyof RetentionPolicyRow]);
      }
    }
    if (input.duplicates !== undefined) {
      const merged = parseMerged(duplicatesPolicyRowSchema, { ...current.duplicates, ...input.duplicates }, 'duplicates');
      for (const [field, descriptor] of Object.entries(DUPLICATES_SETTINGS)) {
        if (!(field in input.duplicates)) continue;
        values.set(descriptor.key, merged[field as keyof DuplicatesPolicyRow]);
      }
    }
    if (input.returns !== undefined) {
      const merged = parseMerged(returnReasonsPolicyRowSchema, { ...current.returns, ...input.returns }, 'returns');
      for (const [field, descriptor] of Object.entries(RETURNS_SETTINGS)) {
        if (!(field in input.returns)) continue;
        values.set(descriptor.key, merged[field as keyof ReturnReasonsPolicyRow]);
      }
    }

    return values;
  }
}

function parseMerged<TSchema extends z.ZodType>(
  schema: TSchema,
  candidate: unknown,
  group: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  throw AppError.validation(`The ${group} settings would not be valid after this change.`, {
    issues: z.treeifyError(parsed.error),
  });
}

/** Only the keys the body actually carried, so absent means "leave alone". */
function profilePatchOf(input: UpdateSettingsInput): OrgProfilePatch {
  const patch: Record<string, unknown> = {};
  if (input.organisation === undefined) return patch;
  for (const [field, value] of Object.entries(input.organisation)) {
    if (value === undefined) continue;
    patch[field] = value;
  }
  return patch;
}

function enforcementOf(
  descriptors: Record<string, { readonly enforcedBy: SettingConsumer }>,
): Record<string, SettingConsumer> {
  return Object.fromEntries(
    Object.entries(descriptors).map(([field, descriptor]) => [field, descriptor.enforcedBy]),
  );
}

/**
 * What goes in the audit diff.
 *
 * `enforcement` and `email` are excluded: neither is stored, neither can be
 * changed by this endpoint, and including them would put a constant in every
 * before/after pair for the reader to skip past.
 */
function auditShape(view: OrgSettingsView): Record<string, unknown> {
  return {
    organisation: view.organisation,
    attendance: view.attendance,
    photo: view.photo,
  };
}

function emailView(): EmailSettingsView {
  return {
    transport: env.MAIL_TRANSPORT,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    from: env.MAIL_FROM,
    // The values themselves never leave the process. Whether they are set is
    // the part an administrator needs in order to read the transport's answer.
    credentialsConfigured: Boolean(env.SMTP_USER) && Boolean(env.SMTP_PASSWORD),
  };
}
