# Open questions

Per `CLAUDE.md` §7. Nothing here is guessed at in code — where a default is
stated, the code implements the default and this file records that it was a
default, not an answer.

Format: question, the REQ it blocks, the phase it blocks, and the recommended
default being used until answered.

---

## Raised during Phase 0 setup

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| P0-1 | **Product name.** `CLAUDE.md` and the specs say **Setu**; the repository directory is **Vyuha**. Which is the product name? | Nothing yet — cosmetic | Using **Vyuha**, matching the directory. One find-replace changes it. Package names, the DB name, and bucket names all use `vyuha`. |
| P0-2 | **shadcn MCP server was not configured.** `CLAUDE.md` §3 requires every component be installed through it. A `.mcp.json` has now been written pointing at `npx shadcn@latest mcp`, but it only takes effect after the CLI is reloaded. | All UI work | No UI has been built yet, so nothing has been sourced any other way. UI work waits for the MCP to be live. |
| P0-3 | **MailHog replaced with Mailpit** in the dev stack. MailHog has had no release since 2020 and publishes no arm64 image, so on Apple Silicon it runs under emulation. | Nothing — dev infrastructure only | Mailpit v1.22, same SMTP port 1025, web UI on 8025. |
| P0-4 | **Where do punch photos live in production?** Hostinger sells no S3-compatible object storage. Either MinIO on the same VPS, or Cloudflare R2. | Phase 1 | **Cloudflare R2.** At under 50 employees the estimate is roughly 4 GB a year, inside R2's 10 GB free tier, and egress is free. It keeps photos off the app disk, gives object versioning and lifecycle rules for the 12-month purge (REQ-L-03), and means a VPS rebuild cannot lose the evidence that makes a punch defensible. MinIO on the same box is the fallback if you would rather nothing left the VPS. Nothing in the code is R2-specific — the file service targets the S3 API. |
| P0-5 | **Third-party identity provider (Clerk) instead of own auth?** | Phase 0 | **Answered 12 Aug 2026: own auth.** See [ADR 0002](adr/0002-own-auth-not-clerk.md). |
| P0-6 | **The icon library now contradicts the constitution.** Preset `b50dFpu8w` was applied in full, which swapped `iconLibrary` from `lucide` to `phosphor`. Every icon import in `apps/web/src` is now `@phosphor-icons/react`; zero files import `lucide-react`. CLAUDE.md §3 rule 2 and `05-decisions.md` both state "Icons only (`lucide-react`)". | Any future UI work | **Nothing reverted.** The preset was applied deliberately after the conflict was flagged, and reverting it would undo an intentional choice and churn every screen a second time. But the two cannot both stand: the next `shadcn add` will emit phosphor imports while the constitution says lucide, and a later contributor reading CLAUDE.md will "fix" it back. **Decide one:** (a) amend CLAUDE.md §3 rule 2 and `05-decisions.md` to say phosphor, or (b) revert to lucide with `shadcn add --overwrite` plus an import sweep. Option (a) is a two-line documentation change; (b) touches every screen. The style also moved `base-nova` to `base-lyra`, which is what set `--radius: 0` and made the app square. |

| P0-7 | **The organisation logo is stored in the browser, not on the server.** REQ-L-01 asks for an org logo; the control is built and works, but it persists to localStorage because there is no settings endpoint and no file upload API yet. | Phase 4, or sooner | Per-browser today: a second person signing in sees the monogram until the server owns it. The permanent home already exists in the schema — `organizations.logo_key` pointing at a row in `files`. Moving it is one endpoint plus swapping the store; the client already normalises the image to a 128px PNG, which is what the server would store anyway. **Answered 12 Aug 2026: approved. sharp and the S3 client are installed and the platform file service is being built now** (it is a Phase 0 deliverable in its own right, and the same two dependencies carry the Phase 1 punch photo pipeline). The logo moves off localStorage once that service has an upload endpoint. **Closed 14 Aug 2026.** `POST /settings/logo` stores the bytes through `FileService` — the same magic-byte sniff and the same sharp re-encode the punch photo pipeline uses, so the declared content type is never consulted and nothing a client sent is stored verbatim — and writes the resulting `files.id` to `organizations.logo_key`. `GET /settings/branding` returns the organisation name and a short-lived signed URL and is gated on being signed in rather than on `settings.manage`, because the sidebar renders it on every screen for every employee; `FILE_READ_RULES` already said `ORG_LOGO` was readable by any authenticated principal. The zustand/localStorage store is deleted. Two consequences worth stating: a replaced or removed logo has its old `files` row stamped with `expires_at` so the existing purge job sweeps the object rather than leaving it unreferenced in the bucket forever, and a `logo_key` that no longer resolves — a purged object, a restored database, or a value that is not an id — falls back to the monogram with a warning in the log rather than failing the one endpoint every page load calls. |
| P0-8 | **The phone gets a bottom navigation bar, which the PRD does not describe.** PRD §6.1 specifies a left sidebar and §6.5 only says it collapses. | Nothing — already built | A hamburger is a desktop pattern on a phone: every destination is two taps away and none is under a thumb. The bar shows four destinations plus More, and which four is chosen per person and per device, because a shop-floor employee opens Punch and nothing else while HR lives in Approvals. Confirm this is wanted, and I will fold it into PRD §6.1 rather than leaving it as an undocumented addition. The desktop sidebar is unchanged. |

| P0-9 | **JWT signing is hand-rolled.** `platform/auth/jwt.ts` implements HS256 with `node:crypto` because no JWT library is a declared dependency and this phase was told not to add one. | Before Phase 1 ships | **Resolved 12 Aug 2026.** `jose` replaced the hand-rolled file. The swap cost both exports becoming async - `jose` has no synchronous API because it is built on WebCrypto - so the guard, `AuthService.accessResponse` and two tests now await. All ten attack cases are unchanged in substance and still pass, and the tokens in them are still forged by hand with `createHmac`, so the verifier is attacked by something that does not share its code. Verified live: real token 200, forged `alg:none` 401. What follows is the original note. It is careful code — `alg` is compared to a constant and never dispatched on, signatures use `timingSafeEqual`, `exp` is required, there is no decode-without-verify export, and a forged `alg:none` token is rejected (verified live). It also has 11 attack-shaped tests. None of that changes the rule: a hand-written security primitive is a liability, and the seam is deliberately two functions wide so the swap is small. `jose@6.2.8` is already in the pnpm store as a transitive dependency. **Needs your approval to add.** |
| P0-10 | **Invitations cannot be delivered.** `nodemailer` is not installed, so there is a `Mailer` port with a `LogMailer` that writes the link to the log in development and logs an error in production. | Before anyone but the seeded admin can sign in | REQ-B-03 provisioning is invite-only, so without mail there is exactly one account. **Resolved 12 Aug 2026.** SMTP mailer on nodemailer, selected by `MAIL_TRANSPORT`. Verified by sending a real invitation, reading the link out of the captured message in Mailpit, and using it to accept and sign in. Mailpit is already running on SMTP 51025 to receive it. |
| P0-11 | **The per-IP login limit is in-memory.** REQ-B-10's per-account limit (5 per 15 minutes, then lockout) is in Postgres and is unaffected. The per-IP limit (20 per 15 minutes) resets on restart and is per-instance, because no Redis client is installed. | Before a second instance runs | **Resolved 12 Aug 2026.** Sliding window on a Redis sorted set. Verified across a restart, which the in-memory version could not survive. It fails open when Redis is down - the Postgres per-account lockout is unaffected either way, and failing closed would stop the whole company signing in over a cache outage. Say the word if you want that inverted. Fine on one VPS today, but it costs nothing to make it correct now. Related: `trust proxy` is deliberately **not** set, so `req.ip` is the socket address — correct with no proxy in front, but it must be set to a specific hop count when Caddy lands, or any client can spoof `X-Forwarded-For` and walk past the limit. |
| P0-12 | **`GET /me` is mounted at `/api/v1/auth/me`.** Technical design §6 specifies `/me`. | Before the web client wires to it | Cosmetic, and a one-line change. Flagging so the contract and the code do not quietly disagree. |

## Raised during Phase 1 master data

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| P1-1 | **No permission key covers departments, designations or locations.** PRD §2.1 names `employee.view` / `employee.manage` for people and `settings.manage` for org settings, but the three masters an employee points at are in neither list, and §5 gives them no screen of their own. | REQ-A-01, REQ-A-02 | **Read: `employee.view`.** Anyone who can see the employee list needs these names to render its filters and its form, so a narrower key would leave Operations looking at a list it cannot filter. **Write, departments and designations: `employee.manage`** — they are people master data and HR owns them. **Write, locations: `settings.manage`** — a location row carries the geofence centre and the IP allowlist (REQ-D-08, REQ-D-09), so whoever can edit one can decide from where a punch is accepted. That is an Admin control, not an HR one. Say the word if locations should sit with HR instead; it is a one-line change per route. |
| P1-2 | **No delete route exists for any master.** Technical design §6 lists `GET/POST/PATCH` for all four resources and no `DELETE`, and REQ-M-04 forbids a hard delete. | Nothing yet | None built. An employee is retired through REQ-A-05 (status INACTIVE with a last working date), which keeps the history past reports need. A department or designation created by mistake currently cannot be removed from the picker. If that needs fixing, the shape is a soft-delete route guarded by the write key above, refusing while any live employee still points at the row. |

## Raised during Phase 1 punch screen wiring

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| P1-3 | **Is the half-day choice always available on an IN punch, or is it a policy?** REQ-D-07 says the choice is made at the moment of punching and only on the IN, but nothing in `PunchContext` says whether an organisation may switch it off, and there is no settings column for it. | REQ-D-07 | Offered on every IN punch. The client derives it from `nextPunchType === 'IN'` rather than inventing a setting the server does not have. If half days should be restricted — by leave policy, by employment type, or off entirely — that is a settings column and a line in the punch context. |
| P1-4 | **REQ-M-03 says consent acceptance is recorded. Nothing records it, and the retention period it is supposed to state is not enforced.** The consent checkbox is component state that disappears on reload, so the notice reappears every visit. Separately, item 12 above agrees 12 months for photo retention (REQ-L-03), but punch photos are written with no `expires_at` at all, so the purge job never selects them and the period is not kept. | REQ-M-03, REQ-L-03 | **Resolved 14 Aug 2026, both halves (launch plan WS-B); acceptance half re-done after the pre-deploy security gate.** The first resolution recorded acceptance (`consent_acceptances`, `POST /me/consent`) but the record was advisory: `PunchService` never consulted it, so the API would store a photo punch for a user with no acceptance row, and an offline first punch fired the consent POST once and never replayed it. The gate is now server-side, in the punch command: with a living acceptance row the punch proceeds; without one, a punch whose body asserts `consentAccepted: true` records the acceptance **in the same transaction as the punch insert** (idempotent through the partial unique index), and a punch asserting nothing is refused with `CONSENT_REQUIRED`, which the client maps to re-showing the notice. The tick travels in the punch body and in every offline queue entry, so a first punch taken offline carries its acceptance to sync time instead of losing it. Migration 0013 stamps `notice_version` and `retention_months_quoted` onto each acceptance at recording time, so a row can still prove what was promised after the retention setting changes. Retention is enforced: the punch pipeline stamps `files.expires_at` on the photo and its thumbnail from `attendance.photo_retention_months` (calendar months, day-clamped), so the existing purge job selects them; the settings catalogue names the pipeline as the consumer and the notice states the number the server actually enforces. Ticking the box is the recorded act; unticking is not a withdrawal mechanism — if withdrawal is ever wanted, that is a soft delete of the row and a new decision. |
| P1-6 | **Opening two tabs logs the user out of every session.** REQ-B-05's reuse detection is working exactly as specified, and that is the problem: the access token is deliberately held in memory only, so every cold document load must call `/auth/refresh`. Two documents booting at once — two tabs, a restored window, a quick double reload — send the same refresh cookie twice. Verified against the running API: of two concurrent refreshes one returns 200 and the other `REFRESH_TOKEN_REUSED`, and the family is then revoked, so the tab that *succeeded* is also dead at its next refresh. | REQ-B-05 | **Nothing changed.** Reuse detection is a security control and quietly softening it to stop a symptom is not a call to make without you. The standard fix is a short rotation tolerance: for a few seconds after a token is rotated, accept the previous one and return the same replacement instead of treating it as theft — genuine theft replays are separated from the legitimate races by minutes, not seconds, so the detection still does its job. The alternative, serialising refresh across tabs with a Web Lock, is client-side only and does nothing for a browser restart. Recommend the tolerance window, with the length as your call; 10 seconds is typical. **RESOLVED 16 Aug 2026, on Virag's instruction.** The window is built and defaults to 10 seconds, set by `AUTH_REFRESH_REPLAY_TOLERANCE_SECONDS`; 0 disables it. A repeat of the same token inside the window returns the *same* replacement from a short-lived Redis entry keyed by the token's hash -- not a second one, which would leave the two tabs holding different tokens and merely move the race. Nothing is minted, no session row is added, and the family is not touched. Outside the window every path is byte-for-byte what it was: the check sits ahead of the transaction and `decide` is unchanged. Redis being unreachable fails closed -- the tolerance simply does not apply and strict rotation refuses, so an outage costs a re-login rather than the control. The three existing reuse tests now close the window explicitly before replaying, so they still prove detection, and a new test proves two tabs receive the identical token with nothing revoked. Falsified by disabling the window and watching that test answer 401 REFRESH_TOKEN_REUSED. |
| P1-5 | **`facingMode: { exact: 'user' }` may make the punch screen unusable on a desktop.** Technical design §7 specifies `exact` deliberately, and the reason is sound: without it the browser treats the constraint as a preference and can return the rear camera, which is the one somebody points at a photograph of a colleague. But many desktop and laptop webcams report no `facingMode` at all, and `exact` rejects them outright — the screen then says "This device has no front camera" and blocks the punch. | REQ-D-02 | Left exactly as it is. This is an anti-spoofing control and loosening it to widen device support is not a change to make quietly. It also means the camera path cannot be exercised in a headless browser, because Chrome's synthetic capture device reports no facing mode either — so the capture flow is still unverified end to end. If desktop punching is required, the shape is to keep `exact` on touch devices, where a rear camera actually exists, and fall back to any camera on a device that has only one. **Resolved 14 Aug 2026, by the shape above, after Virag hit the block on a MacBook and the pilot needed a punch it could actually make.** `exact: { user }` is still what is asked for first and is still what a phone gets. Only when it is refused does the code widen, and only on a device that enumerates exactly **one** camera — a phone always enumerates two or more, so it keeps the hard refusal, and a device with one camera has no rear camera to point at a photograph. The count is taken after a permissioned stream exists, because a browser withholds the device list until then; counting first would read one entry on a phone and hand the fallback to exactly the device that must never have it. Four tests pin this, and the one that matters — a two-camera device that cannot name a front camera is still refused — was falsified by weakening the guard to `>= 1` and watching it fail by name. Verified in a headless browser whose synthetic camera reports no facing mode, which is the same shape as the laptop: the punch screen now offers the camera instead of blocking. Consequence worth stating: a laptop with a single rear-only webcam would now be accepted, which on a desk is a camera pointed at the person anyway. Say the word to revert; it is one comparison. |

## Raised during the Phase 2 parallel build

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| P2-1 | ~~**REQ-E-09 unlock has no Admin-only permission key.**~~ **CLOSED 14 Aug 2026** — verified stale by the phase audit. A separate `attendance.unlock` key exists (`packages/shared/src/permissions.ts`); `DELETE /attendance/locks/:id` requires it while `POST` requires `attendance.lock`, and tests assert Admin holds it and HR does not. The label became a control. | REQ-E-09 | — |
| P2-2 | **Four settings are recorded and audited but nothing reads them.** REQ-L-02 lists geofence behaviour, regularization limits and escalation days; REQ-L-03 lists photo retention. The punch path hard-blocks on the geofence directly instead of consulting the setting, and `files.expires_at` is never stamped for punch photos, so retention is unenforced (this is the same gap as P1-4). | REQ-L-02, REQ-L-03 | The settings screen prints, under each field, whether anything reads it — "In force now. Read by: Day engine" or "Saved and audited, but nothing reads it yet". Four switches that silently do nothing would be worse than none at all. **The photo-retention half is resolved with P1-4 (14 Aug 2026): the punch pipeline now reads `attendance.photo_retention_months` and the screen says so.** The geofence-behaviour, regularization and escalation settings remain read by nothing, and the screen still says so. |
| P2-3 | ~~**Roles are read-only; `PATCH /roles` does not exist.**~~ **PARTLY CLOSED 14 Aug 2026** — verified stale by the phase audit. `GET/POST/PATCH /roles` all exist behind `roles.manage`, audited, with a full web editor (`role-editor-sheet.tsx`), and the last-holder-of-`roles.manage` invariant is enforced on both strip paths inside a locking transaction. ~~**Still open, and it matters:** a role cannot be *assigned* to a user through the product.~~ **CLOSED 16 Aug 2026** — the assignment half was itself stale within hours of being written: `31f855f` (14 Aug, in `v1.0.0-attendance`) added `/employees/:id/access` with grant and revoke through `RbacAdminService`, plus the "Access and roles" section on the employee record. Verified live during Phase 6a against the running stack: grant, multi-role union (D-15), idempotent regrant, unknown-role 404, revoke restoring the original set, audit rows for both writes, and the section rendering — 15 checks and 29 API tests. REQ-B-07's acceptance is exercisable end to end. | REQ-B-07 | — |
| P2-4 | **Excel export needs a spreadsheet library and CLAUDE.md forbids adding a dependency without asking.** | REQ-J-03 | CSV, written behind an interface so XLSX drops in without touching call sites. REQ-J-03 asks for a formatted workbook — frozen header, column widths, a filter header block — and CSV carries none of that. Say the word and `exceljs` goes in. |
| P2-6 | **REQ-C-03 names four levels for a weekly-off pattern and only two are modelled.** Employee level (`employees.weekly_off_pattern_id`) and organisation level (a settings key) exist. Location and department levels have no storage anywhere — not on the writing side, and the day engine's repository reached the same conclusion from the reading side. | REQ-C-03 | Two levels, and no storage invented for the other two. `/weekly-off-patterns` is master CRUD; a pattern is attached per employee or per organisation. If a location or a department needs its own pattern — a plant that works alternate Saturdays while head office does not — that is a nullable column on each of those two tables plus a resolution order in the day engine. Straightforward, but it changes how the engine decides, so it waits for you. |
| P2-5 | **`PATCH /settings` where technical design 6 says `PUT`.** Absent groups mean unchanged, which is PATCH semantics, and every other update endpoint in this API is PATCH. | REQ-L-01 | PATCH. Flagged rather than silently diverging from the design document. |

## The leave / approvals join — DONE, 15 Aug 2026

Kept for the record because the reasoning still applies to the next slice that
joins the framework.

Leave landed in `a15a9e7`; regularization and on-duty in `565d594`. Both took
the shape this note predicted: a subject-handler registry mirroring
`JobRegistry`, each slice registering itself on init, the framework never
importing the slice. Raise and handle landed together in one change, for the
reason below.

**What the note got right.** Raising without a handler is the dangerous half:
the inbox would mark a request approved while the ledger and the balance
recorded nothing, with no error anywhere. A guard without a handler is the
inert half, and it broke ten tests when tried alone.

**What the note did not anticipate.** Routing a second subject type into one
inbox needed the decision guard to change. `APPROVAL_ACT_KEYS` was
`leave.approve.team|all`; leaving it there would have silently made every leave
approver a correction approver, and `regularization.approve` decide nothing. A
handler now declares `actPermissions`, checked in `decideWithin` -- the one
place the single and bulk paths both pass through. The widened route guard is
tested from the exploitable side: a holder of `regularization.approve` alone who
is also the requester's reporting manager, and therefore genuinely on the step,
is refused on a leave request. With the narrowing deleted that test answers 201
and the balance moves.

**Still open: REQ-G-10's second join.** Cancelling on or after the start date
still needs an approver key rather than raising an approval request. It changes
who may cancel and creates a second approval per request, which is a leave
policy decision -- CLAUDE.md §7 territory, not to be guessed at.

## Raised during guided tour and Updates design

Design only — nothing built. Full design in
[`06-guided-tour-and-updates.md`](06-guided-tour-and-updates.md). No REQ ID
exists for either surface; neither appears in the PRD or in
`03-scope-and-delivery-plan.md`, which is question G-6 below.

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| G-1 | **Does the tour auto-start on first sign-in, or offer itself and wait?** | Nothing — design only | **Offer.** A single popover on the avatar with "Not now" and "Start". The same account type is used by a shop-floor employee who opens Punch and closes the tab; taking over their first sign-in to explain a Reports menu they cannot open is hostile. Say the word if it should seize the screen instead. |
| G-2 | **One permission-filtered tour, or a distinct tour per role?** | Nothing | **One registry, permission-filtered** on the same `PermissionKey` set the sidebar and the Go To palette already filter on. It cannot disagree with the navigation, and a new role needs no new tour. Separate tours per role means three lists that drift apart. |
| G-3 | **Does "tour seen" and "changelog read" live per device or per user?** | Nothing | **Per device — `localStorage` via `zustand/persist`**, keyed `vyuha.guide`, exactly like `nav-preferences-store`. Cost of being wrong: the tour offers itself again on a second browser. Server-side is one `user_preferences` row and one endpoint away and the store is the only seam, but it is not needed to ship. |
| G-4 | **Is `/updates` acceptable as an off-sidebar route?** PRD §6.1 fixes the sidebar to Work, Records, Reports and Setup, and a changelog belongs to none of them. | REQ-N-01 adjacency | **Yes — the same treatment `/profile` already takes.** Added to `OFF_NAV_LABELS` in `lib/nav.ts` so the breadcrumb can name it, never added to `NAV_GROUPS`, reached from the account menu. Recorded here rather than editing PRD §6.1 unasked. |
| G-5 | **Does a release note ever need to interrupt?** A breaking change or a policy change may warrant more than a dot. | Nothing | **No interruption of any kind.** An unread dot on the avatar, cleared by opening `/updates`. No sign-in modal, no toast — it is the most resented pattern in operations software and these users open the app several times a day. If a "must read before continuing" tier is wanted, that is a different design and should be said before this is built. |
| G-6 | **Which phase does this belong to?** Neither surface appears anywhere in `03-scope-and-delivery-plan.md`. | Nothing | **Phase 5 (polish and hardening)** for the Guide — a tour that describes screens is worth writing once the screens have stopped moving. The `data-guide` attributes are the exception and are free to add opportunistically from now, since an unused data attribute costs nothing. **Updates has no such dependency and could ship on its own at any point.** |
| G-7 | **Who writes the changelog copy, and at what granularity?** | Nothing | **One entry per shipped change, grouped by release, written by whoever closes the phase**, from the REQ IDs already required in every commit message (CLAUDE.md §4). Entries carry their REQ IDs so a line traces back to the PRD. |
| G-8 | **The `data-guide` attributes are a real coupling and this is the one place the design can rot.** A refactor that drops one makes the step vanish with no error in production. | Nothing — **closed** | **Met, in two layers.** `scripts/check-guide-anchors.mjs` catches a deleted attribute and runs in `pnpm lint`; `guide-anchors.test.tsx` renders the real shell at both widths and asserts each anchor resolves to exactly one element, which is the half the static check cannot do. Both were falsified: a rename fails both, a duplicate passes the static check and fails the render test. Superseded note follows. The anchor surface came out at seven attributes rather than twenty-two, because every screen step points at the one shared `PageHeader`. `apps/web/scripts/check-guide-anchors.mjs` reads the source, asserts each anchor still appears on an element, and runs as part of `pnpm lint`. It catches a deleted attribute. It **cannot** prove exactly one element matches at runtime, which is what the original recommendation asked for — that needs a DOM test runner, and `apps/web` has none. See G-9. |
| G-9 | **`apps/web` had no test runner.** `vitest` was a devDependency of `apps/api` only, so nothing in the web app could be rendered in a test. | Nothing — **answered 13 Aug 2026** | **Approved and added:** `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, all dev-only, plus `vitest.config.mts` and `pnpm test`. Two consequences worth knowing. First, `attendance-analysis.test.ts` had hand-rolled its own runner *because* there was none, and said so in its header; it now delegates to vitest with all 25 assertions untouched. Second, the web app can now satisfy the "unit tests for domain logic" line in CLAUDE.md §4, which it previously could not. 52 tests pass. |

## Raised during WS-A (deployment rail)

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| WS-A-1 | **Sentry is deferred: `@sentry/node` needs your word.** Technical design §17 asks for error tracking and `SENTRY_DSN` has been a validated env slot since Phase 0, but no SDK is installed — CLAUDE.md §6 forbids adding a dependency unasked, and launch-plan §2 row 13 is unanswered. | Nothing hard — errors are in the structured logs (`docker compose logs api`), reachable per the runbook | **Deferred, recorded here per the launch plan.** When approved, the wiring is small and the slot already exists: install `@sentry/node`, initialise it in `main.ts` behind `if (env.SENTRY_DSN !== undefined)`, and production starts reporting with no schema or config change. Until then `.env.production.example` documents the slot as inert. |
| WS-A-2 | **The nightly dump lands on the VPS disk; off-site is an operator step.** Technical design §17 says "nightly pg_dump to off-site object storage". `docker/backup.sh` writes and verifies the dump and prunes old ones, and the runbook instructs copying it off the box in the same cron (rclone/rsync) — but nothing in this repo performs the copy, because the off-site target (R2 bucket? another box?) does not exist to point at yet. | NFR-08's off-site half | Dump + rehearsed restore are done and scripted (restore rehearsed against a live-data dump, row counts diffed table by table). Decide the off-site target and it is one rclone line in the same crontab; an R2 `vyuha-backups` bucket is the obvious choice if row 7's credentials arrive. |

## Raised while building the integrations read endpoint

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| I-1 | ~~**How long is a Tally heartbeat allowed to go missing before the connection is called stale?**~~ **CLOSED 16 Aug 2026, by Phase 6b.** The Phase 0 default was 15 minutes, recorded here as a default rather than an answer. REQ-Q-04 turned out to already hold the answer: five minutes is when a missing heartbeat alerts, and Phase 6b's lease takeover uses the same threshold for the same reason — "when do we stop believing the agent is alive" must have one answer, or a lease can change hands while the screen still calls the connection healthy. `STALE_AFTER_MINUTES` now derives from the shared `AGENT_LEASE_TAKEOVER_MINUTES`, so the two cannot drift apart again; the endpoint still returns the number it judged by. | — | — |
| I-2 | **`GET /integrations` derives the status rather than returning the stored column.** A connection with no `last_heartbeat_at` is reported `DISCONNECTED` whatever `status` says, and a stored `ERROR` survives going quiet. | Nothing | The column is written by whatever last talked to the connection and a row can outlive the truth of it — a restored backup, or a `CONNECTED` written before an agent was ever installed, would have the screen report a healthy Tally link that does not exist. The heartbeat is the fact; the column is a claim about it. Say the word if the column should be authoritative instead; it is one function. |

## Raised during WS-D (data load and onboarding)

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| WS-D-1 | **The seeded administrator had no employee record, so the two employee-scoped screens were dead on every fresh database.** REQ-B-02 keeps the login and the person as separate rows joined 1:1, and the seed created both and joined neither: `users.employee_id` was null on `admin@vyuha.local`. `/punch` answered "this sign-in is not linked to an employee record", and `GET /leave/balances?year=2026` answered 400 "This account has no employee record, so it has no leave of its own". Both are correct behaviour for an unlinked login, and both are the first screens a pilot administrator opens. | REQ-B-02, REQ-D-01, REQ-G-04 | **Resolved 14 Aug 2026.** The seed joins the administrator's login to VY-0001 — the root of the seeded reporting tree and head of Administration, so the login's team scope is the whole organisation. Joined to somebody the seed already created rather than given an employee row of its own: a dedicated row would put a twenty-sixth body into the headcount, the muster and every export, which is invented data on a path that runs (CLAUDE.md §6), while this writes one foreign key between two rows that already existed and invents nothing. REQ-A-03's twenty-five is unchanged. The join fills a null and never repoints one, so a re-seed cannot drag a moved link back. **Still your call:** VY-0001 is a fabricated person, so on production the pilot administrator's login must be pointed at their own roster row — that is now an explicit step in launch plan §WS-D and a box in the §WS-E checklist. Say the word if a pilot administrator should instead hold a login that is deliberately *not* an employee and never punches; the seed would then be left as it is and the launch-plan step becomes "confirm it is unlinked". |
| WS-D-2 | **CI's browser job could not fail, so WS-D-1 above sat in `main` unreported.** Two independent defects in `.github/workflows/ci.yml`, both silent. (1) The `Drive the app` step piped `verify-ui.mjs` into `tee`; GitHub's default shell for a `run:` block is `bash -e {0}` with **no** `pipefail`, so the step reported `tee`'s exit code and the script's `process.exit(1)` was discarded — the job reported success whatever the browser found. (2) The step that reads the once-printed seed password matched `^ +[A-Za-z0-9_-]{20,}$`, and `-` is inside that class, so it also matched the 63-dash separator the seed prints *above* the password; `head -1` took the separator, meaning CI had been signing in with a row of dashes and failing nearly every check, invisibly, for as long as the job has existed. | The delivery plan's "red CI blocks merge" | **Both fixed 14 Aug 2026.** `shell: bash` on the driving step (which is `bash --noprofile --norc -eo pipefail {0}`), verified locally: `bash -e -c 'exit 1 \| tee /dev/null'` exits 0, the same under `-eo pipefail` exits 1. Pipefail is set on that one step rather than as a workflow default, because the seed step ends in a `grep` that legitimately finds nothing on a re-seeded database and pipefail would abort it before the message explaining that. The password match now requires one alphanumeric character, which rejects the separator and nothing else. **Expect the browser job to be able to go red from now on** — that is the point, and any failure it reports on the next run is real rather than new. |

## Raised while making notifications visible (REQ-K-02 … K-05)

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| K-1 | **What counts as a "low leave balance"?** REQ-K-03 lists the event and REQ-G-08 talks about negative balances, but no number anywhere says when somebody should be told their balance is running out. | REQ-K-03 | **Two days, and only on the crossing** — the approval that takes a balance from at-or-above two days to below it. `LOW_LEAVE_BALANCE_DAYS` in `leave-balance-warning.ts`, a constant with this note against it rather than a settings row the Settings screen does not show. Firing whenever a balance is merely low would send the same warning on every subsequent approval, and the crossing test is also what keeps Leave Without Pay quiet — it opens at zero and every approval takes it further negative, so it can never have been above the line. Say the word for a different number, or for it to become a per-leave-type field, which is where it would naturally live. |
| K-2 | ~~**REQ-K-05's white-on-red badge failed WCAG AA on the dark theme.**~~ **CLOSED 14 Aug 2026, in the same change.** Measured in the browser, not assumed: white on the dark theme's `--destructive` is **2.89:1**, under the 4.5:1 NFR-07 asks for. The cause is that `--destructive` is deliberately lifted on dark so destructive *text* stays legible against a dark surface — correct for ink, wrong for a filled shape carrying white text. A `--destructive-solid` token now holds the light red in both themes and measures **4.77:1**, so REQ-K-05's literal instruction and NFR-07 are both true. The probe asserts the ratio in both themes rather than trusting the token. | — | — |
| K-3 | **`REGULARIZATION_DECIDED` is the one REQ-K-03 event still unfired.** A template exists and `NOTIFICATION_EVENT_ROUTES` names its destination, but nothing emits it: the regularization slice — service, endpoints, screen — is being built separately and did not exist when this was written. | REQ-K-03, REQ-F-05 | **Parked deliberately rather than fired from a seam this slice owns.** The two places it could have gone are the approvals framework's decision path and the regularization service's own. Firing it from the framework would put subject-type knowledge into the one file REQ-I-01 exists to keep generic, and would collide with the slice being built beside it — two emits for one decision, and the reader gets told twice. One line in the regularization service's decide path closes it: `emit({ type: NOTIFICATION_EVENTS.REGULARIZATION_DECIDED, audience: { kind: 'employees', employeeIds: [request.employeeId] }, payload: { date, outcome } })`. Everything else it needs — template, default channels, preference row, destination — is already in place and already appears on the preferences screen. |
| K-4 | **Eight of the thirteen notification destinations named routes this app has never rendered**, and nothing noticed because until the bell existed there was no way to click one. `/leave/{id}`, `/attendance/periods`, `/punch-audit/{id}` and `/approvals/{id}` would all have landed on the not-found placeholder. | Nothing — **closed** | **Fixed and guarded.** Destinations moved to `NOTIFICATION_EVENT_ROUTES` in the shared contract, pointed at routes that exist, and `apps/web/src/features/notifications/notification-routes.test.ts` reads the real router and fails if any of them stops resolving. Falsified: reverting `period.locked` to `/attendance/periods` fails the test by name. Two of them are honest downgrades worth knowing about — a flagged punch opens the approvals inbox because PRD §5 screen 9 (Punch Audit) has no route yet, and a regularization decision opens the attendance timeline for the same reason. Both become detail links the day those screens ship. |
## Raised while building the orphaned screens (REQ-G-11, G-12, H-03, A-06)

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| OS-1 | **REQ-G-12's concurrent-absence threshold cannot be set through the product.** `GET /leave/calendar` reads `leave.concurrent_absence_threshold` from the settings table and defaults it to **0**, and 0 means no day is ever flagged. The settings catalogue (`apps/api/src/platform/settings/settings.catalogue.ts`) contains only the `attendance` group; there is no `leave` group, so `PATCH /settings` cannot write this key and no screen can. The Team leave calendar is therefore shipping with its warning permanently silent on any database where nobody has run an INSERT by hand. Verified both ways on a live stack: with the row absent the endpoint answers `threshold 0, warnings []` for a month with three people in one department away on the same day; with `'2'` inserted directly it answers the warning, and the screen renders it. | REQ-G-12's second half | **Nothing invented.** The calendar states the truth rather than implying the feature is on: with no threshold set, the section note reads "No concurrent-absence threshold is set, so no day is flagged." Adding it is a `leave` settings group — one entry in the catalogue, one Zod group in the shared settings contract, one card on the Settings screen — which is a settings-screen change and was left alone deliberately while other work is in flight there. The same gap applies to `leave.comp_off_expiry_days` (REQ-G-11 calls the 30 days "configurable") and `leave.year_start_month` (REQ-G-04 calls the start month configurable): all three are read by the service, none is writable. Say the word and the three land together. |
| OS-2 | **PRD §6.1's Work group now lists six items, not five.** REQ-G-12 has no screen in the §5 inventory and no home in the §6.1 navigation, but a month view of who is away has to be reachable from somewhere. `/team-leave` was added to the Work group after Approvals, gated on `leave.approve.team` — the same key Approvals takes, because the screen exists to be read before a decision. | Nothing — already built | **Added rather than left unreachable.** Recorded here rather than editing PRD §6.1 unasked, the same treatment P0-8 gave the phone's bottom bar. Confirm it and I will fold both the route and a screen-inventory row into the PRD. The three other surfaces in this slice needed no new route: comp-off and restricted-holiday election are bands on My Leave (screen 5), balance adjustment is a sheet on Leave Types & Balances (screen 12, whose title already promised it), and the employee import is a sheet on Employees (screen 10, whose entry already says "list, detail, import"). |
| OS-3 | **REQ-H-02's calendar-to-location link has no write path.** An employee inherits a holiday calendar from `locations.holiday_calendar_id` (or an override on `employees.holiday_calendar_id`), and neither column is writable through any endpoint or screen — `createLocationSchema` and the location sheet do not carry it. So a freshly seeded organisation can create a calendar, mark holidays restricted and set an allowance, and every employee's restricted-holiday pool is still empty, because nothing points at the calendar. Found while verifying REQ-H-03: the pool answered `allowance 0, options []` until the column was set with SQL. | REQ-H-02, and REQ-H-03 in practice | **Not built, because it is a masters change on a screen another slice may be holding.** The employee picker and the location sheet are the two places it belongs, and the shape is one nullable column added to each write schema plus a calendar picker on each form. Until then the restricted-holiday band says exactly which of the three states it is in — no calendar attached, calendar with no allowance, or allowance with no restricted days listed — so nobody is left staring at a blank list wondering which. |
| OS-4 | **The five REQ-G-02 seed leave types are a constant nothing calls.** `apps/api/src/modules/attendance/leave/leave-seed-types.ts` exports `SEED_LEAVE_TYPES` with its placeholder values, and the only other reference in the repository is its own test: `seed/run-seed.ts` never inserts them. A fresh database therefore has zero leave types, so nobody can apply for leave, no balance can exist, and comp-off refuses with "No leave type with the code CO exists" — REQ-G-11's grant is unreachable until somebody creates the type by hand. | REQ-G-02, and REQ-G-11 on a fresh database | **Not changed, because seed content is a data decision.** Every number on those five types is a placeholder standing in for OPEN-QUESTIONS item 4, and inserting them makes placeholders look like policy on any database somebody seeds. Two ways out: seed them as they are, clearly labelled by the `placeholderNote` they already carry, or leave the seed alone and make it an explicit step in the launch plan alongside the holiday calendar. Recommend seeding them — REQ-G-02 says "seed types", and a pilot that cannot apply for leave until somebody invents five records by hand is worse than a placeholder somebody edits. |

| G-10 | **Header shortcut chips moved into tooltips, which softens PRD §6.4.** §6.4 says "every control with a shortcut renders a small hint chip showing the key", and `shortcut-hint.tsx` calls a missing chip a review failure. The header was carrying up to eight chips permanently in a 56px bar — the calculator alone rendered "Ctrl N or Alt N", five chips beside a 20px icon, making it the widest control in the row at 154px. | Nothing — flagging a deliberate departure | **Moved, not removed.** Each header control now shows its name and its key in a hover tooltip it owns. Both keys still appear for a browser-reserved one, and the key stays discoverable three ways: on hover, in the `Ctrl+F1` sheet which lists every active shortcut, and in the guided tour. Measured: the header actions row went from 377px to 255px and the calculator from 154px to 32px. **What this does cost is a touch device**, where there is no hover — but the chips were already hidden below `sm`, so nothing regressed there; it is the desktop that changed. Say the word and the chips come back on the two controls that matter most. |

## Carried from `05-decisions.md` — still open

| # | Question | Needed by | Recommended default in use |
|---|---|---|---|
| 1 | Office Maps link / coordinates for the 100 m geofence centre | Phase 1 | None. Geofence centre is a `locations` column and stays null; punch geofencing cannot be enabled until supplied. |
| 2 | General shift timings — in, out, break | Phase 1 | None. Seeded as a placeholder General shift, clearly marked, not to reach production. |
| 3 | Office IP address(es) for the web punch allowlist | Phase 1 | None. `locations.ip_allowlist` stays empty; web punch is blocked until populated. |
| 4 | Leave types: entitlement, carry-forward cap, negative limit, notice days, half-day allowed, document required after N days | Phase 2 | The five seed types from REQ-G-02 with placeholder values. |
| 5 | This year's holiday list | Phase 2 | Empty calendar. REQ-H-01 says no dates ship assumed. |
| 6 | Who runs payroll, in what format, and the exact columns they need | Phase 3 | REQ-J-04's column set as v1, to be signed off before the contract locks. |
| 7 | Attendance cycle — calendar month, or a cutoff like 26th–25th | Phase 3 | Calendar month. |
| 8 | Do all employees have a work email address? | Phase 0 | Assuming yes. REQ-B-02 already allows an employee record without a login, so a no answer does not require a schema change — only another invite route. |
| 9 | NestJS or Fastify | Phase 0 | **Answered 12 Aug 2026: NestJS on the Express adapter.** Fastify is dropped at your instruction. It is also the lower-risk choice for REQ-D-02: punch photos arrive as multipart, and `@nestjs/platform-express` uses multer, which is far better trodden than `@fastify/multipart`. Throughput is irrelevant at 2,000 punches a day. |
| 10 | Hosting and file storage | Phase 0 | **Answered 12 Aug 2026: Hostinger VPS.** Docker Compose behind Caddy, as in technical design §17. Object storage is still open — see P0-4 below, since Hostinger has no S3-compatible service. |
| 11 | Brand colour, logo, typeface | Phase 0 | shadcn default theme tokens until supplied. |
| 12 | Photo retention period | Phase 1 | 12 months (REQ-L-03). |
| 13 | Consequence rules — does 3 lates equal a half day? | Phase 1 | No such rule. Lates are counted and reported; no automatic deduction. Inventing one would be a policy decision, not a technical one. |
| 14 | Regularization limits — days back, count per month | Phase 2 | 7 days back, 3 per month (REQ-F-02). |

---

## P6a-1 — REQ-O-02 and REQ-O-04 cannot both hold as written

**Raised:** 16 August 2026, during Phase 6a.
**Blocks:** nothing — a default is in force and the navigation ships with it.

The attendance sidebar carries **22** destinations today. REQ-O-02 moves eight
of them to Administration (Settings, Roles, Integrations, Audit log, Recycle
bin, Period lock, Downloads, Organisation) and REQ-O-03 moves Approvals to the
top bar. That is nine, leaving **13**. REQ-O-04 caps a module sidebar at
**eleven** and says so as "a hard constraint on future work, not a target".

`11-decisions` D-16 reads "nineteen items ... pulling them out drops the current
sidebar to eleven", so the arithmetic there started from a smaller count than
the sidebar actually has. The requirement is not wrong, but its list is two
destinations short of its own cap.

**Default in force:** Shifts and rosters, Leave types, and Holidays move into
Administration under an "Attendance setup" section, giving **10**. They are
configuration a person visits when a policy changes, not work they do during a
day, which is the same line REQ-O-02 draws — its rationale is "these are
workspace concerns", and a leave type is closer to that than to My leave. It
also leaves headroom, which a cap sitting exactly at its limit does not.

**Reverse it by saying so.** The alternative is to raise REQ-O-04 to 13, which
costs nothing structurally; the cap exists to stop the sidebar becoming the
navigation again, and 13 vs 11 does not decide that. REQ-O-05's Go To does.

---

## P6b-1 — What happens to a price rate that vanishes from Tally? (REQ-R-03, REQ-R-06)

REQ-R-06 says a *master* that disappears is marked `absent_in_tally` and
retained, and parties and stock items now do exactly that on a full re-pull.
Price list entries are not masters and carry no absent flag: a rate whose
(item, price level) pair stops arriving simply stays in the projection at its
last value, forever, with only `last_pulled_at` betraying its age.

**Recommended default:** on the final chunk of a *full* `price_list` pull,
delete entries not touched since the job was created — the same watermark the
absent marking uses. A rate is a derived row nothing references; the schema's
own comment says deleting a projection row is what a re-pull is for, and a
stale rate shown as current is worse than a gap. Incremental pulls would
still never delete.

Not implemented without a decision because it is the one place the sync
engine would hard-delete data on its own initiative.

---

## P6b-2 — Absent marking from an OpsTally `stock.snapshot` (REQ-R-06)

A `stock.snapshot` is the push analogue of a full pull, so its final chunk
*could* mark absentees. It does not: the reference says delivery is
best-effort chronological under failure — chunk 3 can arrive before chunk 1
is retried — so "not touched since the snapshot began" would mark items
whose chunk is merely late. **Default in force:** snapshots upsert only. Mark
absent from the pull path's full re-pull, or once OpsTally sends a snapshot
completion marker. Say the word if a lag-tolerant heuristic is preferred.

## P6b-3 — Price lists and GST rate under OpsTally (REQ-R-02, R-03)

OpsTally's stock payload carries no GST rate and no per-price-level rates
(its `salePrice` already resolves the Standard Price List into one number).
Under this transport `stock_items.gst_rate` stays null and
`price_list_entries` receives nothing; both fill from the pull agent when
its Tally transport lands. Recorded so nobody reads an empty Price lists
screen as a defect.

## P6b-4 — Voucher projection from the retained inbox (Phase 6c)

Vouchers arrive now and are retained in `sync_inbox.payload`. 6c's voucher
writer should replay `sync_inbox WHERE payload IS NOT NULL` oldest-first per
connection, then clear `payload` on success — the deferred index already
exists for that read. Idempotency by voucher GUID as for every projection.

## P6b-5 — Backfill when the source is push-only (REQ-S-01, S-04)

OpsTally emits `voucher.*` only for changes within its lookback (90 days by
default) and offers no on-demand voucher snapshot. A first-time historical
backfill against a copy of the books (REQ-S-04) therefore cannot come
through this door alone. Options for 6c: raise the Agent's lookback for one
baseline pass; a one-off pull-agent run with the XML transport; or an
export/import step. Needs a decision before 6c starts.

## P7-1 — An administrator with no employee record sees no tasks (REQ-V-01, 08 §2.2)

08 §2.2 gives tasks `view.self` and `view.team` only — no `view.all` — and
both breadths are resolved against the caller's employee record. The seeded
`admin@vyuha.local` has none, so it sees an empty task list and any task it
creates is owned by nobody and vanishes from its own view. Contacts and
deals do not have this problem because they carry `view.all`.
Recommended default: add `crm.task.view.all`, held by Admin, so an
administrator can see and reassign every task the way it can every contact.
Until decided, tasks are built exactly to the table as written; the dev
account with an employee record (`info@example.com`) is unaffected.

## P7-2 — Which roles hold the task keys (REQ-V-01) — partly closed 18 Aug 2026

Sales and Sales manager now exist as system roles with the §2.2 keys that
exist. Still open: whether Employee/Operations/HR should hold
`crm.task.view.self` and `crm.task.manage`.

08 §2.2's task rows cover Sales, Sales manager, Purchase, Accounts and
Admin — the four roles that do not exist yet plus Admin. The existing
Employee/Operations/HR roles are not in the table, so an operations
manager cannot be assigned a task today. Recommended default: give
`crm.task.view.self` and `crm.task.manage` to every system role once the
Sales roles land, since REQ-V-02 lets a task hang off an employee and
REQ-V-07 makes tasks a landing screen. Held at Admin only until then.

## P8-1 — Which number the customer sees on a Vyuha-raised invoice (D-38, REQ-AA-11) — closed 18 Aug 2026: Tally's number

A Vyuha-raised invoice carries INV-0001 here and is pushed as a Sales
voucher whose `REFERENCE` is INV-0001; Tally then assigns its own voucher
number, which comes back as `remoteVoucherNumber` and is shown beside the
badge. Recommended default (in use): Vyuha's number is the reference on
the voucher and on the customer's dispatch message; Tally's number is
shown alongside and never printed as the invoice number. Say the word if
Tally's number should be the customer's.

## P8-2 — Should dispatch wait for the pushed invoice to be accepted by Tally? (D-38, REQ-AA-14) — closed 18 Aug 2026: it waits

Confirming a Vyuha-raised invoice advances `invoiced_qty` at once, so a
dispatch may follow while the Sales voucher is still queued or after Tally
rejected it (the invoice then shows FAILED with Tally's words).
Recommended default (in use): dispatch on confirm; the sync badge on the
invoice is the accountant's signal to fix a rejection. The stricter rule —
count `invoiced_qty` only when the push is accepted — is a one-line change
in `InvoiceService.confirm` if you prefer it.

## P8-3 — Credit days (REQ-W-09's overdue half) — blocked on P6b-5 — accepted for go-live 18 Aug 2026

The credit block enforces the limit (D-40). "Overdue bills beyond credit
days" needs bill-wise allocations from Tally. Until then credit days are
shown, not enforced. Confirm this is acceptable for go-live.

## P8-4 — Attendance push shape (D-06, Phase 6e) — closed 18 Aug 2026: attendance is not linked to Tally; 6e dropped

Vouchers (Tally Payroll's Attendance voucher, which needs Payroll enabled
with employee masters and attendance types in the company) or a file
handoff to whoever runs payroll? Everything else in the push path is
built; this is the only reason 6e is not started. Recommended default:
file handoff (less coupling) unless payroll is run inside Tally Payroll.

## P8-5 — Who picks and packs: which key does the warehouse hold? (REQ-AA-06, D-26)

The pick queue and Pack sit behind `sales.document.view.*` (to see) and
`sales.document.create` (to pack), because 08 §2.2 names no warehouse
role and no fulfilment key. A salesperson therefore sees only their own
orders on the queue; a warehouse person needs a role holding
`sales.document.view.all` + `sales.document.create` — which also lets them
raise orders. Recommended default until you say otherwise: an Admin-made
"Warehouse" role with exactly those two keys (roles are editable, REQ-B-07).
The cleaner shape, if picking is a separate job, is a `sales.fulfil` key
held by Warehouse, Sales and Sales manager, with Pack, Dispatch and the
queue behind it and `create` no longer implying them — a one-line seam
change per route, plus a matrix row.

## P14-1 — Doc 14's open decisions reuse numbers 11 already assigned (docs 11, 14)

`14-analytics-and-reports.md` §12 numbers its open decisions D-34…D-39,
but `11-decisions-phase-6-8.md` — the stated authority — already assigned
D-34 (fulfilment wording) through D-45 (the printed page). Two different
decisions both named "D-35" will eventually be cited into a wrong build.
Recommended default, in use now: read doc 14's six as **D14-1…D14-6** in
that order (batches, cost, lapse thresholds, margin visibility, push vs
pull, usage retention); renumber them in doc 14 at the next edit. Code
and commits cite the D14-x names.

## P14-2 — REQ-AG-02's thresholds (doc 14 §12 D14-3)

Customer lapse shipped with the doc's recommended default: expected gap =
the customer's own median gap between Sales vouchers, at-risk past one
gap, lapsed past two, three sales minimum. Not yet configurable; say the
word if the multiplier or the minimum should be a setting.

## P-HELP-1 — A support answer panel has no REQ ID anywhere (proposed REQ-AJ-01…05)

Owner, 22 Aug 2026: "add a chatbot in header for support". Built, but not as
a chatbot and not in the header — the reasoning is worth recording because
three parts of it are decisions, not implementation details.

**It answers, it does not converse.** The corpus is written as answer cards
of one to three sentences, so nothing has to summarise them at read time and
the panel can be deterministic. That removes an LLM, and with it: the first
outbound HTTP call this API would ever make, the prompt-injection surface
through `sales_documents.last_error` (Tally-authored text, echoed verbatim,
created outside our validation because masters are Tally-owned per REQ-R-04),
a new class of employee free text leaving the box with none of the consent
machinery `0012_consent_acceptances` and `0013_consent_promises` exist to
provide, and an eval harness for a non-deterministic feature in a codebase
whose Definition of Done assumes assertions.

**The corpus is API-side, never in the web bundle.** `docker/Caddyfile` serves
the SPA from `handle { root * /srv }` with no auth directive; only `/api/*` is
proxied to the guarded API. A corpus shipped in the bundle would be readable
by anyone who resolves the domain, and these cards name which controls are
switched off. So `help.cards.ts` lives in `apps/api` and reaches the client
only through an authenticated, permission-filtered endpoint.

**It sits on Ctrl+F1, not on a new key or a new header control.** PRD §6.4
calls that key "contextual help / shortcut sheet" and the table has no free
slot — `docs/06` §3 records the Guide refusing to invent one for the same
reason. The header already renders four controls and P-22 spent a pass
removing chrome from it.

Three things to confirm:

1. **REQ IDs.** `AJ` is the next free prefix; nothing is written into
   `01-product-requirements.md` yet. Proposed: AJ-01 the panel, AJ-02 the
   card catalogue, AJ-03 permission filtering, AJ-04 the error-code hook,
   AJ-05 the unanswered-question path.
2. **The unanswered-question path is not built.** On a miss the panel says so
   and offers the nearest cards. Recording the miss would give the usage
   signal `07-launch-plan.md` §0a says does not exist yet — but it stores
   employee free text, so it needs an explicit "send this to your
   administrator" action rather than silent logging, plus a table and a
   notification. Say the word and it is one increment.
3. **Who writes new cards.** Same answer as G-7 for the changelog — whoever
   closes the phase. The risk is the one `changelog.test.ts` already
   demonstrates: it passes 13/13 over a changelog stale at v0.9.0 while this
   branch sits 97 commits ahead, because the guard catches deletion and not
   divergence. `help.cards.test.ts` therefore asserts route and permission
   references resolve, which catches a card pointing at a screen that was
   renamed or a key that was deleted — the A-01 failure mode, where
   `regularization.raise` left the catalogue entirely.

## Legal pages (22 Aug 2026, owner's request: terms and privacy, accepted by signing in)

`/legal/terms` and `/legal/privacy` exist and are linked from the consent line under Sign in and Set password. The wording in `apps/web/src/features/legal/legal-content.ts` is a working draft written from what the product records and does; it has **not been reviewed by counsel**. Three things only the owner can supply, and the draft says "ask your administrator" in their place until they arrive:

1. The operator's legal entity name and registered address (governs the jurisdiction clause).
2. The grievance officer's name and contact, which the Digital Personal Data Protection Act, 2023 expects a data fiduciary's processor to publish.
3. Whether the photo retention and recycle-bin windows stated match what each organisation configures (the draft states the defaults: twelve months, and "a set window").

Recommended default: keep the draft live (it is accurate about the product) and have counsel review before the first external organisation signs in.

## Two-step sign-in (REQ-B-09, 22 Aug 2026)

Built as the owner decided. Two things to know before it meets real users:

1. **A correct code is accepted again within its window.** The server validates a code one step either side of now and does not remember the last step it accepted, so the same six digits work twice inside ninety seconds. Closing it is one column on `users` (`totp_last_step`) and one comparison; recommended before Tally goes live, not needed for a pilot.
2. **No SMS or email fallback.** The owner chose an authenticator app; a lost phone is answered by the ten recovery codes and the Admin reset. If a fallback is ever wanted, the challenge table already carries what a second method would need.

Recommended default: ship as is; add the last-step column in the next auth increment.

## Audit-trail retention (22 Aug 2026, from the appearance brief's "data retention: exports and audit trail")

Not built, on purpose. `audit_logs` carries the `vyuha_forbid_mutation` trigger: the database refuses UPDATE and DELETE on the trail, which is the product's tamper-evidence guarantee (a purge attempt in the test suite was refused by it). A retention policy that deleted trail entries would need that guarantee loosened -- a SECURITY DEFINER path the trigger lets through -- and that is a decision about what the trail promises, for the owner and counsel, not a setting.

Recommended default: keep the trail append-only; if storage ever matters, add "archive older than N months to cold storage and keep a hash chain" rather than deletion. Export retention (the download tray) is a setting and is built.

## REQ-AJ-02 — bill allocations are not yet pulled from Tally (22 Aug 2026)

`bill_allocations` (migration 0051) is the projection the ageing, statement and payment-behaviour reports read, and the one a promise-to-pay's kept / partially kept / broken state must be derived from ("receipts pulled from Tally against the named bills"). Today only the demo seed fills it: `SyncWriterService` has no allocation writer and the agent results contract carries no allocation rows. Until the agent sends them, a promise in production can never be seen as kept.

**Recommended default:** extend the agent results contract with an entity type `bill_allocation` (voucher reference, party, bill name, ref type new / against / advance / on_account, bill date, due date, signed amount) written by `SyncWriterService` beside the voucher; the agent is outbound-only, so this is a change on the agent as well. Area AJ is built against the projection as it stands, so it lights up the day the rows arrive.

## The per-IP login rate limit does not refuse (22 Aug 2026, found merging work-order-aj-ao into phase-6a)

**Not mine, and not caused by the merge** — reproduced on plain `phase-6a`
with the merge absent, in a worktree of its own, with the file run alone so
it was not contention.

`login-rate-limit.test.ts` fails nine ways. The budget is twenty failures
per address per fifteen minutes; the twenty-first attempt should throw
`RATE_LIMITED` and instead returns `no-error`, and the window that should
hold twenty members holds nought. Both the Redis path and the Postgres
fallback are therefore failing to record and failing to refuse.

The likely cause, unconfirmed: `claimAttempt` opens with

    if (this.redis.status !== 'ready') return this.claimViaDb(...)

and an ioredis client is `connecting`/`wait` until it has connected. So a
freshly built client — which is what the test builds, and what the API has
for the first moments after boot and after any reconnect — takes the
Postgres path every time. If that path is the broken one, the limit is off
in exactly the window an attacker would find it off.

It arrived with PR #5's "database fallback for rate limits". The
per-account lockout (five attempts, in Postgres, with an email notice) is
unaffected and still stands, which is what keeps this a serious defect
rather than an emergency.

Also red on `phase-6a` from the same PR, 34 tests across 7 files:
`seed.test.ts` (Employee now holds `regularization.raise`, which the seed's
own expectation was never updated for), `punch`, `regularization`,
`auth.endpoints`, `password-reset-rate-limit` and `fallback-job-runner`.

**Recommended:** fix the limiter before anything ships, and treat the seed
expectation as a one-line update. Not touched here because it is another
developer's in-flight feature and a security control is the wrong place for
a guess.

## Corrections came back in the merge, against a decision in writing (23 Aug 2026) — CLOSED 23 Aug 2026

**Owner's answer: the 21 August decision stands.** Both keys are out of the
catalogue again, Operations no longer holds the approve key, and the slice runs
on the keys `approval-keys.ts` had named for it all along — `punch.self` to
raise, `attendance.edit` to decide — so the feature itself was not thrown away.
Commit `e6caaf3`. The record of the disagreement is kept below.

`docs/05-decisions.md` line 84 and `PENDING.md` row A-01 record that
corrections and on-duty requests were removed as employee-raised features on
21 August, with `regularization.raise` and `regularization.approve` deleted
from the catalogue. Open requests stay decidable in Approvals by whoever may
edit attendance, which is exactly what `packages/shared/src/approval-keys.ts`
still declares:

    regularization: { act: [PERMISSIONS.ATTENDANCE_EDIT], ... }

On 22 August, `46cba6d` ("fix(merge): restore regularization permissions
dropped by phase-6a") read that deletion as a merge accident and put both
keys back into `permissions.ts`, and `3d6ec5d` re-added the feature itself.

The two halves now disagree. Operations holds `regularization.approve` but
the approval catalogue asks for `attendance.edit`, so **16 tests across
`regularization.endpoints.test.ts` and `punch.endpoints.test.ts` fail** with
"You do not hold the permission that decides this kind of request."

Left alone deliberately: reverting would destroy a colleague's in-flight
feature, and keeping it contradicts a decision the repository states in two
places. This is a product call, not a merge repair.

**Recommended default — the 21 August decision stands.** Delete the two keys
from `permissions.ts` again, drop `REGULARIZATION_APPROVE` from the
Operations set, and have an `attendance.edit` holder decide in those tests.
If the feature is wanted back instead, `approval-keys.ts` gets
`REGULARIZATION_APPROVE` in `act` -- and then A-01 and decision 84 need
rewriting, because the repository currently asserts both things at once.

One consequence to note either way: commit `109421a` corrected two role
expectations to include `regularization.raise`, because that is what the
code returns today. If the key is deleted again, those two expectations go
back to three keys.

---

## Raised during Phase 6a — the receivable snapshot (D-23)

Defaults implemented in `receivable-snapshot.service.ts` and the two nightly
handlers. **All three confirmed by the owner, 25 August 2026** — recorded
here rather than guessed at, and now decisions rather than drift.

| # | Question | Blocks | Recommended default in use |
|---|---|---|---|
| D-23-1 | **Billwise parties' opening bills are invisible to the snapshot.** `bill_allocations` hangs off vouchers, so a ledger-master opening bill ref has no `new` row; receipts marked against one sum negative and the group is dropped. The voucher-grain fallback seeds `parties.opening_balance` (D-22 rule 6), but the billwise path has no per-bill date to seed with. | Nothing yet — understates billwise parties whose receivable predates the sync window | **Accept the understatement and keep the dropped groups out**, until the connector projects opening bill refs with their own dates. Netting the party's opening balance against the dropped groups would need a bill date to age by, and inventing one would fabricate ageing. The service comment marks the spot. |
| D-23-2 | **Does the CFO snapshot honour `interest_party_settings.credit_days_override`?** The interest build ages by `override ?? party.credit_days`; the snapshot uses `party.credit_days` alone, so the two modules can disagree on when the same bill went overdue for an overridden party. | Nothing yet — cosmetic divergence between two reports | **No.** The override is an interest-module setting for pricing, not a statement about the bill's real terms, and modules may not read each other's settings. If the owner wants one ageing everywhere, the override moves to the party master and both modules read it there. |
| D-23-3 | **Is the snapshot's day boundary IST, or each organisation's own timezone?** Organisations carry a `timezone` column (default `Asia/Kolkata`) and the attendance sweeps close each org's day in its own zone; both nightly book photographs (D-22, D-23) close the day at IST midnight for every org via `istDateOf`. | Nothing while every org is IST | **Fixed IST**, matching "dates are stored UTC and displayed IST" in the CFO brief. If a non-IST organisation ever onboards, both handlers take the org's timezone from the row they already read, and `istDateOf` becomes `localDateIn(now, org.timezone)` — the seam is one function. |
