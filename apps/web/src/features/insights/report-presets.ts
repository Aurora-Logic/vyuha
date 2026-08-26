import type { CustomWidget, WidgetKind, WidgetSize } from '@vyuha/shared';

import type { InsightArea } from '@vyuha/shared';

/**
 * Presets built from the report list the owner supplied (docs/18): every
 * entry the current metric catalogue can honestly express, named after the
 * numbered reports it realises. The rest of the list arrives as the CFO
 * phases land their metrics -- a preset here is never a promise of figures
 * that do not exist yet.
 */

interface PresetWidgetSeed {
  readonly title: string;
  readonly kind: WidgetKind;
  readonly size: WidgetSize;
  readonly area: InsightArea;
  readonly metric: string;
}

export interface ReportPreset {
  readonly id: string;
  readonly name: string;
  /** Which numbered reports from docs/18 this realises. */
  readonly covers: string;
  readonly description: string;
  readonly widgets: readonly PresetWidgetSeed[];
}

export const REPORT_PRESETS: readonly ReportPreset[] = [
  {
    id: 'sales-summary',
    name: 'Sales summary',
    covers: 'Reports 1, 2, 15',
    description: 'Orders and invoices by value over the period, and where every estimate stands.',
    widgets: [
      { title: 'Sales orders', kind: 'bar', size: '2x1', area: 'sales', metric: 'orders-value' },
      { title: 'Invoices', kind: 'area', size: '1x1', area: 'sales', metric: 'invoices-value' },
      { title: 'Estimates by state', kind: 'bar', size: '1x1', area: 'sales', metric: 'estimate-funnel' },
    ],
  },
  {
    id: 'daily-sales-register',
    name: 'Daily sales register',
    covers: 'Report 9',
    description: 'Day-wise invoicing as rows, with the received side beside it.',
    widgets: [
      { title: 'Invoiced, day by day', kind: 'table', size: '1x1', area: 'receivables', metric: 'invoiced' },
      { title: 'Received, day by day', kind: 'table', size: '1x1', area: 'receivables', metric: 'received' },
    ],
  },
  {
    id: 'receivables-summary',
    name: 'Receivables summary',
    covers: 'Reports 42, 43, 47',
    description: 'Invoiced against received, the ageing of what is open, and the exposure interest runs on.',
    widgets: [
      { title: 'Invoiced', kind: 'bar', size: '1x1', area: 'receivables', metric: 'invoiced' },
      { title: 'Received', kind: 'bar', size: '1x1', area: 'receivables', metric: 'received' },
      { title: 'Customer ageing', kind: 'bar', size: '1x1', area: 'receivables', metric: 'customer-ageing' },
      { title: 'Interest-bearing exposure', kind: 'area', size: '1x1', area: 'receivables', metric: 'interest-exposure' },
    ],
  },
  {
    id: 'customer-ageing',
    name: 'Customer ageing',
    covers: 'Report 43',
    description: 'The ageing buckets as bars, and the parties behind them as rows.',
    widgets: [
      { title: 'Ageing buckets', kind: 'bar', size: '2x1', area: 'receivables', metric: 'customer-ageing' },
      { title: 'Parties by outstanding', kind: 'table', size: '2x1', area: 'receivables', metric: 'customer-ageing' },
    ],
  },
  {
    id: 'collections-week',
    name: 'Collections',
    covers: 'Reports 44, 46',
    description: 'What arrived, day by day, against what was billed.',
    widgets: [
      { title: 'Received', kind: 'area', size: '2x1', area: 'receivables', metric: 'received' },
      { title: 'Invoiced', kind: 'line', size: '2x1', area: 'receivables', metric: 'invoiced' },
    ],
  },
  {
    id: 'stock-ageing',
    name: 'Stock ageing',
    covers: 'Report 61',
    description: 'How long stock has sat since it last moved, and the oldest items by name.',
    widgets: [
      { title: 'Items by idle age', kind: 'bar', size: '2x1', area: 'sales', metric: 'stock-ageing' },
      { title: 'Oldest items', kind: 'table', size: '2x1', area: 'sales', metric: 'stock-ageing' },
    ],
  },
  {
    id: 'attendance-summary',
    name: 'Attendance summary',
    covers: 'Workforce reports',
    description: 'The workforce day by day, late arrivals, and the overtime credited.',
    widgets: [
      { title: 'Attendance each day', kind: 'bar', size: '2x1', area: 'attendance', metric: 'attendance-mix' },
      { title: 'Late arrivals', kind: 'line', size: '1x1', area: 'attendance', metric: 'late-arrivals' },
      { title: 'Overtime', kind: 'area', size: '1x1', area: 'attendance', metric: 'overtime' },
    ],
  },
  {
    id: 'sync-health',
    name: 'Sync health',
    covers: 'Data-quality reports',
    description: 'Jobs finishing against failing, exceptions raised, and pull freshness.',
    widgets: [
      { title: 'Sync jobs', kind: 'bar', size: '2x1', area: 'sync', metric: 'job-outcomes' },
      { title: 'Sync exceptions', kind: 'line', size: '1x1', area: 'sync', metric: 'exceptions' },
      { title: 'Minutes since last pull', kind: 'line', size: '1x1', area: 'sync', metric: 'pull-freshness' },
    ],
  },
  {
    id: 'morning-glance',
    name: 'Morning glance',
    covers: 'Report 10, the pacing strip',
    description: 'Four headline numbers and the ageing, for the first look of the day.',
    widgets: [
      { title: 'Invoiced', kind: 'number', size: '1x1', area: 'receivables', metric: 'invoiced' },
      { title: 'Received', kind: 'number', size: '1x1', area: 'receivables', metric: 'received' },
      { title: 'Sales orders', kind: 'number', size: '1x1', area: 'sales', metric: 'orders-value' },
      { title: 'Open exceptions', kind: 'number', size: '1x1', area: 'sync', metric: 'exceptions' },
      { title: 'Customer ageing', kind: 'bar', size: '2x1', area: 'receivables', metric: 'customer-ageing' },
    ],
  },
];

/** A preset's widgets as real widgets: fresh ids, the house option defaults. */
export function widgetsOf(preset: ReportPreset): CustomWidget[] {
  return preset.widgets.map((seed, index) => ({
    id: `w${String(Date.now())}-${String(index)}`,
    title: seed.title,
    kind: seed.kind,
    size: seed.size,
    area: seed.area,
    metric: seed.metric,
    options: {
      legend: true,
      dataLabels: true,
      showTotal: true,
      palette: 'default',
      omitZero: false,
      curve: 'linear',
      points: true,
      stacked: true,
      grid: false,
      xOrder: 'natural',
    },
  }));
}
