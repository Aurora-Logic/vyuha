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
    margin: z.string().nullable(),
    marginPct: z.number().nullable(),
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

const breakdownRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  net: z.string(),
  lastYear: z.string(),
  qty: z.string(),
  vouchers: z.number(),
});

const salesAnalysisSchema = z.object({
  scope: z.array(z.object({ level: z.string(), key: z.string(), label: z.string() })),
  summary: z.object({
    net: z.string(),
    lastYear: z.string(),
    delta: deltaReadingSchema,
    qty: z.string(),
    customers: z.number(),
    vouchers: z.number(),
    unassignedNet: z.string(),
    unassignedPct: z.number(),
  }),
  trend: z.array(z.object({ t: z.string(), net: z.number(), lastYear: z.number() })),
  breakdowns: z.array(z.object({ level: z.string(), label: z.string(), rows: z.array(breakdownRowSchema) })),
});

export type SalesAnalysisData = z.infer<typeof salesAnalysisSchema>;
export type BreakdownRowData = z.infer<typeof breakdownRowSchema>;

export interface SalesScope {
  brand?: string;
  person?: string;
  party?: string;
  item?: string;
}

export function useSalesAnalysis(
  range: { from: string; to: string },
  scope: SalesScope,
  options: { enabled?: boolean } = {},
): UseQueryResult<SalesAnalysisData, Error> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  for (const [k, v] of Object.entries(scope)) if (typeof v === 'string' && v !== '') params.set(k, v);
  const qs = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'sales-analysis', qs],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/sales-analysis?${qs}`, { signal });
      return parseOrThrow(salesAnalysisSchema, body, 'sales analysis');
    },
    staleTime: 60_000,
  });
}

const deskReasonSchema = z.object({ key: z.string(), label: z.string(), reason: z.string(), amount: z.string() });

const deskRowSchema = z.object({
  rank: z.number(),
  partyId: z.string(),
  party: z.string(),
  ownerRef: z.string().nullable(),
  ownerLabel: z.string(),
  tierCode: z.string().nullable(),
  primary: deskReasonSchema,
  others: z.array(deskReasonSchema),
  atStake: z.string(),
  score: z.number(),
  breakdown: z.object({ value: z.number(), urgency: z.number(), risk: z.number(), opportunity: z.number(), cooldown: z.number() }),
  lastContact: z.object({ on: z.string(), outcome: z.string() }).nullable(),
});

const deskTodaySchema = z.object({
  date: z.string(),
  theme: z.object({ key: z.string(), label: z.string(), hint: z.string() }),
  mixed: z.boolean(),
  cap: z.number(),
  strip: z.object({ called: z.number(), outcomes: z.number(), collected: z.string(), orders: z.number(), orderValue: z.string() }),
  rows: z.array(deskRowSchema),
  qualified: z.number(),
});

export type DeskTodayData = z.infer<typeof deskTodaySchema>;
export type DeskRowData = z.infer<typeof deskRowSchema>;

const callSheetSchema = z.object({
  party: z.object({
    id: z.string(),
    name: z.string(),
    ownerLabel: z.string(),
    creditLimit: z.string().nullable(),
    since: z.string().nullable(),
  }),
  why: z.object({ primary: deskReasonSchema.nullable(), others: z.array(deskReasonSchema) }),
  numbers: z.object({
    thisYear: z.string(),
    lastYear: z.string(),
    delta: deltaReadingSchema,
    outstanding: z.string(),
    overdue: z.string(),
    ageing: z.record(z.string(), z.string()),
    maxDaysOverdue: z.number(),
    delayCostPerYear: z.string(),
    promisesMade: z.number(),
    promisesKept: z.number(),
  }),
  buys: z.object({
    top: z.array(z.object({ group: z.string(), share: z.number(), net: z.string() })),
    stopped: z.array(z.object({ group: z.string(), lastYear: z.string() })),
    shouldBuy: z.array(z.object({ partyId: z.string(), party: z.string(), category: z.string(), adoptionPct: z.number(), estimate: z.string() })),
  }),
  lastContact: z.object({ on: z.string(), outcome: z.string(), notes: z.string(), ownerLabel: z.string() }).nullable(),
  asks: z.array(z.string()),
  recent: z.array(
    z.object({ on: z.string(), outcome: z.string(), amount: z.string().nullable(), nextDate: z.string().nullable(), notes: z.string() }),
  ),
});

export type CallSheetData = z.infer<typeof callSheetSchema>;

export const DESK_OUTCOME_LABELS: Record<string, string> = {
  ORDER_PLACED: 'Order placed',
  PROMISE_TO_PAY: 'Promise to pay',
  PARTIAL_PAYMENT: 'Partial payment',
  NO_RESPONSE: 'No response',
  DISPUTE_RAISED: 'Dispute raised',
  NOT_INTERESTED: 'Not interested',
  WRONG_CONTACT: 'Wrong contact',
  CALL_AGAIN: 'Call again on a date',
};

export function useDeskToday(options: { cap: number; mixed: boolean; enabled?: boolean }): UseQueryResult<DeskTodayData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'desk', options.cap, options.mixed],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/desk?cap=${String(options.cap)}&mixed=${options.mixed ? '1' : '0'}`, { signal });
      return parseOrThrow(deskTodaySchema, body, "director's desk");
    },
    staleTime: 60_000,
  });
}

export function useCallSheet(partyId: string | null): UseQueryResult<CallSheetData, Error> {
  return useQuery({
    enabled: partyId !== null,
    queryKey: ['cfo', 'desk', 'sheet', partyId],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/desk/${partyId ?? ''}`, { signal });
      return parseOrThrow(callSheetSchema, body, 'call sheet');
    },
    staleTime: 30_000,
  });
}

export async function logDeskOutcome(
  partyId: string,
  body: { outcome: string; amount?: string; nextDate?: string; notes?: string },
): Promise<void> {
  await apiRequest(`/cfo/desk/${partyId}/outcome`, { method: 'POST', body });
}

const qualityCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  unit: z.enum(['pct', 'count']),
  target: z.number(),
  health: z.number().nullable(),
  fix: z.string(),
  drill: z.string().nullable(),
  note: z.string().optional(),
});

const dataQualitySchema = z.object({
  asOf: z.string(),
  headline: z.number().nullable(),
  checks: z.array(qualityCheckSchema),
});

export type DataQualityData = z.infer<typeof dataQualitySchema>;
export type QualityCheckData = z.infer<typeof qualityCheckSchema>;

export function useDataQuality(options: { enabled?: boolean } = {}): UseQueryResult<DataQualityData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'data-quality'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/cfo/data-quality', { signal });
      return parseOrThrow(dataQualitySchema, body, 'data quality');
    },
    staleTime: 120_000,
  });
}

const penetrationSchema = z.object({
  from: z.string(),
  to: z.string(),
  categories: z.array(z.string()),
  customers: z.array(z.object({ partyId: z.string(), party: z.string(), total: z.string(), filled: z.number() })),
  cells: z.array(z.object({ partyId: z.string(), category: z.string(), count: z.number(), amount: z.string() })),
  columnTotals: z.record(z.string(), z.object({ count: z.number(), amount: z.string() })),
});

export type PenetrationData = z.infer<typeof penetrationSchema>;

export function usePenetration(
  range: { from: string; to: string },
  options: { enabled?: boolean } = {},
): UseQueryResult<PenetrationData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'penetration', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/penetration?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(penetrationSchema, body, 'penetration grid');
    },
    staleTime: 60_000,
  });
}

const tierRowSchema = z.object({
  code: z.string(),
  label: z.string(),
  description: z.string(),
  colourToken: z.string(),
  creditDays: z.number().nullable(),
  creditLimit: z.string().nullable(),
  maxDiscountPct: z.string().nullable(),
  contactEveryDays: z.number().nullable(),
  servicePriority: z.string(),
  reviewEvery: z.string(),
  sortOrder: z.number(),
  assigned: z.number(),
});

export type TierRowData = z.infer<typeof tierRowSchema>;

export function useTiers(options: { enabled?: boolean } = {}): UseQueryResult<TierRowData[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'tiers'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/cfo/tiers', { signal });
      return parseOrThrow(z.array(tierRowSchema), body, 'customer classes');
    },
    staleTime: 300_000,
  });
}

export async function saveTier(row: Omit<TierRowData, 'assigned'>): Promise<void> {
  await apiRequest('/cfo/tiers', { method: 'PUT', body: row });
}

export async function deleteTier(code: string): Promise<void> {
  await apiRequest(`/cfo/tiers/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

const gradeReadingSchema = z.object({
  grade: z.enum(['A', 'B', 'C', 'D', 'E']),
  risk: z.number(),
  breakdown: z.record(z.string(), z.number()),
});

const tierAssignmentSchema = z.object({
  tierCode: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  assignedBy: z.string(),
  reason: z.string(),
});

const partyClassSchema = z.object({
  partyId: z.string(),
  current: tierAssignmentSchema.nullable(),
  history: z.array(tierAssignmentSchema),
  grade: gradeReadingSchema.nullable(),
});

export type PartyClassData = z.infer<typeof partyClassSchema>;

export function usePartyClass(partyId: string | null, options: { enabled?: boolean } = {}): UseQueryResult<PartyClassData, Error> {
  return useQuery({
    enabled: (options.enabled ?? true) && partyId !== null,
    queryKey: ['cfo', 'party-class', partyId],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/parties/${partyId ?? ''}/class`, { signal });
      return parseOrThrow(partyClassSchema, body, 'customer class');
    },
    staleTime: 60_000,
  });
}

export async function assignClass(partyId: string, body: { tierCode: string; reason: string; effectiveFrom: string }): Promise<void> {
  await apiRequest(`/cfo/parties/${partyId}/class`, { method: 'PUT', body });
}

const classGradeSchema = z.object({
  classes: z.array(z.string()),
  grades: z.array(z.string()),
  unclassed: z.object({ count: z.number(), amount: z.string() }),
  cells: z.array(
    z.object({
      tierCode: z.string(),
      grade: z.string(),
      count: z.number(),
      amount: z.string(),
      parties: z.array(z.object({ partyId: z.string(), party: z.string(), outstanding: z.string() })),
    }),
  ),
});

export type ClassGradeData = z.infer<typeof classGradeSchema>;

export function useClassGrade(options: { enabled?: boolean } = {}): UseQueryResult<ClassGradeData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'class-grade'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/cfo/class-grade', { signal });
      return parseOrThrow(classGradeSchema, body, 'class and grade grid');
    },
    staleTime: 60_000,
  });
}

const pivotResultSchema = z.object({
  rows: z.array(z.object({ key: z.string(), label: z.string(), total: z.number() })),
  columns: z.array(z.object({ key: z.string(), label: z.string(), total: z.number() })),
  cells: z.array(z.object({ row: z.string(), column: z.string(), value: z.number() })),
  grandTotal: z.number(),
  metric: z.string(),
  unit: z.enum(['money', 'count', 'ratio']),
});

export type PivotResultData = z.infer<typeof pivotResultSchema>;

export interface PivotSpecInput {
  rows: string;
  columns: string | null;
  metric: string;
  expr?: string | undefined;
  top: number;
}

export function usePivot(
  range: { from: string; to: string },
  spec: PivotSpecInput,
  scope: SalesScope = {},
  options: { enabled?: boolean } = {},
): UseQueryResult<PivotResultData, Error> {
  const params = new URLSearchParams({ from: range.from, to: range.to, rows: spec.rows, metric: spec.metric, top: String(spec.top) });
  if (spec.columns !== null) params.set('columns', spec.columns);
  if (spec.expr !== undefined && spec.expr.trim() !== '') params.set('expr', spec.expr.trim());
  for (const [k, v] of Object.entries(scope)) if (typeof v === 'string' && v !== '') params.set(k, v);
  const qs = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'pivot', qs],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/pivot?${qs}`, { signal });
      return parseOrThrow(pivotResultSchema, body, 'pivot');
    },
    staleTime: 60_000,
  });
}

export const PIVOT_DIMENSION_LABELS: Record<string, string> = {
  party: 'Customer',
  brand: 'Brand',
  item: 'Product',
  category: 'Category',
  salesperson: 'Salesperson',
  class: 'Customer class',
  month: 'Month',
  business_line: 'Business line',
  compare: 'This period vs last year',
};

export const PIVOT_METRIC_LABELS: Record<string, string> = {
  net: 'Net sales',
  landed: 'Landed cost (proxy)',
  margin: 'Pocket margin (proxy)',
  gross: 'Gross sales',
  discount: 'Discount',
  returns: 'Returns',
  qty: 'Quantity',
  vouchers: 'Vouchers',
};

const exceptionRowSchema = z.object({
  checkKey: z.string(),
  voucherId: z.string(),
  voucherNumber: z.string(),
  voucherType: z.string(),
  voucherDate: z.string(),
  party: z.string(),
  partyId: z.string().nullable(),
  amount: z.string(),
  reason: z.string(),
  review: z.object({ state: z.string(), reason: z.string(), reviewedAt: z.string() }).nullable(),
});

const exceptionsSchema = z.object({
  asOf: z.string(),
  from: z.string(),
  to: z.string(),
  checks: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      hint: z.string(),
      rows: z.array(exceptionRowSchema),
      available: z.boolean(),
      note: z.string().optional(),
    }),
  ),
  open: z.number(),
});

export type ExceptionsData = z.infer<typeof exceptionsSchema>;
export type ExceptionRowData = z.infer<typeof exceptionRowSchema>;

export function useExceptions(range: { from: string; to: string }, options: { enabled?: boolean } = {}): UseQueryResult<ExceptionsData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'exceptions', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/exceptions?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(exceptionsSchema, body, 'exceptions');
    },
    staleTime: 60_000,
  });
}

export async function reviewException(body: { checkKey: string; voucherId: string; state: 'accepted' | 'investigating'; reason: string }): Promise<void> {
  await apiRequest('/cfo/exceptions/review', { method: 'POST', body });
}

const weekCloseSchema = z.object({
  from: z.string(),
  to: z.string(),
  planned: z.number(),
  called: z.number(),
  outcomes: z.array(z.object({ outcome: z.string(), count: z.number(), amount: z.string() })),
  targeted: z.string(),
  collected: z.string(),
  ordersWon: z.object({ count: z.number(), value: z.string() }),
  rollovers: z.array(z.object({ partyId: z.string(), party: z.string(), reason: z.string(), atStake: z.string() })),
  byOwner: z.array(z.object({ ownerRef: z.string(), ownerLabel: z.string(), planned: z.number(), called: z.number() })),
});

export type WeekCloseData = z.infer<typeof weekCloseSchema>;

export function useWeekClose(week: string, options: { enabled?: boolean } = {}): UseQueryResult<WeekCloseData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'desk', 'week-close', week],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/desk/week-close?week=${week}`, { signal });
      return parseOrThrow(weekCloseSchema, body, 'week close');
    },
    staleTime: 60_000,
  });
}

/** The Monday of the week holding `day` (ISO date), as an ISO date. */
export function mondayOf(day: string): string {
  const d = new Date(Date.parse(day));
  const weekday = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((weekday + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const plannerSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.array(
    z.object({
      date: z.string(),
      theme: z.object({ key: z.string(), label: z.string(), hint: z.string() }),
      rows: z.array(deskRowSchema),
      atStake: z.string(),
    }),
  ),
  byOwner: z.array(z.object({ ownerLabel: z.string(), names: z.number(), atStake: z.string() })),
});

export type PlannerData = z.infer<typeof plannerSchema>;

export function usePlanner(week: string, cap: number, options: { enabled?: boolean } = {}): UseQueryResult<PlannerData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'desk', 'planner', week, cap],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/desk/planner?week=${week}&cap=${String(cap)}`, { signal });
      return parseOrThrow(plannerSchema, body, 'week planner');
    },
    staleTime: 60_000,
  });
}

const alertReasonSchema = z.object({ key: z.string(), label: z.string(), why: z.string(), amount: z.string(), immediate: z.boolean() });

const alertsSchema = z.object({
  asOf: z.string(),
  alerts: z.array(
    z.object({
      partyId: z.string().nullable(),
      subject: z.string(),
      exposure: z.string(),
      since: z.string().nullable(),
      reasons: z.array(alertReasonSchema),
      action: z.string(),
      snoozed: z.object({ until: z.string(), reason: z.string() }).nullable(),
    }),
  ),
  digest: z.object({ count: z.number(), exposure: z.string() }),
  companyAlerts: z.array(alertReasonSchema),
  cap: z.number(),
});

export type AlertsData = z.infer<typeof alertsSchema>;
export type AlertData = AlertsData['alerts'][number];

export function useAlerts(options: { enabled?: boolean } = {}): UseQueryResult<AlertsData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'alerts'],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>('/cfo/alerts', { signal });
      return parseOrThrow(alertsSchema, body, 'alerts');
    },
    staleTime: 60_000,
  });
}

export async function snoozeAlert(body: { alertKey: string; partyId: string | null; until: string; reason: string }): Promise<void> {
  await apiRequest('/cfo/alerts/snooze', { method: 'POST', body });
}

const marginSchema = z.object({
  coveragePct: z.number(),
  waterfall: z.array(z.object({ key: z.string(), label: z.string(), amount: z.string() })),
  slices: z.array(
    z.object({
      level: z.string(),
      label: z.string(),
      rows: z.array(z.object({ key: z.string(), label: z.string(), net: z.string(), margin: z.string().nullable(), marginPct: z.number().nullable() })),
    }),
  ),
  negativeGrains: z.array(z.object({ day: z.string(), party: z.string(), item: z.string(), net: z.string(), margin: z.string() })),
});

export type MarginData = z.infer<typeof marginSchema>;

export function useMargin(
  range: { from: string; to: string },
  scope: SalesScope = {},
  options: { enabled?: boolean } = {},
): UseQueryResult<MarginData, Error> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  for (const [k, v] of Object.entries(scope)) if (typeof v === 'string' && v !== '') params.set(k, v);
  const qs = params.toString();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'margin', qs],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/margin?${qs}`, { signal });
      return parseOrThrow(marginSchema, body, 'margin');
    },
    staleTime: 60_000,
  });
}

const slabRowSchema = z.object({
  id: z.string(),
  brand: z.string(),
  label: z.string(),
  threshold: z.string(),
  basis: z.string(),
  period: z.string(),
  reward: z.string(),
  active: z.boolean(),
  progress: z.string(),
  distance: z.string(),
  attainedPct: z.number(),
  daysLeft: z.number(),
});

const brandRowSchema = z.object({
  brand: z.string(),
  net: z.string(),
  lastYear: z.string(),
  delta: deltaReadingSchema,
  sharePct: z.number(),
  qty: z.string(),
  realisation: z.string().nullable(),
  realisationLy: z.string().nullable(),
  margin: z.string().nullable(),
  marginPct: z.number().nullable(),
  target: z.string().nullable(),
  achievementPct: z.number().nullable(),
  categories: z.array(z.object({ category: z.string(), net: z.string() })),
  slabs: z.array(slabRowSchema),
});

const brandsSchema = z.object({ brands: z.array(brandRowSchema), asOf: z.string() });

export type BrandRowData = z.infer<typeof brandRowSchema>;
export type SlabRowData = z.infer<typeof slabRowSchema>;

export function useBrands(range: { from: string; to: string }, options: { enabled?: boolean } = {}): UseQueryResult<z.infer<typeof brandsSchema>, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'brands', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/brands?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(brandsSchema, body, 'brand performance');
    },
    staleTime: 60_000,
  });
}

export async function saveSlab(body: { id?: string; brand: string; label: string; threshold: string; reward: string; active: boolean }): Promise<void> {
  await apiRequest('/cfo/brand-slabs', { method: 'PUT', body });
}

export async function deleteSlab(id: string): Promise<void> {
  await apiRequest(`/cfo/brand-slabs/${id}`, { method: 'DELETE' });
}

const priceBandSchema = z.object({
  itemId: z.string(),
  item: z.string(),
  qty: z.string(),
  net: z.string(),
  min: z.string(),
  p25: z.string(),
  median: z.string(),
  p75: z.string(),
  max: z.string(),
  recoverable: z.string(),
});

export type PriceBandData = z.infer<typeof priceBandSchema>;

export function usePriceBands(range: { from: string; to: string }, options: { enabled?: boolean } = {}): UseQueryResult<PriceBandData[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'price-bands', range.from, range.to],
    queryFn: async ({ signal }) => {
      const body = await apiRequest<unknown>(`/cfo/price-bands?from=${range.from}&to=${range.to}`, { signal });
      return parseOrThrow(z.array(priceBandSchema), body, 'price bands');
    },
    staleTime: 60_000,
  });
}

const abcXyzSchema = z.object({
  cells: z.array(z.object({ abc: z.string(), xyz: z.string(), count: z.number(), net: z.string(), items: z.array(z.object({ itemId: z.string(), item: z.string(), net: z.string() })) })),
});

export type AbcXyzData = z.infer<typeof abcXyzSchema>;

export function useAbcXyz(options: { enabled?: boolean } = {}): UseQueryResult<AbcXyzData, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'abc-xyz'],
    queryFn: async ({ signal }) => parseOrThrow(abcXyzSchema, await apiRequest<unknown>('/cfo/abc-xyz', { signal }), 'ABC-XYZ'),
    staleTime: 300_000,
  });
}

const cohortSchema = z.object({ cohort: z.string(), size: z.number(), retention: z.array(z.number()) });

export function useCohorts(options: { enabled?: boolean } = {}): UseQueryResult<z.infer<typeof cohortSchema>[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'cohorts'],
    queryFn: async ({ signal }) => parseOrThrow(z.array(cohortSchema), await apiRequest<unknown>('/cfo/cohorts', { signal }), 'cohorts'),
    staleTime: 300_000,
  });
}

const concentrationSchema = z.object({
  top5Pct: z.number(),
  top10Pct: z.number(),
  hhi: z.number(),
  top5PctLy: z.number().nullable(),
  hhiLy: z.number().nullable(),
});

export function useConcentration(options: { enabled?: boolean } = {}): UseQueryResult<z.infer<typeof concentrationSchema>, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'concentration'],
    queryFn: async ({ signal }) => parseOrThrow(concentrationSchema, await apiRequest<unknown>('/cfo/concentration', { signal }), 'concentration'),
    staleTime: 300_000,
  });
}

const catalogueSchema = z.array(z.object({ report: z.string(), title: z.string(), blurb: z.string() }));
const scheduleRowSchema = z.object({ id: z.string(), report: z.string(), cadence: z.string(), recipients: z.string(), lastRunOn: z.string().nullable() });

export type ScheduleRowData = z.infer<typeof scheduleRowSchema>;

export function useExportCatalogue(options: { enabled?: boolean } = {}): UseQueryResult<z.infer<typeof catalogueSchema>, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'export-catalogue'],
    queryFn: async ({ signal }) => parseOrThrow(catalogueSchema, await apiRequest<unknown>('/cfo/export-catalogue', { signal }), 'export catalogue'),
    staleTime: 300_000,
  });
}

export function useSchedules(options: { enabled?: boolean } = {}): UseQueryResult<ScheduleRowData[], Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['cfo', 'schedules'],
    queryFn: async ({ signal }) => parseOrThrow(z.array(scheduleRowSchema), await apiRequest<unknown>('/cfo/schedules', { signal }), 'schedules'),
    staleTime: 60_000,
  });
}

export async function saveSchedule(body: { id?: string; report: string; cadence: string; recipients: string }): Promise<void> {
  await apiRequest('/cfo/schedules', { method: 'PUT', body });
}

export async function deleteSchedule(id: string): Promise<void> {
  await apiRequest(`/cfo/schedules/${id}`, { method: 'DELETE' });
}
