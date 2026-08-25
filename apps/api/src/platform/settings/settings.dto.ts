import { DATE_FORMATS } from '@vyuha/shared';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';
import { attendancePolicySchema, photoPolicyObject,
  securityPolicySchema,
  appearancePolicySchema,
  localePolicySchema,
  retentionPolicySchema, duplicatesPolicyRowSchema, returnReasonsPolicyRowSchema,
  interestPolicySchema } from './settings.catalogue.js';

/**
 * The `PUT /settings` body (REQ-L-01, REQ-L-02, REQ-L-03).
 *
 * Every group is optional and every field inside it is optional, because the
 * Settings screen is four tabs and saving one of them must not blank the other
 * three. The consequence is that "absent" and "null" mean different things
 * here: absent leaves the stored value alone, null clears a nullable column.
 */

/**
 * An IANA zone name, checked by asking the platform rather than by matching a
 * pattern -- the same test `createLocationSchema` applies, and for the same
 * reason: a wrong timezone silently shifts every attendance date rather than
 * failing.
 */
const timezoneField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'must be an IANA timezone name, for example Asia/Kolkata');

export const orgProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    legalName: z.string().trim().min(1).max(200).nullable(),
    timezone: timezoneField,
    dateFormat: z.enum(DATE_FORMATS),
    /** ISO-8601 weekday, 1 = Monday. */
    weekStart: z.number().int().min(1).max(7),
    /** REQ-G-04. April by default, confirmed in 05-decisions. */
    leaveYearStartMonth: z.number().int().min(1).max(12),
  })
  .partial();

export type OrgProfilePatchInput = z.infer<typeof orgProfilePatchSchema>;

export const updateSettingsSchema = z
  .object({
    organisation: orgProfilePatchSchema,
    attendance: attendancePolicySchema.partial(),
    photo: photoPolicyObject.partial(),
    security: securityPolicySchema.partial(),
    appearance: appearancePolicySchema.partial(),
    locale: localePolicySchema.partial(),
    retention: retentionPolicySchema.partial(),
    duplicates: duplicatesPolicyRowSchema.partial(),
    returns: returnReasonsPolicyRowSchema.partial(),
    interest: interestPolicySchema.partial(),
  })
  .partial()
  .refine(
    (value) =>
      value.organisation !== undefined ||
      value.attendance !== undefined ||
      value.photo !== undefined ||
      value.security !== undefined ||
      value.appearance !== undefined ||
      value.locale !== undefined ||
      value.retention !== undefined ||
      value.duplicates !== undefined ||
      value.returns !== undefined ||
      value.interest !== undefined,
    // An empty body would otherwise succeed, write nothing, and leave an audit
    // row claiming a settings change with an empty diff.
    { message: 'Send at least one settings group to change.' },
  );

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export class UpdateSettingsDto extends createZodDto(updateSettingsSchema) {}
