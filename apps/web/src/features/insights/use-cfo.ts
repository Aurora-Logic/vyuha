import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
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
