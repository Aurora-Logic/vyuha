# VYUHA — VIRTUAL CFO MODULE
# Master build brief, end to end

Single source of truth. Everything needed to build this module is in this file.
Read the whole file before writing any code.

Structure:

- **Part 0** — how to execute: prerequisites, stack, conventions, gates
- **Parts A–G, K–N** — the specification: principles, metrics, analysis, levels, data
- **Part O** — Director's Desk, daily call list, Export Centre
- **Part P** — Customer tiers A+ to D
- **Part Q** — Analytics robustness rules and the matrix library
- **Part R** — Report detail view and the drill contract

**Scope note:** this document is logic only — metrics, definitions, rules, reports and
data. **All UI, layout, components, charts, colour and interaction design are out of scope
here** and are owned by the design context you already have. Where this document says
"screen" or "view", treat it as a functional requirement, not a layout instruction.

---

# PART 0 — EXECUTION BRIEF

## 0.1 What you are building

A Virtual CFO module inside Vyuha, the existing business platform for **GC Communication,
Nashik** — a distributor of low-voltage switchgear (MCB, MCCB, ACB, RCCB, power quality)
for C&S Electric and BCH Electric.

The module turns Tally data into sales, margin, receivables and growth analytics, and ends
every screen in a named list of customers to act on today.

**It reads from Tally. It never writes to Tally. Payroll stays out of this product.**

## 0.2 Prerequisites — check these before starting

Three things may block the build. Check each and report before writing code.

1. **Tally read connector must exist.** This module has no data without it. If the
   connector is not ready, build against a CSV/XML import from Tally as a temporary source,
   behind the same repository interface, so swapping to the live connector later is a
   one-file change.

2. **The approvals and export framework must be extracted first.** It is currently generic
   in design but sits inside the attendance module and hardcodes attendance permission keys
   in roughly five places. Virtual CFO is the second module — this extraction can no longer
   be deferred. Move it to `platform/` with a permission-key registry before building
   anything here. Report the exact files you changed.

3. **Navigation plan.** The sidebar is already at 19 items in 4 groups and scrolling.
   Do not append Virtual CFO screens to it. Implement the module switcher first: the
   sidebar renders the active module's own navigation, with the module name shown under the
   organisation name.

## 0.3 Stack and repository rules

| Layer | Technology |
|---|---|
| API | NestJS 11 |
| Frontend | React 19 + Vite, PWA |
| Database | PostgreSQL 16 + Drizzle |
| Jobs / cache | Redis + BullMQ |
| Storage | S3-compatible |
| UI | Per the existing platform and design context |
| Validation | Zod 4 |

**Monorepo boundary, lint-enforced, non-negotiable:**
`modules/*` may import `platform/*`. Never the reverse. Modules may not import each other.

The Virtual CFO module lives at `modules/cfo/`. Anything it needs that the attendance module
also needs goes to `platform/`, not into a cross-module import.

## 0.4 UI and design

Out of scope for this document. Follow the existing design context and the platform's
established component conventions. This brief specifies **what each screen must contain and
do**, never how it should look.

## 0.5 Conventions

- Every report has both a chart view and a table view showing identical numbers.
- Every screen has Excel and PDF export.
- All money values stored to 2 decimals, aggregated before rounding, displayed per the
  user's ₹ / thousand / lakh setting.
- All dates stored UTC, displayed IST.
- Zod schema for every API boundary. Drizzle for every query — no raw SQL except in the
  fact-table refresh jobs, where it is expected and should be commented.
- Permission key on every endpoint and every screen. Keys listed in Part K3, plus Part O7
  and P8.
- Every export writes an audit row: user, report, filters, row count.

## 0.6 How to handle decisions

Part M lists 15 open decisions. Parts O and P add more.

**Do not assume a default where this document is silent.** Raise a popup with the question,
the options, and your recommendation. Collect all decisions for a phase and ask them
together at the phase start rather than interrupting mid-build.

Before each phase, produce a table of pending items with a short description of each, so the
owner can see what is outstanding at a glance.

## 0.7 Definition of done — per report

1. Chart view and table view return the same numbers
2. Excel and PDF export work, with the standard header block (Part O6.4)
3. Every number has a definition available: plain meaning and formula
4. Drill-through reaches a named customer or SKU, and from there the source voucher
5. Every path ends at an action that can create a task
6. Permission key enforced on both API and UI
7. Filters reflected in URL query params so the view can be shared
8. Loading, empty, partial-data, stale and error states all handled (Part R8)

## 0.8 Testing

- Unit tests for **every metric formula**, with hand-computed fixtures. A wrong formula that
  looks plausible is the worst failure mode in this module.
- Dedicated tests for the period engine: elapsed-day matching, FY boundaries (April), leap
  years, working-day matching, and month-end edge cases.
- A **level reconciliation test**: sum of persons must equal sum of brands must equal company
  total, to the rupee, on seeded data.
- Snapshot tests for every export header block.
- Performance test: any single-period query over 3 years of data returns under 1 second.

Match the existing project standard — the platform currently has 2,033 tests passing. Do not
regress it.

## 0.9 What not to do

- Do not build twenty separate work-list screens. One layout, twenty config files.
- Do not build separate "company" and "person" screens. One engine, a level filter.
- Do not auto-assign customer tiers. The system suggests; a person decides.
- Do not write to Tally.
- Do not add currency fields to payroll-adjacent areas — payroll is out of scope.
- Do not hardcode tier colours, alert thresholds, incentive rates, materiality floors or
  compliance thresholds anywhere. All configurable in settings.
- Do not rewrite history. Salesperson attribution and customer tier both resolve **as of
  voucher date**, never current.
- Do not skip Phase 1 in favour of building charts.

## 0.10 The one irreversible item

**Start the `fact_receivable_snapshot` daily job before any UI exists.**

DSO trends, collection scores, days-late and credit-grade migration all need daily history,
and history cannot be reconstructed later from current balances. Every day this job is not
running is a day of analytics permanently lost.

Build it first, verify it writes, and leave it running while the rest is built.

## 0.11 Phase gates

Report at the end of each phase and wait for review before starting the next.

| Phase | Gate |
|---|---|
| 1 — Foundation | Period engine tests pass; levels reconcile; snapshot job running; three shared components built |
| 2 — First release | Dashboard, Receivables, six work lists, My CFO all usable on real data |
| 3 — Explanation | Bridges reconcile to net sales exactly; league table agrees with company total |
| 4 — Margin and brand | Margin figures verified against Tally for a sample month; slab tracking matches principal statements |
| 5 — Depth | Compliance and exception reports reviewed with the CA |
| O — Director's Desk | Priority ranking reviewed against the director's own judgment for one week before the screen is built |
| P — Tiers | Tier history resolving correctly as of date, verified on a past-period report |

Use `/loop` for iterative work, `/ultrareview` before each phase gate, and
`/security-review` before the permissions work is considered complete.

## 0.12 Suggested build sequence, whole module

```
Prerequisites  →  extract approvals/export framework, module switcher, Tally source
Phase 1        →  Part N, Phase 1 (foundation)
Phase 2        →  Part N, Phase 2 (first usable release)
Phase P (1-5)  →  Part P steps 1-5 (tiers — needed before the call list is tuned)
Phase 3        →  Part N, Phase 3 (explanation)
Phase O        →  Part O (Director's Desk and Export Centre)
Phase 4        →  Part N, Phase 4 (margin and brand)
Phase 5        →  Part N, Phase 5 (depth)
Phase P (6-10) →  Part P steps 6-10 (tier reports and wiring)
```

Tiers move early because the Director's Desk priority score uses them, and because the first
full classification of the customer base is a human exercise that takes real calendar time.

---

The specification follows. Parts A–N first, then O, P, Q and R.

**Part Q is not optional polish.** Its robustness rules must be built into the metric
engine from the start, not retrofitted. A dashboard that once showed "+840% growth" on a
base of six thousand rupees does not get its audience back.

---
# THE SPECIFICATION

**Built for:** GC Communication, Nashik — distributor of low-voltage switchgear
(MCB, MCCB, ACB, RCCB, power quality) for C&S Electric and BCH Electric, domestic today,
export arm planned.
**Source of truth:** Tally. This module reads. It does not write to Tally.
**Payroll:** permanently out of scope, as with the rest of Vyuha.

---

# PART A — PRINCIPLES

## A1. The governing rule

A report that ends in a percentage is an observation. A report that ends in
**"these 14 customers, ₹31.2 lakh, call by Friday, owner: RS"** is a control.

Every screen answers four things, in this order, top to bottom:

```
1. THE NUMBER   what happened          → Cards
2. THE REASON   why it happened        → Chart
3. THE NAMES    who it happened to     → Table
4. THE ACTION   what we do about it    → Button that creates a task
```

**No screen ships without a drill-through to named parties.** If a number cannot be
attributed to a name, it belongs in the monthly pack as context, not on a screen.

## A2. Functional rules

- Table view and chart view of every report must show identical numbers.
- Excel and PDF export on every report.
- Decisions raised as a question to the user. Never assumed where this document is silent.
- Every metric, threshold, rate and colour token configurable in settings — nothing
  hardcoded.
- No screen is complete until it drills through to a named customer or SKU and ends in an
  action that can create a task.

UI conventions, component choices and visual design are handled by the design context and
are deliberately not specified here.

## A3. Plain-language rule

The screen shows the **plain name**. The technical name lives in an info tooltip. Your team
and your CA must be able to read the same screen.

| On screen | Technical name | Meaning in one line |
|---|---|---|
| Sales | Net sales | Billing after returns and discounts, excluding GST |
| Average bill value | AOV | Sales ÷ number of bills |
| Average rate we got | Average realisation | Sales ÷ quantity — separates a price story from a volume story |
| Real price | Pocket price | What is left after discounts, credit notes and schemes |
| Real profit | Pocket margin | Real price minus landed cost |
| Profit lost in discounts | Price realisation gap | What you would earn if low-price customers paid the middle price |
| Days customers take to pay | DSO | 62 means your money returns 62 days after billing |
| Days late | Average days delinquent | Days taken *beyond* the agreed credit period |
| Collection score | CEI | Out of 100 — how much of what was collectable you actually collected |
| Cost of late payment | Interest cost of credit | What one customer's delay costs you in a year, in rupees |
| Money stuck in the business | Cash conversion cycle | Days between paying for goods and being paid for them |
| Quiet customers | Silent churn | Customers gone unusually quiet compared to their own habit |
| Sleeping customers | Dormant | No order in 90 days |
| Gone customers | Lost | No order in a year |
| Customer grade A–E | Credit score | A pays on time, E is a risk |
| Where the growth came from | Growth bridge / PVM | Splits growth into price, quantity, mix, new, lost |
| Stock lying idle | Dead stock | No movement in 6 months |
| Repeat strength | Net revenue retention | Above 100 means existing customers are growing on their own |

Every number on screen must expose its definition on demand — the plain meaning and the
exact formula.

---

# PART B — FOUNDATIONS

Nothing in Parts C onward is correct unless Part B is correct. Build and test this first.

## B1. Accounting conventions

| Item | Convention |
|---|---|
| Financial year | 1 April – 31 March. Q1 = Apr–Jun. |
| Revenue basis | Invoice date (accrual). Toggle to dispatch date on fulfilment reports only. |
| Value basis | Excluding GST throughout. Print "All figures exclusive of GST" on every export. |
| Gross vs net | Gross = before returns and discount. Net = gross − trade discount − credit notes − rate difference. **Growth is always measured on net.** |
| Credit notes | Recognised in their own period. "Restate to original invoice period" toggle available, default off. |
| Cancelled / deleted vouchers | Excluded from figures, counted in the exception report. |
| Cut-off | Invoiced in period but dispatched after period end — flagged for review, not excluded. |
| Rounding | Store 2 decimals. Display in ₹ / thousand / lakh per user setting. Never round before aggregating. |
| Materiality | Configurable floor, default ₹25,000 or 0.5% of monthly sales, whichever is lower. Below it, group as "Other" so lists stay actionable. |
| Cost basis | **Blocked until the Tally valuation method is confirmed** (FIFO / weighted average / standard / last purchase). |

## B2. Period engine

One shared `PeriodResolver`. Every metric accepts a period token and returns
`{ current, comparison, delta_abs, delta_pct, elapsed_days_matched }`.

**Tokens:** `TODAY`, `YESTERDAY`, `WTD`, `LWTD`, `MTD`, `LMTD`, `LM_FULL`, `LYMTD`,
`LY_SAME_MONTH`, `QTD`, `LQTD`, `LY_SAME_QTD`, `YTD`, `LYTD`, `LY_FULL`, `R30`, `R90`,
`R365`, `CUSTOM`.

**Comparison axis:** none / previous period / same period last year / two years ago /
budget / rolling average of last 3 same-periods.

**Mandatory behaviours:**

- **Elapsed-day matching.** MTD on the 9th compares against days 1–9 of the prior period,
  never a full month. Always print under the picker: *"Day 9 of 31 — comparing against 1–9
  of last month."* This one line prevents the most common misreading of any dashboard.
- **Working-day matching** toggle, using the attendance module's holiday calendar. A month
  with two extra Sundays is not a demand signal.
- **Two-year comparison** as standard on customer analysis — one year cannot distinguish a
  decline from a base effect.
- **Run-rate projection** on all to-date cards: linear and seasonality-adjusted, shown as a
  band, not a point.
- **CAGR** available on any 3+ year selection.
- Every comparison shows value, delta ₹, delta %, direction. **Never a bare percentage.**

## B3. The level model — company down to one person

One metric engine, five scopes. Not separate reports.

```
LEVEL 1  COMPANY          GC Communication (all)
LEVEL 2  BUSINESS LINE    Domestic | Export
LEVEL 3  PRINCIPAL/BRAND  C&S Electric | BCH Electric | Others
LEVEL 4  PERSON           each salesperson
LEVEL 5  ACCOUNT          each customer, each product
```

- **Roll-up must reconcile to the rupee.** Sum of persons = sum of brands = company total.
  A nightly check raises an exception if any level fails to tie.
- Unattributed sales go to a visible **"Unassigned"** bucket, never silently dropped. The
  size of that bucket is itself a data-quality KPI shown in the footer.
- **Same screen, different scope.** Sales Analysis at "Person → Rajesh" is the same
  component as the company view.
- Level selector sits in the period bar. `Breadcrumb` shows: Company › Domestic › C&S ›
  Rajesh, clickable at every step.

## B4. Attribution — how a sale becomes someone's

Settle before building any person-level screen.

1. **Preferred:** salesperson field or cost centre on the Tally voucher.
2. **Fallback:** customer → owner map maintained in Vyuha, with effective-from dates.
3. **Split credit:** percentage split, maximum two people per customer.

**Hard rules:**

- **History is never rewritten.** Reassigning a customer today does not move last year's
  sales to the new owner. Resolve owner as of voucher date. Getting this wrong destroys
  trust in every league table permanently and cannot be recovered.
- House accounts get an explicit "House" owner, never blank.

---

# PART C — METRIC REGISTER

Each metric is a registered definition: `id | plain label | formula | source | denominator |
unit | good direction | slicers | materiality floor | permission key`. Every one must
resolve at all five levels of B3.

## C1. Revenue and volume

| ID | Metric | Formula / note |
|---|---|---|
| R01 | Gross sales | Sales voucher value, ex-GST |
| R02 | Trade discount | Discount ledger + line discount |
| R03 | Sales returns | Credit notes, nature "goods return" |
| R04 | Rate difference / claims | Credit notes, nature "rate diff" — margin leakage disguised as an adjustment; track separately |
| R05 | **Net sales** | R01 − R02 − R03 − R04 |
| R06 | Return rate % | R03 / R01 |
| R07 | Invoice count | |
| R08 | Order count | |
| R09 | AOV | R05 / R07 |
| R10 | Lines per invoice | Basket width |
| R11 | Quantity | Base UOM; conversion table required for mixed-UOM SKUs |
| R12 | **Average realisation** | R05 / R11 |
| R13 | Days with zero sales | Demand and data-quality signal |
| R14 | Order-to-invoice conversion % | |
| R15 | Estimate-to-order conversion % | By salesperson and customer |

## C2. Margin — the pocket-price waterfall

Gross margin is not enough. For a distributor most profit leaks *below* the invoice line.

| ID | Layer | Definition |
|---|---|---|
| M01 | List price | Master rate |
| M02 | − Invoice discount | Line and header |
| M03 | = Invoice price | What the customer is billed |
| M04 | − Off-invoice leakage | Credit notes, rate difference, schemes, freight borne, breakage |
| M05 | = **Pocket price** | What is actually realised |
| M06 | − Landed cost | Purchase + inward freight + non-creditable duty |
| M07 | = **Pocket margin ₹ and %** | The only margin that should drive decisions |
| M08 | − Cost to serve | Delivery, credit cost (C4 D17), returns handling |
| M09 | = **Customer contribution** | Per customer, per order |

Derived: **M10** pocket-price band per SKU (min / P25 / median / P75 / max) ·
**M11** price realisation gap ₹ (recoverable at median) · **M12** margin mix effect ·
**M13** negative-margin lines, zero tolerance · **M14** contribution per delivery.

## C3. Customers

| ID | Metric | Note |
|---|---|---|
| C01 | Active customers | Billed in period |
| C02 | New customers, and revenue from them | |
| C03 | Reactivated | Dormant 180d+ who returned |
| C04 | Repeat revenue % | |
| C05 | Dormant | No order 90d, ordered in prior 12m |
| C06 | Lost | No order 365d |
| C07 | Churn rate % | |
| C08 | Revenue retention % | |
| C09 | Net revenue retention % | Above 100 = base growing on its own |
| C10 | Top-5 / Top-10 concentration % | |
| C11 | HHI | Sum of squared revenue shares — one risk number |
| C12 | Median order gap, days | Per customer, trailing 12m |
| C13 | Order gap variance | Widening gap = churning before they stop |
| C14 | Lifetime pocket margin | |

## C4. Receivables and credit control

Simple ageing is not credit control.

| ID | Metric | Formula / why |
|---|---|---|
| D01 | Outstanding, bill-wise | Requires Tally bill-wise details |
| D02 | Ageing buckets | 0-30 / 31-60 / 61-90 / 91-180 / 180+, **by due date not invoice date** |
| D03 | DSO simple | (Closing debtors / net credit sales) × days |
| D04 | **DSO countback** | Consume closing debtors against most recent months until exhausted. Primary measure — far more accurate when sales are lumpy. |
| D05 | Best possible DSO | Not-yet-due debtors only. Gap to D04 = collectable inefficiency. |
| D06 | **CEI** | (Opening AR + credit sales − closing total AR) ÷ (Opening AR + credit sales − closing current AR) × 100. Unaffected by seasonality, unlike DSO. |
| D07 | **ADD** | D04 − D05. Days late, in one number. |
| D08 | Weighted average days to pay | Per customer, value-weighted |
| D09 | Credit terms allowed vs actual | Variance in days |
| D10 | Overdue ₹ and % | |
| D11 | Credit limit utilisation | Including open orders and unbilled dispatches |
| D12 | Credit breaches | Count, value, approver |
| D13 | Disputed / on-hold | Tagged, excluded from collection KPIs, shown separately |
| D14 | Collection forecast | Next 30/60/90 days, on actual pay behaviour not stated terms |
| D15 | **ECL provisioning matrix** | Ageing bucket × historical loss rate. The provision figure your CA needs at close. |
| D16 | Bad debt written off, recovery rate | |
| D17 | **Interest cost of credit extended** | Overdue ₹ × days × borrowing rate ÷ 365, per customer. Turns "he pays late" into "he costs us ₹1.8 lakh a year" — the most persuasive number in a collection call. |
| D18 | **Credit score A–E** | Payment history 40, ageing 25, limit utilisation 15, order-gap trend 10, disputes 10. Drives the escalation ladder in E3. |

**Promise-to-pay log is mandatory.** A customer who breaks three promises is a different
risk from one who is simply slow, and only the log shows it.

## C5. Working capital

| ID | Metric |
|---|---|
| W01 | Inventory days |
| W02 | Payable days (DPO) |
| W03 | **Cash conversion cycle** = D04 + W01 − W02 |
| W04 | Working capital ₹ blocked, and its interest cost |
| W05 | Funds flow — movement in debtors, creditors, stock between two dates |
| W06 | Stock cover days, per SKU |
| W07 | Dead stock (no movement 180d), at value |
| W08 | Slow-moving (cover > 90 days) |
| W09 | Stockout lost sales, valued at pocket price |
| W10 | Inventory-to-sales ratio trend |

## C6. Purchases and vendors

P01 purchase value by vendor · P02 price variance vs last purchase and 6-month average ·
P03 lead time mean and variance · P04 vendor concentration and single-source SKUs ·
P05 purchase return rate · P06 payment ageing and DPO by vendor · **P07 MSME vendors and
45-day exposure** (see Part F) · P08 early-payment discount captured vs forfeited.

## C7. Fulfilment

F01 order-to-dispatch cycle, mean and P90 · F02 fill rate · F03 OTIF % · F04 open partial
shipments, count and ₹ · F05 delivery cost per order and per ₹1,000 of sales ·
F06 transporter-wise damage/claim rate.

---

# PART D — ANALYSIS ENGINES

## D1. Growth bridge — five factors

Last year's net sales → this year's, decomposed at SKU × customer grain:

1. **Volume effect** = (Qty_TY − Qty_LY) × PocketPrice_LY
2. **Price effect** = (PocketPrice_TY − PocketPrice_LY) × Qty_TY
3. **Mix effect** = residual within retained customers
4. **New customer effect** = revenue from customers with no LY revenue
5. **Lost customer effect** = negative of LY revenue from customers with no TY revenue

Build the **margin bridge on the same five factors**. Revenue up with margin down is the
most common failure mode, and only the paired bridge reveals it. Every bar drills to the
named customers and SKUs inside it.

## D2. Customer movement matrix

Six states (New, Reactivated, Growing, Flat ±5%, Declining, Lost) × three size bands
(A/B/C by revenue) = 18 cells, each showing count and ₹, each clickable to a named list.
**"Declining × A-band" is the most expensive cell on the screen** — large accounts
shrinking — and should be visually loudest.

## D3. RFM plus value at risk

Recency, Frequency, Monetary scored 1–5 on trailing 365 days → segments (Champions, Loyal,
Potential, New, At Risk, Hibernating, Lost), **plus** a value-at-risk column = segment
revenue × that segment's historical churn probability. Turns a wall chart into a
prioritised call list.

## D4. Cohort retention

Customers grouped by acquisition month; revenue retention at M+3, M+6, M+12, M+24. Tells you
whether newly acquired customers are getting better or worse — invisible in any aggregate.

## D5. ABC-XYZ

ABC by revenue contribution × XYZ by demand variability (coefficient of variation). Nine
cells drive different policies: AX gets guaranteed availability, CZ is made-to-order only.
Apply to both SKUs and customers.

## D6. Cross-sell

Association rules across invoices (support, confidence, lift), then inverted: for each
customer, SKUs bought by similar customers that this one does not buy, ranked by expected
value. Surfaces as "next best product" on Customer 360.

## D7. Seasonality and projection

Month × product index over 24–36 months, feeding a forward projection with a confidence
band. Keep it modest and explainable; reuse the Sales_ERP approach rather than building a
second engine.

## D8. Break-even and operating leverage

Monthly fixed cost input + average contribution margin % from M07 → break-even sales, margin
of safety %, degree of operating leverage. Shown against MTD run rate: *"break-even is ₹X;
we are at ₹Y with N days left."*

---

# PART E — THE WORK LISTS

Twenty standing lists. Each is a first-class object: trigger logic, columns, default sort,
owner role, review cadence, and a "push to CRM kanban" action that creates a task with
context pre-filled. Every list exports to Excel with phone number and last conversation note.

One shared layout, twenty config files. **Not twenty screens.**

## E1. Revenue recovery

| # | List | Trigger | Sort | Cadence |
|---|---|---|---|---|
| L01 | **Silent churn** | Days since last order > 1.5 × that customer's own median gap | Annual value at risk | Daily |
| L02 | Declining accounts | Net sales down >20% vs LY, above materiality | ₹ decline | Weekly |
| L03 | Lost lines | SKUs bought last year, not this year, per customer | ₹ gap | Weekly |
| L04 | Win-back | Dormant 90–365 days | Lifetime margin | Weekly |
| L05 | Cross-sell gaps | SKU bought by ≥60% of similar customers, not by this one | Expected ₹ | Monthly |
| L06 | Order-size decline | AOV down >15% with frequency flat | ₹ impact | Monthly |
| L07 | Frequency decline | Order gap widened >30% vs own average | Annual value | Weekly |
| L08 | New customer non-repeat | First order >45 days ago, no second | First order value | Weekly |

## E2. Margin

L09 below-median pricing (with ₹ recoverable) · L10 negative-margin lines · L11 discount
outliers >1.5× category norm, with approver name · L12 off-invoice leakage >3% of gross ·
L13 high revenue low margin — the accounts that look important and aren't ·
L14 cost-to-serve negatives.

## E3. Credit control ladder

| # | List | Trigger | Action |
|---|---|---|---|
| L15 | Due this week | Due in next 7 days | Courtesy reminder, auto-drafted |
| L16 | 1–30 overdue | | Statement + call, owner accounts |
| L17 | 31–60 overdue | | Call by sales owner, new orders flagged |
| L18 | 61–90 overdue | | Supply hold recommended, approval popup |
| L19 | 90+ or grade D–E | | Written demand, provision per D15, legal review |
| L20 | Limit breaches | Utilisation >100% incl. open orders | Block order confirmation until released |

Every credit row carries: party, outstanding, oldest bill date, days overdue, credit grade,
**cost of their delay (D17)**, weighted average days to pay, last payment, last
promise-to-pay and whether it was kept, assigned owner.

---

# PART F — COMPLIANCE AND CONTROL

## F1. Compliance analytics

Turns statutory hygiene into money. **Every threshold configurable, never hardcoded, and
confirmed with your CA — these change with each Finance Act.**

| Check | What it catches |
|---|---|
| Books vs GSTR-1 | Invoice-level reconciliation of taxable value and tax |
| Books vs GSTR-3B vs 2B | Output liability and ITC gaps |
| **ITC at risk — Rule 37** | Purchase invoices unpaid beyond 180 days where ITC was claimed; reversal exposure with interest |
| Credit note time bar | Prior-FY credit notes approaching the statutory cut-off |
| E-invoice / e-way bill coverage | Invoices above threshold missing IRN or EWB; EWB expiring in transit |
| HSN summary | Rate-wise reconciliation, wrong-rate detection |
| **MSME 43B(h) exposure** | Payables to micro/small vendors ageing past the statutory limit, quantified *before* year end |
| TDS/TCS threshold tracker | Per-party cumulative turnover approaching applicable thresholds |
| Party master hygiene | Invalid or cancelled GSTIN, duplicate PAN, missing state code |
| Place of supply anomalies | IGST vs CGST-SGST against party state |
| Advances unadjusted | Aged customer advances |

Each outputs a named list with ₹ exposure, ranked.

## F2. Exception reports

Nightly, delivered as a morning list to admin.

Backdated vouchers · modified after approval (user + timestamp) · deleted or cancelled
vouchers · price override without approval · round-sum entries above materiality · negative
stock · **sales concentrated in the last 3 days of the month** (cut-off signal) · same-day
sale and return · duplicate invoice value+party+date · sales above threshold to parties
without GSTIN · dormant ledger suddenly active · credit note with no linked invoice ·
invoice numbering sequence gaps · one-off customers above materiality.

Each row: voucher, party, value, user, timestamp, and Accept (mandatory reason via `Dialog`)
or Investigate (creates task). Resolved items grey out but remain visible for audit.

---

# PART G — LEVEL VIEWS

## G1. Company view (owner's cockpit)

The main dashboard (H2), plus three company-only panels:

| Panel | Answers | Chart |
|---|---|---|
| Business line split | Domestic vs Export — sales, margin %, days to pay | 100% stacked bar over time |
| Where money is stuck | Cash cycle split into stock days + collection days − supplier credit days | Stacked bar, monthly |
| Concentration risk | Top-5 customer share, top-2 brand share, single-source SKUs | Line with warning band |

Plus a **balance-sheet-lite strip**: debtors, creditors, stock value, net working capital —
four cards with month-on-month movement.

Company-only alerts: concentration rising, one brand carrying the margin, cash cycle
lengthening, export receivables ageing differently from domestic.

## G2. Brand / principal view — specific to this trade

This is where a switchgear distributor actually earns. Its own screen: **Brand Performance**.

Per principal (C&S, BCH, others): purchases · brand sales · brand margin ₹ and % ·
**target vs achievement** · **distance to next rebate slab, in ₹ and days remaining** ·
scheme/rebate accrued (tracked as receivable from principal) · claimed vs received, with
ageing · brand stock and cover days · brand price realisation · category split within brand.

**"₹4.2 lakh to the next slab, 9 days left" is the most profitable number in the module.**
Slabs are all-or-nothing at the boundary; a push in the last week can be worth more than the
month's trading margin. Alert daily from the 20th.

Charts: radial gauge for attainment; bar + cumulative line with slab boundaries as
`ReferenceLine`s; stacked bar for category mix.

**Category 360** for MCB / MCCB / ACB / RCCB / PQ separately. These behave like different
businesses — ACB is low-volume high-value on long credit, MCB is high-volume fast-moving.
Averaging them hides everything.

## G3. Individual — "My CFO" (what each person sees about themselves)

Default screen for anyone with a sales role.

- **Row 1, five cards:** My sales · My target progress · My collections · My overdue book ·
  My real profit %
- **Row 2:** month pacing line (my cumulative vs my target vs my LY); my pending work-list
  count
- **Row 3:** my customers table — this period, last year, change ₹, days overdue, credit
  grade, days since last order, next action
- **Row 4:** indicative incentive to date (G5), clearly marked indicative

This screen is what makes the module something the sales team opens voluntarily. That is the
difference between software that is used and software that is installed.

## G4. Individual — team view (owner and sales head)

**League table**, one row per person: Sales · vs Target · vs LY · New customers ·
Collections · Overdue in book · Real profit % · Discount given % · Actions closed.
Sortable on every column, row click → full scorecard.

**Person scorecard** — `Tabs`: Sales · Customers · Collections · Activity

- Sales — trend vs target, and the growth bridge scoped to their book: did *their* growth
  come from price, volume, or new customers?
- Customers — their movement matrix. **Someone up on sales who has lost four accounts is not
  performing well**, and only this view shows it.
- Collections — their ageing, days to pay, promises kept vs broken
- Activity — tasks assigned vs closed, calls logged, quote conversion; attendance shown as
  context only

**Radar chart** across six axes — sales, growth, collections, margin, new customers,
activity — against team average. One glance separates a discounting volume seller from a
disciplined one.

## G5. Targets and incentive

Targets at four levels: person, brand, category, customer. Monthly, rolling up to quarter
and year. Entered in a `Table` with inline edit, or imported from Excel.

**Incentive is calculated on collected margin, not billed sales.**

1. Paying on billed sales rewards whoever books a heavily discounted order to a customer who
   will not pay for 120 days.
2. Paying on margin makes the salesperson defend price without being told to.
3. Paying on collections makes receivables the sales team's problem, which is where it
   belongs — you cannot collect from a desk in accounts.

```
Eligible base = pocket margin on invoices COLLECTED in the period
Incentive     = base × slab rate, where slab rate = f(target achievement %)
Deduction     = overdue beyond 90 days in own book, at a set rate
Bonus         = new customer added and still active after 3 months
```

All rates configurable. **Vyuha produces a figure and a report only** — the export goes to
Tally, consistent with payroll staying out of this product.

## G6. Account level

Customer 360 and Product 360 (H6). Every Customer 360 header shows the **owner** with an
`Avatar` linking to their scorecard; every Product 360 shows **brand and category** as
labels linking to the brand view.

A user should move Company → Brand → Person → Customer → SKU in four clicks and back out
again, with the numbers never changing meaning.

---

# PART K — DATA AND PERFORMANCE

## K1. Required from Tally

1. **Bill-wise details enabled** — mandatory for all of C4, E3, D15
2. **Credit period and credit limit** per party — else D09, D11, L20 are impossible
3. **Valuation method** — blocks all margin reporting
4. **Salesperson** — cost centre or UDF on voucher; else Vyuha maintains the dated map
5. **Brand on the stock item** — usually the stock group. Confirm C&S and BCH are cleanly
   separated in the item master; if not, fix in Tally first. It is worth the effort.
6. **Category** — MCB / MCCB / ACB / RCCB / PQ as stock category or sub-group
7. **Export vs domestic flag** — voucher type or party group. **Set this up before export
   billing begins**; retrofitting across history is painful.
8. **Vendor MSME status and registration date** — usually not in Tally; needs a Vyuha master
9. **Landed cost components** — whether inward freight sits in item cost or a separate
   ledger; materially changes M06
10. **Party grouping** — for ABC and cross-sell comparison sets
11. **Principal scheme credit notes** — how booked, so accrual vs receipt can be compared
12. **Voucher alteration history** — Tally audit feature on, for Part F2

## K2. Read model

Two fact tables, refreshed by BullMQ:

- `fact_sales_daily` — grain `(date, party, item, brand, business_line, godown,
  salesperson_as_of_voucher_date, voucher_type)` with qty, gross, discount, off-invoice
  adjustments, net, landed cost, pocket margin
- `fact_receivable_snapshot` — grain `(snapshot_date, party, bill_ref)` with bill date, due
  date, amount, outstanding, days overdue, bucket

**Start the receivable snapshot job immediately, before any UI exists.** DSO trend, CEI,
ADD and credit-grade migration all need history, and history cannot be reconstructed later
from current balances. This is the one irreversible decision in the document.

Incremental refresh every 30 minutes, full nightly rebuild, nightly level-reconciliation
check, "data as of HH:MM" always visible. Index on date, party, item. Target sub-second for
any single-period query over 3 years of data.

## K3. Permissions

| Role | Company | Brand | Own scorecard | Others | Margin | Receivables |
|---|---|---|---|---|---|---|
| Owner / Admin | Yes | Yes | Yes | Yes | Yes | All |
| Sales head | Yes | Yes | Yes | Yes | Yes | All |
| Salesperson | Summary only | No | Yes | League table only | Own book, % not ₹ | Own book |
| Accounts | Yes | No | — | No | No | All |
| Others | No | No | No | No | No | No |

Keys: `cfo.sales.view` · `cfo.margin.view` · `cfo.receivables.view` · `cfo.brand.view` ·
`cfo.team.view` · `cfo.compliance.view` · `cfo.exceptions.view` · `cfo.export` ·
`cfo.lists.assign`

Two deliberate choices to confirm with the owner: salespeople see the **league table but not
each other's detail** (rank motivates, full visibility does not), and margin is shown to
salespeople as a **percentage on their own book only** — enough to defend price, not enough
to walk out with your cost structure.

Every export logs user, filter set and row count. A customer list with margins is the most
portable asset in a distribution business.

---

# PART L — NARRATIVE AND ALERTS

The generator consumes computed metric outputs only, never raw rows, and may not state a
number it was not given.

**Structure per period:** headline (direction and cause, one sentence) · bridge summary in ₹
· three things that went right, with names · three that went wrong, with names and ₹ · cash
(DSO/CEI movement, collection forecast, cash cycle) · **do this week** — five actions, each
naming a customer or SKU, each with an owner, each linked to the list it came from.

**Alert defaults**, all configurable, evaluated by a nightly job, landing in the existing
notification bell and a 9:00 AM digest:

top-10 customer down >20% vs LY · silent churn on a customer above ₹X annual · DSO up
>5 days vs rolling 90-day average · CEI down >5 points · ADD up >3 days · gross margin down
>2 points · credit limit breach · concentration up >5 points · dead stock above threshold ·
price realisation gap widening · negative-margin line detected · credit grade migration to
D/E · MSME exposure crossing threshold · **distance-to-slab alert daily from the 20th**.

## Reporting cadence

| Cadence | Contents | Audience |
|---|---|---|
| Daily 9 AM | Yesterday vs LY same day, MTD pacing vs target, collections received, new silent-churn entries, credit breaches, exception count | Owner, sales head |
| Weekly Monday | Full scorecard, L01–L08 refreshed, credit ladder, top 10 movers, fill rate, league table | Owner, sales, accounts |
| Monthly close (PDF) | Full register with 3 comparisons, revenue and margin bridges, movement matrix, ageing with ECL provision, cash cycle, working capital, exceptions, compliance exposures, narrative | Owner, CA |
| Quarterly | Cohort retention, ABC-XYZ, concentration and HHI trend, credit grade migration, price band review, break-even reset | Owner, CA |
| Annual | Three-year trend, CAGR by customer and category, bad debt history, concentration risk note | Owner, CA, banker |

**Acceptance test for the module: the monthly close pack is a single PDF your CA can work
from directly.**

---

# PART M — OPEN DECISIONS (raise via popup)

1. Tally valuation method for landed cost
2. Inward freight — in item cost or separate ledger?
3. Salesperson source — Tally cost centre or Vyuha dated mapping?
4. Are credit notes linked to original invoices in Tally?
5. Borrowing rate for D17 and W04 interest costing
6. Monthly fixed cost for break-even, and who maintains it
7. Delivery cost basis for M08 — per drop, per km, or allocated?
8. Targets — entered in Vyuha or imported?
9. Credit grade weights — accept D18 defaults or tune?
10. Materiality floor
11. Multi-company in Tally — one or several to consolidate?
12. Are C&S and BCH cleanly separated in the stock item master today?
13. Split credit between two salespeople — allowed or not?
14. Incentive slab rates and deduction rate
15. Who may see margin in rupees? Recommend owner and admin only at launch.

---

# PART N — BUILD ORDER

**Phase 1 — Foundation (nothing works without this)**
1. Period engine and comparison contract, with tests for elapsed-day matching, FY
   boundaries, working-day matching
2. Level model and resolver, with nightly reconciliation check and Unassigned bucket
3. Customer → owner mapping with effective dates
4. `fact_sales_daily` and `fact_receivable_snapshot` + refresh jobs. **Start the receivable
   snapshot on day one.**
5. Three shared components: `<KpiCard>`, `<ReportChart>`, `<ReportTable>`. Every screen
   after this is assembly, not construction.
6. Shell: sidebar, breadcrumb, period bar with level selector, command palette

**Phase 2 — First usable release**
7. Metric register: C1, C3, C4
8. Dashboard
9. Receivables
10. Work lists L01, L02, L07, L15–L20 with CRM push — this is where the module starts paying
11. My CFO screen — this is what drives adoption

**Phase 3 — Explanation**
12. Five-factor revenue bridge and margin bridge
13. Customer movement matrix
14. Sales Analysis, level-aware
15. League table and person scorecard
16. Targets entry and target-vs-actual everywhere

**Phase 4 — Margin and brand**
17. Confirm valuation → M-series and pocket-price waterfall → L09–L14
18. Brand Performance with slab tracking
19. Category 360 for MCB/MCCB/ACB/RCCB/PQ
20. Customer 360, Product 360

**Phase 5 — Depth**
21. Working capital, break-even, cohort, ABC-XYZ, cross-sell, seasonality
22. Exceptions and compliance
23. Incentive calculation and export
24. Narrative, alerts, monthly close pack PDF
25. Business-line split when export billing begins

Ship Phases 1–2 as the first release. A dashboard without work lists is a wall chart.
Phase 1 items 1–5 are unglamorous and are the whole foundation — do not let them be skipped
in favour of the charts.

---

# PART O — DIRECTOR'S DESK, DAILY CALL LIST AND EXPORT CENTRE


Solves two things the earlier parts do not:

1. **"Which 5 or 10 customers do we work on today?"** — one list, not twenty.
2. **"Give me the export of everything."** — a report catalogue with scheduled delivery.

---

## O1. The problem this solves

Part E gives twenty work lists. A single customer can appear on six of them at once —
declining, overdue, price leakage, cross-sell gap, order gap widening, limit breach. Twenty
lists is twenty decisions every morning, so in practice nobody opens any of them.

The Director's Desk collapses all twenty into **one ranked, deduplicated, capped list** with
a name, a reason, a rupee figure, an owner and a suggested ask.

**Rule: one customer appears once per day, with their single highest-priority reason
shown and every other reason listed underneath it.**

---

## O2. The priority score

Computed nightly for every active customer. Score 0–100, rebuilt daily.

```
Score = (Value  × 35)
      + (Urgency × 30)
      + (Risk    × 20)
      + (Opportunity × 15)
      − (Cooldown penalty)
```

| Factor | Built from | Notes |
|---|---|---|
| **Value** | Trailing 12-month sales of the customer, log-scaled and normalised 0–1 | Prevents a ₹8,000 customer outranking a ₹40 lakh one on urgency alone |
| **Urgency** | max of: days overdue ÷ 90 · days past their own median order gap ÷ 60 · days to credit-note time bar | Whichever clock is loudest wins |
| **Risk** | Credit grade (A=0 … E=1), broken promise-to-pay count, limit utilisation | |
| **Opportunity** | Cross-sell expected ₹ + lost-line recoverable ₹, normalised | Keeps the list from becoming purely a collection list |
| **Cooldown penalty** | 40 points if contacted in the last 14 days with no outcome change | Stops the same five names appearing every single day |

All weights configurable in Settings. Show the score breakdown on hover — a director will
not trust a ranking he cannot inspect.

## O2.1 Rotation and coverage rules

Without these, the list becomes stale in a week.

| Rule | Default | Why |
|---|---|---|
| Cooldown | 14 days after a logged contact | Unless the outcome was "call again" with a date, or the customer escalates a grade |
| A-band coverage guarantee | Every A-band customer must appear at least once in 30 days | Big accounts must not be crowded out by noisy small ones |
| Dormant injection | At least 1 win-back name per day | Otherwise dormant customers are never called, because they generate no fresh signal |
| New-customer follow-up | Any first-time buyer at day 30 and day 45 | The cheapest revenue in the business |
| No repeat within a week | Unless escalated | |
| Owner balance | No owner gets more than 40% of a day's list | |

---

## O3. The weekly rhythm

Each weekday carries a theme, so the team's head is in one mode per day. Themes and the
daily cap (5 or 10) are configurable per user.

| Day | Theme | Drawn mainly from |
|---|---|---|
| Monday | **Money** — collections | L15–L20 |
| Tuesday | **Slipping** — declining accounts | L02, L06, L07 |
| Wednesday | **Quiet** — silent churn and win-back | L01, L04 |
| Thursday | **Price** — margin and leakage | L09–L14 |
| Friday | **Grow** — cross-sell, lost lines, new customers | L03, L05, L08 |

The score still ranks within the theme, so Monday's ten are the ten *most valuable* overdue
accounts, not the ten oldest. A `Switch` for "Mixed mode" ignores themes and simply serves
the top N by score — use it when someone has been away.

**Saturday:** week-close screen — what was actioned, what came in, what rolls over.

---

## O4. The call sheet — per-customer analytics

Every name on the daily list carries a one-page brief. Available on screen, in the PDF
export, and on mobile.

```
┌──────────────────────────────────────────────────────────────┐
│ CUSTOMER NAME                    Grade B    Owner: RS        │
│ Phone · City · Since 2019 · Terms: 45 days                   │
├──────────────────────────────────────────────────────────────┤
│ WHY TODAY                                                    │
│ Primary : No order in 71 days (their normal gap is 38)       │
│ Also    : ₹4.2L overdue 40 days · buying 22% below median    │
│           price on MCB · stopped buying RCCB since March     │
├──────────────────────────────────────────────────────────────┤
│ THE NUMBERS                                                  │
│ This year        ₹38.4L    Last year  ₹52.1L    −26%         │
│ Last 12m trend   [ 12-month sparkline ]                      │
│ Real profit      14.2%     Company average 17.8%             │
│ Outstanding      ₹6.1L     Overdue ₹4.2L                     │
│ Ageing           0-30 ₹1.9L · 31-60 ₹2.8L · 61-90 ₹1.4L      │
│ Takes to pay     67 days   Agreed 45 · 22 days late          │
│ Their delay costs us  ₹68,400 a year                         │
│ Promises         3 made · 1 kept                             │
├──────────────────────────────────────────────────────────────┤
│ WHAT THEY BUY                                                │
│ Top: MCB 42% · MCCB 31% · PQ 18%                             │
│ Stopped: RCCB (₹4.8L last year) · ACB (₹2.1L)                │
│ Should buy: RCCB — 71% of similar customers do (est ₹3.5L)   │
├──────────────────────────────────────────────────────────────┤
│ LAST CONTACT   12 Aug, RS — "will clear by month end"        │
├──────────────────────────────────────────────────────────────┤
│ SUGGESTED ASK                                                │
│ 1. Collect ₹2.8L (the 31-60 bucket) before month end         │
│ 2. Reopen RCCB — ₹3.5L a year                                │
│ 3. Correct MCB rate — ₹1.4L a year at median                 │
├──────────────────────────────────────────────────────────────┤
│ OUTCOME  [ Order ▾ ] [ ₹______ ] [ Next date ] [ Notes ]     │
└──────────────────────────────────────────────────────────────┘
```

Every figure on this sheet already exists in Parts C and D — nothing new to calculate. The
work is assembling it into one page.

## O4.1 Outcome capture — the part that closes the loop

Mandatory before a name can be marked done. `Select` with: Order placed · Promise to pay ·
Partial payment · No response · Dispute raised · Not interested · Wrong contact ·
Call again on date.

Outcome feeds back into the score, the cooldown, the promise-to-pay log, and the salesperson
activity metric in G4. **Without outcome capture the list has no memory and degrades into a
static report within a month.**

---

## O5.1 Director's Desk — required contents

```
Header:  Tuesday, 26 August · Theme: Slipping accounts · [ 5 | 10 | 20 ]
Strip:   Yesterday — 10 called · 6 outcomes · ₹3.2L collected · 2 orders ₹8.4L
─────────────────────────────────────────────────────────────
Ranked list, one Card per customer:
  rank · name · grade · primary reason · ₹ at stake ·
  owner Avatar · [ Open call sheet ] [ Assign ] [ Done ]
  Collapsible: all other reasons this customer qualifies
─────────────────────────────────────────────────────────────
Footer:  [ Export today's list ] [ Week planner ] [ Change theme ]
```

Each row must expose: the customer's tier and payment grade, the urgency, the secondary
reasons (collapsed), the owner, the call sheet, the outcome capture, and the 5/10/20 cap
control.

## O5.2 Week Planner — required contents

Five columns, one per weekday, each showing its theme and the names queued. Names can be moved between days.
Shows total ₹ at stake per day and per owner,
so a director can see the week's workload before Monday. Regenerates each Sunday night;
manually added names stick.

## O5.3 Week Close (Saturday) — required contents

Called vs planned · outcomes by type · ₹ collected against ₹ targeted · orders won ·
rollovers into next week · owner-wise completion. One `Table`, one bar chart, one export.

---

## O6. Export Centre — the director's overall report list

A single screen listing every report in the module, each exportable on demand or scheduled.

| Column | Content |
|---|---|
| Report | Plain name |
| What it tells you | One line |
| Level | Company / Brand / Person / Customer |
| Default period | |
| Formats | Excel · PDF · both |
| Schedule | None / Daily / Weekly / Monthly |
| Recipients | Email list |
| Last run | Timestamp, download link |

## O6.1 The catalogue

**Daily** — Director's call list (today) · Yesterday's outcomes · Collections received ·
Credit breaches · Exception summary · Distance-to-slab (from the 20th)

**Weekly** — Week planner · Week close · Sales scorecard WTD/MTD · League table ·
Ageing summary · Silent churn additions · Top 10 movers

**Monthly** — Close pack (the CA pack) · Full metric register with three comparisons ·
Revenue bridge · Margin bridge · Customer movement matrix · Ageing with ECL provision ·
Brand performance and scheme accrual · Category performance · Person scorecards ·
Incentive statement · Working capital and cash cycle · Compliance exposures · Exceptions

**Quarterly** — Cohort retention · ABC-XYZ · Concentration and HHI · Credit grade migration
· Price band review · Break-even reset

**Annual** — Three-year trend and CAGR · Bad debt and provisioning history · Customer and
vendor concentration note · Full customer master with lifetime value

**On demand** — Any of the twenty work lists · Customer statement · Customer 360 pack ·
Product 360 pack · Brand pack · Custom export builder

## O6.2 Bulk export

`Checkbox` multi-select across the catalogue → **Export selected** → single ZIP, or a merged
PDF with a cover page and contents. This is the "give me everything" button a director
actually wants before a review meeting or a bank visit.

## O6.3 Scheduled delivery

Per report: cadence, time, recipients, format. Delivered by email, with a WhatsApp digest
option once the WhatsApp API is integrated (already on your Phase 7 roadmap).

Default schedules to ship with:

| Report | When | To |
|---|---|---|
| Director's call list | Daily 8:30 AM | Owner, sales head, each owner gets their own slice |
| Yesterday's outcomes | Daily 8:30 AM | Owner |
| Week planner | Sunday 6:00 PM | Owner, sales head |
| Week close | Saturday 2:00 PM | Owner |
| Monthly close pack | 3rd working day | Owner, CA |
| Slab alert | Daily from the 20th | Owner, sales head |

## O6.4 Export standards

Every export carries a header block: company name, report name, period and comparison
period, level and member, filters applied, generated-by user, generated-at timestamp,
"data as of", and "All figures exclusive of GST".

Excel exports are **data, not decoration** — one flat sheet per report, real numbers not
text, no merged cells, so it can be pivoted. Add a second sheet with the filter block.
PDF exports are formatted for reading and for printing on A4.

Every export is logged: user, report, filters, row count. A customer list with margins is
the most portable asset in the business.

---

## O7. Permissions

| Role | Sees |
|---|---|
| Owner / Director | Full list, all owners, all reports, bulk export |
| Sales head | Full list, all owners, all reports except incentive detail of others |
| Salesperson | **Only their own slice of the daily list** and their own call sheets. Same screen, filtered. |
| Accounts | Money-theme days and receivables reports only |

A salesperson opening the Director's Desk sees "My 5 for today", not the company's ten. Same
component, scoped by the level model in Part B3.

---

## O8. Build order for Part O

1. Priority score job, running nightly over the existing work lists. No UI yet — verify the
   ranking by exporting a CSV and reading it with the owner for a week. **Tune weights
   before building the screen.**
2. Deduplication and reason-stacking (primary reason + all others).
3. Rotation and coverage rules.
4. Director's Desk screen with the 5/10/20 cap.
5. Call sheet — assembly only, all figures already exist.
6. Outcome capture and feedback into score, cooldown and activity metrics.
7. Export of today's list (Excel + PDF call sheets).
8. Week Planner and Week Close.
9. Export Centre catalogue.
10. Scheduling and email delivery.
11. Bulk ZIP / merged PDF export.

Step 1 is worth a full week of tuning on real data before any screen is built. A ranked list
the director disagrees with on day three is worse than no list at all — he will stop opening
it and will not come back.

---

# PART P — CUSTOMER TIERS (A+ TO D)


---

## P1. Two gradings, and why they must not collide

The module already has an **automatic credit grade A–E** (Part C4, D18), computed from
payment behaviour. You are now adding a **manual tier A+ to D**, set by judgment.

These are different things and must never share a visual language, or every screen becomes
ambiguous.

| | Credit grade | Customer tier |
|---|---|---|
| Name on screen | **Payment grade** | **Customer class** |
| Values | A · B · C · D · E | A+ · A · B · C · D |
| Set by | System, nightly | A person, manually |
| Answers | "Will they pay?" | "How important are they to us?" |
| Changes | On its own, from behaviour | Only when someone decides |
| Must be visually distinct | Yes — the two must never be confused on screen |

A customer can be **Class A+ with Payment grade D** — your biggest account who pays late.
That combination is exactly the one a director needs to see at a glance, and it is invisible
if the two systems look alike.

Show both side by side wherever a customer is named: `[A+] [D]` with distinct shapes and a
tooltip on each.

---

## P2. Tier values

Five tiers: **A+ · A · B · C · D**, set manually. Each carries its own colour token,
configurable in the tier master. Colour must never be the only carrier of meaning — the
letter is always shown. Visual treatment is otherwise left to the design context.

The tier badge appears wherever a customer is named: customer detail, every table row, the
call sheet, work lists, league tables, exports and search results.

## P3. Tier master — configurable, not hardcoded

A settings screen with one row per tier:

| Field | Example |
|---|---|
| Code | A+ |
| Label | Key account |
| Description | Director relationship, quarterly visit |
| Colour token | Configurable |
| Default credit days | 45 |
| Default credit limit | ₹15,00,000 |
| Maximum discount without approval | 12% |
| Minimum contact frequency | Every 30 days |
| Service priority | Highest — dispatch same day |
| Review frequency | Quarterly |

Tiers can be renamed and their count changed (four to six), but **never deleted while
customers are assigned** — reassign first. Deleting a tier silently would orphan history.

---

## P4. Assignment

### Single customer
On Customer 360, a `Select` in the header. Changing it opens a `Dialog` requiring:
new tier, **reason** (mandatory, free text), effective date (default today).
Confirm → `Sonner`, written to history and audit log.

### Bulk
On the Customers screen: filter, `Checkbox` multi-select, "Set class" in the bulk bar,
one shared reason for the batch, preview count before applying.

### Import
Excel upload — customer code + tier + reason. Validation preview before commit, showing
what will change and what will not. Useful for the first-time classification of your
existing base, which is faster done in a spreadsheet with your sales team in a room.

### History — the important part

```
customer_tier_assignment
  customer_id · tier · effective_from · effective_to
  assigned_by · reason · created_at
```

**Resolve the tier as of the voucher date, never the current tier.** Same principle as
salesperson attribution in Part B4. If a customer was Class C last year and is A+ today,
last year's reports must still show C — otherwise every historical comparison silently
shifts each time someone re-grades, and nobody can reproduce an old report.

Customer 360 shows a small timeline of tier changes with reason and who made them.

---

## P5. System suggestion, human decision

The system proposes; the person decides. Never auto-assign.

Nightly, compute a **suggested tier** from revenue decile, margin contribution, order
frequency and growth trend. Then produce a **mismatch list**:

| Customer | Current class | Suggested | Why | Action |
|---|---|---|---|---|
| … | C | A | Now in top 15% by revenue, growing 34% | Accept · Keep · Snooze 90d |

Two directions matter, and both are useful:

- **Under-classified** — a C customer now buying like an A, receiving C-level service. You
  are under-serving someone worth protecting.
- **Over-classified** — an A+ customer who has shrunk for four quarters but still enjoys
  A+ credit terms and discount authority. This is where money leaks quietly.

Surface this list quarterly, and add "class mismatch" as a low-priority alert.

---

## P6. What the tier actually drives

A classification that only colours a badge is decoration. Wire it into:

| Area | Effect |
|---|---|
| **Priority score** (Part O2) | Tier multiplies the Value factor — A+ ×1.5, A ×1.25, B ×1.0, C ×0.8, D ×0.5. A director's call list should lean toward key accounts. |
| **Coverage guarantee** (O2.1) | A+ must be contacted every 30 days, A every 45, B every 60. Any breach raises a "neglected key account" alert — the most expensive failure a distributor makes. |
| **Credit policy** | Default credit days and limit come from the tier when a new customer is created |
| **Discount authority** | Discount above the tier ceiling requires approval; the approval popup shows the tier |
| **Dispatch priority** | Tier appears on the dispatch board so picking order follows it |
| **Work lists** | Filterable by tier; default view for the owner is A+ and A only |
| **Reports** | Tier as a slicer everywhere — sales by class, ageing by class, margin by class |
| **Escalation** | An A+ customer at 60 days overdue escalates to the director, not the accounts clerk |

## P6.1 New reports unlocked

- **Class mix** — revenue, margin and count by tier, this year vs last. 100% stacked bar.
- **Class migration** — a matrix of who moved from which class to which over the year, with
  ₹ impact. The number that matters: how many B customers became A, and how many A became C.
- **Service vs class** — fill rate, dispatch time and complaint count by tier. Answers "are
  we actually serving A+ better, or only calling them A+?"
- **Neglected key accounts** — A+ and A past their contact frequency, with days elapsed.
- **Class vs payment grade grid** — a 5 × 5 heatmap, count and ₹ in each cell. The A+ / D
  cell is your concentrated risk, in one number.

---

## P7. Review cadence

| When | What |
|---|---|
| Quarterly | Mismatch list reviewed by owner and sales head; accept or keep with reason |
| Annually, at FY start | Full re-classification with the sales team; import route is fastest |
| On event | New customer gets a tier at creation, mandatory field, default C |

Never re-grade silently, and never mid-month — a class change mid-period makes that period's
class-wise report unreadable. Effective dates should default to the 1st of the next month
unless overridden.

---

## P8. Permissions

| Role | Can |
|---|---|
| Owner / Director | Set any tier, edit the tier master, bulk assign, import |
| Sales head | Set tiers up to A, propose A+ for approval |
| Salesperson | See tiers, propose a change with reason — creates an approval task |
| Accounts | See tiers only |

Every change writes to the audit log: who, when, from, to, reason. Tier drives credit terms
and discount authority, so it is a financial control, not a label.

---

## P10. Build order

1. Tier master table and settings screen, with configurable colours
2. Tier display used consistently wherever a customer is named
3. `customer_tier_assignment` with effective dates, and as-of-date resolution
4. Single assignment on Customer 360, with mandatory reason
5. Tier shown everywhere a customer is named, including exports
6. Bulk assign and Excel import — do the first full classification of your base here
7. Tier as a slicer across all reports
8. Wire into priority score, coverage guarantee, credit defaults, discount ceilings
9. Suggested tier job and the mismatch list
10. Class mix, class migration, neglected key accounts, class × payment-grade grid

Steps 1–3 first. Once history is being recorded with dates, everything else can be added
without rework — but a tier system built without effective dates has to be rebuilt from
scratch the first time someone asks "what was this customer's class last March?"

---

# PART Q — ANALYTICS ROBUSTNESS AND THE MATRIX LIBRARY

Everything before this defines *what* to measure. This part defines *how to make those
measurements survive contact with real Tally data*, and adds the complete set of
two-dimensional matrices the module should carry.

A number that is wrong once destroys more trust than ten numbers that were never built.

---

## Q1. Robustness rules — apply to every metric, everywhere

These are not optional refinements. Each one exists because a real distributor's data
breaks the naive version of the calculation.

### Q1.1 Small numbers

| Rule | Behaviour |
|---|---|
| **Minimum base for a percentage** | If the comparison base is below the materiality floor, show the ₹ change only. Never "+840%" on a base of ₹6,000. |
| **Minimum sample for a trend** | A trend line needs at least 6 periods. Below that, show the points, not the line, and no trend arrow. |
| **Minimum orders for an order-gap** | Median order gap needs at least 5 completed orders. Below that the customer is "Insufficient history", not "silent churn". This alone removes most false alarms from the daily call list. |
| **Minimum lines for a price band** | A SKU's price band needs 8 or more customer-SKU transactions in the window. Below that, show the raw prices, not a median and quartiles. |
| **New customer growth** | No last-year base means growth is **"New"**, never a percentage and never infinity. |
| **Zero denominator** | Displays as "—" with a tooltip explaining why. Never 0, never NaN, never a blank cell. |

### Q1.2 Outliers

A single ₹40 lakh project order will distort every average that customer touches for a year.

- **Median as the default, mean as the secondary.** Average order value, days to pay, price
  realisation and order gap all use median. Show the mean beside it where both are useful.
- **Winsorise price analysis** at P5 and P95 before computing bands, so one wrongly-keyed
  rate does not widen every SKU's spread.
- **Flag, never silently exclude.** Any transaction beyond 3 median-absolute-deviations gets
  an outlier badge in tables and an "excluded from average" note. The user must be able to
  see what was set aside and put it back with a toggle.
- **Project orders** — allow a manual "one-off / project" tag on an invoice. Tagged
  invoices are excluded from order-gap, AOV and trend calculations but included in totals.
  Without this tag, one project order makes a good customer look like a churn risk for the
  next twelve months.

### Q1.3 Comparability

- **Incomplete periods are labelled.** The current month is always marked "in progress";
  never plot it as a completed point beside finished months without a visual distinction
  (dashed segment, hollow marker).
- **Base-effect warning.** If the comparison period was itself abnormal — more than 2
  standard deviations from that customer's or SKU's own 24-month mean — show a small warning
  icon on the delta: "last year was unusually high".
- **Working-day and festival adjustment.** Diwali shifts by weeks between years. Offer a
  festival-aligned comparison toggle in addition to calendar comparison.
- **Price-list changes.** When a principal revises rates, the price effect in the growth
  bridge should separate *your* pricing decisions from *their* rate revision. Store price
  list versions with effective dates and split the price effect into "list change" and
  "our discounting".

### Q1.4 Data integrity

- **Duplicate party ledgers.** In Tally the same customer often exists as two or three
  ledgers (branch, old name, spelling variant). Build a **party merge map** in Vyuha:
  suggested duplicates by fuzzy name, GSTIN and phone; a human confirms. Without this,
  concentration, retention and every customer-level metric is wrong, and the daily call list
  will show the same customer twice.
- **UOM normalisation.** Quantity metrics are meaningless across mixed UOMs. Maintain a
  conversion table; where a SKU has no conversion, quantity metrics are suppressed for it
  rather than summed wrongly.
- **Missing cost.** Any line without a resolvable landed cost is excluded from margin and
  counted in the data-quality score. Margin % is never computed on a partial denominator
  without saying so on screen: "margin shown on 94% of lines".
- **Credit note lag.** Returns often land weeks after the sale. Any period less than 45 days
  old carries a "may still change" marker on net sales and return rate.
- **Backdated entries.** If a voucher is entered after a period was reported, the affected
  report shows a restatement flag with the old and new figure.

### Q1.5 Reproducibility

- Every report can be run **"as at" a past date** and reproduce exactly what it showed then.
  This requires the fact tables to be append-and-version, not overwrite.
- Metric definitions are **versioned with effective dates**. If the DSO formula changes,
  old reports keep the old formula and say which version they used.
- Every export header carries: period, comparison, level, filters, data-as-of, metric
  definition version, and generated-by.

### Q1.6 Reconciliation

Run nightly, surface failures as exceptions:

1. Sum of persons = sum of brands = sum of business lines = company total, to the rupee
2. Sum of ageing buckets = total outstanding = Tally debtors closing balance
3. Net sales in the fact table = Tally sales register for the same period
4. Opening + additions − collections − credit notes = closing, on receivables
5. Sum of the growth bridge's five factors = actual year-on-year change, exactly

**Rule five is the acceptance test for the bridge.** If the factors do not sum to the actual
change, the bridge is decorative and must not ship.

### Q1.7 Confidence and honesty on screen

- Forecasts show a **band, never a point**, and state the method in one line.
- Churn probabilities, elasticity and any modelled figure carry a confidence label —
  High / Medium / Low — based on sample size and history length, with the reason on hover.
- Correlation is never described as cause in the narrative layer. "Discount and volume move
  together" is permitted; "discount drives volume" is not, unless the elasticity test in
  Q2.16 was run.

---

## Q2. The matrix library

Twenty-two matrices. Each is a grid, each cell is clickable to a named list, each cell has
a defined action. Build them from one shared `<MatrixGrid>` component with configurable
axes, thresholds, cell colouring and drill target — not twenty-two separate screens.

Thresholds are configurable in every case; the defaults below are sensible starting points.

### Customer matrices

| # | Matrix | Axis X | Axis Y | What each cell tells you |
|---|---|---|---|---|
| Q2.1 | **Movement × size** | New / Reactivated / Growing / Flat / Declining / Lost | A / B / C band | Where revenue is being won and lost. "Declining × A" is the most expensive cell in the module. |
| Q2.2 | **Class × payment grade** | Class A+…D (manual) | Payment grade A…E | Concentrated risk. The A+ / D cell is your biggest exposure in one number. |
| Q2.3 | **Value × risk** | Trailing 12m revenue decile | Composite risk score | Who to protect, who to tighten, who to let go |
| Q2.4 | **Recency × frequency** | Days since last order, bucketed | Orders in 12m, bucketed | The RFM core, as a readable grid |
| Q2.5 | **Growth × margin** | Revenue growth % vs LY | Pocket margin % | Four quadrants: grow-and-earn, grow-but-thin, shrinking-but-profitable, exit candidates |
| Q2.6 | **Ageing × class** | Ageing bucket | Customer class | Are your key accounts also your slowest payers? Usually yes, and nobody looks. |
| Q2.7 | **Share of wallet × margin** | Estimated wallet share | Pocket margin % | Where to push volume vs where to fix price |
| Q2.8 | **Order size × frequency** | Median order value | Orders per year | Segments a distributor's base far better than revenue alone. Small-frequent and large-rare need completely different service models. |

### Product and category matrices

| # | Matrix | Axis X | Axis Y | Purpose |
|---|---|---|---|---|
| Q2.9 | **ABC × XYZ** | Revenue contribution A/B/C | Demand variability X/Y/Z | Stocking policy per cell. AX = never out of stock; CZ = order against demand only. |
| Q2.10 | **Penetration grid** | Customer | Category (MCB / MCCB / ACB / RCCB / PQ) | **The whitespace map.** Filled cell = they buy it; empty = they buy it from someone else. For a five-category distributor this is the single most actionable grid in the module. |
| Q2.11 | **Brand share by customer** | Customer | C&S / BCH / Others | Who is single-brand and could be converted, and where you are losing a brand |
| Q2.12 | **Price vs volume** | Average realisation decile | Quantity decile, per SKU | Where discounting bought volume and where it simply gave money away |
| Q2.13 | **Stock cover × velocity** | Cover days | Sales velocity | Buy more / hold / promote / liquidate, one action per cell |
| Q2.14 | **Margin × velocity** | Pocket margin % | Units per month | Which SKUs to push in campaigns; high-margin fast movers first |
| Q2.15 | **Seasonality heatmap** | Month | Category | When each category actually sells. Drives stocking and campaign timing. |
| Q2.16 | **Discount elasticity** | Discount % decile | Volume index | Tests whether discount buys volume at all. In most distribution businesses it does not, and this grid is how you prove it before the next scheme. |

### People, service and vendor matrices

| # | Matrix | Axis X | Axis Y | Purpose |
|---|---|---|---|---|
| Q2.17 | **Salesperson: growth × collection** | Sales growth % | Collection quality (CEI or days late) | Separates the seller who books volume he cannot collect from the one who does both |
| Q2.18 | **Salesperson: margin × volume** | Pocket margin % | Sales value | Finds the discounter early |
| Q2.19 | **Service equity** | Customer class | Fill rate / dispatch time | Are you actually serving A+ better, or only calling them A+? |
| Q2.20 | **Vendor dependency × reliability** | Share of purchases | Lead-time variance | Single-source risk, ranked |
| Q2.21 | **Cohort retention** | Acquisition month | Months since acquisition | Whether newly won customers are getting better or worse |
| Q2.22 | **Quote conversion × price index** | Quoted price vs market/median index | Win rate | The price at which you actually start losing orders — the only empirical basis for a discount policy |

### Rendering rules for all matrices

- Cell colour = intensity of a single hue, not a rainbow. Colour carries magnitude only.
- **Every cell shows two things: count and ₹.** A cell with 40 customers worth ₹2 lakh and
  a cell with 3 customers worth ₹80 lakh must never look alike.
- Empty cells are meaningful in Q2.10 and Q2.11 — style them as opportunity, not absence.
- Clicking a cell opens the named list behind it, with bulk actions that create CRM tasks.
- Every matrix exports with both count and value grids on separate sheets.
- Row and column totals always shown, and they must tie to the module totals (Q1.6).

---

## Q3. Data Quality screen

Robust analytics needs a screen that admits what is broken. Place it under CONTROL.

| Check | Metric | Fix action |
|---|---|---|
| Unassigned sales | % of net sales with no salesperson | Assign owner |
| Duplicate parties | Suspected duplicate ledger pairs | Review and merge |
| Missing cost | % of lines with no resolvable landed cost | Map cost |
| Missing due date / bill-wise ref | % of invoices | Fix in Tally |
| Items without brand | Count of SKUs | Map to C&S / BCH / Other |
| Items without category | Count of SKUs | Map to MCB / MCCB / ACB / RCCB / PQ |
| Items without UOM conversion | Count | Add conversion |
| Parties without class | Count | Assign tier |
| Parties without credit terms | Count | Set terms |
| Invalid or missing GSTIN | Count | Correct master |
| Negative margin from bad cost | Count of lines | Investigate |
| Customers without a phone number | Count | Add — a call list without numbers is useless |

Each row: current value, target, trend over 90 days, and a drill to the offending records.

**A single headline "Data health: 87%" score sits on the CFO dashboard.** Every analytical
screen shows a small warning when its own inputs fall below a threshold — for example,
the margin screen warns when cost coverage drops under 90%.

This screen is what makes the rest defensible. Build it in Phase 2, not last.

---

## Q4. Metric governance

- A single **metric registry** table is the source of every definition: id, plain label,
  technical name, formula, source, denominator, unit, good direction, materiality floor,
  minimum sample, permission key, version, effective from.
- Every screen reads labels and tooltips **from the registry**, never hardcoded strings. One
  definition change updates every screen and every export.
- A **"How is this calculated?"** panel on every metric, opened from the info icon, showing
  the formula, the source vouchers, what is excluded, and the current definition version.
- A **change log** screen: what definition changed, when, by whom, and which reports are
  affected. Any user comparing an old export with a new one must be able to see why they
  differ.

---

## Q5. Alert discipline

Robust alerting is mostly about *not* firing. An alert system that cries wolf is switched
off within a fortnight, taking the module with it.

| Rule | Default |
|---|---|
| Minimum value floor | No alert on exposure below materiality |
| Confirmation | Threshold breaches must persist 2 consecutive evaluations before firing, except credit limit breaches and negative-margin lines, which fire immediately |
| Hysteresis | An alert clears only when the metric recovers past the threshold by 10%, so it does not flap |
| Daily cap | Maximum 10 alerts per user per day, ranked by ₹ exposure; the rest roll into a digest line |
| Deduplication | One alert per customer per day, carrying all reasons |
| Snooze | Any alert can be snoozed with a reason and a date; snoozes are logged and reviewed monthly |
| Escalation | An unacknowledged alert above a value threshold escalates to the director after 3 days |
| Seasonal suppression | Metrics with a known seasonal pattern compare against the seasonally adjusted expectation, not the flat average |

Every alert states: what, how much, since when, why it fired, and one action.

---

## Q6. Build order for Part Q

1. Robustness rules Q1.1 and Q1.2 into the metric engine — before any metric ships, not
   retrofitted. Retrofitting minimum-sample rules after users have seen "+840%" is how a
   dashboard loses its audience.
2. Reconciliation checks Q1.6, wired to the nightly job and the exception list.
3. Data Quality screen (Q3) and the party merge map — these unblock the accuracy of
   everything else.
4. Metric registry and the "How is this calculated?" panel (Q4).
5. `<MatrixGrid>` shared component.
6. Matrices in this order: Q2.1, Q2.10, Q2.2, Q2.5, Q2.9, Q2.6, Q2.17 — these seven cover
   most decisions. The rest follow as configs.
7. Comparability rules Q1.3 and reproducibility Q1.5.
8. Alert discipline Q5, before alerts are switched on for real users.
9. Remaining matrices.

Q2.10, the penetration grid, is worth building early and out of sequence. For a
five-category switchgear distributor, the empty cells in that grid are the clearest revenue
opportunity in the entire module, and they need no modelling — only a join.

---

# PART R — REPORT DETAIL VIEW AND DRILL CONTRACT

Every report in the catalogue is clickable. Clicking it opens a full detail view, and from
there every number keeps drilling until it reaches an actual Tally voucher.

Build **one** `<ReportDetail>` shell with a config per report. Not 183 pages.

---

## R1. The drill contract

Four levels. Every report supports all four, or declares which it stops at.

```
LEVEL 1   SUMMARY       the headline number, on a card or in the catalogue
LEVEL 2   BREAKDOWN     grouped rows — by customer, product, month, bucket
LEVEL 3   TRANSACTIONS  the individual invoices, orders, receipts or lines
LEVEL 4   VOUCHER       the source document as it exists in Tally
```

**Rules:**

- **Every drill terminates at a voucher.** If a user cannot get from a total to the exact
  invoice behind it, the report is not finished. This is the single test of whether the
  module is trusted — a controller who cannot trace a figure will not use the figure.
- The path is always visible in a breadcrumb, and every step in it is clickable back.
- Filters carry down the drill and are shown as removable chips at each level.
- Period and comparison never change during a drill unless the user changes them.
- The voucher view is read-only, shows voucher number, date, party, items, values, taxes,
  and a "how this was counted" note explaining which metrics included it.

## R2. Entry points

A report detail view opens from any of these, and the source is remembered so Escape returns
there:

- The Report Catalogue (Part O6) — clicking the report name
- A dashboard KPI card
- A chart element — bar, point, cell, slice
- A matrix cell
- An alert
- A work list row
- The command palette
- A direct URL

---

## R3. Required contents of a report detail view

Every report detail view must contain, regardless of how it is laid out:

- The report name and its one-line plain meaning
- Period, comparison period, level and member currently applied
- Applied filters, individually removable
- A summary strip of 3–5 headline figures with change in ₹ and %
- Data-as-of timestamp, and a warning when input data is incomplete
- A primary visual appropriate to the report type (R4)
- **A full data table, always** — same numbers as the visual
- Grand total that ties to the summary strip, with a badge confirming it ties
- Export, definition panel and available actions
- A breadcrumb showing the drill path, each step clickable

## R4. Rendering suitability — what "whatever is suitable" resolves to

Each report declares a `renderType` in its config. Ten types cover all 183.

| Type | Used when | Primary view | Examples from the catalogue |
|---|---|---|---|
| `RANK` | Comparing many named things at one point in time | Horizontal bar, top 15, rest in table | Sales by customer, by product, by salesperson (3–8) |
| `TREND` | One or few series over time | Line, with comparison series | Sales trend, DSO trend, cash cycle (2, 49, 76) |
| `PACING` | Progress through a period against a goal | Cumulative area with projection and target line | Month pacing, target vs achievement, slab distance (10, 80, 81) |
| `BRIDGE` | Explaining a change between two figures | Waterfall | Revenue bridge, margin bridge, funds flow (19, 20, 78) |
| `BUCKET` | Distribution across ordered bands | Stacked horizontal bar | Ageing, stock cover, price bands (46, 37, 65) |
| `MATRIX` | Two dimensions crossed | Grid with count and ₹ in every cell | All of group 9 (100–118) |
| `COMPOSITION` | Share of a whole, over time or at a point | 100% stacked bar, or treemap for a snapshot | Category mix, brand share (85, 84) |
| `STATEMENT` | A running account for one party | Ledger-style table, running balance, no chart | Customer statement, bill-wise outstanding (47, 48) |
| `LIST` | Names to act on, not numbers to study | Card or row list with reason, ₹, owner, action | All of group 10 (119–143) |
| `REGISTER` | Raw transactions for verification | Plain table, virtualised, no chart | Daily sales register, exception reports (9, 155–169) |

**Fallback rule:** if a report does not clearly fit a type, it is `REGISTER` — a plain,
sortable, exportable table. A boring table that is correct beats a clever chart that is
wrong, and every report in this module must at minimum be readable as a table.

---

## R5. Table capabilities — the same on every report

| Capability | Behaviour |
|---|---|
| Standard columns | Dimension · current · comparison · change ₹ · change % · share % · rank · sparkline. Reports may add their own, never drop these where applicable. |
| Sort | Any column, multi-column with shift |
| Column filter | Per column, type-appropriate — text search, number range, date range, multi-select |
| Group by | Any dimension, with collapsible subtotals |
| Subtotals and grand total | Always shown; grand total must tie to the summary strip, and a badge confirms it does |
| Column chooser | Show, hide, reorder; choice remembered per user per report |
| Freeze | First column and header row always frozen |
| Cell drill | Any value cell opens the next level down |
| Row action | Opens the entity's 360 page, or the voucher |
| Saved views | Name and save a filter-plus-column set; share it with a colleague |
| Row density | Compact / normal, remembered per user |
| Large sets | Server-side pagination and virtual scroll beyond 500 rows — never load 40,000 rows into the browser |
| Conditional formatting | Negative values, outliers, breaches and overdue rows visually marked, never by colour alone |

---

## R6. Export from the detail view

Exports **exactly what is on screen** — same filters, same columns, same sort, same grouping.
A user who has spent five minutes shaping a view expects the export to match it. Anything
else is a bug.

- Excel: flat data sheet plus a second sheet with the filter and definition block
- PDF: formatted as displayed, including the visual
- Both carry the standard header block: company, report, period, comparison, level, filters,
  data-as-of, definition version, generated by, generated at

---

## R7. Definition panel

A definition panel must be available on every report, showing:

- Plain-English meaning
- Exact formula
- Source vouchers and ledgers
- What is excluded, and why
- Minimum sample rules that apply (Part Q1.1)
- Current definition version and effective date
- Related reports

Content comes from the metric registry (Part Q4), never hardcoded.

---

## R8. States

| State | Behaviour |
|---|---|
| Loading | Skeleton in the shape of the table and visual, not a spinner |
| Empty | One line explaining why there is no data — usually the filter or the period — with a one-click way to widen it |
| Partial data | Yellow strip: "Margin shown on 94% of lines" with a link to Data Quality |
| Stale | "Data as of 09:00, refresh due 09:30" with a manual refresh |
| Error | Destructive alert, retry, and the timestamp of the last good load |
| Restated | Flag if backdated entries changed a previously reported figure, showing old and new |

---

## R10. URL and sharing

Every detail view is fully addressable:

```
/cfo/report/{reportId}?period=MTD&compare=LY&level=person&member=RS
   &filter=brand:CS&group=customer&sort=-net&view=table
```

Sending that link to a colleague opens exactly the same view, subject to their permissions.
If a permission blocks part of it, show what they may see and state plainly what is hidden —
never fail silently.

---

## R11. Build order

1. `<ReportDetail>` shell — header, summary strip, view toggle, table, footer, states
2. `<ReportTable>` with the full R5 capability set — this is the most reused component in
   the module and deserves the most care
3. Drill contract and breadcrumb, with the voucher view as the terminating page
4. Rendering types in this order: `REGISTER`, `RANK`, `TREND`, `BUCKET` — these four cover
   the first release
5. Export from view, matching filters exactly
6. Definition panel, reading from the metric registry
7. `PACING`, `BRIDGE`, `MATRIX`, `COMPOSITION`, `STATEMENT`, `LIST`
8. Saved views, column chooser persistence, sharing links

**Report configs, not report pages.** Adding the 184th report should mean adding one config
file — id, plain name, renderType, dimensions, metrics, default period, drill target,
permission key — and nothing else.
