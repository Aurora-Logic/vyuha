# Work order — Pricing, Duplicates, Collections, Returns, Portal

A prompt for Claude Code. Save as `docs/15-work-order-aj-ao.md` and point at it, or paste it in sections.

---

## Context

You are extending **Vyuha**, a monorepo the business already runs in production: NestJS 11 API, React 19 + Vite PWA, PostgreSQL 16 + Drizzle, Redis + BullMQ, S3-compatible storage, shadcn/ui + Tailwind 4, Zod 4. Attendance is live. Tally integration, CRM, sales, purchase and reporting are specified in `docs/08`–`docs/14`.

**Read before writing any code, in this order:**

1. `CLAUDE.md`
2. `docs/11-decisions-phase-6-8.md` — the authority. Where it disagrees with any other doc, it wins.
3. `docs/08-product-requirements-phase-6-8.md` — areas O–Z, the permission matrix, the glossary
4. `docs/09-technical-design-phase-6-8.md` — §1.1, §3, §4 especially
5. `docs/12-order-to-dispatch-flow.md` — you are mirroring its shapes
6. `docs/13-procurement-shortage-to-grn.md` — the GRN pattern you will invert for returns
7. `docs/14-analytics-and-reports.md` — §9 UI standards, §10 the period picker

This work order adds requirement areas **AJ**–**AO**. Areas A–N are attendance, O–Z are `08`, AA–AC are `12` and `13`, AD–AI are `14`. Do not reuse an ID.

---

## Standing constraints — not negotiable, not up for interpretation

**Tally is the system of record.** Vyuha holds a projection: derived, disposable, rebuildable. If Vyuha's database were dropped and rebuilt from a backfill, nothing financial would be lost. Every design decision here must preserve that property.

**Never build, under any framing, in any of these modules:**

| Not built | Why |
|---|---|
| Balance Sheet, P&L, Trial Balance | A second number nobody can reconcile is worse than none |
| Any GST return, TDS, TCS or 26AS output | Tally is the certified filing system |
| A ledger, a journal, or a stock adjustment path in Vyuha | D-01. Stock moves only as a consequence of a voucher |
| Credit notes and debit notes | Tally's. Vyuha records the physical event and waits for the note to appear on a pull |
| Automatic sync conflict resolution | REQ-T-02, permanent. The exception queue is the feature, not a fallback |
| Master creation **or editing** in Vyuha | REQ-R-04. A customer is created and corrected in Tally |
| Any payment, disbursement or money calculation | See AM below, which is gated |

If a requirement in this file appears to need one of the above, **stop and raise it**. Do not implement a partial version.

**Build order.** Ship in this sequence, each with its own `/ultrareview`:

1. **AN — Pricing.** Smallest, and it changes the data going in. Every day without it is another wrong rate baked into history that no later report can un-bake.
2. **AO — Duplicate detection.** Cheap, read-only, and it improves the quality of every screen after it. Pricing resolves per party, so knowing two parties are the same party matters before Collections starts chasing both.
3. **AJ — Collections.** Highest revenue impact of anything remaining.
4. **AK — Returns.** A genuine hole; nothing handles a return today.
5. **AL — Customer portal.**
6. **AM — Expense claims.** Only after D-43 is answered. Do not start it on assumption.

---

## Area AN — Pricing and price lists

Price lists pull from Tally today (REQ-R-03) and are used by nothing. This area makes them govern the rate on every document.

### The shape

A price list is **Vyuha-owned**. This is the second deliberate exception to D-01, after `item_vendors` in `13` D-27. Record it as an exception in `docs/11`; do not let it become a precedent for a third.

**The list does not push to Tally.** Tally needs the rate on each voucher line, which it gets from the pushed document anyway. Pushing the list itself adds a second sync surface for no benefit, and Tally has no approval concept to receive the workflow below.

| ID | Requirement |
|---|---|
| REQ-AN-01 | A **price list** has a name, an effective-from and effective-to date, a version number, a state, and an assignment set. |
| REQ-AN-02 | A **price list line** carries item or item group, a basis of `rate`, `discount_pct` or `both`, the rate, the discount percentage, and optional quantity slab bounds. Both bases exist because some customers are on a fixed rate, some on a percentage off list, and some on a rate with a further percentage. |
| REQ-AN-03 | **Quantity slabs.** A line may apply only above a minimum quantity, or between bounds. Overlapping slabs on one item within one list are rejected at save, not at resolution. |
| REQ-AN-04 | **Assignment** is to specific parties, to a party group, or as the default list. One party may be assigned to only one list at a time for a given effective period; overlap is rejected. |

### Versioning — the part that matters most

| ID | Requirement |
|---|---|
| REQ-AN-05 | States: `draft` → `pending_approval` → `active` → `superseded` / `expired`. |
| REQ-AN-06 | **An active price list is immutable.** Changing it creates a new version in `draft`, which goes through approval and supersedes the old one on activation. The superseded version is retained forever. |
| REQ-AN-07 | This is why: an invoice raised eighteen months ago must remain explainable. If the list it resolved from can be edited, the rate on that invoice can no longer be justified to the customer questioning it. Same discipline as the append-only punch and leave ledgers. |
| REQ-AN-08 | Activation of a new version does **not** alter any document already raised. |

### Approval

| ID | Requirement |
|---|---|
| REQ-AN-09 | A price list moves from `draft` to `active` only through the **platform approvals framework** (`platform/approvals` after REQ-P-01). Register `price_list` as a subject type with its own handler. Do not write a bespoke approval flow. |
| REQ-AN-10 | New permissions: **`pricing.manage`** (create and edit drafts — Sales manager, Admin) and **`pricing.approve`** (Admin only). |
| REQ-AN-11 | Per REQ-P-04, the `price_list` subject type registers its own approve permission. A test must assert it does not fall back to an attendance key. |
| REQ-AN-12 | The approver sees a **diff against the version being superseded** — which items moved, by how much, and which parties are affected. Approving a hundred-line price list without seeing what changed is a rubber stamp. |

### Resolution

| ID | Requirement |
|---|---|
| REQ-AN-13 | Resolution order, first match wins, evaluated at the **document date** and not today: party-specific list → party-group list → default list → the item's rate from the Tally master. |
| REQ-AN-14 | Within a list: item-specific line → item-group line. Within either, the narrowest matching quantity slab. |
| REQ-AN-15 | Every document line **stores what resolved**: `price_list_id`, `price_list_version`, `resolved_rate`, `applied_discount_pct`, and the final rate. Not a foreign key that can be followed to a changed row — the values themselves. |
| REQ-AN-16 | The resolved rate is the **floor**. A rate below it routes to the existing discount approval, `sales.discount.approve` (REQ-W-08), with a mandatory reason. Above it needs nothing. |
| REQ-AN-17 | The document line UI shows the resolved rate, where it came from, and the variance if overridden. A salesperson should be able to answer "why this rate" without leaving the screen. |
| REQ-AN-18 | A **price list simulator**: pick a party and an item, see what resolves and why, without raising a document. This is the screen support will actually use. |

### Tables

```
price_lists              id, name, version, supersedes_id, state,
                         effective_from, effective_to,
                         created_by, approved_by, approved_at, notes

price_list_lines         price_list_id, item_id (nullable),
                         item_group_id (nullable), basis,
                         rate, discount_pct, min_qty, max_qty
                         CHECK (item_id IS NOT NULL OR item_group_id IS NOT NULL)

price_list_assignments   price_list_id, party_id (nullable),
                         party_group (nullable), is_default
```

Document line tables gain `price_list_id`, `price_list_version`, `resolved_rate`, `applied_discount_pct`.

### Acceptance

- A party on a 12% discount list gets 12% off on a new estimate, and the line shows which list and version resolved.
- Activating a new version leaves every existing document's rate unchanged.
- An active list cannot be edited. The attempt is refused at the API, not only hidden in the UI.
- A rate below the resolved floor routes to approval and cannot be pushed to Tally without it.
- A superseded list from a year ago still resolves correctly when opening an invoice from that period.
- Overlapping quantity slabs are rejected at save with the conflicting lines named.

---

## Area AO — Duplicate detection and highlighting

Master data comes from Tally, and Tally accumulates duplicates: the same customer entered twice with a different suffix, the same item under two codes. Today Vyuha shows both without comment, so a salesperson picks one, Collections chases the other, and the ageing splits across two rows that are one company.

This area **detects and shows**. It does not fix.

| ID | Requirement |
|---|---|
| REQ-AO-01 | Vyuha detects likely duplicate records in pulled master data, at minimum for **parties** and **items**, and with the same mechanism for vendors, item groups and contacts. One detector, an entity-type config, not five implementations. |
| REQ-AO-02 | **Party matching** compares: normalised name (case, punctuation, extra spaces, and the usual suffix variants — Pvt Ltd / Private Limited / P Ltd / & / and), GSTIN, PAN, phone, email, and address pincode + first line. GSTIN or PAN equal is a near-certain match on its own. |
| REQ-AO-03 | **Item matching** compares: normalised name, alias or part number, HSN, and UOM. Two items with the same part number and different names are the strongest signal here. |
| REQ-AO-04 | Each detected pair carries a **confidence score** and the fields that matched. The threshold for showing a match is configurable in settings, not hard-coded. |
| REQ-AO-05 | Matches are grouped into **clusters**, not pairs. If A matches B and B matches C, the screen shows one cluster of three. |
| REQ-AO-06 | **Highlighting.** Any row belonging to an open duplicate cluster renders with the destructive/danger surface token as its row background — in every list, table and picker where that entity appears, not only on the duplicates screen. |
| REQ-AO-07 | The red background comes from the **preset theme tokens** (the destructive surface and its foreground pair). No hex, and it must remain legible in both light and dark themes and against the zebra striping the table already uses. |
| REQ-AO-08 | Colour is never the only signal. Every highlighted row also carries an icon and a tooltip naming the other records in the cluster and the fields that matched, and the row is reachable and announced by keyboard. |
| REQ-AO-09 | **Pickers included.** When a salesperson selects a party on an estimate or an item on a line, a flagged record shows the warning inline before it is chosen. Catching it at the picker is worth more than catching it on a report afterwards. |
| REQ-AO-10 | A **duplicates screen** per entity type: clusters ranked by impact — open documents, outstanding amount, transactions in the last period — so the ones actually splitting the ledger surface first. |
| REQ-AO-11 | **Vyuha never merges, edits or deletes a master.** D-01 and REQ-R-04 stand. Merging happens in Tally. A cluster can be marked `sent_to_tally`, and the next pull either shows the merge and auto-closes the cluster or leaves it open. |
| REQ-AO-12 | **Dismissal.** A cluster can be marked "genuinely different" with a mandatory reason, by whom and when. A dismissed cluster is never re-raised unless one of the matching fields changes on a later pull. |
| REQ-AO-13 | Detection runs as a **BullMQ job after each master pull**, writing to a `duplicate_clusters` table. It never runs on list render, and the highlight is a cheap join on a flag, not a per-row comparison. |
| REQ-AO-14 | New permissions: `duplicates.view` and `duplicates.manage` (dismiss, mark sent to Tally). Accounts, Sales manager and Admin hold `.manage`. |
| REQ-AO-15 | A **duplicate summary report** — open clusters by entity type, by confidence band, and the outstanding amount sitting behind party clusters. Registered in the report registry (REQ-AD-02), like every other report. |

### Tables

```
duplicate_clusters       id, entity_type, confidence, matched_fields,
                         state (open | sent_to_tally | dismissed | resolved),
                         dismissed_reason, dismissed_by, dismissed_at,
                         detected_at, last_seen_at

duplicate_cluster_members cluster_id, entity_id
```

### Acceptance

- Two parties differing only by "Pvt Ltd" and "Private Limited" are clustered and both rows show the red background wherever either appears.
- The same two parties show the warning in the party picker on a new estimate.
- Two items with the same part number and different names are clustered.
- Merging the parties in Tally and running a pull closes the cluster with no manual step.
- A dismissed cluster stays dismissed across pulls, and reappears only if the GSTIN or phone changes.
- The highlight passes contrast in both themes, and the same information is available without seeing colour.
- No code path in this area writes to a party or item row.

---

## Area AJ — Collections

Ageing and statements exist from `14`. Tasks and notification channels exist. This assembles them into a working process.

| ID | Requirement |
|---|---|
| REQ-AJ-01 | **Promise to pay** — party, amount, promised date, against which bills, taken by, taken on, notes. |
| REQ-AJ-02 | PTP states: `open`, `kept`, `partially_kept`, `broken`. State is **derived from receipts pulled from Tally against the named bills**, never set by hand. A collector cannot mark their own promise kept. |
| REQ-AJ-03 | **Collector assignment** — parties assigned to a collector, with a target amount per period. One party, one collector at a time. |
| REQ-AJ-04 | **Follow-up tasks** use the platform `tasks` table with `subject_type = 'party'` (D-17). No collections-specific task table. |
| REQ-AJ-05 | **Reminder with statement attached** — composed from the existing statement (REQ-Y-01) and print engine, sent through the existing channel abstraction (REQ-AA-25), including the `manual` fallback until the WhatsApp API lands. |
| REQ-AJ-06 | Every reminder is recorded: channel, recipient, sent at, status, and the statement as-of date. A customer claiming they were never told has an answer. |
| REQ-AJ-07 | **Collector dashboard**: assigned parties, total outstanding, overdue, promises open, promises due today, promises broken, collected against target this period. |
| REQ-AJ-08 | **Promised against collected** report — by collector, by party, by period. The report the whole area exists for. |
| REQ-AJ-09 | **Broken promise report** — promises past their date with no matching receipt, ranked by amount. Notifies daily per D-38. |
| REQ-AJ-10 | A party with a broken promise **flags on the credit check** (REQ-W-09). Repeatedly promising and not paying is exactly the signal a credit limit exists to catch. |
| REQ-AJ-11 | New permissions: `collections.view.self`, `collections.view.all`, `collections.manage`. Accounts and Sales manager hold `.all`. |
| REQ-AJ-12 | **Collections never writes to a balance.** No write-off, no adjustment, no settlement. It records intent and observes what Tally says arrived. |
| REQ-AJ-13 | Where a party sits in an open duplicate cluster (AO), the collector dashboard shows the combined outstanding across the cluster alongside the row's own figure, so one company is not chased twice for halves of the same balance. |

---

## Area AK — Sales returns and replacements

Structurally the GRN inverted: goods arrive, quantity and condition are recorded, and the accounting document is Tally's.

| ID | Requirement |
|---|---|
| REQ-AK-01 | A **return receipt** — party, the invoice or dispatch it relates to, lines with quantity, reason, and condition. |
| REQ-AK-02 | Reasons are a configurable list: damaged in transit, wrong item, wrong quantity, quality rejection, customer cancelled, warranty. Free text alongside, never instead. |
| REQ-AK-03 | **Disposition per line**: `restock` or `scrap`. Recorded at receipt, not decided later in someone's head. |
| REQ-AK-04 | Photographs at receipt, through the existing dispatch photo pipeline (`12` REQ-AA-20, gallery allowed). A damage claim without a photograph is an argument. |
| REQ-AK-05 | **Credit note stays Tally's.** Vyuha raises none. The return enters an `awaiting_credit_note` state and appears on the accountant's queue — the exact mirror of the billing handshake in `12` §3.3, including the linking problem and the unlinked queue. |
| REQ-AK-06 | On the next pull, the credit note links to the return. An unlinkable credit note appears on an exceptions screen and is never guessed at by party and date. |
| REQ-AK-07 | **Restock does not move stock in Vyuha.** The stock rises in Tally as a consequence of the credit note, and Vyuha sees it on the following pull. D-01, and REQ-AC-07 specifically. |
| REQ-AK-08 | **Replacement dispatch** — a new dispatch (`12` REQ-AA-16) linked to the return, going through the same modes, photographs, LR capture and customer notification. It is not a special case; it is a dispatch with a return reference. |
| REQ-AK-09 | A replacement may need its own invoice or may be free of charge. Which one is a decision recorded on the return, and it determines whether the dispatch waits for an invoice (REQ-AA-14). |
| REQ-AK-10 | **Return rate reporting** by item, by customer, by reason — feeding REQ-AG-21. |
| REQ-AK-11 | New permissions: `returns.view`, `returns.manage`, `returns.disposition` (deciding scrap). |

---

## Area AL — Customer portal

Everything it shows already exists. The work is access, not content.

| ID | Requirement |
|---|---|
| REQ-AL-01 | **One link per party.** Shows their orders with balances, dispatches with LR numbers and box photographs, statement, invoices, and open promises where they exist. |
| REQ-AL-02 | **Read-only.** No actions in v1. No order placement, no payment, no document upload. |
| REQ-AL-03 | Access is a **signed link key** bound to one party, with an expiry, and withdrawable at any time. Keys are random and non-sequential, and there is no shared login for the portal. |
| REQ-AL-04 | **Party scoping lives in the repository layer**, exactly as the existing `ScopeService` enforces employee scope. The party id comes from the link key and is applied as a filter in every portal query — never assembled in the controller, never relied on from the UI. A repository method that would return a different party's rows if handed a different id is a defect, whether or not any screen calls it that way. |
| REQ-AL-05 | Portal requests go through the standard throttle, counted per link key and per source address, so repeated requests with invalid keys are slowed and logged rather than served. |
| REQ-AL-06 | Every portal view is audited: key, party, what was viewed, when, from where. |
| REQ-AL-07 | A key is withdrawable instantly by Admin or Accounts, and takes effect immediately rather than at next expiry. |
| REQ-AL-08 | Photographs are served through the existing **short-expiry signed media links**. The portal never receives a durable object-storage URL. |
| REQ-AL-09 | The portal is **outside the access window** (`12` REQ-AB-01). It is not a staff login, and a customer in another timezone is not covered by an office rule. |
| REQ-AL-10 | Fully responsive; most customers will open it on a phone from a WhatsApp message. |
| REQ-AL-11 | Before this area ships, add a test suite that calls every portal repository method with a party id other than the one on the key and asserts an empty result. Run the repo's review command over the area with party scoping as the focus. |

---

## Area AM — Expense claims — DO NOT START

`01` and `03` state the boundary: no salary, wage, tax or reimbursement calculation, and "if a field would need a currency symbol, it does not belong in this product". Expense reimbursement is money owed to a person.

**This area is gated on decision D-43 and must not be built on assumption.**

If it is approved, the permitted shape is narrow and should be written into `docs/11` before any code:

- The employee photographs the bill and **types an amount**. Vyuha computes nothing — no rates, no mileage, no per-diem, no tax.
- It routes through the existing approvals framework as a new subject type.
- It hands off as a **file export**. Vyuha pays nothing and settles nothing.
- No balance, no outstanding, no employee ledger.

Anything beyond that is payroll wearing a different hat.

---

## Definition of done

`CLAUDE.md` §4 applies in full. Additionally, for this work order:

- Every component from **shadcn, installed via the shadcn MCP**. No other library, no hand-rolled components, no pasted source. No native form elements, including date and time inputs.
- **Preset theme tokens only.** No hex value in any component — the duplicate highlight in AO included.
- The shared `PeriodPicker` from `14` §10 — never a second date control.
- One hierarchy, no card-inside-a-card. No emojis.
- Usable at 360px, touch targets ≥44px, no hover-only interaction.
- Keyboard-complete with hint chips: `Alt+G`, `Ctrl+G`, `Ctrl+A`, `Ctrl+Q`, `Esc`, `F12`, `Alt+F2`, `Alt+E`, `Enter`.
- Every new report registered in the report registry (REQ-AD-02), not built as a route component.
- Boundary lint respected: new modules import `platform/*` and never each other.
- Every state change audited by the existing interceptor. No parallel logging.
- Commit in vertical slices, referencing REQ IDs.

---

## Decisions to record in `docs/11` before starting

> **Recorded 22 Aug 2026 as D-49…D-56.** The numbers below collided with decisions docs/11 already held (D-40 credit enforcement … D-47 dispatch slip); the mapping is D-40→D-49, D-41→D-50, D-42→D-51, D-43→D-52, D-44→D-53, D-45→D-54, D-46→D-55, D-47→D-56. Where this file says "D-43" for expense claims, read D-52.

| # | Question | Blocks | Default in force |
|---|---|---|---|
| D-40 | Tally price lists are pulled today. Do they still matter, or does the Vyuha list replace them entirely? | AN-13 | **Replace.** Vyuha's chain resolves; Tally's pulled lists are ignored and eventually stop being pulled. Two pricing sources is the same mistake as two ledgers. |
| D-41 | Who approves price lists — Admin only, or a second approver above a variance threshold? | AN-09 | Admin only. Add a threshold if approvals become a bottleneck, not before. |
| D-42 | Is a replacement dispatch chargeable by default, or free? | AK-09 | Decided per return, no default. A wrong default here silently gives goods away or silently bills for a company error. |
| D-43 | **Are expense claims approved to build at all?** | All of AM | **No.** Not started without an explicit instruction recorded here. |
| D-44 | How long does a portal link key live, and is it per-party or per-contact? | AL-03 | 90 days, per party, rotating. Per-contact if individual accountability is wanted, which costs a contact register the portal does not otherwise need. |
| D-45 | Does a broken promise block new orders, or only flag? | AJ-10 | **Flag only.** Blocking on a broken promise as well as on a credit limit gives one customer two ways to be stopped, and the override key will get handed out to relieve it. |
| D-46 | Does a duplicate-flagged party or item block document creation, or only highlight? | AO-09 | **Highlight only**, consistent with D-45. A block here stops work over a data-quality problem the user cannot fix from Vyuha, since the merge happens in Tally. |
| D-47 | What confidence threshold shows a cluster, and does GSTIN-equal auto-flag regardless of name? | AO-04 | Show at 0.75; GSTIN or PAN equal flags at full confidence regardless of name distance. Tunable in settings from day one. |
