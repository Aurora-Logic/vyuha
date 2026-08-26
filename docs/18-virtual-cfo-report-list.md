# Vyuha Virtual CFO — Report List

Every report the module should produce. No design, no build notes.

Levels: **CO** company · **BL** business line (domestic/export) · **BR** brand · **PE** person · **CU** customer · **PR** product

---

## 1. Sales and revenue

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 1 | Sales summary | Gross, returns, discounts, net sales with comparison | All | Daily |
| 2 | Sales trend | Net sales over time, multi-period comparison | All | Monthly |
| 3 | Sales by customer | Ranked, with growth vs LY and share % | CO BL BR PE | Monthly |
| 4 | Sales by product | Ranked, with growth and share | CO BR | Monthly |
| 5 | Sales by category | MCB / MCCB / ACB / RCCB / PQ | CO BR | Monthly |
| 6 | Sales by salesperson | | CO | Monthly |
| 7 | Sales by territory | | CO | Monthly |
| 8 | Sales by godown | | CO | Monthly |
| 9 | Daily sales register | Day-wise, with running MTD | CO | Daily |
| 10 | Month pacing | MTD vs target vs last month vs last year, with projection | All | Daily |
| 11 | Quantity and realisation | Volume sold and average rate — separates price growth from volume growth | All | Monthly |
| 12 | Average bill value trend | AOV and lines per invoice | CO PE CU | Monthly |
| 13 | Sales returns analysis | Return rate by customer, product and reason | CO CU PR | Monthly |
| 14 | Rate difference and claims | Post-sale adjustments, by customer | CO CU | Monthly |
| 15 | Order to invoice conversion | Orders raised vs invoiced | CO PE | Weekly |
| 16 | Estimate to order conversion | Quote win rate | CO PE CU | Monthly |
| 17 | Seasonality analysis | Month-wise index by category and product | CO BR | Quarterly |
| 18 | Sales forecast | Projection with confidence band | CO BR | Monthly |

## 2. Growth and customer movement

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 19 | Revenue growth bridge | Growth split into volume, price, mix, new customers, lost customers | CO BL BR PE | Monthly |
| 20 | Margin growth bridge | Same five factors, on profit | CO BR | Monthly |
| 21 | Customer movement summary | New, reactivated, growing, flat, declining, lost — count and ₹ | CO PE | Monthly |
| 22 | New customer report | Added in period, with revenue and repeat status | CO PE | Monthly |
| 23 | Lost customer report | No order in 12 months, with lost value | CO PE | Monthly |
| 24 | Dormant customer report | No order in 90 days | CO PE | Weekly |
| 25 | Reactivated customers | Returned after 180+ days | CO PE | Monthly |
| 26 | Customer retention | Revenue retention and net revenue retention | CO | Quarterly |
| 27 | Cohort retention | Retention by month of acquisition | CO | Quarterly |
| 28 | Customer concentration | Top 5 / top 10 share, HHI trend | CO BR | Quarterly |
| 29 | RFM segmentation | Segments with value at risk | CO | Monthly |
| 30 | Order frequency analysis | Median order gap and gap widening, per customer | CO PE | Weekly |
| 31 | Customer lifetime value | Cumulative margin per customer | CO | Annual |

## 3. Margin and pricing

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 32 | Margin summary | Pocket margin ₹ and %, with comparison | All | Monthly |
| 33 | Pocket price waterfall | List price down to realised margin, showing every leak | CO BR PR | Monthly |
| 34 | Margin by customer | Ranked, against company average | CO PE | Monthly |
| 35 | Margin by product | | CO BR | Monthly |
| 36 | Margin by category | | CO BR | Monthly |
| 37 | Price band by SKU | Min, median, max realised price across customers | CO BR | Monthly |
| 38 | Price realisation gap | ₹ recoverable if below-median customers moved to median | CO PE | Monthly |
| 39 | Discount analysis | Discount % by customer, product, salesperson, with approver | CO PE | Monthly |
| 40 | Off-invoice leakage | Credit notes and rate differences as % of gross, by customer | CO CU | Monthly |
| 41 | Negative margin lines | Every line sold below cost | CO | Weekly |
| 42 | Cost to serve | Margin after delivery and credit cost, per customer | CO CU | Quarterly |
| 43 | Discount elasticity | Whether discount actually bought volume | CO BR | Quarterly |
| 44 | Break-even and margin of safety | Break-even sales vs current run rate | CO | Monthly |

## 4. Receivables and credit

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 45 | Outstanding summary | Total, overdue, by bucket | CO PE | Daily |
| 46 | Ageing analysis | 0-30 / 31-60 / 61-90 / 91-180 / 180+, party-wise, by due date | CO PE CU | Weekly |
| 47 | Bill-wise outstanding | Invoice-level detail per party | CU | On demand |
| 48 | Customer statement | Ledger statement for sending | CU | On demand |
| 49 | Days to pay (DSO) | Countback and simple, with trend | CO PE CU | Monthly |
| 50 | Collection score (CEI) | How much of what was collectable was collected | CO PE | Monthly |
| 51 | Days late (ADD) | Days taken beyond agreed terms | CO CU | Monthly |
| 52 | Credit terms allowed vs actual | Variance in days, per customer | CO CU | Monthly |
| 53 | Credit limit utilisation | Including open orders and unbilled dispatches | CO CU | Daily |
| 54 | Credit limit breaches | With approver | CO | Daily |
| 55 | Cost of credit extended | What each customer's delay costs per year | CO CU | Monthly |
| 56 | Collections received | Daily receipts against invoices | CO PE | Daily |
| 57 | Collection forecast | Expected receipts next 30 / 60 / 90 days | CO | Weekly |
| 58 | Promise-to-pay log | Promises made vs kept, per customer | CO CU | Weekly |
| 59 | Credit score / grade list | A–E grading with reasons | CO | Monthly |
| 60 | Credit grade migration | Who improved, who deteriorated | CO | Quarterly |
| 61 | ECL provisioning matrix | Provision figure for the CA | CO | Monthly |
| 62 | Bad debt and recovery | Written off and recovered | CO | Annual |
| 63 | Disputed receivables | On-hold amounts with reasons | CO | Weekly |

## 5. Stock, purchase and working capital

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 64 | Stock valuation | Closing stock by item, brand, category, godown | CO BR | Monthly |
| 65 | Stock cover days | Days of cover per SKU | CO BR | Weekly |
| 66 | Dead stock | No movement in 180 days, at value | CO BR | Monthly |
| 67 | Slow moving stock | Cover above 90 days | CO BR | Monthly |
| 68 | Stockout lost sales | Order lines short-supplied, valued | CO | Weekly |
| 69 | Inventory to sales ratio | Trend | CO | Monthly |
| 70 | Purchase summary | By vendor, with comparison | CO BR | Monthly |
| 71 | Purchase price variance | Vs last purchase and 6-month average | CO BR | Monthly |
| 72 | Vendor lead time | Mean and variance | CO | Quarterly |
| 73 | Vendor concentration | Share and single-source SKUs | CO | Quarterly |
| 74 | Payables ageing and DPO | | CO | Monthly |
| 75 | Early payment discount | Captured vs forfeited | CO | Monthly |
| 76 | Cash conversion cycle | Stock days + collection days − supplier credit days | CO | Monthly |
| 77 | Working capital blocked | ₹ and its interest cost | CO | Monthly |
| 78 | Funds flow | Where cash moved between two dates | CO | Monthly |

## 6. Brand, principal and category

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 79 | Brand performance | Sales, margin, stock for C&S, BCH, others | BR | Monthly |
| 80 | Target vs achievement (principal) | Against principal targets | BR | Weekly |
| 81 | Distance to next slab | ₹ needed and days remaining | BR | Daily from the 20th |
| 82 | Scheme and rebate accrual | Expected credit notes from principals | BR | Monthly |
| 83 | Scheme claimed vs received | Gap and ageing | BR | Monthly |
| 84 | Brand share by customer | Who buys which brand, who is single-brand | CO CU | Quarterly |
| 85 | Category performance | MCB / MCCB / ACB / RCCB / PQ as separate businesses | CO BR | Monthly |
| 86 | Category penetration by customer | Which categories each customer does not buy from you | CO PE | Monthly |

## 7. People, targets and incentive

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 87 | League table | All salespeople across sales, growth, collections, margin, activity | CO | Weekly |
| 88 | Person scorecard | Full performance for one person | PE | Monthly |
| 89 | Target vs actual | By person, brand, category, customer | All | Weekly |
| 90 | My CFO | A person's own numbers, customers and pending actions | PE | Daily |
| 91 | Activity report | Tasks assigned vs closed, calls logged, conversion | PE | Weekly |
| 92 | Incentive statement | Calculated on collected margin — figure only, paid in Tally | PE | Monthly |

## 8. Fulfilment and service

| # | Report | What it tells you | Level | Frequency |
|---|---|---|---|---|
| 93 | Order to dispatch cycle | Average and 90th percentile | CO | Weekly |
| 94 | Fill rate | Quantity dispatched vs ordered | CO CU | Weekly |
| 95 | OTIF | On time in full | CO CU | Monthly |
| 96 | Open partial shipments | Count and value pending | CO | Daily |
| 97 | Delivery cost | Per order and per ₹1,000 of sales | CO | Monthly |
| 98 | Transporter performance | Damage and claim rate | CO | Quarterly |
| 99 | Service equity | Fill rate and dispatch time by customer class | CO | Monthly |

## 9. Matrices

| # | Report | What it tells you | Frequency |
|---|---|---|---|
| 100 | Movement × size band | Where revenue is won and lost | Monthly |
| 101 | Customer class × payment grade | Concentrated risk — big accounts that pay badly | Monthly |
| 102 | Value × risk | Who to protect, tighten, or let go | Quarterly |
| 103 | Recency × frequency | RFM as a readable grid | Monthly |
| 104 | Growth × margin | Grow-and-earn vs grow-but-thin vs exit candidates | Quarterly |
| 105 | Ageing × class | Whether key accounts are also the slowest payers | Monthly |
| 106 | Wallet share × margin | Where to push volume vs fix price | Quarterly |
| 107 | Order size × frequency | Service model segmentation | Quarterly |
| 108 | ABC × XYZ | Stocking policy per cell | Quarterly |
| 109 | **Penetration grid** | Customer × category whitespace — the clearest revenue map | Monthly |
| 110 | Brand share grid | Customer × brand | Quarterly |
| 111 | Price × volume | Where discounting bought volume and where it did not | Quarterly |
| 112 | Stock cover × velocity | Buy more / hold / promote / liquidate | Monthly |
| 113 | Margin × velocity | Which SKUs to push in campaigns | Quarterly |
| 114 | Seasonality heatmap | Month × category | Quarterly |
| 115 | Salesperson growth × collection | Who books what they cannot collect | Monthly |
| 116 | Salesperson margin × volume | Finds the discounter early | Monthly |
| 117 | Vendor dependency × reliability | Single-source risk | Quarterly |
| 118 | Quote conversion × price index | The price at which you start losing orders | Quarterly |

## 10. Work lists (action lists, not analysis)

| # | List | Trigger | Frequency |
|---|---|---|---|
| 119 | Director's call list | Top 5 / 10 / 20 customers to work on today, deduplicated across all lists | Daily |
| 120 | Silent churn | Gone quiet past 1.5× their own median order gap | Daily |
| 121 | Declining accounts | Down more than 20% vs last year | Weekly |
| 122 | Lost lines | SKUs they bought last year and not this year | Weekly |
| 123 | Win-back | Dormant 90 to 365 days | Weekly |
| 124 | Cross-sell gaps | Bought by similar customers, not by this one | Monthly |
| 125 | Order size decline | Bill value down with frequency flat | Monthly |
| 126 | Frequency decline | Order gap widening | Weekly |
| 127 | New customer non-repeat | First order 45 days ago, no second | Weekly |
| 128 | Below-median pricing | With ₹ recoverable | Monthly |
| 129 | Negative margin lines | | Weekly |
| 130 | Discount outliers | Above category norm, with approver | Monthly |
| 131 | Off-invoice leakage | Above 3% of gross | Monthly |
| 132 | High revenue low margin | Accounts that look important and are not | Monthly |
| 133 | Cost-to-serve negatives | | Quarterly |
| 134 | Due this week | | Weekly |
| 135 | 1–30 overdue | | Weekly |
| 136 | 31–60 overdue | | Weekly |
| 137 | 61–90 overdue | Supply hold recommended | Weekly |
| 138 | 90+ or grade D–E | Legal and provisioning review | Weekly |
| 139 | Credit limit breaches | | Daily |
| 140 | Neglected key accounts | A+ and A past their contact frequency | Weekly |
| 141 | Class mismatch | Current class vs suggested class | Quarterly |
| 142 | Week planner | The coming week's names by day | Weekly |
| 143 | Week close | Called vs planned, outcomes, ₹ collected | Weekly |

## 11. Compliance

| # | Report | What it tells you | Frequency |
|---|---|---|---|
| 144 | Books vs GSTR-1 | Invoice-level reconciliation | Monthly |
| 145 | Books vs GSTR-3B vs 2B | Output liability and ITC gaps | Monthly |
| 146 | ITC at risk (Rule 37) | Purchases unpaid beyond 180 days | Monthly |
| 147 | Credit note time bar | Prior-FY claims approaching the cut-off | Monthly |
| 148 | E-invoice / e-way bill coverage | Missing IRN or EWB, expiring EWBs | Weekly |
| 149 | HSN summary | Rate-wise reconciliation | Monthly |
| 150 | MSME 43B(h) exposure | Payables past the statutory limit | Monthly |
| 151 | TDS / TCS threshold tracker | Parties approaching thresholds | Monthly |
| 152 | Party master hygiene | Invalid or cancelled GSTIN, duplicate PAN | Monthly |
| 153 | Place of supply anomalies | IGST vs CGST-SGST mismatch | Monthly |
| 154 | Unadjusted advances | Aged customer advances | Monthly |

## 12. Exceptions and control

| # | Report | What it catches | Frequency |
|---|---|---|---|
| 155 | Backdated vouchers | | Daily |
| 156 | Modified after approval | With user and timestamp | Daily |
| 157 | Deleted and cancelled vouchers | | Daily |
| 158 | Price override without approval | | Daily |
| 159 | Round-sum entries | Above materiality | Weekly |
| 160 | Negative stock | Sales booked without stock | Daily |
| 161 | Period-end sales concentration | Cut-off signal | Monthly |
| 162 | Same-day sale and return | | Weekly |
| 163 | Duplicate invoices | Same party, value and date | Weekly |
| 164 | Sales to parties without GSTIN | Above threshold | Monthly |
| 165 | Dormant ledger suddenly active | | Weekly |
| 166 | Credit note without linked invoice | | Weekly |
| 167 | Invoice numbering gaps | Statutory requirement | Monthly |
| 168 | One-off customers above materiality | | Monthly |
| 169 | Level reconciliation failures | Persons, brands and company not tying | Daily |

## 13. Data quality

| # | Report | What it tells you | Frequency |
|---|---|---|---|
| 170 | Data health score | Single headline figure | Daily |
| 171 | Unassigned sales | Sales with no salesperson | Weekly |
| 172 | Duplicate party ledgers | Suspected duplicates to merge | Weekly |
| 173 | Missing cost coverage | % of lines without landed cost | Weekly |
| 174 | Missing due dates / bill-wise refs | | Weekly |
| 175 | Unmapped items | No brand, no category, no UOM conversion | Weekly |
| 176 | Unclassified parties | No class, no credit terms, no phone number | Weekly |

## 14. Packs and digests

| # | Pack | Contents | Frequency |
|---|---|---|---|
| 177 | Daily digest | Yesterday vs last year, MTD pacing, collections, call list, breaches, exception count | Daily 8:30 AM |
| 178 | Weekly pack | Scorecard, work lists, credit ladder, league table, top movers | Monday |
| 179 | Week close | Actioned vs planned, outcomes, rollovers | Saturday |
| 180 | **Monthly close pack** | Full register, both bridges, movement matrix, ageing with provision, cash cycle, working capital, brand and scheme position, exceptions, compliance, narrative — the single PDF the CA works from | 3rd working day |
| 181 | Quarterly pack | Cohort retention, ABC-XYZ, concentration, grade migration, price band review, break-even reset, class mismatch | Quarterly |
| 182 | Annual pack | Three-year trend and CAGR, bad debt history, concentration risk note, full customer master with lifetime value | Annual |
| 183 | Bulk export | Any selection of the above as one ZIP or merged PDF | On demand |

---

**Total: 183 reports.** Not all are separate screens — most are configurations of a shared
report engine, and the twenty-five work lists share one layout.

If you need a starting subset, these fifteen cover most decisions:
1, 10, 19, 21, 24, 32, 38, 46, 49, 57, 79, 81, 87, 109, 119.
