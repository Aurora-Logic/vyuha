import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PERMISSIONS } from '@vyuha/shared';

import { InjectDatabase, type Database } from '../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../platform/rbac/principal.js';
import { CreditControlService } from './credit-control.service.js';
import { SalesAnalysisService } from './sales-analysis.service.js';

/**
 * Part L: the narrative generator consumes computed metric outputs only,
 * never raw rows, and may not state a number it was not given. Every
 * figure below is lifted from a service that already answers an endpoint
 * of its own; this class only arranges them into sentences. Decomposition
 * is described as the largest factor, never as the cause -- correlation
 * is not causation and the brief forbids pretending otherwise.
 */

export interface NarrativeAction {
  readonly text: string;
  readonly owner: string;
  readonly link: string;
}

export interface Narrative {
  readonly from: string;
  readonly to: string;
  readonly headline: string;
  readonly bridge: readonly { label: string; amount: string }[];
  readonly reconciliationError: string;
  readonly right: readonly { name: string; detail: string }[];
  readonly wrong: readonly { name: string; detail: string }[];
  readonly cash: readonly string[];
  readonly actions: readonly NarrativeAction[];
}

const lakh = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2)} crore`;
  if (abs >= 100_000) return `₹${(value / 100_000).toFixed(2)} lakh`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
};

@Injectable()
export class NarrativeService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly sales: SalesAnalysisService,
    private readonly credit: CreditControlService,
  ) {}

  async read(principal: Principal, from: string, to: string): Promise<Narrative> {
    const [analysis, bridge] = await Promise.all([
      this.sales.analyse(principal, from, to, {}),
      this.credit.bridge(principal, from, to),
    ]);

    const net = Number(analysis.summary.net);
    const lastYear = Number(analysis.summary.lastYear);
    const factors = [
      { label: 'Volume', amount: bridge.volumeEffect },
      { label: 'Price', amount: bridge.priceEffect },
      { label: 'Mix', amount: bridge.mixEffect },
      { label: 'New customers', amount: bridge.newCustomerEffect },
      { label: 'Lost customers', amount: bridge.lostCustomerEffect },
    ];
    const biggest = [...factors].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
    const pct = lastYear > 0 ? Math.round(((net - lastYear) / lastYear) * 100) : null;
    const direction = net >= lastYear
      ? pct === null ? `Net sales ${lakh(net)}, with nothing sold in the same days last year` : `Net sales ${lakh(net)}, up ${String(pct)}% on the same days last year`
      : `Net sales ${lakh(net)}, down ${String(Math.abs(pct ?? 0))}% on the same days last year`;
    const headline = biggest === undefined || net === 0
      ? `${direction}.`
      : `${direction}; the largest factor in the bridge was ${biggest.label.toLowerCase()} at ${lakh(biggest.amount)}.`;

    // Three right, three wrong, with names: the customer breakdown the
    // sales-analysis screen already shows, ranked by year-on-year delta.
    const parties = analysis.breakdowns.find((b) => b.level === 'party')?.rows ?? [];
    const deltas = parties
      .map((row) => ({ name: row.label, delta: Number(row.net) - Number(row.lastYear), net: Number(row.net) }))
      .filter((row) => row.delta !== 0);
    const right = [...deltas].sort((a, b) => b.delta - a.delta).slice(0, 3).filter((r) => r.delta > 0)
      .map((r) => ({ name: r.name, detail: `${lakh(r.delta)} ahead of the same days last year` }));
    const wrong = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, 3).filter((r) => r.delta < 0)
      .map((r) => ({ name: r.name, detail: `${lakh(r.delta)} behind the same days last year` }));

    const cash: string[] = [];
    if (hasPermission(principal, PERMISSIONS.CFO_RECEIVABLES_VIEW)) {
      // The prior window of the same length, for movement rather than a level.
      const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
      const prevTo = new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10);
      const prevFrom = new Date(Date.parse(prevTo) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const [now, prev] = await Promise.all([
        this.credit.receivables(principal, from, to),
        this.credit.receivables(principal, prevFrom, prevTo),
      ]);
      cash.push(`Outstanding ${lakh(Number(now.outstanding))}, of which ${lakh(Number(now.overdue))} overdue.`);
      if (now.dsoCountback !== null) {
        cash.push(prev.dsoCountback === null
          ? `DSO ${String(now.dsoCountback)} days by countback.`
          : `DSO ${String(now.dsoCountback)} days by countback, ${now.dsoCountback === prev.dsoCountback ? 'level with' : now.dsoCountback > prev.dsoCountback ? `up ${String(now.dsoCountback - prev.dsoCountback)} on` : `down ${String(prev.dsoCountback - now.dsoCountback)} on`} the prior ${String(days)} days.`);
      }
      if (now.cei !== null) cash.push(`CEI ${String(now.cei)}${prev.cei === null ? '' : ` (was ${String(prev.cei)})`}.`);
      if (now.addDays !== null) cash.push(`Average days delinquent ${String(now.addDays)}${prev.addDays === null ? '' : ` (was ${String(prev.addDays)})`}.`);
      cash.push('The full cash cycle needs purchase-side data the Tally projection does not carry yet; the receivables half above is complete.');
    }

    const actions = await this.doThisWeek(principal);

    return {
      from,
      to,
      headline,
      bridge: factors.map((f) => ({ label: f.label, amount: f.amount.toFixed(2) })),
      reconciliationError: bridge.reconciliationError.toFixed(2),
      right,
      wrong,
      cash,
      actions,
    };
  }

  /** Five actions, each naming a customer, each with an owner, each linked to the list it came from. */
  private async doThisWeek(principal: Principal): Promise<NarrativeAction[]> {
    if (!hasPermission(principal, PERMISSIONS.CFO_RECEIVABLES_VIEW)) return [];
    const workLists = await this.credit.workLists(principal);
    const picked: { partyId: string | null; party: string; reason: string; amount: string; listKey: string; listLabel: string }[] = [];
    for (const list of workLists.lists) {
      const row = list.rows.find((r) => !picked.some((p) => p.party === r.party));
      if (row === undefined) continue;
      picked.push({ partyId: row.partyId, party: row.party, reason: row.reason, amount: row.amount, listKey: list.key, listLabel: list.label });
      if (picked.length === 5) break;
    }
    const ids = picked.map((p) => p.partyId).filter((id): id is string => id !== null);
    const owners = ids.length === 0 ? { rows: [] as { partyId: string; email: string | null; ref: string }[] } : await this.db.execute<{ partyId: string; email: string | null; ref: string }>(sql`
      SELECT party_id AS "partyId", u.email, owner_ref AS ref
      FROM customer_owner_map m LEFT JOIN users u ON u.id::text = substr(m.owner_ref, 6)
      WHERE m.org_id = ${principal.orgId} AND m.party_id IN ${ids}
        AND m.effective_from <= now()::date AND (m.effective_to IS NULL OR m.effective_to >= now()::date)
    `);
    const ownerOf = new Map<string, string>();
    for (const o of owners.rows) {
      if (ownerOf.has(o.partyId)) continue;
      ownerOf.set(o.partyId, o.ref === 'HOUSE' ? 'House' : (o.email?.split('@')[0] ?? 'Former user'));
    }
    return picked.map((p) => ({
      text: `${p.party} — ${p.reason} (${lakh(Number(p.amount))}, from ${p.listLabel})`,
      owner: p.partyId === null ? 'Unassigned' : (ownerOf.get(p.partyId) ?? 'Unassigned'),
      link: `/reports/work-lists?list=${p.listKey}`,
    }));
  }
}
