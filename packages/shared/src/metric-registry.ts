/**
 * The metric registry (CFO brief Q4): one source for every definition --
 * id, plain label, technical name, formula, source, denominator, unit,
 * good direction, materiality floor, minimum sample, permission key,
 * version, effective from. Every screen reads labels and the "How is this
 * calculated?" panel from here, never from a hardcoded string, so one
 * definition change updates every screen and every export. A version
 * bump with an effective date is the change log (Q4).
 */

export type RegistryUnit = 'money' | 'count' | 'pct' | 'days' | 'score' | 'grade';
export type GoodDirection = 'up' | 'down' | 'none';

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly technicalName: string;
  /** Plain-English meaning, one or two sentences. */
  readonly meaning: string;
  readonly formula: string;
  readonly source: string;
  readonly denominator?: string;
  readonly unit: RegistryUnit;
  readonly good: GoodDirection;
  /** Rupees below which a change is shown as an amount, never a percent (Q1.1). */
  readonly materialityFloor?: number;
  /** Observations below which the metric abstains (Q1.1). */
  readonly minimumSample?: string;
  readonly excludes?: string;
  readonly permission: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly related?: readonly string[];
  /** Where in the module the figure is drawn today, or null while it waits on a decision. */
  readonly builtIn: string | null;
}

const V1 = '2026-08-27';
const SALES = 'cfo.sales.view';
const RECV = 'cfo.receivables.view';
const VOUCHERS = 'Sales and Credit Note vouchers pulled from Tally, cancelled excluded';
const FACT = 'fact_sales_daily (ex-GST, attributed as of voucher date)';
const SNAPSHOT = 'fact_receivable_snapshot (nightly photograph of the book)';

export const METRIC_REGISTRY: readonly MetricDefinition[] = [
  { id: 'R01', label: 'Gross sales', technicalName: 'gross', meaning: 'What was billed on Sales vouchers, before discounts, returns and GST.', formula: 'Σ Sales voucher value, ex-GST', source: FACT, unit: 'money', good: 'up', materialityFloor: 25_000, permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Sales analysis, pivot' },
  { id: 'R02', label: 'Trade discount', technicalName: 'discount', meaning: 'Money given away on the invoice: discount ledgers and line discounts.', formula: 'Σ discount ledger lines + line discounts', source: FACT, unit: 'money', good: 'down', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Pivot' },
  { id: 'R03', label: 'Sales returns', technicalName: 'returns', meaning: 'Goods that came back, valued at the credit note.', formula: 'Σ Credit Notes', source: FACT, unit: 'money', good: 'down', excludes: 'Credit notes are not yet split by nature (M4); every credit note counts here until they are.', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Pivot', related: ['R04'] },
  { id: 'R04', label: 'Rate difference and claims', technicalName: 'rate_diff', meaning: 'Margin leakage disguised as an adjustment, tracked apart from returns.', formula: 'Σ Credit Notes of nature "rate difference"', source: FACT, unit: 'money', good: 'down', permission: SALES, version: 1, effectiveFrom: V1, builtIn: null, related: ['R03'] },
  { id: 'R05', label: 'Net sales', technicalName: 'net', meaning: 'What the business actually sold, after discounts and returns, before GST.', formula: 'R01 − R02 − R03 − R04', source: FACT, unit: 'money', good: 'up', materialityFloor: 25_000, permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Sales analysis, league, My CFO, scorecard, pivot', related: ['R01', 'R02', 'R03'] },
  { id: 'R06', label: 'Return rate', technicalName: 'return_rate', meaning: 'How much of what is billed comes back.', formula: 'R03 ÷ R01', source: FACT, denominator: 'R01 gross sales', unit: 'pct', good: 'down', minimumSample: '20 invoices', permission: SALES, version: 1, effectiveFrom: V1, builtIn: null },
  { id: 'R07', label: 'Invoice count', technicalName: 'vouchers', meaning: 'Sales vouchers in the period.', formula: 'count(Sales vouchers)', source: VOUCHERS, unit: 'count', good: 'none', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Sales analysis, pivot' },
  { id: 'R09', label: 'Average order value', technicalName: 'aov', meaning: 'Net sales per invoice.', formula: 'R05 ÷ R07', source: FACT, denominator: 'R07 invoice count', unit: 'money', good: 'up', minimumSample: '20 invoices', permission: SALES, version: 1, effectiveFrom: V1, builtIn: null },
  { id: 'R11', label: 'Quantity', technicalName: 'qty', meaning: 'Units sold in the base unit of measure.', formula: 'Σ billed quantity (base UOM)', source: FACT, unit: 'count', good: 'up', excludes: 'Lines whose quantity cannot be parsed count as zero; mixed-UOM SKUs await a conversion table.', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Sales analysis, pivot' },
  { id: 'R12', label: 'Average realisation', technicalName: 'realisation', meaning: 'Net rupees per unit -- the price actually got.', formula: 'R05 ÷ R11', source: FACT, denominator: 'R11 quantity', unit: 'money', good: 'up', minimumSample: 'quantity above zero in both years for a price effect', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Growth bridge (price effect)' },

  { id: 'C01', label: 'Active customers', technicalName: 'active_customers', meaning: 'Customers billed in the period.', formula: 'count(distinct party with a Sales voucher)', source: VOUCHERS, unit: 'count', good: 'up', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Sales analysis' },
  { id: 'C02', label: 'New customers', technicalName: 'new_customers', meaning: 'First-time buyers: nothing in the prior 365 days.', formula: 'parties with sales in the window and none before it', source: VOUCHERS, unit: 'count', good: 'up', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Movement matrix, scorecard radar', related: ['C03'] },
  { id: 'C03', label: 'Reactivated', technicalName: 'reactivated', meaning: 'Dormant 180 days or more, then back.', formula: 'gap from last order before the window to first order inside it ≥ 180 days', source: VOUCHERS, unit: 'count', good: 'up', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Movement matrix' },
  { id: 'C05', label: 'Dormant', technicalName: 'dormant', meaning: 'No order for 90 days, but ordered in the prior twelve months.', formula: 'last Sales voucher between 90 and 365 days ago', source: VOUCHERS, unit: 'count', good: 'down', permission: SALES, version: 1, effectiveFrom: V1, builtIn: null },
  { id: 'C06', label: 'Lost', technicalName: 'lost', meaning: 'Bought last year, nothing this year.', formula: 'net > 0 in the same days last year and 0 in the window', source: VOUCHERS, unit: 'count', good: 'down', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Movement matrix, growth bridge (lost effect)' },
  { id: 'C12', label: 'Median order gap', technicalName: 'median_gap_days', meaning: 'A customer’s own rhythm: the middle gap between their orders.', formula: 'median(days between consecutive Sales vouchers, trailing 12m)', source: VOUCHERS, unit: 'days', good: 'down', minimumSample: '5 completed orders before the metric may accuse (Q1.1)', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Silent churn, frequency decline, desk urgency', related: ['C13'] },
  { id: 'C13', label: 'Order gap variance', technicalName: 'gap_widening', meaning: 'Recent gaps against their normal: widening means churning before they stop.', formula: 'mean(last 3 gaps) ÷ median(all gaps) > 1.3', source: VOUCHERS, unit: 'pct', good: 'down', minimumSample: '5 completed orders', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Frequency decline list, payment grade' },

  { id: 'M05', label: 'Pocket price', technicalName: 'net', meaning: 'What is actually realised after discounts, returns and rate differences -- the only price that should drive decisions.', formula: 'gross − discount − returns − rate difference', source: FACT, unit: 'money', good: 'up', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Margin waterfall', related: ['R05'] },
  { id: 'M06', label: 'Landed cost (proxy)', technicalName: 'landed_cost', meaning: 'The cost of the goods sold. Until M1 answers the valuation question, this is the master’s cost price -- a proxy, and it says so everywhere it appears.', formula: 'Σ qty × stock item cost price; null when any line of a grain has no cost', source: FACT, unit: 'money', good: 'down', excludes: 'Grains with any uncosted line, ledger-only vouchers, credit notes: their margin is null, never zero.', permission: 'cfo.margin.view', version: 1, effectiveFrom: V1, builtIn: 'Margin, pivot', related: ['M07'] },
  { id: 'M07', label: 'Pocket margin (proxy)', technicalName: 'pocket_margin', meaning: 'Pocket price less landed cost, on costed grains only, beside its coverage. K3: rupees need cfo.margin.view; a salesperson sees the percentage on their own book.', formula: 'M05 − M06, per grain; coverage = costed net ÷ net', source: FACT, unit: 'money', good: 'up', materialityFloor: 25_000, permission: 'cfo.margin.view', version: 1, effectiveFrom: V1, builtIn: 'Margin, league, scorecard, My CFO, pivot', related: ['M05', 'M06'] },
  { id: 'M13', label: 'Negative-margin grains', technicalName: 'negative_margin', meaning: 'Zero tolerance: a grain sold below its landed cost is named, not averaged away.', formula: 'grains where pocket margin < 0', source: FACT, unit: 'count', good: 'down', permission: 'cfo.margin.view', version: 1, effectiveFrom: V1, builtIn: 'Margin' },
  { id: 'D02', label: 'Ageing buckets', technicalName: 'ageing', meaning: 'Outstanding by how far past due, by due date not invoice date.', formula: 'current / 0-30 / 31-60 / 61-90 / 91-180 / 180+ days past due', source: SNAPSHOT, unit: 'money', good: 'down', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Credit control, scorecard, call sheet' },
  { id: 'D04', label: 'DSO, countback', technicalName: 'dso_countback', meaning: 'How many days of sales the book represents, consuming closing debtors against the most recent months -- accurate when sales are lumpy.', formula: 'consume closing debtors month by month backwards; whole months count their days, the last month pro rata', source: `${SNAPSHOT} and monthly net credit sales`, unit: 'days', good: 'down', minimumSample: 'six months of sales', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Credit control', related: ['D05', 'D07'] },
  { id: 'D05', label: 'Best possible DSO', technicalName: 'dso_best', meaning: 'The DSO if everyone paid on the due date: not-yet-due debtors only.', formula: 'current debtors ÷ credit sales × days', source: SNAPSHOT, unit: 'days', good: 'down', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Credit control', related: ['D04', 'D07'] },
  { id: 'D06', label: 'Collection effectiveness index', technicalName: 'cei', meaning: 'How much of what could have been collected was, unaffected by seasonality.', formula: '(opening AR + credit sales − closing AR) ÷ (opening AR + credit sales − closing current AR) × 100', source: SNAPSHOT, unit: 'pct', good: 'up', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Credit control' },
  { id: 'D07', label: 'Average days delinquent', technicalName: 'add', meaning: 'Days late, in one number.', formula: 'D04 − D05', source: SNAPSHOT, unit: 'days', good: 'down', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Credit control', related: ['D04', 'D05'] },
  { id: 'D10', label: 'Overdue', technicalName: 'overdue', meaning: 'Outstanding past its due date.', formula: 'Σ outstanding where bucket ≠ current', source: SNAPSHOT, unit: 'money', good: 'down', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Everywhere a book is shown' },
  { id: 'D11', label: 'Credit limit utilisation', technicalName: 'utilisation_pct', meaning: 'Outstanding against the customer’s limit.', formula: 'outstanding ÷ credit limit × 100', source: `${SNAPSHOT}; party credit limit from Tally`, denominator: 'credit limit', unit: 'pct', good: 'down', excludes: 'Open orders and unbilled dispatches are not yet included.', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Limit breaches, desk risk, payment grade' },
  { id: 'D17', label: 'Interest cost of credit extended', technicalName: 'delay_cost_per_year', meaning: 'What a late payer costs the business at the borrowing rate -- the most persuasive number in a collection call.', formula: 'overdue × annual rate ÷ 100 (per year)', source: `${SNAPSHOT}; rate from the interest module (M5)`, unit: 'money', good: 'down', permission: RECV, version: 1, effectiveFrom: V1, builtIn: 'Credit control, My CFO, call sheet' },
  { id: 'D18', label: 'Payment grade', technicalName: 'credit_grade', meaning: 'Will they pay? A to E from behaviour, nightly. Never the customer class, which is a person’s judgment.', formula: 'risk = days late/90 × 40 + overdue share × 25 + (utilisation − 80)/70 × 15 + gap widening × 10 + disputes/3 × 10; A < 20, B < 40, C < 60, D < 80, E', source: `${SNAPSHOT}, promises to pay, desk outcomes, order rhythm`, unit: 'grade', good: 'none', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Customer page, class × grade grid', related: ['D11', 'C13'] },

  { id: 'X01', label: 'Five-factor growth bridge', technicalName: 'growth_bridge', meaning: 'How last year’s net became this year’s: volume, price, mix, new customers, lost customers -- and the factors must sum to the change exactly.', formula: 'volume = (qTY − qLY) × pLY; price = (pTY − pLY) × qTY where both years have quantity; new and lost whole; mix = the retained residual', source: 'voucher lines at customer × SKU, ledger-only vouchers as their own line', unit: 'money', good: 'none', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Growth, scorecard', related: ['R05', 'R12', 'C02', 'C06'] },
  { id: 'X02', label: 'Desk priority score', technicalName: 'desk_score', meaning: 'Which customers to work on today, 0-100.', formula: 'value (log-scaled, × class multiplier) × 35 + urgency (max of overdue/90, days past gap/60) × 30 + risk × 20 + opportunity × 15 − 40 on cooldown', source: 'work lists, trailing-12m sales, promises, desk outcomes, customer class', unit: 'score', good: 'none', excludes: 'Opportunity reads zero until Phase 5 prices cross-sell and lost lines.', permission: SALES, version: 1, effectiveFrom: V1, builtIn: 'Director’s desk', related: ['D10', 'C12', 'D18'] },
  { id: 'Q01', label: 'Data health', technicalName: 'data_health', meaning: 'How far the inputs are from their targets, averaged over the checks that can run today.', formula: 'mean over measurable checks of max(0, 1 − (value − target) ÷ span)', source: 'Data Quality checks', unit: 'pct', good: 'up', permission: 'cfo.exceptions.view', version: 1, effectiveFrom: V1, builtIn: 'Data quality, overview' },
];

export function metricById(id: string): MetricDefinition | undefined {
  return METRIC_REGISTRY.find((m) => m.id === id);
}
