import {
  DATE_FORMATS,
  type DateFormat,
  DEVICE_BINDING_MODES,
  type DeviceBindingMode, INTEREST_DAY_BASES, MFA_POLICIES, appearanceSchema, type Appearance, localeSchema, retentionSchema, type WorkspaceLocale, type RetentionPolicy, duplicatesPolicySchema, type DuplicatesPolicy, returnReasonsPolicySchema, type ReturnReasonsPolicy } from '@vyuha/shared';
import { z } from 'zod';

/**
 * The `GET /settings` contract, as this screen reads it (REQ-L-01 to REQ-L-05).
 *
 * Declared here rather than imported from the API: the two packages ship
 * separately, so what matters is that the screen states the shape it needs and
 * refuses anything else. `parseOrThrow` turns a mismatch into a visible error
 * rather than an `undefined` rendered into a field.
 *
 * The file deliberately imports nothing but `zod` and the shared enums, so the
 * contract can be checked against a live API response by a script that does not
 * boot the whole application.
 */

/** Single-sourced in @vyuha/shared; a format outside this set will not render. */
export { DATE_FORMATS };
export type { DateFormat };

/** REQ-L-02 lists geofence behaviour; the three outcomes are the punch-window three. */
export const GEOFENCE_BEHAVIOURS = ['BLOCK', 'ALLOW_WITH_REASON', 'ALLOW_AND_FLAG'] as const;
export type GeofenceBehaviour = (typeof GEOFENCE_BEHAVIOURS)[number];

export const orgProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string().nullable(),
  timezone: z.string(),
  // Not `z.enum(DATE_FORMATS)`: an organisation seeded before the set was
  // fixed would fail to parse, and the screen would refuse to load rather than
  // offer the reader a way to correct it.
  dateFormat: z.string(),
  weekStart: z.number().int(),
  leaveYearStartMonth: z.number().int(),
  logoKey: z.string().nullable(),
});

export type OrgProfile = z.infer<typeof orgProfileSchema>;

export const attendancePolicySchema = z.object({
  geofenceBehaviour: z.enum(GEOFENCE_BEHAVIOURS),
  deviceBindingMode: z.enum(DEVICE_BINDING_MODES),
  maxWorkMinutes: z.number().int(),
  regularizationWindowDays: z.number().int(),
  regularizationMaxPerMonth: z.number().int(),
  regularizationAutoFile: z.boolean(),
  earlyArrivalEnabled: z.boolean(),
  earlyArrivalThresholdMinutes: z.number().int(),
  autoEscalationDays: z.number().int(),
});

export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;

export const photoPolicySchema = z.object({
  retentionMonths: z.number().int(),
  minBytes: z.number().int(),
  maxBytes: z.number().int(),
});

export type PhotoPolicy = z.infer<typeof photoPolicySchema>;

export const emailSettingsSchema = z.object({
  transport: z.enum(['smtp', 'log']),
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean(),
  from: z.string(),
  credentialsConfigured: z.boolean(),
});

export type EmailSettings = z.infer<typeof emailSettingsSchema>;

/** The workspace's accent, base and density, as the API keeps them. */
export { appearanceSchema };
export type { Appearance };

/** REQ-B-09, and the sign-in window's length (owner, 22 Aug 2026). */
export const securityPolicySchema = z.object({
  mfaPolicy: z.enum(MFA_POLICIES),
  sessionHours: z.number().int(),
  endSessionOnClose: z.boolean(),
});

export { localeSchema, retentionSchema };
export type { WorkspaceLocale, RetentionPolicy };

export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

/**
 * D-22: the interest cost module's rate, basis and windows. The two enums are
 * declared here rather than imported: they live in the API's settings
 * catalogue, and this file states the shape the screen needs (see the header).
 * `rateSource` stays a loose string for the dateFormat reason — FIXED is the
 * only source today, and a screen that refused a future one could not offer
 * the reader a way to correct it.
 */
export const INTEREST_RECEIVABLE_BASES = ['VOUCHER', 'BILL'] as const;
export type InterestReceivableBase = (typeof INTEREST_RECEIVABLE_BASES)[number];

export const INTEREST_STOCK_CLOCK_STARTS = ['AFTER_CREDIT_DAYS', 'INWARD'] as const;
export type InterestStockClockStart = (typeof INTEREST_STOCK_CLOCK_STARTS)[number];

export { INTEREST_DAY_BASES };

export const interestPolicySchema = z.object({
  annualRatePct: z.number(),
  dayBasis: z.union([z.literal(365), z.literal(360)]),
  rateSource: z.string(),
  receivableBase: z.enum(INTEREST_RECEIVABLE_BASES),
  stockClockStart: z.enum(INTEREST_STOCK_CLOCK_STARTS),
  includeGstInStock: z.boolean(),
  recomputeWindowDays: z.number().int(),
  nonMovingDays: z.number().int(),
});

export type InterestPolicy = z.infer<typeof interestPolicySchema>;

/**
 * OS-1: the three leave policy rows the leave slice reads (REQ-G-04,
 * REQ-G-11, REQ-G-12). Bounds live server-side in the catalogue; the screen
 * states only the shape it needs.
 */
export const leavePolicySchema = z.object({
  yearStartMonth: z.number().int(),
  compOffExpiryDays: z.number().int(),
  concurrentAbsenceThreshold: z.number().int(),
});

export type LeavePolicy = z.infer<typeof leavePolicySchema>;

export const INTEREST_RECEIVABLE_BASE_LABELS: Record<InterestReceivableBase, string> = {
  VOUCHER: 'Each Sales voucher is a bill',
  BILL: 'Tally bill marks (when they arrive)',
};

export const INTEREST_STOCK_CLOCK_LABELS: Record<InterestStockClockStart, string> = {
  AFTER_CREDIT_DAYS: 'After the vendor credit days pass',
  INWARD: 'From the inward date',
};

/** Field name to the feature that reads it today, or null when nothing does. */
const enforcementSchema = z.record(z.string(), z.string().nullable());

export const orgSettingsSchema = z.object({
  organisation: orgProfileSchema,
  attendance: attendancePolicySchema,
  photo: photoPolicySchema,
  security: securityPolicySchema,
  appearance: appearanceSchema,
  locale: localeSchema,
  retention: retentionSchema,
  duplicates: duplicatesPolicySchema,
  returns: returnReasonsPolicySchema,
  interest: interestPolicySchema,
  leave: leavePolicySchema,
  email: emailSettingsSchema,
  enforcement: z.object({
    attendance: enforcementSchema,
    photo: enforcementSchema,
    security: enforcementSchema,
    appearance: enforcementSchema,
    locale: enforcementSchema,
    retention: enforcementSchema,
    duplicates: enforcementSchema,
    returns: enforcementSchema,
    interest: enforcementSchema,
    leave: enforcementSchema,
  }),
  unreadableKeys: z.array(z.string()),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export const testEmailResultSchema = z.object({
  sentTo: z.string(),
  transport: z.enum(['smtp', 'log']),
});

export type TestEmailResult = z.infer<typeof testEmailResultSchema>;

/** What `PUT /settings` accepts. Every group optional; absent means unchanged. */
export interface SettingsPatch {
  organisation?: Partial<Omit<OrgProfile, 'id' | 'logoKey'>>;
  attendance?: Partial<AttendancePolicy>;
  photo?: Partial<PhotoPolicy>;
  security?: Partial<SecurityPolicy>;
  appearance?: Partial<Appearance>;
  locale?: Partial<WorkspaceLocale>;
  retention?: Partial<RetentionPolicy>;
  duplicates?: Partial<DuplicatesPolicy>;
  returns?: Partial<ReturnReasonsPolicy>;
  interest?: Partial<InterestPolicy>;
  leave?: Partial<LeavePolicy>;
}

export const GEOFENCE_LABELS: Record<GeofenceBehaviour, string> = {
  BLOCK: 'Block the punch',
  ALLOW_WITH_REASON: 'Allow with a typed reason',
  ALLOW_AND_FLAG: 'Allow and flag for review',
};

export const DEVICE_BINDING_LABELS: Record<DeviceBindingMode, string> = {
  OFF: 'Do not check the device',
  WARN: 'Allow and flag a new device',
  ENFORCE: 'Block until HR approves the rebind',
};

export const WEEKDAY_LABELS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

export const MONTH_LABELS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

/**
 * A short list of the zones an Indian operation plausibly runs in, plus UTC.
 *
 * A free-text field would let somebody type a zone the platform rejects, and a
 * complete IANA list is 400 entries of noise. The server validates whatever
 * arrives against the platform's own zone database either way, so this list
 * constrains the control without becoming the contract.
 */
export const TIMEZONE_OPTIONS = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'UTC',
] as const;
