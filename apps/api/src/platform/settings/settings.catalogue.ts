import {
  DEFAULT_APPEARANCE,
  DEFAULT_LOCALE,
  DEFAULT_MFA_POLICY,
  DEFAULT_RETENTION,
  DEFAULT_SESSION_HOURS,
  DEVICE_BINDING_MODES,
  MFA_POLICIES,
  SESSION_HOURS_MAX,
  SESSION_HOURS_MIN,
  appearanceSchema,
  localeSchema,
  retentionSchema,
  type Appearance,
  type RetentionPolicy,
  type WorkspaceLocale, DEFAULT_DUPLICATES_POLICY, duplicatesPolicySchema, type DuplicatesPolicy,
  DEFAULT_RETURN_REASONS_POLICY, returnReasonsPolicySchema, type ReturnReasonsPolicy, GEOFENCE_BEHAVIOURS } from '@vyuha/shared';
import { z } from 'zod';

/**
 * REQ-L-02 and REQ-L-03: the org-scoped policy rows the Settings screen edits.
 *
 * Two things this file is careful about.
 *
 * **It is a catalogue, not an escape hatch.** `PUT /settings` writes only keys
 * named here, validated by the schema named here. An arbitrary key/value
 * endpoint would let an administrator store `"BLOCk"` in
 * `attendance.punch_window_behaviour`, and the punch pipeline refuses to start
 * a request when a setting will not parse -- so a typo in a settings form would
 * take punching down. Unknown key is a 400.
 *
 * **It states which settings are actually in force.** Several of the fields
 * REQ-L-02 lists belong to features that ship in a later phase, and a switch
 * that visibly moves while nothing reads it is worse than no switch: it reads
 * as a control that has been turned on. `enforcedBy` carries the truth to the
 * screen, which says so next to the field.
 *
 * The `attendance.*` prefix is not a boundary violation. `settings` is a
 * platform table and this module owns reading and writing it; the prefix names
 * the module that *consumes* a row. Technical design §1 forbids
 * `platform/ -> modules/` imports, so the key strings are repeated rather than
 * imported -- `settings.catalogue.test.ts` fails if a consumer renames one.
 */

// The behaviour enum lives in @vyuha/shared now that the punch pipeline
// honours it (P2-2, closed 28 Aug 2026); re-exported for existing importers.
export { GEOFENCE_BEHAVIOURS, type GeofenceBehaviour } from '@vyuha/shared';

const KB = 1024;

/**
 * What reads a setting today, or null when nothing does yet.
 *
 * A free string rather than an enum: it is displayed, not branched on, and the
 * moment it becomes a union somebody will be tempted to switch on it.
 */
export type SettingConsumer = string | null;

export interface SettingDescriptor {
  /** The row in `settings.key`. */
  readonly key: string;
  /** One line for the field's help text. */
  readonly help: string;
  readonly enforcedBy: SettingConsumer;
}

/**
 * Field name inside its group, to the row it is stored in.
 *
 * Keyed by the same field names the schemas below use, so
 * `settings.catalogue.test.ts` can assert the two agree rather than trusting
 * that they were edited together.
 */
export const ATTENDANCE_SETTINGS = {
  geofenceBehaviour: {
    key: 'attendance.geofence_behaviour',
    help: 'What happens to a punch outside the location radius (REQ-D-08).',
    // P2-2, closed 28 Aug 2026: the punch pipeline consults the row on every
    // outside verdict. BLOCK refuses as before; ALLOW_WITH_REASON records
    // with a typed reason or answers PUNCH_REASON_REQUIRED; ALLOW_AND_FLAG
    // records and flags for Approvals.
    enforcedBy: 'Punch',
  },
  deviceBindingMode: {
    key: 'attendance.device_binding_mode',
    help: 'Whether punching from a new device warns, blocks, or is ignored (REQ-B-08).',
    enforcedBy: 'Punch',
  },
  // Owner, 21 Aug 2026: early arrival is recognised (confetti at the punch,
  // a streak on the profile) when the first IN beats shift start by this many
  // minutes; the toggle switches the whole recognition off.
  earlyArrivalEnabled: {
    key: 'attendance.early_arrival_enabled',
    help: 'Whether an early arrival is celebrated and counted toward a streak.',
    enforcedBy: 'Day engine',
  },
  earlyArrivalThresholdMinutes: {
    key: 'attendance.early_arrival_threshold_minutes',
    help: 'How many minutes before shift start counts as early.',
    enforcedBy: 'Day engine',
  },
  maxWorkMinutes: {
    key: 'attendance.max_work_minutes',
    help: 'Worked minutes are capped here, so a missing OUT cannot pay a 30-hour day (REQ-E-03).',
    enforcedBy: 'Day engine',
  },
  regularizationWindowDays: {
    key: 'attendance.regularization_window_days',
    help: 'How many days back a regularization may be raised (REQ-F-02).',
    // Read on every raise, and again by `GET /regularizations/policy` so the
    // form bounds its own calendar to the window actually in force. Today
    // counts as one of the days, so 7 reaches back to six days ago.
    enforcedBy: 'Regularization',
  },
  regularizationMaxPerMonth: {
    key: 'attendance.regularization_max_per_month',
    help: 'How many regularizations one employee may raise in a month (REQ-F-02).',
    // Counted over the calendar month the request is *made* in, not the month
    // being corrected. Zero switches the feature off without taking the
    // permission away from four roles.
    enforcedBy: 'Regularization',
  },
  regularizationAutoFile: {
    key: 'attendance.regularization_auto_file',
    help: 'Automatically file a correction request when a punch is late or outside the shift window, so the employee only has to add a reason instead of starting the form themselves. Off leaves raising a correction to the employee, as today.',
    enforcedBy: 'Regularization',
  },
  autoEscalationDays: {
    key: 'attendance.auto_escalation_days',
    help: 'An untouched approval escalates to HR after this many days (REQ-G-09).',
    // P2-2, closed 28 Aug 2026: read when a request is raised; the sweep then
    // honours what the request carries. A malformed row falls back to the
    // shared default rather than stopping requests being raised.
    enforcedBy: 'Approvals framework',
  },
} as const satisfies Record<string, SettingDescriptor>;

export const PHOTO_SETTINGS = {
  retentionMonths: {
    key: 'attendance.photo_retention_months',
    help: 'How long a punch photo is kept before the purge job removes it (REQ-L-03).',
    // The punch pipeline stamps `files.expires_at` on the photo and its
    // thumbnail from this row; the purge job sweeps that column nightly.
    enforcedBy: 'Punch photo pipeline',
  },
  minBytes: {
    key: 'attendance.photo_min_bytes',
    help: 'Smallest acceptable stored photo. Below this the stamp is not legible.',
    enforcedBy: 'Punch photo pipeline',
  },
  maxBytes: {
    key: 'attendance.photo_max_bytes',
    help: 'Largest stored photo, before re-encoding at a lower quality band.',
    enforcedBy: 'Punch photo pipeline',
  },
} as const satisfies Record<string, SettingDescriptor>;

/**
 * Bounds, not preferences. Each one is the range outside which the consuming
 * feature would misbehave rather than merely be configured oddly.
 */
export const attendancePolicySchema = z.object({
  geofenceBehaviour: z.enum(GEOFENCE_BEHAVIOURS),
  deviceBindingMode: z.enum(DEVICE_BINDING_MODES),
  // The day engine's own guard is `positive().max(24h)`; 60 minutes is the
  // floor below which every full day would be truncated to nothing.
  maxWorkMinutes: z.number().int().min(60).max(24 * 60),
  regularizationWindowDays: z.number().int().min(1).max(90),
  // Zero is a legitimate policy: regularization switched off without removing
  // the permission from four roles.
  regularizationMaxPerMonth: z.number().int().min(0).max(31),
  regularizationAutoFile: z.boolean(),
  earlyArrivalEnabled: z.boolean(),
  earlyArrivalThresholdMinutes: z.number().int().min(5).max(240),
  autoEscalationDays: z.number().int().min(1).max(30),
});

export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;

const photoByteBudget = z.number().int().min(1 * KB).max(2_048 * KB);

/**
 * Unrefined, so `.partial()` is still available for the patch body. The
 * cross-field rule below belongs to the *merged* result rather than to the
 * patch: sending only `maxBytes` can invert the band just as easily as sending
 * both, and a rule checked on the patch alone would miss it.
 */
export const photoPolicyObject = z.object({
  // Floor of 3, not 1: a regularization window can reach 90 days
  // (`regularizationWindowDays` above), so a one-month retention would purge
  // a photo while the punch it evidences is still disputable. Three months
  // is the smallest value that cannot outrun the longest dispute window.
  retentionMonths: z.number().int().min(3).max(120),
  minBytes: photoByteBudget,
  maxBytes: photoByteBudget,
});

export const photoPolicySchema = photoPolicyObject.refine(
  (value) => value.minBytes <= value.maxBytes,
  {
    // An inverted band makes `resolvePunchSettings` throw on every punch, so
    // it is refused at the edit rather than discovered at the camera.
    message: 'The smallest photo size must not exceed the largest.',
    path: ['minBytes'],
  },
);

export type PhotoPolicy = z.infer<typeof photoPolicyObject>;

/**
 * The value used when no row exists. Every one of these is the default the
 * consuming code already applies, or the default written down in the PRD --
 * none is invented here, because a settings screen that reports a different
 * default from the one in force is worse than no screen.
 */
export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicy = {
  // REQ-D-08 and 05-decisions: hard block.
  geofenceBehaviour: 'BLOCK',
  // REQ-B-08: warn.
  deviceBindingMode: 'WARN',
  // `DEFAULT_MAX_WORK_MINUTES` in the day engine.
  maxWorkMinutes: 16 * 60,
  // REQ-F-02: 7 days back, 3 a month.
  regularizationWindowDays: 7,
  regularizationMaxPerMonth: 3,
  // Off: raising a correction is left to the employee unless an organisation
  // opts in.
  regularizationAutoFile: false,
  // Owner, 21 Aug 2026: on, fifteen minutes.
  earlyArrivalEnabled: true,
  earlyArrivalThresholdMinutes: 15,
  // REQ-G-09.
  autoEscalationDays: 3,
};

export const DEFAULT_PHOTO_POLICY: PhotoPolicy = {
  // REQ-L-03.
  retentionMonths: 12,
  // REQ-D-03a's 80-150 KB band, matching `DEFAULT_PUNCH_SETTINGS`.
  minBytes: 80 * KB,
  maxBytes: 150 * KB,
};

/**
 * REQ-B-09. Owner, 22 Aug 2026: two-step sign-in is required for Admin and
 * Accounts unless Settings says otherwise; anybody may turn it on.
 */
export const SECURITY_SETTINGS = {
  mfaPolicy: {
    key: 'security.mfa_policy',
    help: 'Which roles must sign in with an authenticator app (REQ-B-09).',
    enforcedBy: 'Sign-in',
  },
  // Owner, 22 Aug 2026: the refresh window per organisation, and whether
  // the cookie outlives the browser. Read by SessionService at sign-in and
  // at every rotation, so a change takes effect from the next request.
  sessionHours: {
    key: 'security.session_hours',
    help: 'How long a sign-in lasts, renewed by use.',
    enforcedBy: 'Sign-in',
  },
  endSessionOnClose: {
    key: 'security.end_session_on_close',
    help: 'Whether closing the browser ends the sign-in.',
    enforcedBy: 'Sign-in',
  },
} as const satisfies Record<string, SettingDescriptor>;

export const securityPolicySchema = z.object({
  mfaPolicy: z.enum(MFA_POLICIES),
  sessionHours: z.number().int().min(SESSION_HOURS_MIN).max(SESSION_HOURS_MAX),
  endSessionOnClose: z.boolean(),
});
export type SecurityPolicy = z.infer<typeof securityPolicySchema>;
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = { mfaPolicy: DEFAULT_MFA_POLICY, sessionHours: DEFAULT_SESSION_HOURS, endSessionOnClose: false };

/** How every figure is written; rides with the branding read so every client agrees. */
export const LOCALE_SETTINGS = {
  numberFormat: { key: 'locale.number_format', help: 'Lakh-and-crore or thousands grouping.', enforcedBy: 'Every figure' },
  currencySymbol: { key: 'locale.currency_symbol', help: 'The symbol before an amount.', enforcedBy: 'Every figure' },
} as const satisfies Record<string, SettingDescriptor>;
export const localePolicySchema = localeSchema;
export type LocalePolicy = WorkspaceLocale;
export const DEFAULT_LOCALE_POLICY: LocalePolicy = DEFAULT_LOCALE;

/** How long what the system keeps is kept; punch photos have their own row under attendance. */
export const RETENTION_SETTINGS = {
  exportsDays: { key: 'retention.exports_days', help: 'Days a download stays in the tray.', enforcedBy: 'Exports' },
} as const satisfies Record<string, SettingDescriptor>;
export const retentionPolicySchema = retentionSchema;
export type RetentionPolicyRow = RetentionPolicy;
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = DEFAULT_RETENTION;

/**
 * Owner, 22 Aug 2026: the accent and the base are the workspace's, light
 * and dark each person's. Read by every signed-in client through the
 * branding endpoint, which is how the shell colours itself before the
 * settings screen is ever opened.
 */
export const APPEARANCE_SETTINGS = {
  accentHue: { key: 'appearance.accent_hue', help: 'The accent hue, 0-360, at the theme\'s fixed lightness.', enforcedBy: 'Shell' },
  accentChroma: { key: 'appearance.accent_chroma', help: 'How saturated the accent is.', enforcedBy: 'Shell' },
  base: { key: 'appearance.base', help: 'The neutral ramp: stone, zinc, neutral, gray or slate -- the five shadcn ships.', enforcedBy: 'Shell' },
  density: { key: 'appearance.density', help: 'Comfortable or compact spacing; type size does not change.', enforcedBy: 'Shell' },
  // df1d3df added the typeface to the shared contract without this row, so
  // PATCH refused the very key the screen offered -- masked until the stale
  // shared dist was rebuilt. The catalogue test now catches the drift.
  font: { key: 'appearance.font', help: 'The workspace typeface, the same four the printed documents offer.', enforcedBy: 'Shell' },
} as const satisfies Record<string, SettingDescriptor>;

export const appearancePolicySchema = appearanceSchema;
export type AppearancePolicy = Appearance;
export const DEFAULT_APPEARANCE_POLICY: AppearancePolicy = DEFAULT_APPEARANCE;

/** 15 REQ-AO-04 / D-56: the confidence a cluster shows from; the detector reads the same key. */
export const DUPLICATES_SETTINGS = {
  confidenceMin: { key: 'masters.duplicate_confidence_min', help: 'A duplicate cluster is shown from this confidence (0.5 to 1). A shared GSTIN or PAN is always 1.', enforcedBy: 'Duplicate detector' },
} as const satisfies Record<string, SettingDescriptor>;
export const duplicatesPolicyRowSchema = duplicatesPolicySchema;
export type DuplicatesPolicyRow = DuplicatesPolicy;
export const DEFAULT_DUPLICATES_POLICY_ROW: DuplicatesPolicy = DEFAULT_DUPLICATES_POLICY;

/** 15 REQ-AK-02: the reasons the return desk may choose from. Free text rides alongside, never instead. */
export const RETURNS_SETTINGS = {
  reasons: { key: 'sales.return_reasons', help: 'The reasons a return may be recorded under. Free text is always allowed beside the reason, never in place of it.', enforcedBy: 'Return receipt' },
} as const satisfies Record<string, SettingDescriptor>;
export const returnReasonsPolicyRowSchema = returnReasonsPolicySchema;
export type ReturnReasonsPolicyRow = ReturnReasonsPolicy;
export const DEFAULT_RETURN_REASONS_POLICY_ROW: ReturnReasonsPolicy = DEFAULT_RETURN_REASONS_POLICY;

/**
 * D-22: the interest cost module's knobs. The snapshots hold balances with
 * no rate baked in, so editing the rate re-prices history at the next read;
 * the window and non-moving settings feed the nightly build and the stock
 * report. `rate_source` and `receivable_base` exist ahead of their second
 * values so the day bill marks or a bank-linked rate arrive is a data
 * change, not a schema one.
 */
export const INTEREST_RATE_SOURCES = ['FIXED'] as const;
export const INTEREST_RECEIVABLE_BASES = ['VOUCHER', 'BILL'] as const;
export const INTEREST_STOCK_CLOCK_STARTS = ['AFTER_CREDIT_DAYS', 'INWARD'] as const;

export const INTEREST_SETTINGS = {
  annualRatePct: { key: 'interest.annual_rate', help: 'Percent per annum applied to blocked working capital. D-22 seeds 12.00.', enforcedBy: 'Interest reports' },
  dayBasis: { key: 'interest.day_basis', help: 'Days in the interest year: 365, or 360 for bank convention.', enforcedBy: 'Interest reports' },
  rateSource: { key: 'interest.rate_source', help: 'Where the annual rate comes from. FIXED is the only source today.', enforcedBy: null },
  receivableBase: { key: 'interest.receivable_base', help: 'VOUCHER treats each Sales voucher as a bill (D-22 v1); BILL is reserved for when Tally bill marks gain a writer.', enforcedBy: 'Interest snapshots' },
  stockClockStart: { key: 'interest.stock_clock_start', help: 'AFTER_CREDIT_DAYS starts the stock funding clock once the vendor credit days pass; INWARD starts it at the inward date.', enforcedBy: 'Interest snapshots' },
  includeGstInStock: { key: 'interest.include_gst_in_stock', help: 'Whether GST paid on purchases joins the stock value being funded. Off in v1 (D-22).', enforcedBy: 'Interest snapshots' },
  recomputeWindowDays: { key: 'interest.recompute_window_days', help: 'How many days back the nightly build recomputes, so backdated entries are caught rather than trusted to a stale snapshot.', enforcedBy: 'Interest snapshots' },
  nonMovingDays: { key: 'interest.non_moving_days', help: 'Days without outward movement before an item is flagged non-moving.', enforcedBy: 'Interest reports' },
} as const satisfies Record<string, SettingDescriptor>;

export const interestPolicySchema = z.object({
  annualRatePct: z.number().min(0).max(100),
  dayBasis: z.union([z.literal(365), z.literal(360)]),
  rateSource: z.enum(INTEREST_RATE_SOURCES),
  receivableBase: z.enum(INTEREST_RECEIVABLE_BASES),
  stockClockStart: z.enum(INTEREST_STOCK_CLOCK_STARTS),
  includeGstInStock: z.boolean(),
  recomputeWindowDays: z.number().int().min(7).max(365),
  nonMovingDays: z.number().int().min(7).max(365),
});
export type InterestPolicy = z.infer<typeof interestPolicySchema>;

export const DEFAULT_INTEREST_POLICY: InterestPolicy = {
  // D-22: 12.00 percent on a 365-day year.
  annualRatePct: 12,
  dayBasis: 365,
  rateSource: 'FIXED',
  // D-22: voucher-grain until Tally bill marks arrive.
  receivableBase: 'VOUCHER',
  stockClockStart: 'AFTER_CREDIT_DAYS',
  // D-22: no separate GST-on-purchases interest line in v1.
  includeGstInStock: false,
  recomputeWindowDays: 90,
  nonMovingDays: 90,
};

/** Every key this module is allowed to write, in one flat set. */
export const WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(ATTENDANCE_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(PHOTO_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(SECURITY_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(APPEARANCE_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(LOCALE_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(RETENTION_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(DUPLICATES_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(RETURNS_SETTINGS).map((descriptor) => descriptor.key),
  ...Object.values(INTEREST_SETTINGS).map((descriptor) => descriptor.key),
]);

/**
 * Reads one group out of whatever rows the organisation has.
 *
 * A row that will not parse is *not* an error here, and that is deliberate.
 * This is the read path for a settings screen; refusing to render the screen
 * because one row is corrupt would remove the only place the corrupt row can
 * be fixed. The consuming feature still refuses the value at the point of use,
 * which is where refusing is useful.
 */
export function resolveGroup<TSchema extends z.ZodType>(
  schema: TSchema,
  descriptors: Record<string, SettingDescriptor>,
  fallback: z.infer<TSchema>,
  rows: ReadonlyMap<string, unknown>,
): { value: z.infer<TSchema>; unreadable: readonly string[] } {
  const candidate: Record<string, unknown> = { ...(fallback as object) };
  const unreadable: string[] = [];

  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!rows.has(descriptor.key)) continue;
    candidate[field] = rows.get(descriptor.key);
  }

  const parsed = schema.safeParse(candidate);
  if (parsed.success) return { value: parsed.data, unreadable };

  // One bad row must not discard the six good ones beside it, so the fields
  // that failed fall back individually and are named to the caller.
  const repaired: Record<string, unknown> = { ...(fallback as object) };
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!rows.has(descriptor.key)) continue;
    const attempt = schema.safeParse({ ...repaired, [field]: rows.get(descriptor.key) });
    if (attempt.success) repaired[field] = rows.get(descriptor.key);
    else unreadable.push(descriptor.key);
  }

  const settled = schema.safeParse(repaired);
  if (settled.success) return { value: settled.data, unreadable };

  // Unreachable unless a default itself stopped parsing, which the catalogue
  // test exists to prevent. Reported rather than silently swallowed.
  throw new Error(
    `Settings defaults no longer satisfy their own schema: ${JSON.stringify(z.treeifyError(settled.error))}`,
  );
}
