import {
  DEVICE_BINDING_MODES,
  GEOFENCE_BEHAVIOURS,
  type DeviceBindingMode,
  type GeofenceBehaviour,
} from '@vyuha/shared';
import { z } from 'zod';

/**
 * The punch policy an administrator can change without a deploy (REQ-K-01:
 * "changing a policy setting immediately alters punch behaviour without a
 * redeploy"). Rows in the platform `settings` table, keyed here.
 *
 * The defaults are the answers in `05-decisions.md`, not invented ones:
 * out-of-window punches are allowed with a typed reason, device binding warns
 * rather than enforces, and the photo band is REQ-D-03a's 80-150 KB.
 *
 * A malformed value throws rather than falling back. A settings row that says
 * `"BLOCk"` and silently behaves as ALLOW_WITH_REASON is a control that has
 * been turned off without anybody being told.
 */

export const PUNCH_SETTING_KEYS = {
  deviceBindingMode: 'attendance.device_binding_mode',
  geofenceBehaviour: 'attendance.geofence_behaviour',
  photoMinBytes: 'attendance.photo_min_bytes',
  photoMaxBytes: 'attendance.photo_max_bytes',
  photoRetentionMonths: 'attendance.photo_retention_months',
} as const;

export type PunchSettingKey = (typeof PUNCH_SETTING_KEYS)[keyof typeof PUNCH_SETTING_KEYS];

export interface PunchSettings {
  readonly deviceBindingMode: DeviceBindingMode;
  /** REQ-D-08 and REQ-L-02: what an outside-the-radius punch becomes. */
  readonly geofenceBehaviour: GeofenceBehaviour;
  /** REQ-D-03a: the band the stored photo should land in. */
  readonly photoMinBytes: number;
  readonly photoMaxBytes: number;
  /** REQ-L-03: how long a punch photo lives before the purge job takes it. */
  readonly photoRetentionMonths: number;
}

const KB = 1024;

export const DEFAULT_PUNCH_SETTINGS: PunchSettings = {
  deviceBindingMode: 'WARN',
  geofenceBehaviour: 'BLOCK',
  photoMinBytes: 80 * KB,
  photoMaxBytes: 150 * KB,
  // REQ-L-03's default, the same 12 the settings catalogue states.
  photoRetentionMonths: 12,
};

// 20 KB is below anything a legible 1280px stamped photo can be; 2 MB is above
// anything worth storing 26,000 times a month.
const byteBudget = z.number().int().min(1 * KB).max(2_048 * KB);

/**
 * Generic over the schema rather than over the key: a lookup table of schemas
 * indexed by key gives every read the union of all four value types, and the
 * caller then has to narrow a value it already knows the shape of.
 */
function read<TSchema extends z.ZodType>(
  values: ReadonlyMap<string, unknown>,
  key: PunchSettingKey,
  schema: TSchema,
): z.infer<TSchema> | undefined {
  if (!values.has(key)) return undefined;

  const parsed = schema.safeParse(values.get(key));
  if (!parsed.success) {
    throw new Error(`Setting "${key}" is not a valid value: ${JSON.stringify(values.get(key))}.`);
  }
  return parsed.data;
}

/**
 * `values` is whatever the `settings` table holds for this organisation, keyed
 * by setting key. Absent keys take the default above; present ones must parse.
 */
export function resolvePunchSettings(values: ReadonlyMap<string, unknown>): PunchSettings {
  const photoMinBytes =
    read(values, PUNCH_SETTING_KEYS.photoMinBytes, byteBudget) ??
    DEFAULT_PUNCH_SETTINGS.photoMinBytes;
  const photoMaxBytes =
    read(values, PUNCH_SETTING_KEYS.photoMaxBytes, byteBudget) ??
    DEFAULT_PUNCH_SETTINGS.photoMaxBytes;

  if (photoMinBytes > photoMaxBytes) {
    throw new Error(
      `Photo size band is inverted: "${PUNCH_SETTING_KEYS.photoMinBytes}" (${String(photoMinBytes)}) ` +
        `exceeds "${PUNCH_SETTING_KEYS.photoMaxBytes}" (${String(photoMaxBytes)}).`,
    );
  }

  return {
    deviceBindingMode:
      read(values, PUNCH_SETTING_KEYS.deviceBindingMode, z.enum(DEVICE_BINDING_MODES)) ??
      DEFAULT_PUNCH_SETTINGS.deviceBindingMode,
    geofenceBehaviour:
      read(values, PUNCH_SETTING_KEYS.geofenceBehaviour, z.enum(GEOFENCE_BEHAVIOURS)) ??
      DEFAULT_PUNCH_SETTINGS.geofenceBehaviour,
    photoMinBytes,
    photoMaxBytes,
    photoRetentionMonths:
      // The same 3-120 band the settings catalogue accepts on the way in.
      // The floor is 3 because a regularization window can reach 90 days
      // (REQ-F-02), and a shorter retention would purge a photo while the
      // punch it evidences is still disputable.
      read(values, PUNCH_SETTING_KEYS.photoRetentionMonths, z.number().int().min(3).max(120)) ??
      DEFAULT_PUNCH_SETTINGS.photoRetentionMonths,
  };
}

/**
 * When a photo written now falls due for the purge (REQ-L-03).
 *
 * Calendar months, with the day clamped: a photo taken on 31 October plus four
 * months lands on 28/29 February rather than rolling into 2/3 March, so a
 * twelve-month promise is never quietly a twelve-months-and-three-days one.
 */
export function photoExpiry(now: Date, retentionMonths: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + retentionMonths;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const expiry = new Date(now);
  expiry.setUTCFullYear(year, month, Math.min(now.getUTCDate(), lastDayOfTarget));
  return expiry;
}
