# PART S — CUSTOM BUILDER AND LIFECYCLE MODELS

**Prompt for Claude Code.** Add the following to the Vyuha Virtual CFO module. The existing
brief already covers period comparison (Part B2), custom date ranges, saved views (R5),
customer movement states (D2), RFM (D3) and cohorts (D4). **Do not rebuild those.** Add
only what is below, and reuse the existing metric registry, period engine, level model and
report engine. Logic only — UI follows the existing design context.

---

## S1. Custom report builder

Users must be able to create their own reports without a developer.

### S1.1 What the user assembles

| Choice | From |
|---|---|
| Level | Company / business line / brand / person / customer (the existing level model) |
| Rows (dimension) | Customer, customer group, class, product, category, brand, salesperson, territory, godown, transporter, month, quarter, ageing bucket, payment grade |
| Columns | A second dimension, or the period comparison |
| Metrics | Any registered metric from Part C — multi-select |
| Period and comparison | The existing period engine, unchanged |
| Filters | Any dimension, any metric threshold (e.g. margin % below 12, overdue above ₹1 lakh) |
| Sort, group, subtotal | Any selected column |
| Render type | Chosen automatically from the shape of the selection, overridable by the user (Part R4) |

### S1.2 Calculated fields

Users may define derived fields as expressions **over registered metrics only** —
`(net_sales - landed_cost) / net_sales`, `overdue / outstanding`. Never raw SQL, never
direct table access. Validate the expression, check unit compatibility, and reject a
division whose denominator can be zero without a guard.

Calculated fields inherit the materiality floor and minimum-sample rules from Part Q1.

### S1.3 Saving, sharing, scheduling

- Save with a name and description; appears in the report catalogue under "Custom".
- Share with named users or roles. **The viewer's permissions apply, not the author's** — a
  custom report containing margin must return blanks for someone without `cfo.margin.view`,
  and say so on screen rather than failing silently.
- Schedule any custom report for email delivery, same mechanism as standard reports.
- Version the definition; changing a shared report notifies its subscribers.

### S1.4 Custom KPI cards and custom alerts

- **Custom KPI card:** any metric + level + period + comparison, pinned to the user's own
  dashboard. Maximum 12 per user.
- **Custom alert:** metric + operator + threshold + scope + evaluation frequency + recipients.
  Inherits all the alert discipline rules in Part Q5 — minimum value floor, two-evaluation
  confirmation, hysteresis, daily cap, deduplication.

### S1.5 Guardrails

Custom reports must not become a way around controls. They inherit, without exception:
permission keys, materiality floors, minimum-sample suppression, the party merge map, and
export audit logging. Row limits and query timeouts apply; a custom report that would scan
more than a configured row count is refused with an explanation, not left to run.

---

## S2. Customer lifecycle

The existing movement states are a period-over-period comparison. This is a persistent
lifecycle with stages, dated transitions and time-in-stage.

### S2.1 Stages

| Stage | Entry rule | Exit |
|---|---|---|
| **Prospect** | In the system, never billed | First invoice |
| **First order** | First invoice raised | Second invoice, or 90 days elapsed |
| **Onboarding** | Days 1–90 from first invoice | Day 91 |
| **Growing** | Revenue rising vs own trailing 3-month average, 2 consecutive periods | Flattens or declines |
| **Established** | 12+ months active, revenue within ±15% of own average | Growth or decline |
| **At risk** | Order gap beyond 1.5× own median, or revenue down >25%, or payment grade fell to D/E | Recovers, or goes dormant |
| **Dormant** | No order 90 days | Orders again, or 365 days |
| **Lost** | No order 365 days | Orders again |
| **Won back** | Ordered after dormant or lost | 90 days, then rejoins the normal path |

Stages are computed nightly. **Store every transition with its date** in a
`customer_lifecycle_stage` table (customer, stage, from_date, to_date, trigger_reason), and
resolve stage as of a date — same principle as tier and salesperson attribution. Never
overwrite.

### S2.2 Metrics this unlocks

| Metric | What it tells you |
|---|---|
| Stage distribution | Count and ₹ in each stage, now vs a year ago |
| **Time to second order** | Median days. The strongest single predictor of whether a new customer survives. |
| Time in each stage | Median and distribution |
| **Onboarding health score** | First 90 days: orders placed, categories bought, payment behaviour. Scored, and correlated with 24-month survival. |
| Stage transition matrix | Who moved from which stage to which, month over month, with ₹ |
| **Survival curve** | % of customers still active at 6, 12, 24, 36 months from first order |
| Lifecycle value curve | Cumulative pocket margin by months since first order, overlaid by acquisition cohort |
| Recovery rate | % of at-risk customers who returned to Established, by intervention type |
| Stage SLA breach | Contact frequency required per stage, and who is overdue |

### S2.3 Rules per stage

Each stage carries configurable defaults: required contact frequency, credit posture,
service priority, and which work list the customer feeds. A customer entering **At risk**
should automatically appear on the Director's call list the following morning, with the
trigger reason shown.

---

## S3. Brand and product lifecycle

Missing entirely from the current brief, and material for a switchgear distributor where
principals launch and discontinue series regularly.

### S3.1 Stages

| Stage | Detection rule (all thresholds configurable) |
|---|---|
| **Introduction** | First sale within the last 6 months |
| **Growth** | Sales rising >20% vs prior quarter **and** the number of distinct customers buying it is rising |
| **Maturity** | Sales within ±15% for 3 consecutive quarters, customer count stable |
| **Decline** | Sales falling for 2 consecutive quarters **and** customer count falling |
| **End of life** | Manually flagged from a principal announcement, with an effective date |
| **Discontinued** | No purchase possible; stock is finite |

Detection proposes; a person confirms. Never auto-flag end of life — that comes from the
principal, not from the data.

### S3.2 New product introduction tracking

For every SKU in Introduction:

- Launch date, launch target, and actual vs target
- **Adoption curve** — cumulative distinct customers who have bought it at least once
- **Penetration** — those customers as a % of the customers who buy that category from you
- Time to first 10 / 50 / 100 units
- Repeat rate — customers who bought it more than once
- Which salespeople have sold it, and which have not sold it at all. **The list of
  salespeople with zero sales of a new SKU is usually the reason a launch is failing**, and
  it is invisible in an aggregate launch report.
- Cannibalisation check — did the predecessor SKU fall by roughly what the new one gained?

### S3.3 Decline and end-of-life management

| Metric | Why it matters |
|---|---|
| **Obsolescence exposure** | Stock value of SKUs in Decline, End of life and Discontinued |
| **Days to clear** | Current stock ÷ trailing 90-day sales rate, per SKU |
| **Stock beyond horizon** | Units that will not sell before the EOL date at the current rate — the number to negotiate with the principal on, while you still can |
| **Successor mapping** | Old SKU → replacement SKU, maintained as a master |
| **Migration tracker** | % of the old SKU's customers who have bought the successor, and who has not. This is a direct call list. |
| Price erosion | Average realisation over the SKU's life, showing when discounting began |
| Provisioning input | Suggested slow-moving and obsolete provision for the CA at close |

### S3.4 Brand-level lifecycle

- Share of your total sales by brand, over 3 years, with trend
- Brand dependency risk — combine share with single-source SKU count
- Category composition within each brand over its life
- New-series introductions per brand per year, and their adoption rate. This is a fair
  measure of how well the principal is actually supporting you.

---

## S4. Reports to add to the catalogue

| # | Report | Frequency |
|---|---|---|
| 184 | Custom report builder — user-defined | On demand |
| 185 | My custom reports and shared custom reports | On demand |
| 186 | Customer lifecycle stage distribution | Monthly |
| 187 | Lifecycle stage transition matrix | Monthly |
| 188 | Time to second order | Quarterly |
| 189 | Onboarding health scorecard | Monthly |
| 190 | Customer survival curve | Quarterly |
| 191 | Lifecycle value curve by cohort | Quarterly |
| 192 | At-risk customers with trigger reason | Weekly |
| 193 | Stage SLA breaches | Weekly |
| 194 | Recovery rate by intervention | Quarterly |
| 195 | Product lifecycle stage mix | Monthly |
| 196 | New product introduction scorecard | Monthly |
| 197 | Adoption and penetration curve, per new SKU | Monthly |
| 198 | Salespeople with zero sales of a new SKU | Monthly |
| 199 | Cannibalisation check | Quarterly |
| 200 | Obsolescence exposure and days to clear | Monthly |
| 201 | Stock beyond EOL horizon | Monthly |
| 202 | Successor migration tracker | Monthly |
| 203 | Price erosion over product life | Quarterly |
| 204 | Brand share and dependency trend | Quarterly |
| 205 | Principal support scorecard — launches and adoption | Annual |

## S5. Data and masters required

New masters maintained in Vyuha, not Tally:

1. `customer_lifecycle_stage` — customer, stage, from_date, to_date, trigger_reason
2. `product_lifecycle_stage` — item, stage, from_date, to_date, confirmed_by
3. `product_launch` — item, launch_date, target, target_period
4. `product_successor` — old_item, new_item, effective_date
5. `product_eol` — item, announcement_date, effective_date, source
6. `custom_report` — definition JSON, owner, shared_with, version, schedule
7. `custom_alert` — metric, operator, threshold, scope, frequency, recipients

## S6. Build order

1. `customer_lifecycle_stage` table and the nightly stage engine — start writing history
   immediately, as with the receivables snapshot. Stage history cannot be reconstructed.
2. Stage distribution, transition matrix, at-risk list wired into the Director's call list
3. Time to second order, onboarding health, survival curve
4. Product lifecycle masters and the stage detection job, with human confirmation
5. NPI scorecard, adoption curve, zero-sales-by-salesperson list
6. Successor mapping, migration tracker, obsolescence exposure
7. Custom report builder — read-only metrics first, calculated fields second
8. Custom KPI cards, then custom alerts
9. Brand lifecycle and principal support scorecard

Items 1 and 4 write history and should start before their reports are built. Item 7 should
come after the metric registry is complete, or users will build custom reports on
definitions that are still moving.
