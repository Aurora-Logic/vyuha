import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { formatMoney } from '@/lib/format';
import { parseOrThrow } from '@/lib/api/parse';

/**
 * The Virtual CFO's Phase 2 endpoints: the receivable book read as measures,
 * and the work lists (E1, E3) -- named parties with amounts and reasons.
 */

const creditOverviewSchema = z.object({
  asOf: z.string().nullable(),
  outstanding: z.string(),
  overdue: z.string(),
  buckets: z.record(z.string(), z.string()),
  dsoCountback: z.number().nullable(),
  bestPossibleDso: z.number().nullable(),
  addDays: z.number().nullable(),
  cei: z.number().nullable(),
  ageingTrend: z.array(z.object({ t: z.string() }).catchall(z.union([z.string(), z.number()]))),
  topOverdue: z.array(
    z.object({
      partyId: z.string().nullable(),
      party: z.string(),
      outstanding: z.string(),
      overdue: z.string(),
      oldestBill: z.string().nullable(),
      daysOverdue: z.number(),
      lastPayment: z.string().nullable(),
      costPerYear: z.string(),
    }),
  ),
});

export type CreditOverviewData = z.infer<typeof creditOverviewSchema>;

const workListRowSchema = z.object({
  partyId: z.string().nullable(),
  party: z.string(),
  amount: z.string(),
  reason: z.string(),
  daysOverdue: z.number().optional(),
  oldestBill: z.string().nullable().optional(),
  lastPayment: z.string().nullable().optional(),
  utilisationPct: z.number().optional(),
  medianGapDays: z.number().optional(),
  daysSinceLastOrder: z.number().optional(),
  declinePct: z.number().nullable().optional(),
});

const workListsSchema = z.object({
  asOf: z.string(),
  lists: z.array(
    z.object({ key: z.string(), label: z.string(), hint: z.string(), rows: z.array(workListRowSchema) }),
  ),
});

export type WorkListsData = z.infer<typeof workListsSchema>;
export type WorkListRowData = z.infer<typeof workListRowSchema>;

export function useCfoReceivables(
  range: { from: string; to: string },
  options: { enabled?: boolean } = {},
): UseQueryResult<CreditOverviewData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'receivables', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/receivables?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(creditOverviewSchema, body, 'credit overview');
    },
    staleTime: 60_000,
  });
}

export function useCfoWorkLists(options: { enabled?: boolean } = {}): UseQueryResult<WorkListsData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'work-lists'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/cfo/work-lists', { signal });
      return parseOrThrow(workListsSchema, body, 'work lists');
    },
    staleTime: 60_000,
  });
}

const bridgeSchema = z.object({
  lastYear: z.number(),
  thisYear: z.number(),
  change: z.number(),
  volumeEffect: z.number(),
  priceEffect: z.number(),
  mixEffect: z.number(),
  newCustomerEffect: z.number(),
  lostCustomerEffect: z.number(),
  reconciliationError: z.number(),
});

export type GrowthBridgeData = z.infer<typeof bridgeSchema>;

const movementSchema = z.object({
  cells: z.array(
    z.object({
      state: z.string(),
      band: z.string(),
      count: z.number(),
      amount: z.string(),
      parties: z.array(
        z.object({ partyId: z.string(), party: z.string(), thisYear: z.string(), lastYear: z.string() }),
      ),
    }),
  ),
});

export type MovementData = z.infer<typeof movementSchema>;
export type MovementCell = MovementData['cells'][number];

export function useGrowthBridge(
  range: { from: string; to: string },
  options: { enabled?: boolean } = {},
): UseQueryResult<GrowthBridgeData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'growth-bridge', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/growth-bridge?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(bridgeSchema, body, 'growth bridge');
    },
    staleTime: 60_000,
  });
}

export function useMovement(
  range: { from: string; to: string },
  options: { enabled?: boolean } = {},
): UseQueryResult<MovementData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'movement', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/movement?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(movementSchema, body, 'movement matrix');
    },
    staleTime: 60_000,
  });
}

export const deltaReadingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pct'), deltaAbs: z.number(), deltaPct: z.number() }),
  z.object({ kind: z.literal('abs-only'), deltaAbs: z.number(), reason: z.string() }),
  z.object({ kind: z.literal('new'), deltaAbs: z.number() }),
  z.object({ kind: z.literal('none'), reason: z.string() }),
]);

export type DeltaReadingData = z.infer<typeof deltaReadingSchema>;

/** Q1.1 spoken aloud: a small base gets rupees, never a percentage. */
export function deltaText(delta: DeltaReadingData): string {
  switch (delta.kind) {
    case 'pct':
      return `${delta.deltaPct >= 0 ? '+' : '\u2212'}${String(Math.abs(Math.round(delta.deltaPct)))}% vs last year`;
    case 'abs-only':
      return `${delta.deltaAbs >= 0 ? '+' : '\u2212'}${formatMoney(Math.abs(delta.deltaAbs).toFixed(2))} vs a small base`;
    case 'new':
      return 'New \u2014 nothing last year';
    case 'none':
      return 'Nothing in either year';
  }
}

const leagueSchema = z.array(
  z.object({
    ownerRef: z.string(),
    ownerEmail: z.string().nullable(),
    bookSize: z.number(),
    sales: z.string(),
    salesDelta: deltaReadingSchema,
    collections: z.string(),
    overdue: z.string(),
    target: z.string().nullable(),
    achievementPct: z.number().nullable(),
  }),
);

export type LeagueData = z.infer<typeof leagueSchema>;
export type LeagueRowData = LeagueData[number];

export function useLeague(
  range: { from: string; to: string },
  options: { enabled?: boolean } = {},
): UseQueryResult<LeagueData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'league', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/league?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(leagueSchema, body, 'league table');
    },
    staleTime: 60_000,
  });
}

const targetsSchema = z.array(z.object({ ownerRef: z.string(), month: z.string(), netTarget: z.string() }));

export type TargetsData = z.infer<typeof targetsSchema>;

export function useTargets(month: string, options: { enabled?: boolean } = {}): UseQueryResult<TargetsData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'targets', month],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/targets?month=${month}`, { signal });
      return parseOrThrow(targetsSchema, body, 'targets');
    },
    staleTime: 30_000,
  });
}

export async function saveTarget(input: { ownerRef: string; month: string; netTarget: string }): Promise<void> {
  await apiRequest('/cfo/targets', { method: 'PUT', body: input });
}

const radarAxisSchema = z.object({
  axis: z.string(),
  mine: z.number().nullable(),
  team: z.number().nullable(),
  note: z.string().optional(),
});

const scorecardSchema = z.object({
  ownerRef: z.string(),
  ownerEmail: z.string().nullable(),
  row: leagueSchema.element,
  teamSize: z.number(),
  radar: z.array(radarAxisSchema),
  bridge: bridgeSchema,
  movement: movementSchema,
  ageing: z.record(z.string(), z.string()),
  promises: z.object({ kept: z.number(), broken: z.number(), open: z.number() }),
  activity: z.object({ assigned: z.number(), closed: z.number() }),
});

export type ScorecardData = z.infer<typeof scorecardSchema>;

export function useScorecard(
  ownerRef: string,
  range: { from: string; to: string },
  options: { enabled?: boolean } = {},
): UseQueryResult<ScorecardData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'scorecard', ownerRef, range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(
        `/cfo/team/${encodeURIComponent(ownerRef)}?from=${range.from}&to=${range.to}`,
        { signal },
      );
      return parseOrThrow(scorecardSchema, body, 'scorecard');
    },
    staleTime: 60_000,
  });
}
