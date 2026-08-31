# 05 — Decision Log

Confirmed by the client. **This file overrides any assumed default in documents 01–03.** If a requirement here contradicts something written earlier, this wins.

Last updated: 11 August 2026

---

## Scale

| Decision | Value |
|---|---|
| Users at launch | Under 50 |
| Locations | One |
| Implication | Multi-location tables stay in the schema, but per-location holiday calendars, per-location period locks, and location filters ship hidden. Photo storage lands around 4 GB/year rather than 37. |

## Punch — where and how

| Decision | Value |
|---|---|
| Punch channels | Mobile PWA **and** web browser |
| Governing rule | **Office premises only** — nobody punches from home |
| Mobile enforcement | GPS geofence, **hard block** outside radius |
| Geofence radius | **100 m** |
| Geofence centre | From the office Google Maps link *(pending)* |
| Web enforcement | **Office IP allowlist** — desktop geolocation is IP-derived and unreliable, so network origin is the credible premises signal |
| GPS accuracy handling | Block only when `distance − accuracy > radius`; low-confidence fixes are allowed and flagged, not refused |
| Mock/fake GPS | Detected and rejected, flagged |
| GPS denied or unavailable | Allowed **with a mandatory typed reason**, flagged `no_location`; repeat offenders raise an HR notification |
| Out-of-window punch | Allowed **with a mandatory typed reason**, then flagged for approval |
| Device binding | **Warn** on a new device (not enforced) |
| Half day | Selectable **at the moment of punching**, first half or second half |
| Photo | Mandatory both IN and OUT, front camera only, no gallery path |
| Photo compression | Automatic — client downscale, server re-encode to 80–150 KB, 256px thumbnail; lists load thumbnails only |

## Shift and calendar

| Decision | Value |
|---|---|
| Shifts | **One general shift** (timings pending) |
| Late threshold | **10 minutes** past shift start |
| Weekly off | **Configurable in the UI** — Admin ticks the off days, alternate-Saturday rule as a toggle, per-person override available. Nothing hardcoded. |
| Holidays | Admin-entered list; no dates ship assumed |
| Overtime | **Tracked as minutes.** No rates, no money, ever |
| IN with no OUT | Day becomes **Pending until regularized** — not absent, not half day |

## Leave

| Decision | Value |
|---|---|
| Leave year | Starts **April** (Indian FY) |
| Crediting | **Accrues monthly**, pro-rated from joining month |
| Approver | **Reporting manager** |
| Negative balance | **Allowed, limit set per leave type** (`negative_balance_limit`; 0 disables) |
| Carry-forward | **Allowed, with a cap** — cap set per leave type |
| Comp-off | **Granted** for working a holiday or weekly off |
| Comp-off expiry | **30 days** from the earned date, with lapse warnings at 7 and 2 days |

## Access

| Decision | Value |
|---|---|
| Admin | **Full CRUD on every entity**, plus a 90-day Recycle Bin for soft-deleted records |
| Two exceptions | `punches` and `audit_logs` are append-only. Admin **voids** a punch with a reason (creating an adjusting record); the original stays visible. An editable punch log is worthless in a dispute. |

## Interface

| Decision | Value |
|---|---|
| Components | **shadcn only, installed via the shadcn MCP.** No other library, no hand-rolled components, no pasted source |
| Native elements | **None** — this explicitly includes date pickers, time pickers, dropdowns, checkboxes, and every other small control |
| Date/time inputs | shadcn Calendar / Popover / Command compositions. Never `<input type="date">`, never a third-party picker |
| Mobile | **Fully responsive throughout.** Pickers open as a bottom Sheet on small screens, touch targets ≥44px, no hover-only interaction anywhere |
| Emojis | None. Icons only (`@phosphor-icons/react`; owner confirmed Phosphor 28 Aug 2026) |
| Layout | One consistent hierarchy, no card-inside-a-card |
| Keyboard | TallyPrime key parity, hint chip on every control that has a shortcut |

---

## Attendance changes, 21 August 2026

Owner decisions for the second attendance brief (docs/PENDING.md, A-01 to A-09):

- Corrections (regularization) and on-duty requests are removed as employee-raised
  flows. Open requests stay decidable in Approvals until the queue is empty.
- An admin-recorded IN/OUT (`ADMIN_ENTRY`) counts in the day computation, sits
  beside the employee's own punches rather than replacing them, needs a reason,
  and is gated on `attendance.edit`.
- Late and out-of-window punches are always accepted and flagged into Approvals;
  the punch-window behaviour setting is retired.
- Early arrival: hand-rolled confetti, default threshold 15 minutes, streak
  resets on a non-early working day; both settings live under Attendance policy.
- Geofence: the server rejects anything outside the radius except a fix that is
  outside by less than its own accuracy. No field-staff exemption, no
  allow-with-reason without a fix, and an office with no coordinates cannot punch
  until they are entered. Radius per office, editable, default 100 m.
- Durations in the shift editor use an hours + minutes picker in 5-minute steps.

## Still open

| # | Question | Needed by |
|---|---|---|
| 1 | Office Maps link / coordinates | Phase 1 |
| 2 | General shift timings — in, out, break | Phase 1 |
| 3 | Office IP address(es) for the web allowlist | Phase 1 |
| 4 | Leave types: name, entitlement, carry-forward cap, negative limit, notice days, half-day allowed, document required after N days | Phase 2 |
| 5 | This year's holiday list | Phase 2 |
| 6 | Who runs payroll, in what format, and the **exact columns** they need | Phase 3 |
| 7 | Attendance cycle — calendar month, or a cutoff like 26th–25th | Phase 3 |
| 8 | Do all employees have a work email address? | Phase 0 |
| 9 | NestJS or Fastify *(default: NestJS)* | Phase 0 |
| 10 | Hosting and file storage *(default: VPS + Cloudflare R2)* | Phase 0 |
| 11 | Product name — **Setu** proposed, confirm or replace | Phase 0 |
| 12 | Brand colour, logo, typeface | Phase 0 |
| 13 | Photo retention period *(default: 12 months)* | Phase 1 |
| 14 | Consequence rules — does 3 lates equal a half day? | Phase 1 |
| 15 | Regularization limits — days back, count per month *(default: 7 days, 3/month)* | Phase 2 |
