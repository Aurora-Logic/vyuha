import { z } from 'zod';

/**
 * Reports (owner, 26 Aug 2026): the observability pattern over the product's
 * own data. Four prebuilt areas -- each a page of metric cards over a time
 * range -- and custom reports a user composes from those same metrics.
 *
 * One contract serves both: an area endpoint returns `MetricView`s, and a
 * custom-report widget is a pointer at one of them (`area` + `metric`) plus
 * how to draw it. The builder therefore needs no data endpoints of its own,
 * and a widget can never show a figure its viewer's permissions would not
 * let them open on the area page -- the same endpoint, the same guard.
 */

export const INSIGHT_AREAS = ['attendance', 'receivables', 'sales', 'sync'] as const;

export type InsightArea = (typeof INSIGHT_AREAS)[number];

export const insightsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

/** How a headline and an axis print. Money stays text end to end (D-01). */
export type MetricUnit = 'count' | 'money' | 'minutes' | 'percent';

/** One day bucket. `t` is the day (YYYY-MM-DD); every other key is a series value. */
export type MetricPoint = { t: string } & Record<string, string | number>;

export interface MetricSeriesDef {
  /** The key inside each point, and the identity a legend names. */
  readonly key: string;
  readonly label: string;
}

export interface MetricBreakdownColumn {
  readonly key: string;
  readonly label: string;
  readonly numeric?: boolean;
  readonly unit?: MetricUnit;
}

/** The table under a chart -- Supabase's request list, our top parties. */
export interface MetricBreakdown {
  readonly columns: readonly MetricBreakdownColumn[];
  readonly rows: readonly Record<string, string | number>[];
}

export interface MetricView {
  readonly key: string;
  readonly label: string;
  /** The sentence behind the info glyph: what this figure is and is not. */
  readonly hint: string;
  readonly unit: MetricUnit;
  /**
   * What the x axis is made of. Days get date ticks; a category axis (an
   * ageing bucket) prints its labels verbatim. Absent means day.
   */
  readonly xKind?: 'day' | 'category';
  /** Range total or latest value, as text -- exact for money, digits for counts. */
  readonly headline: string;
  readonly series: readonly MetricSeriesDef[];
  readonly points: readonly MetricPoint[];
  readonly breakdown?: MetricBreakdown;
}

export interface AreaInsights {
  readonly area: InsightArea;
  readonly from: string;
  readonly to: string;
  readonly metrics: readonly MetricView[];
}

/* ------------------------------- custom reports ------------------------------- */

export const WIDGET_KINDS = ['bar', 'barh', 'line', 'area', 'donut', 'number', 'table'] as const;

export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** The named palettes a widget may choose; 'default' is the fresh multi-hue set. */
export const WIDGET_PALETTES = ['default', 'accent', 'blue', 'violet', 'amber', 'rose', 'teal'] as const;

export type WidgetPalette = (typeof WIDGET_PALETTES)[number];

/** Grid spans, not free resize: 1x1 half width, 2x1 full width, 2x2 full and tall. */
export const WIDGET_SIZES = ['1x1', '2x1', '2x2'] as const;

export type WidgetSize = (typeof WIDGET_SIZES)[number];

export const customWidgetSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(80),
  kind: z.enum(WIDGET_KINDS),
  size: z.enum(WIDGET_SIZES).default('1x1'),
  area: z.enum(INSIGHT_AREAS),
  metric: z.string().min(1).max(60),
  options: z
    .object({
      legend: z.boolean().default(true),
      dataLabels: z.boolean().default(false),
      /** The figure in a donut's centre, or the whole of a number card. */
      showTotal: z.boolean().default(true),
      palette: z.enum(WIDGET_PALETTES).default('default'),
      /** Drop the days on which nothing happened, the way Twenty's builder can. */
      omitZero: z.boolean().default(false),
      /** A pinned y range; absent means the data decides. */
      yMin: z.number().finite().optional(),
      yMax: z.number().finite().optional(),
    })
    .default({ legend: true, dataLabels: false, showTotal: true, palette: 'default', omitZero: false }),
});

export type CustomWidget = z.infer<typeof customWidgetSchema>;

export const customReportWriteSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Shared reports appear for everyone holding report.view; personal ones for their author. */
  shared: z.boolean().default(false),
  widgets: z.array(customWidgetSchema).max(24).default([]),
});

export type CustomReportWrite = z.infer<typeof customReportWriteSchema>;

export interface CustomReportView {
  readonly id: string;
  readonly name: string;
  readonly shared: boolean;
  readonly ownerUserId: string;
  readonly ownerName: string;
  /** Whether the caller may edit -- true only for the author. */
  readonly editable: boolean;
  readonly widgets: readonly CustomWidget[];
  readonly updatedAt: string;
}
