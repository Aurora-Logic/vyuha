# 08 — Product Requirements: Tally, CRM, ERP

Product: **Vyuha**
Phase in scope: **6, 7, 8** — Tally integration, CRM, sales and purchase documents
Status: draft for build
Companion to `01-product-requirements.md`, which covers Phases 0–5 and remains in force for attendance.

Requirement IDs continue the existing lettering. Attendance used areas **A–N**. This document uses **O–Z**. No ID is ever reused.

---

## 1. Problem and goals

Attendance proved the platform. The business now wants the rest of its working day in the same place — the customers it sells to, the tasks its people are chasing, and the documents that move an enquiry to a paid invoice.

All of that data already exists in TallyPrime, including every year of history. Tally is where the accountant works, where GST returns are filed, and where the auditor looks. Nothing in this phase changes that, and the design should make it impossible to change it by accident.

**Goals**

- G7 — Read the business's real data out of Tally — parties, items, vouchers, outstandings — including full history, without anyone re-keying it.
- G8 — Let a salesperson raise an estimate, a sales order or a purchase order in Vyuha, and have it land in Tally as a real voucher without a second entry.
- G9 — Answer "who owes us what, and who actually pays on time" from data the accountant already trusts.
- G10 — Give the sales team contacts, deals and tasks on a board, in the same product and under the same permissions as everything else.
- G11 — Grow from one module to four without the navigation, the role model, or the approval framework needing a rewrite.

**Non-goals (explicitly out)**

- N6 — Vyuha computing GST, generating an IRN, or producing an e-way bill. Tally does this and will continue to.
- N7 — Vyuha holding a second copy of the books. There is one ledger and it is Tally's.
- N8 — Editing a Tally voucher from Vyuha by direct database write, under any circumstance.
- N9 — Multi-tenancy. This is G C Communication's own system. If it is ever sold, that is a separate decision made before the platform work, not after.
- N10 — Payroll. Unchanged from `01` N1. Permanent.

---

## 2. Users and roles

Four roles exist today. Four more are needed, and one structural change is needed before any of them.

| Role | Who | Core need |
|---|---|---|
| **Employee** | Everyone | Unchanged — punch, own attendance, leave |
| **Operations** | Line/dept managers | Unchanged, plus team-scoped visibility in CRM |
| **HR** | HR staff | Unchanged |
| **Admin** | Owner / IT | Everything, plus sync configuration and exception resolution |
| **Sales** | Sales executives | Own contacts, deals, tasks; raise estimates and sales orders; read masters |
| **Sales manager** | Sales head | All of Sales at team or full scope; approves discounts and credit overrides |
| **Purchase** | Procurement | Purchase orders, GRNs, vendor records |
| **Accounts** | Accountant / owner | Read every financial screen, own the sync exception queue, no CRM |

### 2.1 A user must be able to hold more than one role

**REQ-P-03** below. Stating it here because it governs the table above rather than following from it.

A salesperson is also an employee. They punch, they apply for leave, and they raise sales orders. Under a single-role model the only ways to express that are a composite "Sales + Employee" role or duplicating every attendance permission into Sales. The first multiplies with every new module; the second means a permission change has to be made in several places and will eventually be made in only one.

Permissions are the union of every role held. Scope resolves to the widest granted. This is a small change to `user_roles` now and an expensive one after two more modules assume the old shape.

### 2.2 New permission keys

Existing keys are unchanged. Twenty-one are added.

| Permission | Sales | Sales mgr | Purchase | Accounts | Admin |
|---|:--:|:--:|:--:|:--:|:--:|
| `masters.tally.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `crm.contact.view.self` | ✓ | ✓ | | | ✓ |
| `crm.contact.view.all` | | ✓ | | | ✓ |
| `crm.contact.manage` | ✓ | ✓ | | | ✓ |
| `crm.deal.view.self` | ✓ | ✓ | | | ✓ |
| `crm.deal.view.all` | | ✓ | | | ✓ |
| `crm.deal.manage` | ✓ | ✓ | | | ✓ |
| `crm.pipeline.manage` | | ✓ | | | ✓ |
| `crm.task.view.self` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `crm.task.view.team` | | ✓ | | | ✓ |
| `crm.task.manage` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sales.document.view.self` | ✓ | ✓ | | ✓ | ✓ |
| `sales.document.view.all` | | ✓ | | ✓ | ✓ |
| `sales.document.create` | ✓ | ✓ | | | ✓ |
| `sales.document.alter` | | ✓ | | | ✓ |
| `sales.discount.approve` | | ✓ | | | ✓ |
| `pricing.manage` (docs/15 AN) | | ✓ | | | ✓ |
| `pricing.approve` (docs/15 AN) | | | | | ✓ |
| `duplicates.view` (docs/15 AO) | | ✓ | | ✓ | ✓ |
| `duplicates.manage` (docs/15 AO) | | ✓ | | ✓ | ✓ |
| `sales.credit.override` | | ✓ | | ✓ | ✓ |
| `purchase.document.view` | | | ✓ | ✓ | ✓ |
| `purchase.document.create` | | | ✓ | | ✓ |
| `purchase.document.approve` | | | | ✓ | ✓ |
| `receivables.view` | | ✓ | | ✓ | ✓ |
| `tally.connection.manage` | | | | | ✓ |
| `tally.sync.run` | | | | ✓ | ✓ |
| `tally.exceptions.resolve` | | | | ✓ | ✓ |

Scoping for `crm.*.self` follows the existing rule: records where the user is the owner, plus records owned by anyone whose `reporting_manager_id` chain reaches them, when they also hold the `.team` variant.

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **System of record** | Tally. Where the authoritative version of a financial record lives. Vyuha holds a projection of it. |
| **Projection** | Vyuha's local copy of Tally data. Readable, reportable, never authoritative. |
| **Write-through** | A document created in Vyuha is queued, pushed to Tally, and is only considered real once Tally accepts it. |
| **AlterID** | Tally's monotonic change counter, carried by every master and voucher. The basis of every incremental pull. |
| **GUID** | Tally's stable identifier for a voucher or master. Survives renaming and renumbering. The join key. |
| **Sync state** | Where a Vyuha-created document stands: `draft`, `queued`, `pushed`, `failed`, `voided_in_tally`. |
| **Exception** | A sync attempt that cannot be resolved automatically. Never merged, always surfaced. |
| **Backfill** | The one-time historical import of every voucher Tally holds. |
| **Deal** | A CRM opportunity moving through pipeline stages. Has no accounting existence. |
| **Party** | A Tally ledger under Sundry Debtors or Sundry Creditors. A customer or a vendor. |
| **Contact** | A CRM person or prospect. Becomes linked to a Party on conversion, never before. |

---

## 4. Requirements

### Area O — Workspace shell and navigation

The sidebar carries nineteen items today and already scrolls. Three modules will not fit in it, and grouping harder does not fix a list that is doing two jobs.

| ID | Requirement |
|---|---|
| REQ-O-01 | The header module label becomes a **module switcher**. `Ctrl+G` (Switch To — the existing Tally-parity key) opens it. Modules: Attendance, CRM, Sales, Purchase, Masters. The sidebar renders only the current module's destinations. |
| REQ-O-02 | **Administration leaves the module sidebar.** Settings, Roles and permissions, Integrations, Audit log, Recycle bin, Period lock, Downloads and Organisation move to a single Administration destination with its own sub-navigation, reached from the organisation name. These are workspace concerns; there is one audit log for the whole system, not one per module. |
| REQ-O-03 | **Approvals leaves the module sidebar** and becomes a top-bar destination with a pending count. `01` already promises one inbox across every approvable thing; a CRM discount and a leave request land in the same place. |
| REQ-O-04 | No module sidebar may exceed **eleven** destinations. This is a hard constraint on future work, not a target. |
| REQ-O-05 | **Go To (`Alt+G`) searches records, not only screens.** Party names, voucher numbers, employee names, deal names, task titles, contact names. Typing an invoice number opens that invoice. Results are permission-filtered before ranking. |
| REQ-O-06 | Module switching preserves the period selected by `Alt+F2`. A user who has scoped to last month stays there when they move from Sales to Receivables. |
| REQ-O-07 | The mobile bottom bar (OPEN-QUESTIONS P0-8) gains module awareness: its four destinations are chosen per person **within** their current module, with the module switcher under More. |

### Area P — Platform extraction

`03` §6 named this risk and `DEPLOYMENT` named the debt. It is now a prerequisite rather than a cleanup.

| ID | Requirement |
|---|---|
| REQ-P-01 | The **approvals framework moves from `modules/attendance` to `platform/approvals`**. No database migration is required — the subject is already polymorphic. The five places that hardcode an attendance permission key are rewired to a per-subject-type handler registry. |
| REQ-P-02 | The **export framework moves to `platform/export`**. Excel and CSV writers, saved views, scheduling and the Downloads tray are already format-agnostic and content-agnostic. |
| REQ-P-03 | **A user may hold multiple roles.** Effective permissions are the union; effective scope is the widest granted. The last-holder-of-`roles.manage` invariant is evaluated against the union. |
| REQ-P-04 | An approval subject type registers its own approve permission. A credit-limit override must never resolve to `regularization.approve`. A test asserts that no subject type falls back to an attendance key. |
| REQ-P-05 | The boundary lint rule extends to the new modules: `modules/crm`, `modules/sales`, `modules/purchase` may import `platform/*` and nothing else. CRM must not import Sales. |

### Area Q — Tally connector

| ID | Requirement |
|---|---|
| REQ-Q-01 | A **connector agent** runs on the network where TallyPrime is reachable. It talks to Tally over XML on port 9000 and to the Vyuha API over outbound HTTPS only. No inbound port is opened to the office. |
| REQ-Q-02 | The agent **polls Vyuha for work** and posts results back. Vyuha never initiates a connection into the office network. |
| REQ-Q-03 | The agent is configured per **company**, not per installation. A Tally installation holding four financial years as four companies is four connections. |
| REQ-Q-04 | **Heartbeat every 60 seconds**, recording agent version, Tally version, the open company, and the last AlterID seen. A heartbeat older than 5 minutes raises a notification to `tally.sync.run` holders. |
| REQ-Q-05 | If Tally is closed, the wrong company is open, or the licence has lapsed, the agent reports **that specific condition** rather than a generic failure. "Tally is not running" and "Tally is running with the wrong company open" are different problems with different fixes. |
| REQ-Q-06 | Every request and response is recorded in the sync journal with a payload hash. Bodies are retained for 30 days, hashes forever. |
| REQ-Q-07 | The agent is a single binary with no installer ceremony, updated by replacing the file. It must survive a Windows restart without a person present. |

### Area R — Masters sync

| ID | Requirement |
|---|---|
| REQ-R-01 | **Parties** (ledgers under Sundry Debtors and Sundry Creditors) pull into Vyuha with name, alias, GSTIN, address, credit limit, credit days, and opening balance. |
| REQ-R-02 | **Stock items** pull with name, alias, unit, group, and GST rate. |
| REQ-R-03 | **Price lists**, where the company maintains them, pull per party group. |
| REQ-R-04 | Masters are **read-only in Vyuha**. There is no create, no edit, no delete. A new customer is created in Tally and appears on the next pull. |
| REQ-R-05 | Incremental pulls key off **AlterID**. A cursor is held per company per entity type. A full re-pull is an explicit administrative action, not a fallback. |
| REQ-R-06 | A master that disappears from Tally is marked `absent_in_tally` and retained. Anything pointing at it keeps resolving. |
| REQ-R-07 | Masters sync runs on a schedule (default every 15 minutes) and on demand. |

### Area S — Historical backfill

| ID | Requirement |
|---|---|
| REQ-S-01 | A one-time import of **every voucher Tally holds**, per company, across every financial year in scope. |
| REQ-S-02 | The backfill is **chunked by period and resumable**. An interrupted run continues rather than restarting. |
| REQ-S-03 | The backfill is **idempotent on GUID**. Running it twice produces one row per voucher. |
| REQ-S-04 | The backfill runs against a **copy of the company data first**, and the run report is reviewed before it is pointed at anything live. A first backfill against live books is not permitted. |
| REQ-S-05 | The run produces a reconciliation report: voucher count and total value per voucher type per month, Vyuha against Tally. A mismatch blocks sign-off. |
| REQ-S-06 | Backfill progress is visible while it runs — company, period, vouchers imported, vouchers remaining, current rate. |

### Area T — Sync operations

| ID | Requirement |
|---|---|
| REQ-T-01 | A **Sync exceptions screen**. Every unresolved conflict, rejection or ambiguity appears here with the document, the Tally response, and the available actions. |
| REQ-T-02 | **Conflicts are never merged automatically.** A record changed on both sides quarantines and waits for a person. |
| REQ-T-03 | Where a record exists on both sides, **Tally wins**. The pull overwrites the Vyuha projection. This is what "system of record" means operationally. |
| REQ-T-04 | A voucher whose GUID disappears from Tally is marked **`voided_in_tally`** and never deleted. `DEPLOYMENT` establishes that history is not erased by deletion; the same rule extends here. |
| REQ-T-05 | Nothing pushes into a **period locked in Tally**. The existing Vyuha period lock (REQ-E-09) is extended to consult the Tally lock. |
| REQ-T-06 | The sync journal is **append-only**, enforced by database trigger, on the same footing as punches and the audit log. |
| REQ-T-07 | Every queue in the sync pipeline is visible in the existing job monitor (`GET /jobs`). Failed pushes retry on the sweep. There is no retry endpoint, consistent with `RUNBOOK`. |
| REQ-T-08 | A daily **drift check** samples recent vouchers and compares Vyuha's projection to Tally. Divergence raises an exception rather than being silently corrected. |

### Area U — CRM core

| ID | Requirement |
|---|---|
| REQ-U-01 | **Contacts** — people, with name, phone, email, designation, company, owner, source, and free-text notes. |
| REQ-U-02 | **Companies** — prospect organisations. A company may or may not be linked to a Tally party. |
| REQ-U-03 | A contact or company is **linked to a Tally party on conversion**, through `external_refs`. Leads are never pushed to Tally. A prospect who never buys must not become a ledger. |
| REQ-U-04 | **Pipelines and stages** are configurable, not hardcoded. Multiple pipelines are supported; one ships. |
| REQ-U-05 | **Deals** — name, company, contact, value, stage, expected close date, owner, probability. A deal has no accounting existence and is never pushed. |
| REQ-U-06 | A deal links to the sales documents raised against it. Opening a won deal shows its estimate, sales order and invoice. |
| REQ-U-07 | Activity log per contact, company and deal: calls, meetings, notes, with timestamp and actor. Written through the platform audit interceptor, not a parallel mechanism. |
| REQ-U-08 | Duplicate detection on contact creation by phone and email, warning rather than blocking. |

### Area V — Tasks and board

| ID | Requirement |
|---|---|
| REQ-V-01 | **Tasks** — title, description, assignee, due date, priority, status, owner. |
| REQ-V-02 | A task's subject is **polymorphic** — `(subject_type, subject_id)` — mirroring the approvals table. A task may hang off a contact, a deal, an invoice, an employee, or nothing at all. |
| REQ-V-03 | **Kanban board** — columns are task statuses, drag moves a task between them. Board columns are configuration, not code. |
| REQ-V-04 | The board and a list view are **two renderings of the same query**. Every filter available on one is available on the other. |
| REQ-V-05 | **The list view is keyboard-complete.** A task's status can be changed, and a task created, assigned and closed, without a mouse. A board is a mouse feature and this product promised Tally users otherwise. Which view is the default is a per-user preference. |
| REQ-V-06 | A drag is a status change is an audit entry. There is no unaudited write path. |
| REQ-V-07 | My tasks is the CRM landing screen: assigned to me, due today or overdue, ordered by due date. |
| REQ-V-08 | Task notifications on assignment, on due date, and on overdue, through the existing notification dispatcher and respecting existing per-user preferences. |

### Area W — Sales documents

| ID | Requirement |
|---|---|
| REQ-W-01 | **Estimate** — line items, quantities, rates, discounts, taxes shown for information. Vyuha-owned. **Not pushed to Tally** (see `11-decisions` D-04). |
| REQ-W-02 | On selecting an item in an estimate, an **information affordance opens that item's history for that party** — quantities, rates and discounts previously quoted and invoiced, from the backfilled data. This is the reason the backfill is worth its cost. |
| REQ-W-03 | **Sales order** — created fresh or converted from an estimate, carrying its lines. Pushes to Tally as a Sales Order voucher. |
| REQ-W-04 | **Delivery challan** — created against a sales order, supporting partial dispatch. One sales order may produce several challans. Pushes as a Delivery Note. |
| REQ-W-05 | **Invoice** — where invoice origin is decided as Vyuha, pushes as a Sales voucher. Where it is decided as Tally, invoices are pull-only and Vyuha has no create path. This is `11-decisions` D-03 and is not yet answered. |
| REQ-W-06 | Every pushed document carries a visible **sync state**. A document displaying "In Tally" that is not in Tally is the failure that ends trust in the system, and the state is therefore never inferred — only reported by the agent. |
| REQ-W-07 | After acceptance, a document is **read-only except through an explicit Alter action**, which re-pushes against the stored GUID. It never creates a second voucher. |
| REQ-W-08 | **Discount above a configured threshold requires approval**, routed through the platform approvals framework using `sales.discount.approve`. |
| REQ-W-09 | A sales order for a party **over its credit limit or with overdue bills beyond its credit days** is blocked, and released only by a holder of `sales.credit.override`, with a recorded reason. |
| REQ-W-10 | Documents are printable and shareable as PDF. Where a legal document requires an IRN, the print action is unavailable until the IRN has returned from Tally. |

### Area X — Purchase documents

| ID | Requirement |
|---|---|
| REQ-X-01 | **Purchase order**, raised on a vendor. Pushes as a Purchase Order voucher. |
| REQ-X-02 | A purchase order may be raised **against a sales order**, carrying the requirement through, or standalone for stock. |
| REQ-X-03 | **GRN** against a purchase order, supporting partial receipt. Pushes as a Receipt Note. |
| REQ-X-04 | A purchase order above a configured value requires approval via `purchase.document.approve`. |
| REQ-X-05 | Open purchase orders — ordered, received, pending — visible per vendor and per sales order. |

### Area Y — Receivables and analysis

Everything in this area is **derived**. Nothing here has a sync path, because nothing here is a document.

| ID | Requirement |
|---|---|
| REQ-Y-01 | **Customer statement** — every invoice, receipt, credit note and debit note for a party, with running balance, as of a chosen date. Exportable and shareable as PDF. |
| REQ-Y-02 | **Ageing** — outstanding bills bucketed 0–30, 31–60, 61–90, 90+, per party and in total. Buckets are configurable. |
| REQ-Y-03 | **Credit cycle** — credit limit and credit days per party against current exposure and actual overdue. Drives the REQ-W-09 block. |
| REQ-Y-04 | **Payment analysis** — average days to pay per party, trend over time, collection efficiency, and the gap between agreed credit days and observed behaviour. Requires several years of backfilled history to be meaningful; with one financial year it is noise, and the screen says so until the backfill covers enough. |
| REQ-Y-05 | **Sales analysis** — value and margin by party, item, item group, month and salesperson. |
| REQ-Y-06 | Every screen in this area is a report under the existing report shell: filter bar, column chooser, saved views, `F12` configure, `Alt+F2` period, Excel export, scheduling. None of them is a bespoke screen. |
| REQ-Y-07 | Every figure states **as-of which sync**, with the timestamp of the last successful pull for that company. A stale number that looks live is worse than a number that admits its age. |

### Area Z — CRM communications

Deferred in detail. Recorded so the platform is not designed in a way that forecloses it.

| ID | Requirement |
|---|---|
| REQ-Z-01 | WhatsApp, email and telephony are **channels behind the existing notification channel abstraction**, not a parallel system. |
| REQ-Z-02 | An inbound or outbound communication is an activity against a contact (REQ-U-07). |
| REQ-Z-03 | The workflow builder named in the Phase 7 roadmap is out of scope until CRM core is in daily use. Requirements are not written for it here. |

---

## 5. Screens

Twenty-seven exist. Twenty-two are added, and eight leave the attendance sidebar under REQ-O-02 and REQ-O-03 without being deleted.

| Module | Screens |
|---|---|
| CRM | My tasks, Board, Contacts, Contact detail, Companies, Company detail, Deals, Deal detail |
| Sales | Estimates, Estimate detail, Sales orders, Sales order detail, Delivery challans, Sales register |
| Purchase | Purchase orders, Purchase order detail, GRNs, Purchase register |
| Masters | Parties, Items, Price lists |
| Receivables | Customer statement, Ageing, Credit cycle, Payment analysis, Sales analysis — all under the report shell |
| Administration | Tally connections, Sync exceptions, Backfill |

Under REQ-O-04 no sidebar exceeds eleven items. Masters and Receivables are reached from within Sales and from Go To rather than being top-level modules if the count is at risk.

---

## 6. Non-functional

| ID | Requirement |
|---|---|
| NFR-08 | A pushed document reaches Tally within **60 seconds** of creation when the agent is healthy, and is visibly queued when it is not. |
| NFR-09 | Masters sync completes within **2 minutes** for a company of 5,000 parties and 10,000 items. |
| NFR-10 | Every receivables report meets the existing NFR-02 bar — first page under 1.5 s — against the full backfilled dataset, not a recent slice. |
| NFR-11 | The connector agent uses under 200 MB of memory and does not require a person to be signed in to the Windows machine. |
| NFR-12 | Loss of Tally connectivity degrades to read-only. Every projection stays readable and every report stays available; only creation queues. |
