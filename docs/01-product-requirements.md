# 01 — Product Requirements

Product: **Setu** — workforce attendance platform
Phase in scope: **Attendance only** (Phase 0–5). CRM and ERP are future modules.
Status: draft for build

---


> **Decisions folded in, 28 Aug 2026 (owner-confirmed).**
> - §6.1: on phones the sidebar is replaced by a bottom navigation bar of four
>   per-person, per-device destinations plus More (P0-8) — a hamburger is a
>   desktop pattern on a phone.
> - §5/§6.1: the Team leave calendar is a screen at `/team-leave` in the Work
>   group, gated on `leave.approve.team` (OS-2, REQ-G-12).
> - §6: `GET /me` is served at `/auth/me`; `/settings` updates are PATCH with
>   absent-groups-unchanged semantics (P0-12, P2-5).
> - The Ctrl+F1 answer panel is REQ-AJ-01; its card catalogue REQ-AJ-02; its
>   permission filtering REQ-AJ-03; the error-code hook REQ-AJ-04; and the
>   unanswered-question path ("send to your administrator", recorded, audited,
>   notified) REQ-AJ-05 (P-HELP-1).
> - Weekly-off patterns exist at employee and organisation level only; the
>   location and department levels REQ-C-03 sketched are dropped until a real
>   need appears (P2-6).
> - Leave cancellation on or after the start date stays an approver-key act
>   (REQ-G-10 second join: decided, not built as a second approval).

## 1. Problem and goals

Attendance today is captured informally and reconciled by hand at month end. Payroll runs outside this system and needs a clean, trustworthy monthly input. The organisation also runs on TallyPrime, and staff are fluent in Tally's keyboard-driven way of working.

**Goals**

- G1 — Capture a tamper-resistant in/out punch with photo and timestamp, from web and mobile.
- G2 — Derive an authoritative daily attendance record per employee, per date, with no manual reconciliation.
- G3 — Handle leave, holidays, and weekly offs so the daily record is complete for every calendar day.
- G4 — Produce a locked, exportable monthly payroll input that a payroll operator can trust without re-checking.
- G5 — Feel native to a Tally user: keyboard-driven, dense, fast, no mouse required.
- G6 — Leave the platform in a state where CRM and Tally-backed ERP modules can be added without re-architecting.

**Non-goals (explicitly out)**

- N1 — Salary, wage, deduction, tax, PF/ESI, or payslip calculation of any kind.
- N2 — Biometric hardware integration (fingerprint/face terminals).
- N3 — Recruitment, onboarding workflows, performance management.
- N4 — CRM and ERP functionality.
- N5 — Live Tally read/write sync (only the integration seams are built now).

---

## 2. Users and roles

| Role | Who | Core need |
|---|---|---|
| **Employee** | Everyone | Punch, see own attendance, apply for leave, raise regularization |
| **Operations** | Line/dept managers | Approve their team's leave and regularization, see team attendance, manage rosters for their department |
| **HR** | HR staff | Everything about people, leave policy, holidays, corrections, reports, exports, period lock |
| **Admin** | Owner / IT | All of HR, plus org settings, roles & permissions, integrations, audit log, user provisioning |

Roles are **not** hardcoded into logic. They are named bundles of permissions, editable in the UI (REQ-B-07). Code checks permissions, never role names.

### 2.1 Permission matrix (initial seed)

| Permission | Employee | Operations | HR | Admin |
|---|:--:|:--:|:--:|:--:|
| `punch.self` | ✓ | ✓ | ✓ | ✓ |
| `attendance.view.self` | ✓ | ✓ | ✓ | ✓ |
| `attendance.view.team` | | ✓ | ✓ | ✓ |
| `attendance.view.all` | | | ✓ | ✓ |
| `attendance.edit` | | | ✓ | ✓ |
| `attendance.lock` | | | ✓ | ✓ |
| `leave.apply.self` | ✓ | ✓ | ✓ | ✓ |
| `leave.approve.team` | | ✓ | ✓ | ✓ |
| `leave.approve.all` | | | ✓ | ✓ |
| `leave.policy.manage` | | | ✓ | ✓ |
| `regularization.raise` | ✓ | ✓ | ✓ | ✓ |
| `regularization.approve` | | ✓ | ✓ | ✓ |
| `employee.view` | | ✓ (team) | ✓ | ✓ |
| `employee.manage` | | | ✓ | ✓ |
| `shift.manage` | | ✓ (dept) | ✓ | ✓ |
| `holiday.manage` | | | ✓ | ✓ |
| `report.view` | | ✓ (team) | ✓ | ✓ |
| `report.export` | | | ✓ | ✓ |
| `settings.manage` | | | | ✓ |
| `roles.manage` | | | | ✓ |
| `audit.view` | | | | ✓ |
| `integration.manage` | | | | ✓ |

Data scoping: `team` = employees whose `reporting_manager_id` chain reaches the user, plus employees in departments the user owns. Scope is applied in the repository layer, never in the UI.

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **Punch** | A single raw event: IN or OUT, with time, photo, location, device |
| **Attendance Day** | The derived record for one employee on one calendar date — the unit everything reports on |
| **Shift** | Named schedule: in time, out time, break, grace windows, thresholds |
| **Roster** | Which shift an employee is on for a given date range |
| **Weekly Off** | Non-working weekday pattern, per employee or per shift |
| **Regularization** | Request to fix a missing or wrong punch, subject to approval |
| **Period Lock** | Freezing a month so exports are stable and cannot silently change |
| **Payroll Input** | The locked monthly export handed to whoever runs payroll |

---

## 4. Functional requirements

### 4.A Organisation and master data

- **REQ-A-01** — Single organisation with multiple **locations** (name, address, timezone, geofence centre + radius, IP allowlist).
- **REQ-A-02** — **Departments** (name, code, head employee) and **designations** (name, code, grade).
- **REQ-A-03** — **Employee** record: employee code (unique, org-wide), name, personal email, work email, mobile, date of joining, date of leaving, employment type (permanent / contract / probation / intern), department, designation, location, reporting manager, default shift, weekly-off pattern, status (active / on-notice / inactive).
- **REQ-A-04** — Employee code is immutable after creation. Everything else is editable with an audit trail.
- **REQ-A-05** — Employment lifecycle: activate, place on notice, deactivate with last working date. A deactivated employee cannot punch from the day after their last working date, but all history is retained and appears in past reports.
- **REQ-A-06** — Bulk import employees from Excel: download template → upload → server-side validation → preview of valid rows and per-row errors → commit. Partial commit allowed; errors downloadable as an annotated sheet.
- **REQ-A-07** — Reporting manager must not create a cycle. Validate on save.

### 4.B Identity, access, and devices

- **REQ-B-01** — Login with work email + password. Password policy: minimum 10 characters, checked against a common-password list, no composition rules.
- **REQ-B-02** — Employee records and login accounts are separate entities linked 1:1. An employee may exist without a login (REQ-A-06 imports create records, not accounts).
- **REQ-B-03** — Account provisioning by invite email with a single-use, 72-hour token. Admin/HR can resend or revoke.
- **REQ-B-04** — Forgot password by emailed single-use token, 30-minute expiry. Password change invalidates all other sessions.
- **REQ-B-05** — Sessions: short-lived access token + rotating refresh token. Refresh token reuse detection revokes the family and forces re-login.
- **REQ-B-06** — Session list per user with device, last IP, last seen; user can revoke a session, Admin can revoke any.
- **REQ-B-07** — Roles are user-defined bundles of permissions. Ship with the four seeded roles from §2.1. Admin can create roles, edit permission sets, and assign multiple roles to a user. The last account holding `roles.manage` cannot be stripped of it.
- **REQ-B-08** — **Device binding for mobile punch.** An employee's first mobile punch binds a device fingerprint. Punching from a different device requires HR approval to rebind. Configurable: off / warn / enforce (default: warn).
- **REQ-B-09** — Optional TOTP two-factor, enforceable per role. Required by default for `Admin`.
- **REQ-B-09a** — **Admin has full CRUD on every entity in the system**, with no screen that is read-only to Admin and no record that can only be changed in the database. This covers: employees, users, departments, designations, locations, shifts, rosters, weekly-off patterns, holiday calendars and holidays, leave types, leave balances and manual ledger adjustments, leave requests, punches (see below), attendance days, regularizations, on-duty requests, approval requests and delegations, roles and permissions, notification templates and preferences, settings, saved views, export jobs, and integration connections.
  - Every one of these gets list, create, view, edit, and delete in the UI. Delete is soft delete, always confirmed, always audited.
  - **Two deliberate exceptions, which are corrections not edits:** `punches` and `audit_logs` are append-only. Admin cannot edit or hard-delete a punch — Admin can void a punch with a mandatory reason, which creates an adjusting record and recomputes the day while leaving the original visible. Preserving this is what makes the attendance record defensible; an editable punch log is worth nothing in a dispute.
  - Admin can restore any soft-deleted record from a Recycle Bin screen, within a retention window (default 90 days).
  - Every Admin CRUD action writes an audit entry with before/after values and the acting user.
- **REQ-B-10** — Rate limits: 5 failed logins per account per 15 min (then 15-min lockout with email notice), 20 per IP per 15 min.

### 4.C Shifts, rosters, weekly offs

- **REQ-C-01** — **Shift master**: name, code, scheduled in, scheduled out, break minutes, crosses-midnight flag, and these policy fields:

  | Field | Default | Meaning |
  |---|---|---|
  | `grace_in_before` | 30 min | Earliest an IN punch is accepted before scheduled in |
  | `grace_in_after` | 10 min | Latest an IN punch is accepted after scheduled in |
  | `late_after` | 10 min | Past this, the day is flagged **Late** |
  | `grace_out_before` | 10 min | Earliest an OUT punch is accepted before scheduled out |
  | `grace_out_after` | 120 min | Latest an OUT punch is accepted after scheduled out |
  | `early_exit_before` | 10 min | Leaving earlier than this flags **Early Exit** |
  | `min_half_day_minutes` | 240 | Below this → Absent |
  | `min_full_day_minutes` | 480 | Below this (but above half-day) → Half Day |
  | `ot_after_minutes` | 30 | Minutes past scheduled out that start counting as overtime |

- **REQ-C-02** — Night shifts crossing midnight are attributed to the **shift start date**, not the calendar date of the OUT punch.
- **REQ-C-03** — Weekly off patterns: fixed weekdays, alternate Saturdays (2nd/4th), or custom per employee. Assignable at org, location, department, or employee level; the most specific assignment wins.
- **REQ-C-04** — **Roster**: assign an employee to a shift for a date range. Overlapping assignments are rejected. Falls back to the employee's default shift when no roster row exists.
- **REQ-C-05** — Bulk roster assignment: pick a department/location + date range + shift, preview the affected employee-days, confirm.
- **REQ-C-06** — Changing a roster for a date that already has computed attendance triggers a recompute of those days, unless the period is locked (then it is rejected with a clear message).

### 4.D Punch

- **REQ-D-01** — Punch types: **IN** and **OUT**. Alternating and strictly ordered per attendance day. A second IN without an OUT is rejected.
- **REQ-D-02** — **Photo is mandatory** on both IN and OUT. Front camera only. Gallery upload and file picker are disabled. If the camera is unavailable or denied, punching is blocked with an instruction to enable it — there is no bypass.
- **REQ-D-03** — The server (not the client) burns a stamp onto the stored image: date, time, employee name, employee code, punch type. Client EXIF is stripped before storage.
- **REQ-D-03a** — **Photos are compressed automatically, on every punch, with no user action.** Volume is the constraint: 500 employees × 2 punches × 26 days is roughly 26,000 images a month, so an uncompressed pipeline is not viable.
  - Client: downscale to max 1280px on the long edge, JPEG quality 0.8, before upload. Target under 200 KB.
  - Server: re-encode after stamping to a target of **80–150 KB** (progressive JPEG, or WebP where the browser accepts it), and generate a **256px thumbnail** used everywhere except the full-size viewer.
  - Reports, tables, and list views load thumbnails only. The full image is fetched on explicit open.
  - Compression targets are configurable in settings, with a stated storage estimate shown next to the setting.
  - The stamp (REQ-D-03) must remain legible after compression — this is a test assertion, not an assumption.
- **REQ-D-04** — Punch captures: server timestamp (authoritative), client timestamp, GPS coordinates + accuracy, IP address, device fingerprint, user agent, app version.
- **REQ-D-05** — Client time is never trusted for policy decisions. If client and server time differ by more than 5 minutes, the punch is flagged.
- **REQ-D-06** — **Window enforcement.** A punch inside the shift's grace window is accepted normally. Outside it, behaviour follows an org setting:
  - `BLOCK` — rejected with the next valid window shown
  - `ALLOW_WITH_REASON` — **(default)** accepted only with a mandatory typed reason, then flagged for approval
  - `ALLOW_AND_FLAG` — accepted, flagged, no reason required

  A flagged punch produces an Attendance Day in **Pending Approval** until Operations or HR clears it.
- **REQ-D-07** — **Half day.** At IN punch, the employee may mark the day as a planned half day and pick first-half or second-half. This overrides duration-based derivation. Half day can also result from hours worked (REQ-E-03).
- **REQ-D-08** — **Geofence: hard block.** The office has a geofence (centre from the supplied Maps coordinates, radius **100 m**). A punch outside the radius is **rejected** — this is the premises-only rule and it is the primary control, since web punch is not restricted by network.
  - **Accuracy tolerance is mandatory.** Block only when `distance − gps_accuracy_m > radius`. A low-confidence fix gets the benefit of the doubt and is recorded with a `low_gps_accuracy` flag for HR review. Without this, people standing inside the building get refused, because indoor GPS regularly degrades to 50–100 m.
  - Reject and flag any reading where the device reports a **mock/fake location** (Android `isFromMockProvider`, plus an iOS plausibility check on impossible position jumps). A fake-GPS app defeats an unguarded geofence in under a minute.
  - The rejection message states the distance from the office, not just "denied".
  - Employees flagged as field staff are exempt; their punch is recorded as **On Duty**.
- **REQ-D-08a** — **GPS denied or unavailable:** the punch is **allowed with a mandatory typed reason** and flagged `no_location` for approval. It is never silently accepted. Repeated `no_location` punches by the same employee raise a notification to HR — permission denial is the obvious way to route around a geofence.
- **REQ-D-09** — **Web punch is restricted to the office IP allowlist.** Browser geolocation on a desktop is derived from IP or Wi-Fi and is unreliable, so network origin is the trustworthy premises signal for web. Mobile punch is governed by GPS (REQ-D-08); web punch is governed by IP. Same premises-only rule, enforced by whichever signal is credible for that device.
- **REQ-D-10** — **Offline punch.** The mobile PWA queues punches locally when offline (photo included) and syncs when connectivity returns. Queued punches carry the original client timestamp and are marked `offline_sync`; the delay is recorded and shown in reports.
- **REQ-D-11** — Every punch submission carries a client-generated idempotency key. Retries never create duplicates.
- **REQ-D-12** — Punches are **immutable**. They are never edited or deleted. Corrections happen through regularization (§4.F), which creates a separate adjusting record.
- **REQ-D-13** — Punch screen shows, before punching: current server time, today's shift and window, current status, and last punch. After punching: a confirmation with the stamped photo thumbnail.

### 4.E Attendance day engine

- **REQ-E-01** — Exactly one **Attendance Day** row exists per active employee per calendar date from their date of joining to the earlier of today and their last working date. No gaps.
- **REQ-E-02** — Statuses, in resolution order:

  | Status | Condition |
  |---|---|
  | `HOLIDAY` | Date is in the employee's holiday calendar |
  | `WEEKLY_OFF` | Date matches the employee's weekly-off pattern |
  | `ON_LEAVE` | An approved leave covers the date (full or half) |
  | `PRESENT` | Worked minutes ≥ `min_full_day_minutes` |
  | `HALF_DAY` | Worked minutes ≥ `min_half_day_minutes`, or marked half day at punch |
  | `ON_DUTY` | Approved field duty / on-duty request |
  | `PENDING` | IN exists, OUT missing, and the shift window has closed |
  | `ABSENT` | No punch, or worked minutes below `min_half_day_minutes` |

  A day can be `HALF_DAY` **and** carry a half-day leave — that combination is valid and must render as such.
- **REQ-E-03** — Worked minutes = (OUT − IN) − break minutes, capped at a configurable maximum (default 16h) to bound bad data.
- **REQ-E-04** — Derived flags per day, independent of status: `late`, `early_exit`, `missing_punch`, `outside_geofence`, `outside_window`, `offline_sync`, `device_mismatch`, `manual_override`.
- **REQ-E-05** — Overtime minutes are recorded as a number only. No rate, no multiplier, no money.
- **REQ-E-06** — The engine is **idempotent**. Recomputing a day from source records yields identical output. It runs on: punch creation, leave approval/cancellation, roster change, holiday change, regularization approval, employee record change, and a nightly sweep for the previous 3 days.
- **REQ-E-07** — A nightly job closes out days with a missing OUT punch: status `PENDING`, flag `missing_punch`, notification to the employee and their manager.
- **REQ-E-08** — **Manual override.** HR can set a day's status directly. This requires a typed reason, sets `manual_override`, records who and when, and is surfaced with a marker in every report. Overrides survive recomputation.
- **REQ-E-09** — **Period lock.** HR locks a month. After locking: no punches, leave, regularizations, overrides, or recomputes affect locked days. Unlocking requires Admin and a reason, and both actions are audited.

### 4.F Regularization and on-duty

- **REQ-F-01** — Employee raises a regularization for a specific date: missing IN, missing OUT, wrong time, or forgot to punch. Mandatory reason. Optional attachment.
- **REQ-F-02** — Configurable limits: how many days back a regularization may be raised (default 7) and how many per month (default 3).
- **REQ-F-03** — On approval, an adjusting record is written and the day is recomputed. The original punches remain untouched and visible.
- **REQ-F-04** — **On-duty / field duty** request: date range + reason + optional client/site name. On approval, those days become `ON_DUTY` and count as present.
- **REQ-F-05** — Rejection requires a reason. The employee is notified with it.

### 4.G Leave management

- **REQ-G-01** — **Leave types** are configurable: name, code, paid/unpaid, accrual method (none / monthly / yearly / on-joining), annual entitlement, carry-forward allowed + cap, encashable flag (informational only — no money math), min/max days per application, notice days required, requires attachment beyond N days, allows half day, allowed for which employment types, counts sandwich days or not.
- **REQ-G-02** — Seed types: Casual Leave, Sick Leave, Earned/Privilege Leave, Leave Without Pay, Compensatory Off. All editable.
- **REQ-G-03** — **Balances** are maintained per employee per leave type per leave year, with an immutable ledger: opening, accrued, availed, adjusted, carried forward, closing. Every movement is a ledger row referencing its cause.
- **REQ-G-04** — Leave year start month is configurable (default April).
- **REQ-G-05** — Pro-rated accrual for mid-year joiners and leavers.
- **REQ-G-06** — **Application**: type, from/to date, half-day flag per boundary day, reason, optional attachment. The form shows the computed working days consumed and the balance before/after, before submission.
- **REQ-G-07** — Validation on apply: sufficient balance, no overlap with existing leave, no application on holidays/weekly offs (they are skipped, not consumed, unless the type counts sandwich days), notice period respected, date not in a locked period.
- **REQ-G-08** — **Negative balance is allowed, up to a limit set per leave type.** The limit is a field on the leave type (`negative_balance_limit`, 0 = not allowed). Applying beyond the limit is rejected. A negative balance is shown in red on the employee's screen and appears on a dedicated report, because it becomes a recovery item at exit.
- **REQ-G-09** — **Approval** routes to the reporting manager, then HR if the leave type requires two-step approval. Configurable per type. Auto-escalate to HR if untouched for N days (default 3).
- **REQ-G-10** — Cancellation: before the start date by the employee directly; on or after the start date via approval. Cancellation reverses the ledger entries and recomputes the affected days.
- **REQ-G-11** — **Comp-off**: HR or an approver grants comp-off credits against a specific worked holiday/weekly-off date. Credits expire **30 days** after the earned date (configurable). Because 30 days is short, the expiry job notifies the employee and their manager at 7 days and again at 2 days before a credit lapses, and expired credits appear on a report rather than vanishing silently.
- **REQ-G-12** — Team leave calendar: month view showing who is away, with a per-department concurrent-absence warning threshold.

### 4.H Holidays

- **REQ-H-01** — Multiple **holiday calendars** (e.g. by location or state), each a named list of dated holidays with optional restricted/optional flag.
- **REQ-H-02** — Employees inherit a calendar from their location, overridable per employee.
- **REQ-H-03** — Restricted holidays: employee chooses up to N per year from a pool; the choice consumes an allowance and marks the day `HOLIDAY` for them only.
- **REQ-H-04** — Bulk import a year's holidays from Excel. Changing a holiday recomputes the affected days unless locked.

### 4.I Approvals framework

- **REQ-I-01** — One generic approval mechanism serves leave, regularization, on-duty, flagged punches, and device rebinding. Do not build four separate ones.
- **REQ-I-02** — An approval request has: type, requester, subject records, current step, approver(s) for that step, status, history of actions with reasons and timestamps.
- **REQ-I-03** — Single **Approvals** inbox per approver, filterable by type, with bulk approve/reject for same-type requests.
- **REQ-I-04** — Delegation: an approver can delegate to another user for a date range. Delegated actions record both identities.
- **REQ-I-05** — An approver cannot approve their own request; it routes to the next level up.

### 4.J Reports and export

- **REQ-J-01** — Every report shares one shell: filter bar (date range, location, department, employee, status, flags), column chooser, sort, pagination, saved views, and an export button.

  | Report | Content |
  |---|---|
  | Daily Muster | One row per employee for a date: shift, in, out, hours, status, flags |
  | Monthly Muster Grid | Employees × days matrix with status codes and a totals block |
  | Late Arrivals | Late days with minutes late, per employee, aggregated |
  | Early Exits | Mirror of the above |
  | Absenteeism | Absent days and percentage by employee, department, month |
  | Missing Punch | Days flagged `missing_punch`, and their regularization status |
  | Overtime | OT minutes by employee and period |
  | Leave Balance | Current balances by employee and type |
  | Leave Ledger | Full movement history for one employee |
  | Leave Availed | Leave taken by type, employee, period |
  | Punch Audit | Raw punch log with photo thumbnails, location, device, flags |
  | Headcount | Active headcount, joiners, leavers by month |
  | **Payroll Input** | The month-end handoff — see REQ-J-04 |

- **REQ-J-02** — Photo viewer: click any punch to see the stamped photo, map pin, device, and flags in a side panel.
- **REQ-J-03** — **Excel export** on every report. Exports run as background jobs and land in a Downloads tray with progress and a 7-day retention. Files are formatted: frozen header, filters applied, column widths set, org name and filter criteria in a header block, generated-at timestamp.
- **REQ-J-04** — **Payroll Input export**, per month, per location, only from a **locked** period. One row per employee: employee code, name, department, designation, date of joining/leaving, calendar days, working days, present days, half days, paid leave days by type, unpaid leave days, holidays, weekly offs, LOP days, overtime minutes, late count. This is the contract with payroll — its column set is versioned and must not change silently.
- **REQ-J-05** — Scheduled exports: a saved report configuration can be emailed daily/weekly/monthly to a list of recipients.
- **REQ-J-06** — All exports are audited: who, what, filters, when.

### 4.K Dashboard and notifications

- **REQ-K-01** — Role-aware dashboard. Employee: today's status, this month's summary, leave balances, pending requests. Operations: team present/absent/late today, pending approvals, team on leave this week. HR/Admin: org-wide present/absent counts, late trend, pending approvals, flagged punches, unlocked periods.
- **REQ-K-02** — Notification channels: in-app bell and email in this phase; the channel interface must accommodate WhatsApp later without touching call sites.
- **REQ-K-03** — Events that notify: punch reminder before shift start (opt-in), missing OUT punch, leave applied / approved / rejected / cancelled, regularization outcome, approval pending for over N days, period locked/unlocked, low leave balance, flagged punch raised.
- **REQ-K-04** — Per-user notification preferences by event and channel.
- **REQ-K-05** — Bell shows an unread count. **The count text is white on the red dot.**

### 4.L Settings

- **REQ-L-01** — Org profile, logo, timezone (default Asia/Kolkata), date format (default dd-MM-yyyy), week start day, leave year start.
- **REQ-L-02** — Attendance policy: punch window behaviour, geofence behaviour, device binding mode, max work minutes, regularization limits, auto-escalation days.
- **REQ-L-03** — Photo retention period (default 12 months) with a purge job and a clear warning before changing it.
- **REQ-L-04** — Email/SMTP configuration with a test-send button.
- **REQ-L-05** — Every settings change is audited with before/after values.

### 4.M Audit and compliance

- **REQ-M-01** — Append-only audit log: actor, impersonator (if any), action, entity type, entity id, before/after diff, IP, user agent, timestamp. No deletes, no updates.
- **REQ-M-02** — Audit viewer with filters, and per-record history on employee, attendance day, leave, and settings screens.
- **REQ-M-03** — Consent notice shown on first punch explaining that a photo and location are captured, with the retention period. Acceptance is recorded.
- **REQ-M-04** — Soft delete everywhere. Nothing employee-related is hard-deleted from the application.
- **REQ-M-05** — Export of all data held about one employee, on request (`employee.manage` permission).

### 4.N Utilities

- **REQ-N-01** — **Global "Go To"** (`Alt+G`): keyboard-driven command palette to jump to any report, master, or employee, and to create records in the flow of work. This is the primary navigation, matching Tally's model.
- **REQ-N-02** — **Switch To** (`Ctrl+G`): switch the current report to a different one, preserving filters where they apply.
- **REQ-N-03** — **Calculator panel** (`Ctrl+N`): a vintage Casio-style calculator, available on any screen without leaving it. Tape display, keyboard-operable, memory keys, result copyable into the focused field. Styled as a physical calculator, not a web widget.
- **REQ-N-04** — Shortcut reference sheet (`Ctrl+F1`) listing every active shortcut for the current screen.

---

## 5. Screen inventory

| # | Screen | Key REQs |
|---|---|---|
| 1 | Login / invite accept / reset | B-01…B-05 |
| 2 | Dashboard (role-aware) | K-01 |
| 3 | Punch (mobile-first) | D-01…D-13 |
| 4 | My Attendance (calendar + list) | E-01, E-02 |
| 5 | My Leave (balances, apply, history) | G-03, G-06 |
| 6 | Approvals inbox | I-03 |
| 7 | Team Attendance | E-02, J-01 |
| 8 | Attendance Register (daily/monthly) | J-01 |
| 9 | Punch Audit + photo viewer | J-02 |
| 10 | Employees (list, detail, import) | A-03, A-06 |
| 11 | Shifts & Rosters | C-01…C-05 |
| 12 | Leave Types & Balances | G-01, G-03 |
| 13 | Holiday Calendars | H-01…H-04 |
| 14 | Reports hub | J-01 |
| 15 | Downloads tray | J-03 |
| 16 | Settings | L-01…L-05 |
| 17 | Roles & Permissions | B-07 |
| 18 | Audit log | M-02 |
| 19 | Period Lock | E-09 |

---

## 6. Experience requirements

### 6.1 Navigation model

Left sidebar, collapsible, grouped: **Work** (Dashboard, Punch, My Attendance, My Leave, Approvals) · **Records** (Employees, Shifts, Leave, Holidays) · **Reports** · **Setup** (Settings, Roles, Integrations, Audit). Sidebar items are permission-filtered. `Alt+G` is the faster path and is advertised in the UI.

### 6.2 Page structure

Every page: breadcrumb + title + primary action (right) → filter/toolbar row → content surface → pagination. No card wrapping a card. Tables sit directly on the page surface with a single outer border, not inside a `Card`.

### 6.3 Density

This is an operations tool. Default to compact table rows (36px), 13–14px body text, tabular numerals for all numeric and time columns. Whitespace should read as deliberate, not generous.

### 6.4 Keyboard specification — TallyPrime parity

Verified TallyPrime keys to implement with the same meaning:

| Key | Action | Notes |
|---|---|---|
| `Alt+G` | Go To — universal navigate/create | Primary navigation |
| `Ctrl+G` | Switch To — change current report | |
| `Esc` | Close screen / clear field input | Never traps focus |
| `Ctrl+A` | Accept / Save | Works from any field in a form |
| `Ctrl+Q` | Quit screen without saving | Confirm if dirty |
| `Alt+C` | Create master on the fly | From any picker field |
| `Alt+D` | Delete current record | Always confirms |
| `Alt+E` | Export | Opens export options |
| `Alt+P` | Opens the print/PDF menu | |
| `Alt+M` | E-mail this report | |
| `Alt+O` | Import | |
| `Alt+K` | Company/Organisation menu | |
| `F2` | Change date | |
| `Alt+F2` | Change period (range) | |
| `F11` | Features / org-level configuration | |
| `F12` | Configure current screen (columns, view) | |
| `Ctrl+F1` | Contextual help / shortcut sheet | |
| `Ctrl+N` | Calculator panel | Toggles |
| `Enter` | Drill down into the focused row | |
| `Alt+Enter` | Expand / collapse a group | |
| `Tab` / `Shift+Tab` | Next / previous field | |
| `Ctrl+↑` / `Ctrl+↓` | First / last item in list | |
| `Page Up` / `Page Down` | Previous / next record or page | |

**Browser-reserved conflicts must be handled, not ignored.** `Ctrl+N`, `Ctrl+T`, `Ctrl+W`, `Alt+F4` cannot be reliably intercepted in a browser tab. For each, register the Tally key (it works where the browser permits, and in the installed PWA), provide a documented in-app alias, and show both on the hint chip. Proposed aliases: `Ctrl+N` → `Alt+N`, `Ctrl+F1` → `F1`.

Every control with a shortcut renders a small hint chip showing the key. Hints are visible by default and can be dimmed in settings, never removed. Shortcuts are scoped: a modal's shortcuts take precedence and the underlying screen's are suspended.

### 6.5 Responsive rules

- ≥1280px: full table, sidebar expanded
- 768–1279px: sidebar collapsed to icons, non-essential columns hidden via the column chooser default
- <768px: tables become stacked record rows — primary identifier + status pill on line one, two supporting fields on line two, row tap opens the detail sheet. Never a horizontal scroll of a wide table.
- The Punch screen is designed mobile-first and is the only screen where the mobile layout is primary.

### 6.6 Copy

Plain, active, sentence case. Buttons name the action and the toast repeats it ("Approve leave" → "Leave approved"). Errors say what happened and what to do. Empty states offer the action that fills them. No exclamation marks, no emojis, no apologising interface.

---

## 7. Non-functional requirements

- **NFR-01** — Punch submission (including photo upload) completes in under 3 seconds on a 4G connection with a 1MB image. Photos are downscaled client-side to max 1280px on the long edge before upload.
- **NFR-02** — Any report renders its first page in under 1.5 seconds at 500 employees × 24 months of data. Seed a dataset of this size and benchmark against it.
- **NFR-03** — Excel export of a full month for 500 employees completes in under 30 seconds as a background job.
- **NFR-04** — Target 500 employees and 2,000 punches/day for this phase; the schema and indexes should not need reworking at 5,000 employees.
- **NFR-05** — All timestamps stored in UTC, rendered in the org timezone. Date-only fields (attendance date, leave date, holiday) are stored as `DATE` and never as timestamps.
- **NFR-06** — Browser support: current Chrome, Edge, Safari, and Android Chrome. Mobile punch requires camera and geolocation permission.
- **NFR-07** — Accessibility: visible focus rings, full keyboard operability, WCAG AA contrast, form fields labelled, reduced-motion respected.
- **NFR-08** — Availability target 99.5%; nightly database backup with restore tested before go-live.
- **NFR-09** — Photos stored in object storage, never in the database, never on a public URL. Access is via short-lived signed URLs granted only to permitted viewers.
- **NFR-10** — All money-adjacent fields are absent by design. If a field would need a currency symbol, it does not belong in this product.

---

## 8. Assumptions

1. One legal entity for now; the schema carries an `org_id` so a second entity is additive, not a rewrite.
2. Employees have smartphones capable of running a PWA with camera access.
3. Payroll continues to run in TallyPrime; this product feeds it.
4. Attendance regulations followed are the organisation's own policy; the product enforces configured policy, not statute.

## 9. Open questions — answer before Phase 1

Recorded in `docs/OPEN-QUESTIONS.md`. Current list:

1. Employee headcount now, and expected in two years?
2. How many locations, and do they have different holiday calendars and shift timings?
3. Are there night shifts today, or only general shift?
4. Current leave policy: types, annual entitlement, carry-forward rules, leave year start?
5. Who approves leave today — direct manager, or does everything go to one person?
6. Should out-of-window punches be blocked outright, or allowed with a reason? (Default assumed: allowed with reason.)
7. Is field/site work common enough to need the On Duty flow in Phase 2 rather than later?
8. What exact columns does whoever runs payroll need in the monthly handoff? Their answer overrides REQ-J-04.
9. Web punch from shared office machines — allowed, or mobile only?
