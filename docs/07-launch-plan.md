# 07 — Launch plan: pilot on 15 August 2026

This document is written to be given to Claude Code. Each workstream ends in a
paste-ready prompt. Read `CLAUDE.md` first; it overrides everything here.

Status source: the phase-by-phase audit of 14 Aug 2026 (all 1,327 tests green,
typecheck and lint clean). Overall the build is roughly two-thirds done —
what remains is concentrated in reports, notifications UI, regularization,
and the entire deployment column.

---

## Progress — 14 Aug 2026, evening

Seven branches merged to main. Gates on the merged result: typecheck 0 errors,
lint 0 warnings (plus two drift guards — guide anchors and service-worker
precache), **1,402 tests passing** (25 shared, 163 web, 1,214 api),
production build clean.

**Read this first if you read nothing else.** Two things found today were
invisible to every test suite and to the vite dev server, and only appeared
when the *production build* was driven in a real browser:

1. **Reconnecting after an offline reload revoked the entire session family.**
   On an offline-loaded page there is no access token in memory, so when
   signal returned the session refetch and the queue drain each presented the
   same single-use rotating refresh cookie. The server did exactly what
   REQ-B-05 specifies — called the second one theft and revoked everything —
   so the employee was thrown to the sign-in form and the queued punch was
   stranded. 3/3 in the production build, 0/3 on the dev server: the faster
   build loses the race every time. Fixed client-side (refresh is now
   single-flight; both senders acquire a token before sending). **No server
   control was softened** — see §2 row 10, still open.
2. **CI's browser gate could never fail.** The driving step piped through
   `tee` under `bash -e` without `pipefail`, so the step reported `tee`'s
   exit code; and the seed-password grep matched the seed's dash separator,
   so CI had been signing in with `-------`. Both fixed. Expect that job to
   be able to go red now — that is the point.

The lesson worth carrying: `pnpm dev` is not what the pilot runs. Rehearse
the offline path against a production build or you are rehearsing a
different application.

| Workstream | State |
|---|---|
| WS-A deployment rail | **Done.** Prod compose, Caddyfile with TLS + security headers, trust proxy (spoof rejected live), backup + **rehearsed restore** (46 tables, row counts matched), runbook, `.env.production.example`. Sentry deferred (§2 row 13 unanswered); off-site backup copy waits on R2 credentials. |
| WS-B product blockers | **Done.** Consent recording (migration 0012), photo retention stamping, leave approve/reject UI with inline day recompute — an approved leave now reaches the muster. |
| WS-C security gate | **Ran, said DO NOT DEPLOY, two blockers fixed.** (1) Consent was client-side only — the API stored photo punches with no acceptance row, proven live; now enforced inside the punch transaction (422 `CONSENT_REQUIRED` without it), including the offline sync path, with notice version and quoted retention recorded (migration 0013). (2) `POST /auth/password-resets` had no rate limit at any layer — 60 requests delivered 43 real emails; now capped 3/address/hour, still answering 202. **That "so enumeration stays blind" was written too early and was wrong**: the final gate measured the two branches and found every known address slower than every unknown one (P(known > unknown) = 1.000; known min 8.51ms above unknown p50 3.97ms), because only the existing-account branch awaited an SMTP send — a gap that widens with a real relay. Fixed by taking the lookup off the request path entirely: it spends the limiter budget and enqueues, so the branches are indistinguishable by construction rather than by balancing (P now 0.50), and delivery was re-proved end to end through Mailpit. Four further findings closed: `STORAGE_ORIGIN` made required (empty shipped a CSP that silently blocked **every** punch photo), root `.dockerignore`, Redis `--requirepass`, photo-retention floor raised to 3 months (a 1-month floor could purge a photo while its punch was still disputable). 71 controls verified working. |
| Smoothness pass (unplanned) | **Done**, under `emil-design-eng` + `thumb-reach`. Zero layout shift on punch / My Attendance / My Leave (skeletons rebuilt to measured content metrics), 44px password reveal, camera preview eases in, bottom-nav tabs uniform, PWA metadata warning gone. Every change measured at 360px and 1440px in both themes. |
| Bug hunt + fixes (unplanned) | **Done.** A CDP hunt over the day-one flows found one launch-blocker crash (two hooks cached different shapes under one query key, reliably killing Team Attendance after Employees) plus five bugs; all fixed, and a new scan test now fails the build on any duplicate query key — it caught a second latent collision on the way in. Also fixed: an offline reload hid the queued punch behind an unusable sign-in form; one wrong password burned two of five lockout attempts. |
| Merge re-verification (unplanned) | **Ran, said MERGE PROBLEMS, all fixed.** Three agents drove merged main in production builds because three separate agents had edited the punch flow and a clean textual merge can still break semantically. It found the session-revocation blocker above, a first-ever install that booted to a **blank page** offline (the entry bundle was never precached — and an immutable HTTP cache had been hiding it), a dev-server offline reload showing *invented* attendance (network failure was misread as "endpoint not built"), and a punch button pressable while the camera held no frame. All fixed; 20 other claims held, including the whole consent gate under adversarial attempts. |
| Seed and CI (unplanned) | **Done.** The administrator's login is now linked to employee VY-0001 — chosen over a dedicated employee row, which would have put a 26th body into headcount, muster and every export. verify-ui 72/73 → **73/73**. |
| WS-D data load and onboarding | **Blocked on §2 inputs.** Nothing loaded yet. |
| WS-E final verify | Pending WS-D. |
| WS-F charts and insights | Not started (launch-week, not go/no-go). |

### The connect-everything push — 14 Aug, evening

Eight branches built in parallel and merged into one product: five feature
slices and three blocker-fix areas. **1,728 tests** (25 shared, 268 web,
1,435 api), typecheck and lint clean, production bundle verified free of
debug code, dev-only routes and sample data.

What landed: **regularization and on-duty** (REQ-F — a forgotten punch-out
finally has a way out, raised from the day sheet where the problem is
noticed, and approval recomputes the day); **the leave/approvals join**
(REQ-I — leave now reaches the real inbox, so delegation and escalation
govern something); **notifications made visible** (REQ-K — bell, list,
preferences, and the seven events that had templates but never fired);
**admin completion** (roles can now be assigned to people, the org logo lives
on the server, records carry their own history, and the Integrations screen
stopped calling an endpoint that did not exist); and **the orphaned screens**
(team leave calendar, comp-off, restricted-holiday election, balance
adjustment, employee bulk import — every one an API that already worked with
no way to reach it).

**What the merge itself caught, none of it visible in any branch alone.** Two
agents invented the same error code for the same idea. Two claimed the same
day-sheet footer — both belonged, so it holds both. Notifications pointed its
regularization event at a placeholder screen with a comment saying that slice
had none yet; it does now. Notifications also wrote a falsification test
asserting `/regularizations` was not a route, which regularization then
created — the test was right to fail. And a guard test written by one agent
caught **four files sharing a test organisation id**, which is why two suites
had been quietly deleting each other's fixtures mid-run.

The lesson worth keeping: parallel branches each verified in isolation are
not a verified product. The merge is its own engineering task, and it found
more real defects per hour than any single branch did.

**§2 row 10 is now urgent and evidenced.** The single-flight fix closes the
within-one-document race, which is the one the offline punch path hits. It
does **not** close two separate documents: two tabs opened together, a
restored window, or a quick double-reload still present the same cookie twice
and still revoke the family. That is P1-6, and softening reuse detection is
the owner's call, not a session's. Recommended: a ~10-second server-side
rotation tolerance (accept the just-rotated token briefly and return the same
replacement — genuine theft replays are separated by minutes, not seconds).
A client-side Web Lock would also close the two-tab case but does nothing for
a browser restart.

**The critical path is now entirely §2** — DNS pointed at the VPS, R2-or-MinIO, geofence coordinates, shift timings, roster, leave types with opening balances, holidays. SMTP has left this list: mail is off by default and invitation links are handed over by the administrator (row 8). No code work blocks the pilot.

---

## 0a. Residual risk at pilot — read before deciding how many people to invite

Nothing below is a reason not to launch. They are the things that will still
be true on the first morning, and holding them consciously is the difference
between a pilot and a surprise.

| Risk | State | What reduces it |
|---|---|---|
| **Nothing has met a real phone, network or person** | The largest unknown by far. Every defect found so far was found by a machine driving a machine. Day one of any pilot surfaces things no test reaches — a permission dialog tapped wrong, a dead spot on the shop floor, a name with an apostrophe. | Start with 5–10 people for two days, not 50. Same system, same day, a tenth of the blast radius. |
| **Nothing has run at scale** | The seed is 25 employees against a 500-employee performance target. No load test exists. | Fine at pilot size. Do the performance pass before widening past ~50. |
| **No production error tracking** | `SENTRY_DSN` is a validated slot with no SDK behind it, pending a dependency approval (§2 row 13). Failures are visible only in `vy logs api`. | Watch the logs directly for the first two days, or approve the dependency. |
| **Two tabs / a browser restart can still sign a user out of everything** | P1-6. Tonight's Web Lock closed the offline-reconnect and two-tab-together cases; a browser restart presenting a stale cookie still trips reuse detection. | §2 row 10 — a ~10-second server-side rotation tolerance. Your call, small change. |
| **Eleven of thirteen reports do not exist** | Attendance Register and Punch Audit are live; Payroll Input is not, and export is CSV rather than formatted Excel. | Month-end is the real deadline, not day one. Needs the `exceljs` approval and the column sign-off. |
| **The approvals framework governs leave, but not yet regularization** | Regularization and on-duty decide on their own endpoints, as leave did until tonight. Both decision bands are deleted whole when their handler lands. | Works correctly today; it is an architectural loose end, not a defect. |

## 0. The honest verdict

**A full launch tomorrow is not possible.** Eleven of thirteen reports,
Payroll Input, XLSX export, the notifications UI, regularization, and the
whole deployment rail do not exist, and the leave/approvals join is
explicitly parked as work that needs a human watching.

**A limited pilot tomorrow is possible** if three things happen today:

1. The inputs in §2 are supplied (nothing in code can substitute for them).
2. The deployment rail (WS-A) and the two product blockers (WS-B) land.
3. The security gate (WS-C) passes with no finding on the punch/photo path.
   This gate can say no. If it does, the launch moves, not the gate.
4. The production data load and onboarding (WS-D) happens before employees
   arrive — a booted, secure, **empty** system is still a failed launch.

**Pilot scope — what employees get on day one:** sign-in by invitation,
punch **from phones** with photo/geofence/offline queue (desktop web punch
is blocked regardless of the IP allowlist by the front-camera constraint —
`facingMode: exact` rejects webcams that report no facing mode, P1-5; it
stays out of the pilot unless §2 row 12 is decided), My Attendance, Team
Attendance,
shifts and rosters, holidays, leave application with balances plus a minimal
approve/reject path, employee and master admin, settings, audit log, period
lock, the two live reports (Attendance Register, Punch Audit) with CSV export
and the Downloads tray.

**Explicitly not in the pilot** (say so to the client in writing): the other
11 reports, Payroll Input and month-end export, XLSX formatting,
notifications (bell, emails beyond invites/resets), regularization and
on-duty, comp-off UI, approval delegation UI, team leave calendar, restricted
holiday election, TOTP, the calculator, and desktop web punch (P1-5). The
first locked month is more than two weeks away — that is the real deadline
for Payroll Input, not tomorrow.

## 1. How to run this plan in Claude Code

- **Model: Claude Fable 5** (`claude-fable-5`). It is the most capable tier
  Anthropic ships — above Opus — and both it and Opus 5 are stable
  production models; the difference is capability, not stability. Use Fable 5
  for everything in this plan that touches security, the deploy rail, or the
  leave/approvals join. Opus 5 is acceptable for mechanical UI wiring and
  copy changes if cost matters; Fast mode (`/fast`) runs on Opus for quicker
  output. Do not switch models mid-workstream.
- Work one workstream per session, in order: A, B, C, D, then E. F (charts)
  can run in a parallel session; it is not a go/no-go item.
- **Every UI task in every workstream must load `/emil-design-eng` and
  `/thumb-reach` before writing UI code, and `/apple-design` for layout per
  CLAUDE.md §5.** This is a standing instruction across this whole plan.
- Project skills now exist and are the gates: `/vyuha-verify` (quality
  gates), `/vyuha-security` (pre-deploy security), `/vyuha-structure`
  (structure and constitution review).

  Owner, 22 Aug 2026: `/vyuha-charts` is retired. It mandated a house chart
  layer -- shared label helpers, a draw-once motion hook, a ChartPanel
  surface -- on top of the shadcn primitive, and the product now uses the
  shadcn chart examples directly and unmodified. A chart is a Card, a
  ChartContainer and Recharts; the only rules left are the ones in this
  file's own section on charts.
  Every workstream ends by running `/vyuha-verify`; the plan ends by running
  `/vyuha-security`.
- Commit at each working increment with REQ IDs. Do not push unless asked.

## 2. Inputs only Virag can supply — needed TODAY

Code cannot proceed past placeholders without these (`05-decisions.md` §Still
open, `OPEN-QUESTIONS.md` carried items):

| # | Input | Without it |
|---|---|---|
| 1 | Office Google Maps link / coordinates for the geofence centre | Mobile punch geofencing stays disabled |
| 2 | General shift timings — in, out, break | The seeded placeholder shift reaches production |
| 3 | Office IP address(es) | Web (desktop) punch stays blocked |
| 4 | Real leave types: entitlement, carry-forward cap, negative limit, notice days | Placeholder seed types reach production |
| 5 | This year's holiday list | Empty calendar; every working day computes as a working day |
| 6 | Production host + domain name, and DNS pointed at it | No TLS, no deploy |
| 7 | Cloudflare R2 credentials (or the word "MinIO on the VPS instead") | No photo storage in production |
| 8 | ~~SMTP credentials for real mail~~ **No longer blocking.** Mail is off by default (`MAIL_TRANSPORT=log`) and the client is deploying without a mail server | Nothing. `POST /auth/invitations` returns the accept link to the administrator, who copies it out of the Employees screen and sends it however they like; the same menu issues a password-reset link. The one thing still lost is the self-service "forgot password" form, whose token reaches nobody — a locked-out person asks an administrator instead. Supply SMTP later and set `MAIL_TRANSPORT=smtp` to turn delivery back on |
| 9 | Decision: icons — amend docs to phosphor (recommended, two-line change) or sweep back to lucide | The constitution and the codebase keep contradicting each other |
| 10 | Decision: refresh-token rotation tolerance ~10s (recommended) or leave the two-tab logout as is | Two tabs / a restored window log the user out of everything |
| 11 | Acknowledgement in writing that the pilot excludes the §0 list | Scope disputes at month-end |
| 12 | Decision: desktop web punch — keep phone-only for the pilot (recommended), or approve the P1-5 camera fallback (keep `exact` on touch devices, accept any camera on single-camera devices) | Desktop punch stays blocked even with the IP allowlist populated |
| 13 | Decision: approve `@sentry/node` as a new dependency, or defer error tracking | CLAUDE.md forbids adding a dependency unasked; without the word, Sentry is deferred and recorded in OPEN-QUESTIONS |
| 14 | Opening leave balances per employee as of 15 Aug | The monthly accrual job runs on the 1st and cannot reconstruct April–August history; balances start wrong |
| 15 | The pilot employee roster (names, emails, departments, designations) in the bulk-import format | Nobody to invite; an empty muster on day one |

## 3. Workstreams

### WS-A — Deployment rail (~1 session, Fable 5)

Nothing here exists today: no Caddyfile, no production compose, no backups,
no runbook; SENTRY_DSN is validated by the env schema but no SDK is
installed.

Deliverables: production `docker-compose.prod.yml` (api built image, web
static build served by Caddy, Postgres with a named volume, Redis, no
Mailpit); `Caddyfile` with TLS, security headers, and reverse proxy to the
api; **`trust proxy` set to the exact hop count in `apps/api/src/main.ts`**
(OPEN-QUESTIONS P0-11 — behind Caddy, `req.ip` is spoofable without it and
the per-IP login limit becomes a fiction); nightly `pg_dump` backup script
plus a **rehearsed restore into a scratch database** (NFR-08 — a backup that
has never been restored is a hope, not a backup); a one-page
`docs/RUNBOOK.md` (start, stop, logs, backup, restore, job monitor via
`GET /jobs`); Sentry wired to the existing env slot **only if §2 row 13
approves the `@sentry/node` dependency** — otherwise deferred and recorded
in OPEN-QUESTIONS. No other new dependency is authorised by this
workstream.

Prompt:

```
Read CLAUDE.md and docs/07-launch-plan.md §WS-A. Build the deployment rail:
production compose, Caddyfile with TLS and security headers, trust proxy hop
count in main.ts, nightly pg_dump backup script with a rehearsed restore
(actually run the restore into a scratch DB and show the row counts), a
one-page docs/RUNBOOK.md, and Sentry ONLY if launch-plan §2 row 13 approved
the @sentry/node dependency (CLAUDE.md forbids adding one unasked; if
unanswered, defer it and record that in OPEN-QUESTIONS). Verify against the
running thing: boot the prod compose locally, sign in through Caddy, then
punch once VIA THE API (multipart POST with a test image - the browser
camera path cannot run headless, see OPEN-QUESTIONS P1-5; the real-camera
punch is WS-E's phone check), and confirm the photo lands in object storage
and the audit row is written. Then run /vyuha-verify and /vyuha-security.
Commit at each working increment.
```

### WS-B — Product launch blockers (~1 session, Fable 5)

Two items, both small, both genuinely blocking:

1. **Consent recording (REQ-M-03 / P1-4).** The notice gates the punch but
   nothing stores acceptance, and punch photos never get `files.expires_at`,
   so the 12-month retention (REQ-L-03) is unenforced. Record acceptance
   server-side once per user — this needs a **new consent-acceptance table
   and a reversible migration** (nothing in the API stores consent today);
   the retention half needs **no migration**, the `expires_at` column and
   its index already exist in `0001_platform_tables.sql` — stamp it from
   the retention setting so the purge job starts selecting punch photos.
   Privacy promises the UI already makes must be true before real employees
   punch.
2. **Minimal leave decision UI (REQ-G-09 subset).** `POST
   /leave/requests/:id/approve|reject` exist and are tested, but no screen
   calls them — an approver cannot decide leave through the product at all.
   Add approve/reject with a reason to the manager's view of leave requests,
   calling the existing endpoints. On approval/cancellation, recompute the
   affected attendance days via the existing `DayEngineService.computeDay`
   (the same inline pattern `holiday.service.ts` uses) so approved leave
   actually reaches the muster. Be aware this **reverses a documented
   in-code decision**: `leave.service.ts:746` deliberately skips the inline
   recompute, resting on a nightly day-engine sweep that was never built
   (`SCHEDULED_JOBS` has no such job) — the reversal is intentional, do not
   stall on the comment; replace it when the recompute lands. **Do NOT
   build the approvals-framework join here** — `OPEN-QUESTIONS.md` ("The leave / approvals join, still
   unwired") explains why that is supervised work; it stays in week 1 with
   Virag watching.

Prompt:

```
Read CLAUDE.md, docs/07-launch-plan.md §WS-B, and the P1-4 and leave/approvals
sections of docs/OPEN-QUESTIONS.md. Implement (1) server-side consent
recording (new consent-acceptance table, reversible migration) plus
expires_at stamping on punch photos from the retention setting (no migration
needed - the column and index exist in 0001), and (2) a minimal leave
approve/reject UI on the existing /leave/requests/:id/approve|reject
endpoints, with day recomputation on approve and cancel following the inline
pattern in holiday.service.ts. The comment at leave.service.ts:746 documents
the opposite choice, resting on a nightly sweep that does not exist - that
decision is reversed here deliberately; replace the comment. Do not
touch the approvals framework or write to the ledger from any new path. Load
/emil-design-eng, /thumb-reach and /apple-design before any UI work. Full
Definition of Done per CLAUDE.md §4 including integration tests. Finish with
/vyuha-verify and /vyuha-structure. Commit with REQ IDs.
```

### WS-C — Security gate (go/no-go, Fable 5)

Run `/vyuha-security` (which itself runs `/security-review`) across the
branch. The Phase 1 exit gate was never recorded, so this is the first full
pass — expect findings. Any finding on the punch, photo, or auth path blocks
launch; fix and re-run. The gate's verdict is final: if it says DO NOT
DEPLOY, the pilot date moves.

Prompt:

```
Run /vyuha-security on the current branch. Fix every finding it marks as a
deploy blocker (punch/photo/auth path), re-run until the verdict is DEPLOY,
and report what was found and fixed, with file:line. Never weaken a check to
get there.
```

### WS-D — Production data load and onboarding (~half a session, Virag + Claude Code together)

A booted, secure, empty system is still a failed launch — this workstream
turns the §2 inputs into production state and gets the workforce in. It runs
after WS-A boots production; Virag drives (the inputs and the people are
theirs), Claude Code assists through the product's own endpoints.

- Location row carrying the geofence centre (§2 row 1) and the IP allowlist
  (row 3).
- General shift updated with real timings (row 2); weekly-off pattern set;
  a roster assigned to every pilot employee via the existing bulk endpoint.
  The seeded placeholder shift must not survive into day one.
- Real leave types (row 4); opening balances loaded via the existing
  `POST /leave/balances/adjust` (row 14) — the monthly accrual job runs on
  the 1st and cannot reconstruct April–August history.
- Holiday calendar imported (row 5) via the existing import endpoints.
- Employee roster imported via `POST /employees/import/validate` + `commit`
  (row 15). Note: this is API-only — there is no import screen yet — so it
  runs as a scripted call; do not build UI in this workstream.
- **The administrator's own login joined to their employee record.** REQ-B-02
  keeps the login and the person as separate rows, and a login with no person
  attached is refused by `/punch` ("this sign-in is not linked to an employee
  record") and by `GET /leave/balances`. An administrator who skips this
  discovers it at the punch screen on day one, in front of employees. The
  seed now joins `admin@vyuha.local` to VY-0001 so a development database is
  punchable out of the box, but VY-0001 is a fabricated person — on production
  the administrator's login must point at **their own** row from the roster
  import above, not at the seeded one. Verify by punching once as that account
  and by opening My Leave.
- An invitation issued for every pilot user from the Employees screen, and the
  link handed to each of them (row 8 — there is no mail server, and the
  administrator passing the link on is the delivery). Each link is single-use
  and dies after 72 hours, so issue them close to the day you need them.
- A one-page employee comms note: what is collected (photo, location), why,
  the retention period, how to install the PWA, and the camera/location
  permission prompts to expect. The delivery plan's own risk table names
  "communicate before rollout" as the adoption mitigation for photo and
  location capture — this note is that mitigation.

Prompt:

```
Read docs/07-launch-plan.md §WS-D. With Virag supplying the §2 inputs, load
production through the existing endpoints: location with geofence centre and
IP allowlist, real shift timings plus weekly-off pattern plus rosters for
every pilot employee (bulk endpoints), real leave types with opening-balance
adjustments via /leave/balances/adjust, holiday import, and the employee
roster via /employees/import/validate then /commit (API-only, scripted - no
new UI). Point the administrator's own login at their real employee row from
that import, not at the seeded VY-0001, and prove it by punching once and
opening My Leave as that account - a login with no employee record is refused
by /punch and by GET /leave/balances. Assert nothing placeholder remains: the
seeded General shift and seed leave types must be updated or replaced. Issue
an invitation for each pilot user from the Employees screen and hand over the
link it returns - there is no mail server, and that is by design (row 8).
Draft the one-page employee comms
note (photo and location collection, retention, PWA install, permission
prompts). Everything through the product's own audited endpoints - no direct
SQL.
```

### WS-F — Charts and insights (parallel session; launch-week, not go/no-go)

Dashboard and the employee detail page get more charts and, more
importantly, computed insight sentences. Charts are plain shadcn: the
ChartContainer primitive and the Recharts shapes from shadcn's own examples,
square and slim to match the theme. What survives from the retired chart
skill is the part that was never about styling -- the series and every
insight threshold live in a tested module, because a chart cannot be
rendered in jsdom and its arithmetic must not be the part nobody can check.
The `dataviz`, `/emil-design-eng` and `/thumb-reach` passes still apply.

Dashboard (REQ-K-01 — closes part of the audited gap):
- Employee: leave balance donut per type with "N days expire on carry-forward
  cap" insight; punctuality trend (arrival deviation vs shift start);
  worked-hours vs expected bar with the delta as the insight.
- Operations/HR/Admin (permission-gated, server-scoped): late-arrivals trend
  with weekday breakdown insight ("9 of 11 lates were Mondays"); absence
  heat strip for the period; pending leave requests count linking to the new
  WS-B decision UI; flagged-punch count linking to Punch Audit.

Employee detail (`employee-detail-page.tsx` already has an analysis base in
`attendance-analysis.ts` — extend, don't fork):
- Monthly hours vs expected; punctuality distribution; leave usage by type
  vs entitlement; overtime trend (gated by `canViewOvertime`); weekday
  pattern ("consistently late after weekly off" class of insight).

Rules that bind here: insights are computed in tested series builders, never
ad hoc in JSX; no insight may surface data the viewer's permissions withhold
(overtime is the live example); every chart ships empty/loading/error states,
both themes, reduced motion, and a 360px pass.

Prompt:

```
Read docs/07-launch-plan.md §WS-F. Load dataviz, /emil-design-eng,
/thumb-reach and /apple-design. Build the dashboard and
employee-detail charts and insight sentences listed there, using the shadcn
MCP for chart components, extending features/employees/attendance-analysis.ts
and the existing series/charts pattern. Every threshold tested in the series
tests; permission scoping inherited from the server, verified against a
non-privileged account. Verify at 360px and 1920px in both themes with the
browser, not by assumption. Finish with /vyuha-verify. Commit with REQ IDs.
```

### WS-E — Final verify and go/no-go

Run `/vyuha-verify` end to end including the browser gate; then the
checklist:

- [ ] All gates green: typecheck, lint, 1,327+ tests, production build,
      verify-ui at 1440px and 360px.
- [ ] Prod compose boots on the VPS; sign-in via invitation works over TLS.
- [ ] A real punch on a real phone from the office lands: photo stamped,
      EXIF-free, geofence verdict correct, audit row written.
- [ ] An offline punch queues and syncs when signal returns.
- [ ] Leave: apply → approve (new UI) → the day shows on the muster.
- [ ] Production holds real data: location with geofence and IP allowlist,
      real shift timings, a roster for every pilot employee, real leave
      types with opening balances, this year's holidays — and no
      placeholder seed rows anywhere.
- [ ] Every pilot login is joined to an employee record, the administrator's
      included and pointing at their own row rather than the seeded VY-0001.
      A login without one cannot punch and has no leave.
- [ ] Invitations delivered to every pilot employee; one sampled acceptance
      completes on a personal phone end to end: PWA install, camera and
      location permissions granted, punch lands.
- [ ] The employee comms note went out before day one.
- [ ] Restore rehearsal done; runbook exists; Sentry receiving (or deferred
      in writing).
- [ ] `/vyuha-security` verdict: DEPLOY.
- [ ] §2 inputs all supplied; §0 exclusions acknowledged in writing.

Any unticked box moves the launch, not the bar.

## 3b. Go-live data the operator supplies (owner's decision, 28 Aug 2026: checklist, not open questions)

These closed every remaining "supply the real number" row in
`docs/OPEN-QUESTIONS.md`. Each names its screen; none blocks a build.

- [ ] Geofence centre and radius per office (Administration > Organisation > location).
- [ ] Office IP allowlist for web punch (same screen).
- [ ] Real shift timings replacing the placeholder General shift (Attendance setup > Shifts).
- [ ] Leave types: entitlements, carry-forward, negative caps (Attendance setup > Leave types; the five seeded rows carry their placeholder notes until edited).
- [ ] This year's holiday calendar, restricted days marked (Attendance setup > Holidays), and each location pointed at its calendar.
- [ ] Payroll column sign-off against REQ-J-04 before the first month-end export.
- [ ] Attendance cycle confirmed (calendar month stands until said otherwise).
- [ ] Brand colour and logo (Settings > Appearance; Settings > Logo).
- [ ] Legal: operator entity name and registered address, grievance officer contact (DPDP), counsel review of the terms and privacy drafts.
- [ ] Sentry project created and SENTRY_DSN set (the API reports only when set).
- [ ] Cloudflare R2 bucket `vyuha-backups` + rclone credentials; add the copy line to the backup cron (WS-A-2).
- [ ] OpsTally: one baseline pass with the lookback raised to cover the history wanted (P6b-5), then drop it back.
- [ ] OpsTally agent owner asked for `bill_allocation` rows (REQ-AJ-02; the server-side writer is live and waiting).
- [ ] Delete the dev verification account verify@vyuha.local before real users arrive.

## 4. After the pilot — the remaining ~10 sessions

Week 1: the leave/approvals join (supervised, per OPEN-QUESTIONS — subject-
handler registry, raise+handle in one change), regularization and on-duty
flows (REQ-F — Pending days currently have no exit), notifications read API
+ bell + preferences UI and the 7 unwired events, user-role assignment UI.
Week 2: reports batch (Monthly Muster, Late Arrivals, Early Exits, Missing
Punch, Overtime, Leave Balance/Ledger), `exceljs` + XLSX house formatting
(needs the dependency approval), Payroll Input behind the column sign-off,
scheduled exports. Then: comp-off UI, delegation UI, team leave calendar,
restricted-holiday election UI, calculator, TOTP, Playwright E2E for the
three critical flows, the 500-employee performance pass, `/ultrareview` to
close each phase.
