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

export const WIDGET_KINDS = [
  'bar',
  'barh',
  'line',
  'area',
  'donut',
  'pie',
  'radial',
  'number',
  'table',
  'heatmap',
  'pivot',
] as const;

export type WidgetKind = (typeof WIDGET_KINDS)[number];

/**
 * The named palettes a widget may choose. 'default' is the fresh multi-hue
 * set; the rest are single-hue families -- the original five plus the nine
 * Notion inks the owner supplied (26 Aug 2026), so a chart can wear the same
 * colour language as the product's surfaces. Values are only ever added
 * here: removing one would make every stored widget that chose it unreadable.
 */
export const WIDGET_PALETTES = [
  'default',
  'mixed',
  'accent',
  'blue',
  'violet',
  'amber',
  'rose',
  'teal',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'purple',
  'pink',
  'red',
] as const;

export type WidgetPalette = (typeof WIDGET_PALETTES)[number];

/** Grid spans, not free resize: 1x1 half width, 2x1 full width, 2x2 full and tall. */
export const WIDGET_SIZES = ['1x1', '2x1', '2x2'] as const;

export type WidgetSize = (typeof WIDGET_SIZES)[number];

/**
 * S1.1: a pivot is rows x columns x one metric over the sales fact, at
 * any scope. Dimensions are the level model's; metrics are registered
 * ones only -- never raw SQL, never a table name.
 */
export const PIVOT_DIMENSIONS = ['party', 'brand', 'item', 'category', 'salesperson', 'class', 'month', 'business_line'] as const;
export type PivotDimension = (typeof PIVOT_DIMENSIONS)[number];
export const PIVOT_COLUMNS = [...PIVOT_DIMENSIONS, 'compare'] as const;
export type PivotColumn = (typeof PIVOT_COLUMNS)[number];
export const PIVOT_METRICS = ['net', 'gross', 'discount', 'returns', 'qty', 'vouchers', 'landed', 'margin'] as const;
export type PivotMetric = (typeof PIVOT_METRICS)[number];

export const pivotSpecSchema = z.object({
  rows: z.enum(PIVOT_DIMENSIONS),
  columns: z.enum(PIVOT_COLUMNS).nullable().default(null),
  metric: z.enum(PIVOT_METRICS).default('net'),
  /**
   * S1.2: an optional arithmetic expression over the registered measures,
   * e.g. "net / vouchers". Parsed and unit-checked server-side; when
   * present it replaces the metric as the cell value (the metric still
   * ranks the top-N fold).
   */
  expr: z.string().trim().min(1).max(200).optional(),
  /** Rows kept, ranked by the metric; the rest fold into "Other". */
  top: z.number().int().min(5).max(100).default(20),
});
export type PivotSpec = z.infer<typeof pivotSpecSchema>;

export const customWidgetSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(80),
  kind: z.enum(WIDGET_KINDS),
  size: z.enum(WIDGET_SIZES).default('1x1'),
  area: z.enum(INSIGHT_AREAS),
  metric: z.string().min(1).max(60),
  /** Present when kind is 'pivot'; the area and metric are then ignored. */
  pivot: pivotSpecSchema.optional(),
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
      /* The per-kind detail the reference's chart blocks carry. */
      /** How a line or area bends: straight segments, smoothed, or stepped. */
      curve: z.enum(['linear', 'smooth', 'step']).default('linear'),
      /** Dots on line and area points. */
      points: z.boolean().default(true),
      /** Stack multi-series bars; off draws them grouped side by side. */
      stacked: z.boolean().default(true),
      /** Horizontal grid lines behind the plot. */
      grid: z.boolean().default(false),
      /** Axis titles, printed along each axis when given. */
      xTitle: z.string().trim().max(40).optional(),
      yTitle: z.string().trim().max(40).optional(),
      /** Only these series drawn; absent means all of them. */
      series: z.array(z.string().min(1).max(60)).max(12).optional(),
      /** Bar order along x: as the data comes, or ranked by value. */
      xOrder: z.enum(['natural', 'asc', 'desc']).default('natural'),
    })
    .default({
      legend: true,
      dataLabels: false,
      showTotal: true,
      palette: 'default',
      omitZero: false,
      curve: 'linear',
      points: true,
      stacked: true,
      grid: false,
      xOrder: 'natural',
    }),
});

export type CustomWidget = z.infer<typeof customWidgetSchema>;

export const customReportWriteSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  /** Shared reports appear for everyone holding report.view; personal ones for their author. */
  shared: z.boolean().default(false),
  widgets: z.array(customWidgetSchema).max(24).default([]),
});

export type CustomReportWrite = z.infer<typeof customReportWriteSchema>;

export interface CustomReportView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly shared: boolean;
  readonly ownerUserId: string;
  readonly ownerName: string;
  /** Whether the caller may edit -- true only for the author. */
  readonly editable: boolean;
  readonly widgets: readonly CustomWidget[];
  readonly updatedAt: string;
}
