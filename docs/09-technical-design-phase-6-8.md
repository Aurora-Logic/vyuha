# 09 — Technical Design: Tally, CRM, ERP

Companion to `08-product-requirements-phase-6-8.md`. Read both before writing code.
Extends `02-technical-design.md`, which remains in force. Where this document is silent, `02` applies.

---

## 1. Architectural stance

The stance from `02` §1 does not change. What changes is that the modules folder stops having one occupant, and that the system acquires a dependency it does not control and cannot reach directly.

```
                      ┌──────────────────────────────┐
   Browser / PWA ───▶ │  Web client (React, shadcn)  │
                      └──────────────┬───────────────┘
                                     │ REST /api/v1
                      ┌──────────────▼───────────────┐
                      │            API               │
                      │                              │
                      │  platform/  ← shared kernel  │
                      │    auth, rbac, org, people,  │
                      │    audit, notify, files,     │
                      │    jobs, approvals*, export*,│
                      │    integration, sync         │
                      │                              │
                      │  modules/                    │
                      │    attendance/   ← live      │
                      │    crm/          ← Phase 7   │
                      │    sales/        ← Phase 8   │
                      │    purchase/     ← Phase 8   │
                      └───┬──────────┬───────────┬───┘
                          │          │           │
                    ┌─────▼───┐ ┌────▼────┐ ┌────▼─────┐
                    │Postgres │ │ Redis   │ │ S3-compat│
                    └─────────┘ └────┬────┘ └──────────┘
                                     │ job queue
                                     │ (agent polls over HTTPS)
        Office LAN                   │
        ┌────────────────────────────┼───┐
        │  ┌──────────────────┐      │   │
        │  │ Tally Connector  │◀─────┘   │   outbound only
        │  │ agent            │──────────────▶ HTTPS to API
        │  └────────┬─────────┘          │
        │           │ XML, localhost:9000│
        │  ┌────────▼─────────┐          │
        │  │   TallyPrime     │          │
        │  │  SYSTEM OF RECORD│          │
        │  └──────────────────┘          │
        └────────────────────────────────┘
```

`*` — approvals and export move into `platform/` in Phase 6a (REQ-P-01, REQ-P-02).

**The direction of the arrows is the design.** Nothing outside the office initiates a connection into it. The agent asks for work and reports results. This means no port forward, no VPN, no static IP requirement, and no inbound attack surface on the machine that holds the company's books.

### 1.1 One rule that governs everything else

**Vyuha holds a projection, not a copy.**

A projection is derived, disposable and rebuildable. If Vyuha's database were dropped and rebuilt from a backfill, nothing financial would be lost. That property must survive every design decision in this phase. The moment a figure exists only in Vyuha, the system has quietly become a second set of books, and the reconciliation burden that follows never goes away.

Practical consequences:

- No accounting field is editable in Vyuha except through a push.
- No Vyuha-side adjustment, correction or "just fix it in the UI" path exists for a synced record.
- Every derived figure (Area Y) recomputes from projected data and stores nothing that cannot be recomputed.

---

## 2. Stack additions

| Layer | Choice | Why |
|---|---|---|
| Connector agent | **TypeScript, compiled to a single binary** (Node SEA or `pkg`) | Same language as everything else, per `02` §2. One file to copy onto a Windows machine, no runtime to install. |
| Tally transport | **HTTP POST of XML to `localhost:9000`** | Tally's only general-purpose interface. ODBC is read-only and version-fragile. |
| XML handling | `fast-xml-parser` | Tally's XML is malformed by strict standards — unescaped ampersands in party names are routine. A tolerant parser is required, not preferred. |
| Agent scheduling | Windows Service via `node-windows`, or Task Scheduler | NFR-11 requires survival of a restart with nobody signed in. |
| Kanban drag | `@dnd-kit/core` | Accessible, keyboard-operable, and does not require a dependency the constitution has to argue about. Its keyboard support is what makes REQ-V-05 achievable on the board as well as the list. |

No other dependency is added without the `CLAUDE.md` §7 approval step.

---

## 3. The sync engine

### 3.1 Ownership, restated as code

Every syncable entity declares an owner. There is no bidirectional entity.

| Entity | Owner | Direction | Tally voucher type |
|---|---|---|---|
| Party (ledger) | Tally | pull | — (master) |
| Stock item | Tally | pull | — (master) |
| Price list | **Vyuha** (D-49) | — | Vyuha-owned and approved; Tally's pulled entries are ignored |
| Estimate | Vyuha | none | — |
| Sales order | Vyuha | push | Sales Order |
| Delivery challan | Vyuha | push | Delivery Note |
| Invoice | **undecided** | one way | Sales |
| Receipt | Tally | pull | Receipt |
| Payment | Tally | pull | Payment |
| Credit / debit note | Tally | pull | Credit Note / Debit Note |
| Purchase order | Vyuha | push | Purchase Order |
| GRN | Vyuha | push | Receipt Note |
| Bill-wise outstanding | Tally | pull | — |
| Contact, company, deal, task | Vyuha | none | — |
| Statement, ageing, credit cycle, analysis | Vyuha | derived | — |

The invoice row is `11-decisions` D-03 and blocks Phase 8b, not Phase 6.

### 3.2 Pull

```
scheduler → enqueue pull job (company, entity type)
          → agent polls GET /sync/jobs, receives it
          → agent reads cursor.last_alter_id from the job payload
          → agent builds a Tally XML export request filtered above that AlterID
          → agent POSTs the response to /sync/results in chunks
          → API upserts on GUID, advances the cursor, journals every chunk
```

**AlterID is the whole mechanism.** Tally stamps every master and voucher with a monotonically increasing counter. Requesting only records above the last-seen value is the difference between a 2-second incremental pull and re-reading the entire daybook every fifteen minutes.

Two properties to hold onto:

- The cursor advances **only after a chunk is durably committed**. A crash mid-pull re-reads a chunk; it never skips one.
- AlterID resets if the company is rewritten from a backup. The agent reports the company's own creation timestamp alongside it; a change there invalidates the cursor and forces an explicit re-pull rather than silently missing every voucher below the old high-water mark.

### 3.3 Push

```
user creates document (state: draft)
  → user confirms (state: queued, push job enqueued)
  → agent polls, receives the job, generates Tally XML
  → agent POSTs to Tally, reads the response
     ├─ accepted → returns GUID + voucher number → state: pushed
     ├─ rejected → returns Tally's LINEERROR verbatim → state: failed, exception raised
     └─ no response / timeout → state stays queued, retried on the sweep
```

**Tally gives no transactional guarantee across a batch.** A request carrying twenty vouchers where the eleventh fails leaves ten imported and no clean way to know which. Therefore: **one voucher per request, always.** It is slower and it is the only version that can be reasoned about after a failure.

**Idempotency.** Every push carries a key. If the agent times out but Tally actually imported the voucher, the retry must not create a second one. Before retrying, the agent queries Tally for the idempotency key stored in the voucher's remote narration field. Present means it landed; absent means it did not. Without this, a flaky office connection produces duplicate invoices, which is the single most damaging failure this system could have.

### 3.4 Conflict handling

| Situation | Behaviour |
|---|---|
| Pull finds a voucher whose Vyuha projection differs | Tally overwrites. Silent. This is normal operation, not a conflict. |
| Pull finds a Vyuha-created document altered in Tally | Tally overwrites, and an exception is raised for visibility only — no action required. |
| Push rejected by Tally | Exception with Tally's verbatim error. The document stays editable. |
| Voucher GUID absent from a full-period pull | `voided_in_tally`. Never deleted. |
| Two agents report for the same company | Second agent refused. One agent per company, enforced by a lease. |
| Cursor ahead of Tally's max AlterID | Company was restored from backup. Cursor invalidated, re-pull required, exception raised. |

**Nothing merges automatically.** The temptation to write a resolution rule for the common case is what produces a system nobody can audit. A person looks at the exception queue.

---

## 4. Schema

### 4.1 Extending `external_refs`

The seam exists from Phase 0. It gains the columns that make it a sync anchor rather than a note.

```
external_refs
  id
  entity_type            text     -- 'sales_order' | 'party' | 'invoice' | ...
  entity_id              uuid
  provider               text     -- 'tally'
  connection_id          uuid     -- which company
  remote_guid            text
  remote_alter_id        bigint
  remote_voucher_number  text
  remote_voucher_type    text
  sync_state             text     -- draft|queued|pushed|failed|voided_in_tally
  idempotency_key        text
  last_pushed_at         timestamptz
  last_pulled_at         timestamptz
  last_error             text
  unique (provider, connection_id, remote_guid)
  unique (entity_type, entity_id, provider, connection_id)
```

### 4.2 New platform tables

```
integration_connections   -- extended: company_guid, company_name, fy_from, fy_to,
                             agent_version, tally_version, last_heartbeat_at, lease_holder

sync_cursors              -- connection_id, entity_type, last_alter_id,
                             last_run_at, company_created_at
                             unique (connection_id, entity_type)

sync_jobs                 -- id, connection_id, direction, entity_type, payload,
                             state, attempts, claimed_by, claimed_at

sync_journal              -- APPEND ONLY (trigger-enforced)
                             id, connection_id, direction, entity_type, entity_id,
                             request_hash, response_hash, request_body, response_body,
                             result, error_code, error_text, duration_ms, created_at
                             request_body/response_body nulled by a 30-day sweep;
                             hashes retained indefinitely

sync_exceptions           -- id, connection_id, kind, entity_type, entity_id,
                             tally_error, state, resolved_by, resolved_at,
                             resolution_note
```

`sync_journal` joins `punches`, `leave_ledger` and `audit_logs` as append-only at the trigger level. `DEPLOYMENT` establishes why: a log that can be edited proves nothing in a dispute, and a sync log is exactly the artefact someone will want when a figure is questioned.

### 4.3 Projection tables

`parties`, `stock_items`, `price_list_entries`, `vouchers`, `voucher_lines`, `bill_allocations`.

Every one of them:

- carries `connection_id` and joins to `external_refs` on GUID
- has **no application write path** — only the sync writer touches them
- is truncatable and rebuildable from a backfill without data loss

`vouchers` is one table with a `voucher_type` discriminator rather than one table per document type. Tally models it this way, the projection should mirror it, and every receivables query in Area Y is a filter over this single table. Partitioning by financial year is the escape hatch if the backfill turns out large; it is not needed at the scale in `05-decisions`.

### 4.4 CRM tables

```
crm_companies        -- may link to a party via external_refs, or not
crm_contacts         -- company_id nullable, owner_id, source
crm_pipelines        -- name, is_default
crm_pipeline_stages  -- pipeline_id, name, sort_order, probability, is_won, is_lost
crm_deals            -- company_id, contact_id, pipeline_id, stage_id, value,
                        expected_close_date, owner_id
crm_activities       -- polymorphic subject, kind, occurred_at, actor_id, body

tasks                -- PLATFORM, not CRM.
                        subject_type, subject_id (both nullable),
                        title, description, assignee_id, owner_id,
                        due_date, priority, status, board_column_id
```

**Tasks live in `platform/`, not `modules/crm/`.** A task hangs off an invoice, an employee, a sales order or nothing. Putting it in the CRM module means the sales module would have to import CRM to attach a task to an invoice, which the boundary lint rule refuses — correctly. The polymorphic subject is the same pattern the approvals table already uses, and the same reasoning applies for the same reason.

---

## 5. API surface

```
# Connector-facing (agent authentication, not user JWT)
POST   /sync/agent/heartbeat
GET    /sync/agent/jobs?connection_id=          claim next job under lease
POST   /sync/agent/results                      chunked results
POST   /sync/agent/errors

# Administration
GET    /sync/connections
POST   /sync/connections
PATCH  /sync/connections/:id
POST   /sync/connections/:id/pull               manual, entity type in body
GET    /sync/cursors
GET    /sync/exceptions
POST   /sync/exceptions/:id/resolve
GET    /sync/journal
POST   /sync/backfill                           start / resume
GET    /sync/backfill/:id                       progress
GET    /sync/backfill/:id/reconciliation

# Masters (read only — no POST, PATCH or DELETE, by design)
GET    /masters/parties
GET    /masters/parties/:id
GET    /masters/items
GET    /masters/price-lists

# CRM
GET|POST        /crm/contacts
GET|PATCH       /crm/contacts/:id
GET|POST        /crm/companies
GET|POST        /crm/deals
PATCH           /crm/deals/:id                  stage change included
GET|POST        /crm/pipelines
GET|POST        /tasks                          platform-level
PATCH           /tasks/:id
GET             /tasks/board                    grouped by column

# Sales
GET|POST        /sales/estimates
POST            /sales/estimates/:id/convert    → sales order
GET|POST        /sales/orders
POST            /sales/orders/:id/push
POST            /sales/orders/:id/alter
GET|POST        /sales/challans
GET             /sales/register

# Purchase
GET|POST        /purchase/orders
GET|POST        /purchase/grns
GET             /purchase/register

# Receivables — all under the existing report shell
GET    /reports/customer-statement
GET    /reports/ageing
GET    /reports/credit-cycle
GET    /reports/payment-analysis
GET    /reports/sales-analysis
```

The agent authenticates with a per-connection credential, not a user token. It holds `sync.agent` and nothing else — it cannot read an employee record, a punch photo, or anything outside its own connection.

---

## 6. Navigation shell

REQ-O-01 through REQ-O-07 in code.

```
platform/shell/
  modules.ts          registry: id, label, icon, destinations[], permission
  ModuleSwitcher      Ctrl+G, rendered on the header label
  AdminShell          the destinations REQ-O-02 pulls out
  GoToIndex           record search, not screen search
```

A module registers itself. Adding one is a registry entry, not an edit to the sidebar component. The eleven-destination cap (REQ-O-04) is asserted by a unit test over the registry, so exceeding it fails CI rather than being noticed in review.

**Go To becomes the real navigation.** `GoToIndex` queries across parties, vouchers, employees, contacts, deals and tasks, permission-filtered before ranking, debounced, capped. Once typing a voucher number opens that voucher, the sidebar stops being how anyone navigates and its length stops being a design problem. This is also the thing a Tally user will reach for first, because it is what `Alt+G` does in Tally.

---

## 7. Failure modes, and what each one looks like

Design that is not stated here will be improvised at 6pm on a month-end.

| Failure | Behaviour |
|---|---|
| Tally closed | Reads serve the projection with an as-of timestamp (REQ-Y-07). Creates queue. Nothing errors. |
| Wrong company open | Agent reports the open company GUID; jobs for other companies are refused rather than executed against the wrong books. |
| Agent machine off overnight | Jobs accumulate. On return the queue drains oldest first. Heartbeat alert fires after 5 minutes and again on recovery. |
| Push accepted but response lost | Idempotency key query on retry (§3.3). No duplicate voucher. |
| Push rejected | Exception with Tally's verbatim error. The document stays editable and the user sees what Tally actually said, not a paraphrase. |
| Tally period locked | Push refused before it is attempted, with the lock date named. |
| Company restored from backup | Cursor invalidated, exception raised, explicit re-pull required. |
| Backfill interrupted | Resumes from the last committed chunk. |
| Two agents, one company | Lease refuses the second. |
| Projection drifts from Tally | Daily drift check (REQ-T-08) raises an exception. Never auto-corrects — an auto-correcting projection hides the bug that caused the drift. |

---

## 8. What is deliberately not built

| Not built | Why |
|---|---|
| A Vyuha-side ledger, trial balance, or P&L | Tally has one. Two is worse than one. |
| GST computation, IRN generation, e-way bill | Tally does this and is already certified for it. Building a second implementation means being wrong on a compliance surface. |
| Direct database writes to Tally, or a Tally TDL that reaches out | XML over the agent is the only channel. |
| Automatic conflict merge | REQ-T-02. |
| Master editing in Vyuha | REQ-R-04. A new customer is created where the accountant creates customers. |
| Multi-tenancy | `08` N9. The schema tolerates it; nothing ships for it. |
| Offline document creation | The punch offline queue exists because a phone on a shop floor loses signal. A salesperson raising an invoice with no connectivity, against a credit limit they cannot check, is not a feature. |
