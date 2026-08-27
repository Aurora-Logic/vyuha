# 11 — Decision Log: Phase 6–8

Confirmed by the client. **This file overrides any assumed default in documents 08–10.** If a requirement there contradicts something here, this wins. Same relationship `05-decisions.md` has to `01`–`03`.

Last updated: 16 August 2026

---

## Confirmed

### D-01 — Tally is the system of record

| | |
|---|---|
| **Decision** | Everything lives in Tally, including all historical data. Vyuha holds a projection. |
| **Confirmed** | 16 August 2026 |
| **Consequence** | No accounting figure is authoritative in Vyuha. Every derived screen recomputes from projected data and stores nothing that cannot be rebuilt. If Vyuha's database were dropped and restored from a backfill, nothing financial would be lost — and that property is a design constraint, not a happy accident. |

### D-02 — Documents created in Vyuha are written through to Tally

| | |
|---|---|
| **Decision** | A document raised in Vyuha becomes a real Tally voucher. There is no second entry by a person. |
| **Confirmed** | 16 August 2026 |
| **Consequence** | Write-through, not two-way sync. Every entity has exactly one owner; the flow is bidirectional overall because different entities are owned by different sides. A record both systems can write will diverge, and no resolution rule survives contact with an accountant and a salesperson who each know they were right. |

### D-04 — Estimates stay in Vyuha and are not pushed

| | |
|---|---|
| **Decision** | Estimates are Vyuha-only. They reach Tally when they become a sales order, and not before. |
| **Confirmed** | 16 August 2026, on the reasoning below. Reverse it by saying so — it is a voucher-type mapping, not an architectural choice. |
| **Reasoning** | TallyPrime has no native quotation voucher. The alternatives are an Optional Sales voucher or a custom type via TDL. Either fills the Day Book with vouchers the accountant must mentally filter past forever, for documents that mostly never convert. Nothing is lost by holding an estimate back: the moment it is accepted it becomes a sales order, and that is the point at which it goes. |

### D-13 — PO means outward, to vendors

| | |
|---|---|
| **Decision** | "Purchase order" throughout these documents is the order Vyuha raises on a supplier. |
| **Confirmed** | 16 August 2026 |
| **Consequence** | A purchase order the customer sends *to* G C Communication is a reference field and an attachment on the sales order, not a document type. These are different tables and conflating them is a common early mistake. |

### D-14 — Admin has full CRUD, with two classes of exception

| | |
|---|---|
| **Decision** | Unchanged from `05-decisions` — Admin holds full CRUD on every entity, plus the 90-day Recycle Bin. |
| **Existing exceptions** | `punches` and `audit_logs` are append-only. Admin voids with a reason; the original stays visible. |
| **New exceptions** | **Synced records.** Admin cannot delete a Tally voucher from Vyuha, because deleting it locally desyncs the books while changing nothing in Tally. Tally-owned records are read-only in Vyuha. Vyuha-owned records that have been pushed are alterable only through the Alter action, which re-pushes against the stored GUID. `sync_journal` joins the append-only set. |
| **In the UI** | Where delete is unavailable, the control says why rather than being absent or failing. A greyed control with no explanation produces a support conversation every time. |

### D-15 — A user may hold multiple roles

| | |
|---|---|
| **Decision** | Roles become a set per user. Permissions are the union; scope is the widest granted. |
| **Confirmed** | 16 August 2026 |
| **Reasoning** | A salesperson is also an employee who punches and applies for leave. Under one role per user the only options are a composite "Sales + Employee" role, which multiplies with every module, or duplicating attendance permissions into Sales, which means a permission change gets made in two places and eventually in one. |
| **Timing** | Phase 6a, before CRM. It is a small change to `user_roles` now and an expensive one after two modules assume the old shape. |

### D-16 — Navigation restructures before any module is added

| | |
|---|---|
| **Decision** | Module switcher on `Ctrl+G`; Administration and Approvals leave the module sidebar; no sidebar exceeds eleven destinations; Go To searches records rather than screens. |
| **Confirmed** | 16 August 2026 |
| **Reasoning** | Nineteen items already scroll. Seven of them — Settings, Roles, Integrations, Audit log, Recycle bin, Period lock, Downloads — are not attendance at all; they are workspace administration sitting inside a module sidebar, and CRM will not get its own copies of them. Pulling them out drops the current sidebar to eleven before anything is added. |
| **The real fix** | Go To searching party names and voucher numbers. Once typing an invoice number opens that invoice, the sidebar stops being how anyone navigates and its length stops mattering. |

### D-17 — Tasks live in the platform, not in CRM

| | |
|---|---|
| **Decision** | `tasks` is a platform table with a polymorphic `(subject_type, subject_id)`, mirroring the approvals table. |
| **Confirmed** | 16 August 2026 |
| **Reasoning** | A task hangs off an invoice, an employee, a sales order or nothing. Putting it in the CRM module would require the sales module to import CRM to attach a task to an invoice, which the boundary lint rule refuses — correctly. |

### D-18 — Conflicts are never resolved automatically

| | |
|---|---|
| **Decision** | Where a record has changed on both sides, Tally wins on read and the case is quarantined for a person to look at. No merge rule is written. |
| **Confirmed** | 16 August 2026 |
| **Reasoning** | A resolution rule for the common case is what produces a system nobody can audit six months later. The exception queue is a screen somebody checks daily, not a log somebody greps after a customer complains. |

### D-19 — Masters and Sales merge; Logistics becomes a module

| | |
|---|---|
| **Decision** | The Masters module folds into Sales as sidebar groups (Documents, Masters, Books). Fulfilment — pick queue, packed, awaiting invoice, dispatches, delivered, returns, scan — moves out into a new Logistics module. Purchase stays whole. |
| **Confirmed** | 25 August 2026, owner. |
| **Reasoning** | Masters and Sales are worked hand in hand: raising an invoice means touching parties, items and price lists in the same sitting, and the module switcher between them was a wall through one job. Fulfilment is the opposite case — a different person at a different bench, whose seven destinations were crowding the Sales sidebar toward the eleven-destination cap (D-16). |
| **Consequence** | Item-level permission gates replace the merged module's single gate, so a masters-only user still sees their screens. Breadcrumbs, the Go To palette's section headings and the guided tour follow the registry and need no separate change, but their tests assert literal labels and move with it. |

### D-20 — The mobile bar is the person's, five wide, from any module

| | |
|---|---|
| **Decision** | The bottom bar carries five chosen destinations plus More. The picker offers every destination the person can reach across every module, not just the active module's. |
| **Confirmed** | 25 August 2026, owner. |
| **Reasoning** | Roles differ more than job titles suggest: the person who lives in Collections and the one who lives in the pick queue should not share a bar. A per-module bar also made the bar itself unstable — it changed under the thumb when a link crossed a module boundary. |
| **Consequence** | The stored preference becomes one cross-module list (store version bump with migration from the per-module shape). A saved route the person can no longer reach is dropped silently, as today. |

### D-21 — GST inputs summary, amending REQ-AE-08 narrowly

| | |
|---|---|
| **Decision** | Vyuha shows a period GST summary — outward taxable value and tax by head (CGST, SGST, IGST, cess) from projected tax-ledger lines, sales net of credit notes — as working data for whoever files. No GSTR form layout, no filing, no by-rate table. Tally remains the filing system; the deep-link stays; the surface says plainly that it is not a return. |
| **Confirmed** | 25 August 2026, owner, choosing "inputs summary" over 3B-shaped sections and over keeping the rule unchanged. |
| **Reasoning** | The same stance the product takes on payroll: produce the inputs, never run the calculation that files. A cross-check figure beside Tally's own 3B saves the accountant a reconciliation walk; a second return would eventually disagree with the certified one by a rupee and cost more than it saves. |
| **Consequence** | The by-rate split (3B table 3.1(a)'s shape) stays unbuilt until the sync contract carries per-line tax rates and a Duties & Taxes ledger master — the projection today has tax heads only as ledger-line names. Head classification from ledger names is stated as such on the surface, with the as-of stamp. `14 §1` stays in force for everything else it names. |

### D-22 — Interest cost and cash cycle analytics, voucher-grain v1

| | |
|---|---|
| **Decision** | An Interest Cost module quantifies working-capital interest on money blocked with customers and in stock, computed from daily closing balance series (never invoice-date arithmetic). Owner's seven scope answers, 25 Aug 2026: the annual rate is an editable org setting seeded at 12.00; vendor credit days read Tally's `credit_days` with a Vyuha-side editable override and a "credit terms missing" flag, never a silent 30; stock interest uses purchase value in v1, labelled "purchase cost basis"; GST on purchases carries no separate interest line in v1; receipts follow Tally's bill-wise marks with FIFO for on-account, the applied rule shown; the series builds from the earliest voucher the projection holds; and receivables run voucher-grain in v1 — each Sales voucher a bill, due at voucher date plus credit days — because `bill_allocations` has readers but no production writer yet. |
| **Consequence** | Surfaces say their own approximations out loud ("voucher-grain until Tally bill marks arrive"). Bill-wise data arriving later upgrades the split in place without a schema change. The spec's §8 export-framework migration was already done (P-10): sources register per module and permission keys are parameterised, so the module only registers its three report sources. This is money *analytics* over projected Tally data — the no-payroll rule stands untouched. |

### D-23 — The Virtual CFO module begins with its clock

| | |
|---|---|
| **Decision** | The CFO master brief's prerequisites resolve as: the approvals/export framework and the module switcher already exist (no work); the Tally read connector proceeds on its gaps with the voucher-grain fallback. The irreversible daily `fact_receivable_snapshot` starts immediately at voucher grain — each Sales voucher a bill, receipts settling oldest-first, due at voucher date plus credit days — upgraded in place by true bill-wise rows wherever `bill_allocations` carries them, every row flagged with its source. Valuation follows Tally's weighted average (agreeing with D-46 by construction). Salesperson attribution is a Vyuha-maintained dated customer-to-owner map resolved as of voucher date, House for house accounts — the live feed carries no cost centre. |
| **Confirmed** | 25 August 2026, owner, four popups. |
| **Consequence** | Daily receivables history accrues from tonight; the day the connector delivers bill-wise data the snapshots simply improve, and no history is lost waiting. The voucher-grain bill mathematics lifts from the interest module to `platform/receivables/` because two modules may not import each other. Parts M–Q of the brief arrive as `docs/16-virtual-cfo.md` before Phase 2. |

---

## Still open

Nothing in Phase 6a is blocked by any of these. Start there.

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| D-03 | **Does Vyuha raise invoices, or does Tally?** | Phase 8b — and decides whether 8b exists | **Tally raises them.** Vyuha stops at sales order and delivery challan and pulls invoices back. This keeps GST computation, IRN generation and e-way bills where they already work and are already certified, avoids a numbering authority conflict, and leaves the accountant's workflow untouched. The cost is that nobody invoices from the field and invoice data lags the sync interval. Note that `01` set the boundary as "if a field would need a currency symbol, it does not belong in this product" — Vyuha raising invoices crosses that line deliberately, and should only be crossed for a demonstrated business need rather than an assumed one. |
| D-05 | **Is Tally on one machine or a server?** | Phase 6b | Assuming **one machine**, so the connector is a Windows service on that desktop. If it is somebody's desktop that gets switched off, that is a reliability problem the heartbeat will surface daily and a server is the better answer. Carried over unanswered from `03` §7. |
| D-06 | **Attendance push shape — vouchers, or a clean file handoff?** | Phase 6e | **Answered by the owner, 18 Aug 2026: attendance is not linked to Tally at all.** Phase 6e is dropped; the push path's first write was the sales order (8a) and it is proven there. Attendance stays where `01`–`03` left it: inputs produced here, handed off outside Tally. |
| D-07 | **Does anyone create sales vouchers directly in Tally?** | Phase 8a | Assuming **no**, so those voucher types are set to Manual numbering in Tally and Vyuha allocates. The number is then known at create time, which is much better on screen. If the accountant will keep entering sales vouchers directly, Tally must allocate and Vyuha shows a provisional reference until the push returns — two allocators on one series will collide, and it will happen in the first busy week. |
| D-08 | **How many financial years, and how many Tally companies?** | Phase 6c | Unknown. Tally installations commonly split financial years across separate company files, and each is a separate connection with its own cursor. This changes the shape of the backfill, not just its size. |
| D-09 | **Roughly how many vouchers in total?** | Phase 6c | Unknown. Sizes the backfill — an afternoon or a week — and determines whether `vouchers` needs partitioning by financial year. |
| D-10 | **What is "Analysis", as distinct from "Payment analysis"?** | Phase 6d | Assuming **sales analysis** — value and margin by party, item, group, month and salesperson (REQ-Y-05). If it meant something else, that requirement is wrong rather than incomplete. |
| D-11 | **Credit limits and credit days — held in Tally per party, or set in Vyuha?** | Phase 6d | Assuming **held in Tally**, pulled with the party master, consistent with D-01. If they are to be managed in Vyuha they become the one piece of party data Vyuha owns, which is a deliberate exception and should be recorded as one rather than drifting into existence. |
| D-12 | **Who holds `sales.credit.override`?** | Phase 8a | Assuming **Sales manager and Accounts**. This is the key that lets an order through for a customer who is over their limit, so it is a business decision about who carries that risk, not a configuration detail. |
| D-19 | **Photo, geofence and consent have precedent — does CRM activity logging need the same treatment?** | Phase 7 | Assuming **no**, because a call note is not biometric data. Raised because `01` was careful about consent and it would be inconsistent to be careless here without having thought about it. |
| D-20 | **Retention for `sync_journal` bodies.** | Phase 6b | **30 days for request and response bodies, hashes retained indefinitely.** Bodies are large and mostly uninteresting after the fact; the hash is what proves what was sent. Say the word if a dispute window longer than 30 days is expected. |

---

## Carried forward, still open from `05-decisions.md`

These predate this phase and remain unanswered. Listed so they are not lost when attention moves to Phase 6.

| # | Question | Blocks |
|---|---|---|
| `05`-6 | Who runs payroll, in what format, and the exact columns | Interacts with D-06 |
| `05`-7 | Attendance cycle — calendar month or a cutoff | Interacts with D-06 |
| `05`-14 | Consequence rules — does 3 lates equal a half day | Attendance, unchanged |
| `05`-15 | Regularization limits — days back, count per month | Attendance, unchanged |
| OQ P0-6 | Icon library: phosphor in the code, lucide in the constitution | Every future screen, including all 22 new ones |
| OQ P2-3 | Role assignment has no endpoint or UI | **Now blocking.** D-15 cannot ship without it; folded into Phase 6a |
| OQ P2-2 | Four settings recorded but read by nothing | Attendance, unchanged |
| REQ-G-10 | Who may cancel leave once it has started | Attendance, unchanged |
| OQ WS-A-1 | Error tracking deferred pending a Sentry decision | Becomes more pressing with an agent running outside the VPS |

**On P0-6 in particular:** twenty-two new screens are about to be built. Deciding the icon library before them costs a two-line documentation change; deciding it after costs a second sweep across a codebase twice the size.

---

## Decisions taken for the order-to-dispatch and procurement flows (`12`, `13`)

Taken 18 August 2026, at the owner's instruction to proceed on the
recommended defaults. Each is reversible; each is recorded so it is a
decision and not a drift.

| # | Decision | Note |
|---|---|---|
| D-21 | Invoice ↔ sales order link: **the sales order number in the Sales voucher's narration** (`SO-0001`) for the same party, else the manual link screen. | The OpsTally payload carries no order reference field, so Tally's own reference cannot be read; the narration is what the accountant already types. Never guessed by party and date. |
| D-22 | No punch gate on the pick queue. | |
| D-23 | Punch endpoints (and the offline punch sync) are exempt from the access window; everything else refused. | |
| D-24 | Short-close needs `sales.document.alter`. | |
| D-25 | No POD stage. | |
| D-26 | Balance returns to the shared pick queue. | |
| D-27 | `item_vendors` is Vyuha-owned — the single exception to D-01. | |
| D-28 | Reorder level and minimum order quantity are Vyuha fields on the item until Tally is shown to hold them. | |
| D-29 | One godown. | OpsTally carries a single closing quantity per item. |
| D-30 | Sales manager allocates an insufficient receipt. | |
| D-31 | A short pack raises the requirement automatically. | |
| D-32 | No requisition step; approval sits on the PO by value. | |
| D-33 | Vendor lead time tracked on `item_vendors`, used for expected dates, not enforced. | |
| D-34 | Fulfilment word between *awaiting invoice* and *partially dispatched*: **`ready_to_dispatch`** (invoiced, nothing dispatched yet). | `12` REQ-AA-03 folds it into *partially dispatched*; a badge saying "partially dispatched" over zero dispatched misleads, and the numbers beside it are what count. |
| D-35 | Procurement requirements live in **the platform** (`platform/procurement`), not in the purchase module. | A requirement hangs off a sales order line and a purchase order line; the two modules may not import each other (technical design §1) — the same reasoning as D-17 for tasks. |
| D-36 | Purchase orders, GRNs and `item_vendors` live in **`modules/purchase`**; the shared document helpers (owner, customer, lines, arithmetic) move to `platform/documents`. | Sales and purchase share a shape and may not import each other. |
| D-37 | The push path is keyed by a **push kind** (`SALES_ORDER`, `DELIVERY_NOTE`, `PURCHASE_ORDER`, `RECEIPT_NOTE`), one outcome handler each; every pushed record carries the same five sync-state columns. | REQ-W-06/W-07 semantics identical across documents. |
| D-38 | **D-03 revised (owner's instruction, 18 Aug 2026 evening): invoices are raised in both places and kept in sync.** Vyuha raises an invoice against a sales order's packed quantities and pushes it as a `Sales` voucher; Tally-raised invoices pull back and link as before (D-21). A Vyuha-raised invoice's own voucher, when it pulls back, attaches to its existing link rather than counting twice — the GUID in `external_refs` is what tells them apart. The sync runs both ways: what Tally later says about any pushed voucher (cancelled, renumbered) comes back to the document that pushed it through the push-outcome seam's mirror half; Tally is the system of record and the document follows. **Owner's answers, 18 Aug evening (P8-1, P8-2): the customer sees Tally's voucher number — Vyuha's INV-nnnn is the internal reference only; and dispatch waits for Tally's acceptance — the order's invoiced_qty and the link move when the agent reports the voucher landed, never at confirm, and an invoice in flight keeps its packed quantity spoken for.** | Phase 8b therefore exists, as this slice. |
| D-39 | **REQ-X-16 (and REQ-W-08) route to the holders of the approving key, not the requester's reporting line** — one level: the first holder who is not the requester is the route, and every other holder acts through the key's override and browses through its scope. A purchase or a discount is decided by whoever holds the key; the framework reads its route as a chain of levels, so listing every holder would make each approve in turn. The document's own Approve button decides the same inbox request, so there is one ledger. A rejection returns it to draft. | The reporting-line default (REQ-G-09) is right for leave and wrong for money. |
| D-40 | **REQ-W-09 enforces the credit limit now and shows credit days without enforcing them.** Exposure is counted the way the credit cycle report counts it (debits less credits over the classified vouchers) plus the money committed in confirmed, uninvoiced Vyuha orders; an order that would take the party past the limit stops with `CREDIT_BLOCKED`, released only by `sales.credit.override` with a reason. Overdue-by-bill waits on bill-wise allocations (P6b-5) — **accepted for go-live by the owner, 18 Aug 2026 (P8-3).** | Half a rule that is right beats a whole rule that guesses at overdue. `sales.credit.override` is held by Admin, Sales manager and Accounts. |
| D-41 | **A PO carries the vendor's email and WhatsApp itself** (REQ-X-18); a Tally party has no contact in the projection today. The customer side gets the party master's email and phone from the pull where the ledger carries them, and the order may override (REQ-AA-28). | Blocking the vendor copy on a Tally field nobody fills would leave REQ-X-18 unbuilt. |
| D-42 | **REQ-AB-05's refusal is decided before the refresh cookie rotates.** A refusal after rotation would burn the cookie and sign the person out on the spot — the hard termination the requirement forbids. `/me` says how many minutes remain until the close so the shell can warn once, fifteen minutes ahead; exempt holders are never warned. | — |
| D-43 | **Push refs live under `entity_type = 'voucher_push'`**, never `voucher`: the pull maps the same GUID to its projection row under `voucher`, and one key cannot point at both the document and the voucher. Found while making a Vyuha-raised invoice's own voucher attach to its link (D-38). | Without this the first live pull after a push would try to update a vouchers row that never existed. |
| D-44 | **The picker marks lines fulfilled, not only quantities** (owner, 18 Aug evening): on the pick screen each line has a *fulfilled* mark that packs its whole balance in one tap; a partial is typed. The pack record still carries quantities — the mark is how a person with a box in one hand says "this one is done". | REQ-AA-06/AA-10 in practice. |
| D-45 | **Printed documents (estimate, sales order, invoice, purchase order) are one page each, and the paper is the editor** (owner, 18–19 Aug 2026): five templates — Tally (the GST tax invoice), Modern, Minimal, Bordered, Ledger — every one carrying every field the Tally page carries, so a choice of look never drops a GST field; a typeface per design as a **system font stack** (sans, serif, humanist, typewriter) so nothing is fetched and every printer prints the same page; figures always monospaced; the business identity and bank saved once; channel-partner logos with a caption on the bottom margin; Enter on the last line adds a line; the PDF is the browser's A4 print of `/print/:kind/:id` (an invoice prints its three GST copies as three pages); Excel from the same record. Classic and Bold were retired; a saved design naming one wears Bordered or Modern. A form-first entry mode was built and removed the same day at the owner's instruction (19 Aug): the paper is the one editor. **The goods papers ride the same engine (owner, 19 Aug): a dispatch prints as the Delivery Note, a pack record as the Packing Slip, a goods receipt as the Goods Receipt Note — each a page with PDF and Excel, each with its own design in Settings, quantities only by default (the design's "rates and amounts" switch turns money on).** | A template that says less than Tally's is a template a business cannot use for a tax invoice. System fonts over Google Fonts: no third-party request from a page that carries a GSTIN. |
| D-46 | **Doc 14's gates, answered by the owner (21 Aug 2026), read as D14-1…D14-6 (P14-1):** D14-1 batches/expiry **not maintained** — batch report absent, stock ageing FIFO-assumed. D14-2 item cost **is maintained, weighted average** — margin reports become buildable but stay Tier 3 (built when asked for by name). D14-3 lapse thresholds **fixed defaults** (own median gap; at-risk ×1, lapsed ×2, three sales minimum). D14-4 margin visible to **Sales manager, Accounts, Admin** via `reports.margin.view` when margin ships. D14-5 exception reports **notify daily when non-empty** through the existing dispatcher. D14-6 report-usage retention **12 months**. Also closed the same day: **P8 — browser print stands** (no server-side PDF; an invoice's three copies are three pages of one printout) and **P8-5 — a Warehouse role holding `sales.document.view.all` + `sales.document.create`**, made in Roles, no new key. | Answered in one sitting so Phase 6d could start whole. |
| D-47 | **Dispatch slip, scan-to-ship, and customer notices (owner, 22 Aug 2026).** The packing slip prints one per box ("Box 1 of 3") with the organisation's ship-to large, write-in boxes for LR/transporter/vehicle, and a **Code 128 barcode** of the slip's number — paper size is a **per-organisation Documents setting, default A5** (A4 for pallets and inside-the-box copies). A phone **scans the barcode** and either **ships** (LR number, transporter, vehicle, LR and box photographs) or **marks delivered** locally (receiver, photograph); the dispatch gains a life, packed → shipped → delivered. The customer hears by **email** from the organisation's mailbox on four events — E1 shipped, E2 delivered with the door photograph, E3 ready to collect, E4 invoice — and by **WhatsApp as click-to-send** (the done screen opens the conversation pre-written; the product marks it sent), with Meta's Cloud API deferred until volume justifies it. The **iPhone barcode-reader dependency is approved** (Safari has no native reader). Same evening: **E3 exists through a fourth dispatch mode, `customer_collects`** (the counter pickup — told it is ready with the barcode to show, the door step is a collection), and **E4 goes without a PDF** (amount, date, bank; the print dialog sends the PDF by hand when asked — D-46's browser print stands). Design: the "Slip, Scan, Notify" artifact of 22 Aug. | Decided in one popup so the five slices could be built in order without a second round. |
| D-48 | **Picking is its own quantity, and every party has a lifecycle (owner, 22 Aug 2026).** A sales-order line gains `picked_qty`, between ordered and packed: the chain becomes ordered → picked → packed → invoiced → dispatched, each a database check. The pick queue's **Pick** action records who picked how much (a `pick_records` table like `pack_records`); Pack can only pack what is picked. Per-line status — **fully / partially (X of Y) / none** — shows on the order (a chip per stage), on the orders list (a roll-up), on the pick-queue and Packed lists, and in a new **per-order fulfilment report**. Clicking an **item**, **customer** or **vendor** anywhere opens its **lifecycle**: the item's every order line, pack, dispatch, PO and GRN in time order; the customer's orders → packs → invoices → dispatches → payments; the vendor's POs → GRNs → items supplied. | The owner asked for the whole chain visible and every entity traceable; recorded before the multi-slice build. |
| D-49 | **Vyuha's price lists replace Tally's (docs/15 proposed this as D-40; owner, 22 Aug 2026).** A price list is Vyuha-owned, versioned and approved -- the **second deliberate exception to D-01 after `item_vendors` (D-27), and not a precedent for a third**. It does not push to Tally: Tally takes the rate on each voucher line from the pushed document. The pulled `price_list_entries` are ignored by resolution and may stop being pulled. Two pricing sources is the same mistake as two ledgers. | docs/09 §3.1's ownership row for "Price list" now reads Vyuha. |
| D-50 | **Admin alone approves a price list (proposed as D-41).** `pricing.approve` is Admin's; `pricing.manage` is Sales manager's and Admin's. A second approver above a variance threshold is added only if approvals become a bottleneck, not before. | |
| D-51 | **A replacement dispatch is chargeable or free per return, no default (proposed as D-42).** A wrong default silently gives goods away or silently bills for a company error. | Area AK. |
| D-52 | **Expense claims are not approved to build (proposed as D-43).** Area AM is not started without an explicit instruction recorded here. | docs/15 §AM's "gated on D-43" means this decision. |
| D-53 | **A portal link key lives 90 days, per party, rotating (proposed as D-44).** Per-contact only if individual accountability is wanted, which costs a contact register the portal does not otherwise need. | Area AL. |
| D-54 | **A broken promise flags, never blocks (proposed as D-45).** Blocking on a broken promise as well as a credit limit gives one customer two ways to be stopped. | Area AJ. |
| D-55 | **A duplicate-flagged party or item highlights, never blocks (proposed as D-46).** The merge happens in Tally; a block would stop work over a problem the user cannot fix from Vyuha. | Area AO. |
| D-56 | **Clusters show at confidence 0.75; GSTIN or PAN equal flags at full confidence regardless of name (proposed as D-47).** Tunable in settings from day one. | Area AO. |
| D-57 | **A free replacement is a marked line, and the invoice-before-dispatch rule reads the mark (implementing D-51).** `sales_document_lines.free_of_charge` is set only by the return that raises the replacement -- there is no field for it on the line editor, and the request contract does not carry one, because a salesperson who could mark a line free of charge would have a way around both REQ-AA-14 and the price-list floor. The database CHECK becomes `dispatched_qty <= invoiced_qty OR free_of_charge`; the floor check skips a free line, since the decision that made it free was recorded on the return. | Area AK. Without the mark a free replacement waits for ever for an invoice nobody will raise. |
| D-58 | **`returns.disposition` is needed at the desk, not only to change a disposition later.** Recording a line as scrap is the write-off; if only the later change needed the key, the check would be one dropdown away from nothing. **Admin and Accounts hold it; Sales manager does not** -- the person a customer is complaining to should not be the person who decides the goods were worthless. Sales manager holds `returns.manage` and raises replacements. | Area AK, REQ-AK-11. |
| D-59 | **Return reasons are an organisation's editable list, stored as the words themselves** (`sales.return_reasons` in Settings, six defaults). Not codes: a reason retired next year must not rewrite what last year's receipt says, and the by-reason report is only readable while the list stays short. Free text rides alongside in a note, never instead of a reason. | Area AK, REQ-AK-02. |
| D-60 | **The portal key is stored as a hash and shown once.** It is returned by the call that issues it and never again -- not on the list, not to Admin, not in the audit row. The key *is* the credential for one customer's whole trading history, so a screen that could show it would make every leak of that screen a leak of every customer's portal. | Area AL, REQ-AL-03. |
| D-61 | **Issuing a link withdraws the live one, in the same transaction.** REQ-AL-01 says one link per party; two live keys would be two things to withdraw and somebody would withdraw one. A partial unique index on `(org_id, party_id) WHERE revoked_at IS NULL` makes a second one impossible rather than merely unlikely. Rotation is therefore just issuing again. | Area AL. |
| D-62 | **The portal is throttled in two dimensions (REQ-AL-05).** Per address, on the standard sliding-window limiter under its own `portal` scope, so a spray of invalid keys cannot spend the office's sign-in budget; and per key, counted from the access log the requirement already asks for, at 400 served requests an hour -- a leaked link being scraped is the other shape of abuse, and a page plus a signed link per photograph is a dozen requests, so the budget is deliberately generous. | Area AL. |
| D-63 | **Portal party scoping is a constructor, not an argument.** `PortalRepository` is built with the organisation and the party the key names, and no method takes a party id -- there is no signature to pass a different one to. A test enumerates the class's own prototype and fails when a method has no party-scope assertion, so a method added later cannot ship unscoped. | Area AL, REQ-AL-04/AL-11. |
| D-64 | **The administration area takes Supabase's settings layout (owner, 27 Aug 2026: "take from Supabase").** A secondary rail -- Settings' pages first (General, Appearance, Office location, Attendance policy, Sales, Purchase, Customer classes, Email, Security and access, Documents), then the workspace screens -- beside a content column, as one layout route around every administration screen; below `lg` the rail is a row naming the place and a bottom sheet of the same groups, and `/administration` stays the directory a phone lands on. A settings page is sections; a section is one bordered panel of label-left, control-right rows (`SettingsSection`, `SettingsPanel`, `SettingsRow`); **each panel saves on its own**, Cancel and Save changes in its footer, and Ctrl+A still saves everything dirty on the screen. The `?tab=` addresses stay, so the sales and purchase deep links do not move. | Ten tabs in a strip scrolled off a 360px screen with no affordance, and one Save for the whole screen was a button nobody could relate to the field they had just edited. |
