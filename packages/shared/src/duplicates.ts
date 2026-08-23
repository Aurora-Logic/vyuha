import { z } from 'zod';

import { pageQuerySchema } from './pagination.js';

/**
 * Area AO (docs/15): likely duplicates in the masters Tally sends --
 * detected after each pull, shown wherever the record appears, never
 * fixed here. Vyuha never merges, edits or deletes a master (D-01,
 * REQ-R-04); a cluster is marked sent to Tally and the next pull either
 * shows the merge or leaves it open. A duplicate-flagged record
 * highlights, never blocks (docs/11 D-55); clusters show from 0.75 and
 * a GSTIN or PAN match flags at full confidence regardless of name
 * (D-56), tunable in settings.
 */

export const DUPLICATE_ENTITY_TYPES = ['party', 'stock_item'] as const;
export type DuplicateEntityType = (typeof DUPLICATE_ENTITY_TYPES)[number];
export const DUPLICATE_ENTITY_LABELS: Record<DuplicateEntityType, string> = { party: 'Parties', stock_item: 'Stock items' };

export const DUPLICATE_CLUSTER_STATES = ['open', 'sent_to_tally', 'dismissed', 'resolved'] as const;
export type DuplicateClusterState = (typeof DUPLICATE_CLUSTER_STATES)[number];
export const DUPLICATE_CLUSTER_STATE_LABELS: Record<DuplicateClusterState, string> = {
  open: 'Open',
  sent_to_tally: 'Sent to Tally',
  dismissed: 'Genuinely different',
  resolved: 'Resolved',
};

/** The fields a match can rest on; the screen names them in this order. */
export const DUPLICATE_MATCH_FIELDS = ['gstin', 'pan', 'name', 'alias', 'phone', 'email', 'address', 'unit', 'group'] as const;
export type DuplicateMatchField = (typeof DUPLICATE_MATCH_FIELDS)[number];
export const DUPLICATE_MATCH_FIELD_LABELS: Record<DuplicateMatchField, string> = {
  gstin: 'GSTIN',
  pan: 'PAN',
  name: 'Name',
  alias: 'Alias or part number',
  phone: 'Phone',
  email: 'Email',
  address: 'Address',
  unit: 'Unit',
  group: 'Group',
};

/** What a list row carries when its record sits in an open cluster (REQ-AO-06/08). */
export interface DuplicateFlag {
  readonly clusterId: string;
  readonly confidence: number;
  readonly matchedFields: readonly DuplicateMatchField[];
  /** The other records in the cluster, by name. */
  readonly others: readonly string[];
}

export interface DuplicateClusterMember {
  readonly entityId: string;
  readonly name: string;
  /** What distinguishes the record at a glance: GSTIN and group for a party, alias and unit for an item. */
  readonly detail: string | null;
  readonly absentInTally: boolean;
}

export interface DuplicateClusterView {
  readonly id: string;
  readonly entityType: DuplicateEntityType;
  readonly confidence: number;
  readonly matchedFields: readonly DuplicateMatchField[];
  readonly state: DuplicateClusterState;
  readonly members: readonly DuplicateClusterMember[];
  /** REQ-AO-10: why this cluster matters more than the next. */
  readonly impact: {
    readonly openDocuments: number;
    readonly outstanding: string;
    readonly recentTransactions: number;
  };
  readonly dismissedReason: string | null;
  readonly dismissedByName: string | null;
  readonly dismissedAt: string | null;
  readonly sentToTallyAt: string | null;
  readonly detectedAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt: string | null;
}

export const duplicateClustersQuerySchema = pageQuerySchema.extend({
  entityType: z.enum(DUPLICATE_ENTITY_TYPES).optional(),
  state: z.enum(DUPLICATE_CLUSTER_STATES).optional(),
});
export type DuplicateClustersQuery = z.infer<typeof duplicateClustersQuerySchema>;

export const dismissDuplicateSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type DismissDuplicateInput = z.infer<typeof dismissDuplicateSchema>;

export const detectDuplicatesSchema = z.object({
  entityType: z.enum(DUPLICATE_ENTITY_TYPES).optional(),
});
export type DetectDuplicatesInput = z.infer<typeof detectDuplicatesSchema>;

export interface DuplicateDetectionResult {
  readonly entityType: DuplicateEntityType;
  readonly scanned: number;
  readonly clusters: number;
  readonly opened: number;
  readonly resolved: number;
  readonly reopened: number;
}

/** REQ-AO-04 / D-56: the threshold lives in settings, read by the detector and the screens. */
export const duplicatesPolicySchema = z.object({
  /** A cluster shows from this confidence; a GSTIN or PAN match is 1 regardless. */
  confidenceMin: z.number().min(0.5).max(1),
});
export type DuplicatesPolicy = z.infer<typeof duplicatesPolicySchema>;
export const DEFAULT_DUPLICATES_POLICY: DuplicatesPolicy = { confidenceMin: 0.75 };
