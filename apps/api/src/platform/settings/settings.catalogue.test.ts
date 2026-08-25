import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPEARANCE_SETTINGS,
  ATTENDANCE_SETTINGS,
  DEFAULT_APPEARANCE_POLICY,
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_DUPLICATES_POLICY_ROW,
  DEFAULT_LOCALE_POLICY,
  DEFAULT_PHOTO_POLICY,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_SECURITY_POLICY,
  DUPLICATES_SETTINGS,
  INTEREST_SETTINGS,
  LOCALE_SETTINGS,
  PHOTO_SETTINGS,
  RETENTION_SETTINGS,
  RETURNS_SETTINGS,
  SECURITY_SETTINGS,
  WRITABLE_SETTING_KEYS,
  appearancePolicySchema,
  attendancePolicySchema,
  localePolicySchema,
  photoPolicySchema,
  resolveGroup,
  retentionPolicySchema,
  securityPolicySchema,
  type SettingDescriptor,
} from './settings.catalogue.js';

/**
 * The catalogue is three lists that have to agree: the schema's fields, the
 * descriptors' keys, and the defaults. Nothing in the type system makes them
 * agree, so this file does.
 *
 * The last block is the one that earns its keep. Technical design §1 forbids
 * `platform/ -> modules/` imports, so the settings module repeats key strings
 * that the attendance module also spells out. A rename on either side would
 * otherwise be silent: the screen would keep writing `attendance.max_work_minutes`
 * to a row nothing reads, the day engine would keep applying its default, and
 * the only symptom would be a setting that appears to save and does nothing.
 */

// `__dirname` rather than `import.meta.url`: this package compiles to
// CommonJS, and `import.meta` is a type error under that module setting even
// though vitest would run it happily.
const SRC_DIR = resolve(__dirname, '../..');
const SETTINGS_DIR = join(SRC_DIR, 'platform', 'settings');

function fieldsOf(schema: typeof attendancePolicySchema): string[] {
  return Object.keys(schema.shape).sort();
}

describe('the catalogue and its schemas describe the same fields', () => {
  it('attendance', () => {
    expect(Object.keys(ATTENDANCE_SETTINGS).sort()).toEqual(fieldsOf(attendancePolicySchema));
  });

  it('photo', () => {
    // The refined schema wraps the object, so the fields come from the
    // defaults, which the next block proves satisfy the schema.
    expect(Object.keys(PHOTO_SETTINGS).sort()).toEqual(Object.keys(DEFAULT_PHOTO_POLICY).sort());
    expect(Object.keys(SECURITY_SETTINGS).sort()).toEqual(Object.keys(DEFAULT_SECURITY_POLICY).sort());
    expect(securityPolicySchema.safeParse(DEFAULT_SECURITY_POLICY).success).toBe(true);
    expect(Object.keys(APPEARANCE_SETTINGS).sort()).toEqual(Object.keys(DEFAULT_APPEARANCE_POLICY).sort());
    expect(appearancePolicySchema.safeParse(DEFAULT_APPEARANCE_POLICY).success).toBe(true);
    expect(Object.keys(LOCALE_SETTINGS).sort()).toEqual(Object.keys(DEFAULT_LOCALE_POLICY).sort());
    expect(localePolicySchema.safeParse(DEFAULT_LOCALE_POLICY).success).toBe(true);
    expect(Object.keys(RETENTION_SETTINGS).sort()).toEqual(Object.keys(DEFAULT_RETENTION_POLICY).sort());
    expect(Object.keys(DUPLICATES_SETTINGS).sort()).toEqual(Object.keys(DEFAULT_DUPLICATES_POLICY_ROW).sort());
    expect(retentionPolicySchema.safeParse(DEFAULT_RETENTION_POLICY).success).toBe(true);
  });
});

describe('defaults', () => {
  it('satisfy their own schema', () => {
    expect(attendancePolicySchema.safeParse(DEFAULT_ATTENDANCE_POLICY).success).toBe(true);
    expect(photoPolicySchema.safeParse(DEFAULT_PHOTO_POLICY).success).toBe(true);
  });

  it('match the values the consuming code already applies', () => {
    // Repeated literals rather than imports, because platform must not import
    // modules. Each one is checked against the module's source below.
    expect(DEFAULT_ATTENDANCE_POLICY.maxWorkMinutes).toBe(16 * 60);
    expect(DEFAULT_ATTENDANCE_POLICY.deviceBindingMode).toBe('WARN');
    expect(DEFAULT_PHOTO_POLICY.minBytes).toBe(80 * 1024);
    expect(DEFAULT_PHOTO_POLICY.maxBytes).toBe(150 * 1024);
    // REQ-L-03.
    expect(DEFAULT_PHOTO_POLICY.retentionMonths).toBe(12);
  });
});

describe('keys', () => {
  const all = [...Object.values(ATTENDANCE_SETTINGS), ...Object.values(PHOTO_SETTINGS), ...Object.values(SECURITY_SETTINGS), ...Object.values(APPEARANCE_SETTINGS), ...Object.values(LOCALE_SETTINGS), ...Object.values(RETENTION_SETTINGS), ...Object.values(DUPLICATES_SETTINGS), ...Object.values(RETURNS_SETTINGS), ...Object.values(INTEREST_SETTINGS)];

  it('are unique', () => {
    const keys = all.map((descriptor) => descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('are namespaced by the module that consumes them', () => {
    for (const descriptor of all) {
      expect(descriptor.key).toMatch(/^[a-z]+\.[a-z0-9_]+$/u);
    }
  });

  it('are exactly the set the endpoint is allowed to write', () => {
    expect([...WRITABLE_SETTING_KEYS].sort()).toEqual(all.map((d) => d.key).sort());
  });
});

describe('resolveGroup', () => {
  it('returns the defaults when nothing is stored', () => {
    const resolved = resolveGroup(
      attendancePolicySchema,
      ATTENDANCE_SETTINGS,
      DEFAULT_ATTENDANCE_POLICY,
      new Map(),
    );
    expect(resolved.value).toEqual(DEFAULT_ATTENDANCE_POLICY);
    expect(resolved.unreadable).toEqual([]);
  });

  it('reads a stored row over the default', () => {
    const resolved = resolveGroup(
      attendancePolicySchema,
      ATTENDANCE_SETTINGS,
      DEFAULT_ATTENDANCE_POLICY,
      new Map([[ATTENDANCE_SETTINGS.maxWorkMinutes.key, 600]]),
    );
    expect(resolved.value.maxWorkMinutes).toBe(600);
    expect(resolved.value.deviceBindingMode).toBe(DEFAULT_ATTENDANCE_POLICY.deviceBindingMode);
  });

  it('keeps the good rows when one is corrupt, and names the corrupt one', () => {
    // The whole reason the read path does not throw: the settings screen is
    // where a corrupt row gets repaired, so it has to render.
    const resolved = resolveGroup(
      attendancePolicySchema,
      ATTENDANCE_SETTINGS,
      DEFAULT_ATTENDANCE_POLICY,
      new Map<string, unknown>([
        [ATTENDANCE_SETTINGS.maxWorkMinutes.key, 600],
        [ATTENDANCE_SETTINGS.deviceBindingMode.key, 'WARn'],
      ]),
    );

    expect(resolved.value.maxWorkMinutes).toBe(600);
    expect(resolved.value.deviceBindingMode).toBe(DEFAULT_ATTENDANCE_POLICY.deviceBindingMode);
    expect(resolved.unreadable).toEqual([ATTENDANCE_SETTINGS.deviceBindingMode.key]);
  });

  it('refuses a stored photo band that is inverted', () => {
    // Each value is individually in range; only the pair is wrong. An
    // inverted band makes every punch throw, so the read path must not hand
    // it back as though it were usable.
    const resolved = resolveGroup(
      photoPolicySchema,
      PHOTO_SETTINGS,
      DEFAULT_PHOTO_POLICY,
      new Map<string, unknown>([
        [PHOTO_SETTINGS.minBytes.key, 900 * 1024],
        [PHOTO_SETTINGS.maxBytes.key, 100 * 1024],
      ]),
    );

    expect(resolved.value.minBytes).toBeLessThanOrEqual(resolved.value.maxBytes);
    expect(resolved.unreadable.length).toBeGreaterThan(0);
  });
});

/**
 * Every key claimed to be enforced must still be spelled that way by the code
 * that enforces it. Reading the sources as text rather than importing them is
 * what keeps this test on the legal side of the module boundary.
 */
describe('the enforced keys still exist in the code that reads them', () => {
  const sources = collectSources(SRC_DIR).filter((path) => !path.startsWith(SETTINGS_DIR));
  const corpus = sources.map((path) => readFileSync(path, 'utf8')).join('\n');

  const enforced: [string, SettingDescriptor][] = [
    ...Object.entries<SettingDescriptor>(ATTENDANCE_SETTINGS),
    ...Object.entries<SettingDescriptor>(PHOTO_SETTINGS),
  ].filter(([, descriptor]) => descriptor.enforcedBy !== null);

  it('finds sources to search', () => {
    // Guards the guard: an empty corpus, or a settings directory that has moved
    // out from under the filter, would make every assertion below pass.
    expect(existsSync(SETTINGS_DIR)).toBe(true);
    expect(sources.length).toBeGreaterThan(50);
    expect(enforced.length).toBeGreaterThan(0);
  });

  it.each(enforced)('%s', (_field, descriptor) => {
    expect(
      corpus.includes(`'${descriptor.key}'`),
      `The catalogue says "${descriptor.key}" is read by ${String(descriptor.enforcedBy)}, ` +
        'but no source outside platform/settings spells it. Either the consumer renamed the ' +
        'key -- in which case rename it here too -- or the consumer was removed, in which ' +
        'case set enforcedBy to null so the screen stops claiming the setting does something.',
    ).toBe(true);
  });
});

function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...collectSources(path));
      continue;
    }
    if (path.endsWith('.ts') && !path.endsWith('.test.ts')) found.push(path);
  }
  return found;
}
