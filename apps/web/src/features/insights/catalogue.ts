import { PERMISSIONS, type InsightArea, type PermissionKey, type WidgetPalette } from '@vyuha/shared';

/**
 * What the four areas offer, named once: the sidebar, the overview, the
 * builder's source picker and the area pages all read this file, so a metric
 * cannot be called two things on two screens.
 */

export const AREA_LABELS: Record<InsightArea, string> = {
  attendance: 'Attendance',
  receivables: 'Receivables',
  sales: 'Sales & purchase',
  sync: 'Sync health',
};

export const AREA_GATES: Record<InsightArea, PermissionKey> = {
  attendance: PERMISSIONS.ATTENDANCE_VIEW_ALL,
  receivables: PERMISSIONS.RECEIVABLES_VIEW,
  sales: PERMISSIONS.SALES_DOCUMENT_VIEW_ALL,
  sync: PERMISSIONS.INTEGRATION_MANAGE,
};

/** The metrics each area endpoint answers, as the builder offers them. */
export const AREA_METRICS: Record<InsightArea, readonly { key: string; label: string }[]> = {
  attendance: [
    { key: 'attendance-mix', label: 'Attendance each day' },
    { key: 'late-arrivals', label: 'Late arrivals' },
    { key: 'overtime', label: 'Overtime' },
  ],
  receivables: [
    { key: 'invoiced', label: 'Invoiced' },
    { key: 'received', label: 'Received' },
    { key: 'voucher-mix', label: 'Vouchers by type' },
    { key: 'customer-ageing', label: 'Customer ageing' },
    { key: 'interest-exposure', label: 'Interest-bearing exposure' },
  ],
  sales: [
    { key: 'orders-value', label: 'Sales orders' },
    { key: 'estimate-funnel', label: 'Estimates by state' },
    { key: 'invoices-value', label: 'Invoices' },
    { key: 'purchase-orders', label: 'Purchase orders' },
    { key: 'stock-ageing', label: 'Stock ageing' },
  ],
  sync: [
    { key: 'job-outcomes', label: 'Sync jobs' },
    { key: 'exceptions', label: 'Sync exceptions' },
    { key: 'pull-freshness', label: 'Minutes since last pull' },
  ],
};

export interface AreaConfig {
  readonly description: string;
  /** Metrics drawn as a line rather than bars: rates and ages, not amounts. */
  readonly lines: readonly string[];
  /** Metrics drawn as a translucent area: balances that flow, not events. */
  readonly areas: readonly string[];
  /** Cards worth a full row even on wide screens (a breakdown table needs it). */
  readonly wide: readonly string[];
}

export const AREA_CONFIG: Record<InsightArea, AreaConfig> = {
  attendance: {
    description: 'The workforce day by day: who was in, who was late, and the overtime the engine credited.',
    lines: ['late-arrivals'],
    areas: [],
    wide: ['attendance-mix'],
  },
  receivables: {
    description: 'Money as Tally wrote it: what was invoiced, what arrived, the ageing of what has not, and the exposure interest runs on.',
    lines: [],
    areas: ['interest-exposure'],
    wide: ['invoiced', 'customer-ageing', 'interest-exposure'],
  },
  sales: {
    description: 'Documents raised here: orders and invoices by value, estimates and purchase orders by where they stand, and the stock that has stopped moving.',
    lines: [],
    areas: [],
    wide: ['orders-value', 'stock-ageing'],
  },
  sync: {
    description: 'The bridge to Tally: jobs finishing, exceptions raised, and how fresh the last pull is.',
    lines: ['pull-freshness'],
    areas: [],
    wide: ['job-outcomes'],
  },
};

/** A single-hue family, its steps far enough apart to stay five colours. */
const familyOf = (hue: number, chroma = 0.17): string[] =>
  [0.5, 0.58, 0.66, 0.74, 0.82].map((l) => `oklch(${String(l)} ${String(chroma)} ${String(hue)})`);

/**
 * Every palette a chart may draw in, in draw order. 'default' is the fresh
 * set: five fixed hues in zigzag lightness (see --fresh-N in index.css),
 * validated for colour-blind separation on both surfaces. The families are
 * one hue in five steps, for whoever asks the builder for a monochrome
 * widget on purpose.
 */
export const CHART_PALETTES: Record<WidgetPalette, readonly string[]> = {
  default: ['var(--fresh-1)', 'var(--fresh-2)', 'var(--fresh-3)', 'var(--fresh-4)', 'var(--fresh-5)'],
  accent: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'],
  blue: familyOf(250),
  violet: familyOf(295),
  amber: familyOf(75),
  rose: familyOf(15),
  teal: familyOf(200),
  // The nine Notion inks the owner supplied, measured to oklch and stepped in
  // lightness around each ink's own hue and chroma -- the muted Notion voice,
  // beside the saturated families above.
  gray: familyOf(91.5, 0.01),
  brown: familyOf(45.6, 0.076),
  orange: familyOf(55.7, 0.159),
  yellow: familyOf(76, 0.13),
  green: familyOf(158.4, 0.085),
  purple: familyOf(309.5, 0.12),
  pink: familyOf(350.4, 0.164),
  red: familyOf(25.8, 0.172),
};

export const PALETTE_LABELS: Record<WidgetPalette, string> = {
  default: 'Fresh (default)',
  accent: 'Accent shades',
  blue: 'Blue',
  violet: 'Violet',
  amber: 'Amber',
  rose: 'Rose',
  teal: 'Teal',
  gray: 'Notion gray',
  brown: 'Notion brown',
  orange: 'Notion orange',
  yellow: 'Notion yellow',
  green: 'Notion green',
  purple: 'Notion purple',
  pink: 'Notion pink',
  red: 'Notion red',
};
