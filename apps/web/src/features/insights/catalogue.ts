import { PERMISSIONS, type InsightArea, type PermissionKey } from '@vyuha/shared';

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
  ],
  sales: [
    { key: 'orders-value', label: 'Sales orders' },
    { key: 'estimate-funnel', label: 'Estimates by state' },
    { key: 'invoices-value', label: 'Invoices' },
    { key: 'purchase-orders', label: 'Purchase orders' },
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
  /** Cards worth a full row even on wide screens (a breakdown table needs it). */
  readonly wide: readonly string[];
}

export const AREA_CONFIG: Record<InsightArea, AreaConfig> = {
  attendance: {
    description: 'The workforce day by day: who was in, who was late, and the overtime the engine credited.',
    lines: ['late-arrivals'],
    wide: ['attendance-mix'],
  },
  receivables: {
    description: 'Money as Tally wrote it: what was invoiced, what actually arrived, and every voucher in between.',
    lines: [],
    wide: ['invoiced'],
  },
  sales: {
    description: 'Documents raised here: orders and invoices by value, estimates and purchase orders by where they stand.',
    lines: [],
    wide: ['orders-value'],
  },
  sync: {
    description: 'The bridge to Tally: jobs finishing, exceptions raised, and how fresh the last pull is.',
    lines: ['pull-freshness'],
    wide: ['job-outcomes'],
  },
};
