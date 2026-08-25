import { z } from 'zod';

/**
 * Workspace appearance (owner, 22 Aug 2026): the accent and the base are
 * the organisation's, light and dark are each person's. The accent is a
 * hue and a chroma at the theme's fixed lightness, so any hue keeps the
 * contrast the theme was measured at; the base is the temperature of the
 * neutrals; density scales spacing, not type.
 */
/**
 * The five neutral ramps shadcn ships, by their own names.
 *
 * These replace the hand-rolled `cool` and `warm`, which were the same idea
 * with names nobody could map onto anything. A designer asked for "zinc" gets
 * zinc; the hue and chroma below are read off Tailwind's own `theme.css`
 * rather than eyeballed, so `stone` here is the same stone a Tailwind class
 * would give.
 */
export const APPEARANCE_BASES = ['stone', 'zinc', 'neutral', 'gray', 'slate'] as const;
export type AppearanceBase = (typeof APPEARANCE_BASES)[number];
export const APPEARANCE_BASE_LABELS: Record<AppearanceBase, string> = {
  stone: 'Stone',
  zinc: 'Zinc',
  neutral: 'Neutral',
  gray: 'Gray',
  slate: 'Slate',
};

/**
 * What a base stored before this change resolves to now.
 *
 * `cool` and `warm` are in at least one organisation's settings row, and an
 * enum that no longer contains them would fail the schema on read -- the
 * appearance would not load, and the screen that fixes it is the one that
 * would not render. Mapped to their nearest shadcn ramp by hue: `cool` was
 * hue 264, which is `gray`; `warm` was hue 70, nearest `stone` at 58.
 *
 * Kept rather than migrated in SQL because it costs nothing and a settings
 * row written by an older build can still arrive from a backup restore.
 */
const RETIRED_BASES: Record<string, AppearanceBase> = {
  cool: 'gray',
  warm: 'stone',
};

/** The stored value, or its replacement, or the default. Never throws. */
export function resolveAppearanceBase(stored: string | null | undefined): AppearanceBase {
  if (stored === null || stored === undefined) return 'stone';
  if ((APPEARANCE_BASES as readonly string[]).includes(stored)) return stored as AppearanceBase;
  return RETIRED_BASES[stored] ?? 'stone';
}

/**
 * Hue and chroma multiplier per ramp, from Tailwind v4's `theme.css`.
 *
 * `chroma` is a multiplier, not a chroma: `index.css` builds every neutral as
 * `calc(<step> * var(--base-k))`, where the steps were authored against stone.
 * So stone is 1 by definition and the others are their chroma over stone's --
 * zinc 0.016/0.013, gray 0.027/0.013, slate 0.046/0.013. Neutral is 0, which
 * is the point of neutral: no hue at all.
 */
export const APPEARANCE_BASE_TOKENS: Record<AppearanceBase, { hue: number; chroma: number }> = {
  stone: { hue: 58, chroma: 1 },
  zinc: { hue: 286, chroma: 1.23 },
  neutral: { hue: 0, chroma: 0 },
  gray: { hue: 264, chroma: 2.08 },
  slate: { hue: 257, chroma: 3.54 },
};

export const APPEARANCE_DENSITIES = ['comfortable', 'compact'] as const;
export type AppearanceDensity = (typeof APPEARANCE_DENSITIES)[number];
export const APPEARANCE_DENSITY_LABELS: Record<AppearanceDensity, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
};

export interface AccentPreset {
  readonly id: string;
  readonly label: string;
  readonly hue: number;
  readonly chroma: number;
}

/** Eight accents in fixed order; the first is the theme as shipped. */
/**
 * Every accent shadcn's themes offer, plus the rest of the ramp they come from.
 *
 * Hue and chroma are Tailwind v4's `-700` step, read from its own `theme.css`.
 * That step because this theme pins the accent's lightness at `oklch(0.457)`,
 * and 700 is the step that sits there -- a 600 chroma is more than the colour
 * can hold once it is darkened to 0.457, so it would flatten. The existing
 * `indigo` was already 277/0.24, which is indigo-700 exactly; the rest were
 * near misses and are now the real values.
 *
 * Ordered around the wheel rather than alphabetically, so the grid reads as a
 * spectrum and a person looking for "something greener" scans in one
 * direction. Slate sits last: it is the one that is deliberately not a colour.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'pink', label: 'Pink', hue: 4, chroma: 0.223 },
  { id: 'rose', label: 'Rose', hue: 17, chroma: 0.222 },
  { id: 'red', label: 'Red', hue: 27.5, chroma: 0.213 },
  { id: 'orange', label: 'Orange', hue: 38.4, chroma: 0.195 },
  { id: 'amber', label: 'Amber', hue: 49, chroma: 0.163 },
  { id: 'yellow', label: 'Yellow', hue: 66.4, chroma: 0.135 },
  { id: 'lime', label: 'Lime', hue: 131.6, chroma: 0.157 },
  { id: 'green', label: 'Green', hue: 150.1, chroma: 0.154 },
  { id: 'emerald', label: 'Emerald', hue: 165.6, chroma: 0.118 },
  { id: 'teal', label: 'Teal', hue: 186.4, chroma: 0.096 },
  { id: 'cyan', label: 'Cyan', hue: 223.1, chroma: 0.105 },
  { id: 'sky', label: 'Sky', hue: 242.7, chroma: 0.134 },
  { id: 'blue', label: 'Blue', hue: 264.4, chroma: 0.243 },
  { id: 'indigo', label: 'Indigo', hue: 277, chroma: 0.24 },
  { id: 'violet', label: 'Violet', hue: 292.6, chroma: 0.27 },
  { id: 'purple', label: 'Purple', hue: 301.9, chroma: 0.265 },
  { id: 'fuchsia', label: 'Fuchsia', hue: 323.9, chroma: 0.253 },
  { id: 'slate', label: 'Slate', hue: 257.3, chroma: 0.044 },
];

/**
 * The workspace typeface, as system stacks so nothing is fetched at runtime.
 * The same four the printed documents already offer, applied to the app font
 * token rather than the paper's, so a workspace reads in one voice.
 */
export const APPEARANCE_FONTS = ['sans', 'serif', 'humanist', 'mono'] as const;
export type AppearanceFont = (typeof APPEARANCE_FONTS)[number];
export const APPEARANCE_FONT_LABELS: Record<AppearanceFont, { label: string; note: string }> = {
  sans: { label: 'Sans', note: 'The default interface face.' },
  serif: { label: 'Serif', note: 'Georgia; a warmer, editorial feel.' },
  humanist: { label: 'Humanist', note: 'Trebuchet or Verdana; open and friendly.' },
  mono: { label: 'Typewriter', note: 'Monospaced throughout.' },
};

export const appearanceSchema = z.object({
  accentHue: z.number().min(0).max(360),
  accentChroma: z.number().min(0.02).max(0.3),
  /** Defaulted, so a settings row written before the typeface existed still parses. */
  font: z.enum(APPEARANCE_FONTS).default('sans'),
  /*
   * Preprocessed rather than a bare enum, so a base written by an older build
   * resolves instead of failing the whole object. Putting it here rather than
   * at each read site means no caller has to remember: the settings endpoint,
   * the shell's boot fetch and a restored backup all get the same answer.
   *
   * Forgiving on write too, which is deliberate. This is a display preference,
   * not a boundary worth a 400 -- a client that sends `cool` gets `gray` and a
   * page that looks right, rather than an error about a value it did not know
   * was retired.
   */
  base: z.preprocess(
    (value) => resolveAppearanceBase(typeof value === 'string' ? value : null),
    z.enum(APPEARANCE_BASES),
  ),
  density: z.enum(APPEARANCE_DENSITIES),
});
export type Appearance = z.infer<typeof appearanceSchema>;

export const DEFAULT_APPEARANCE: Appearance = { accentHue: 277, accentChroma: 0.24, base: 'stone', density: 'comfortable', font: 'sans' };

/** The preset a hue and chroma correspond to, if any; a custom hue has none. */
export function presetFor(appearance: Pick<Appearance, 'accentHue' | 'accentChroma'>): AccentPreset | null {
  return ACCENT_PRESETS.find((preset) => Math.abs(preset.hue - appearance.accentHue) < 0.5 && Math.abs(preset.chroma - appearance.accentChroma) < 0.005) ?? null;
}
