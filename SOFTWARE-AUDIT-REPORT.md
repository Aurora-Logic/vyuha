# Vyuha Software Re-audit Report

> **Working-tree follow-up, 5 September:** This report describes commit `7097a125`, not the subsequent uncommitted remediation. A focused follow-up now passes root lint and typecheck and records additional recovery and verification work as F-01–F-08 in [the action plan](SOFTWARE-IMPROVEMENT-ACTION-PLAN.md#follow-up-review--5-september-2026). The full suite/build were not rerun in that follow-up; the score and test totals below remain historical baseline evidence.

> **Later pre-push verification:** The action plan now records 3,338 passing package tests, six passing release-script tests, a passing production build and a fresh lint pass after two integration corrections. Remaining bundle/pg warnings and missing Node 22, browser/load and staging evidence are documented there. This does not replace the historical scorecard below.

**Re-audit date:** 5 September 2026\
**Reviewed commit:** `7097a125eebdde1a7d77962d4ccf444654278d51` (`phase-6a`)\
**Comparison baseline:** `497eda9a`, before the 16 remediation commits\
**Changes reviewed:** 66 files, 1,694 insertions, 180 deletions\
**Previous score:** 5.8/10\
**Current score:** **6.4/10**\
**Release verdict:** **Not yet ready for unrestricted production**

The [4 September audit](docs/audits/SOFTWARE-AUDIT-2026-09-04.md) is preserved for comparison. This report supersedes its current-status claims. References below point to the reviewed commit; line numbers can move after further edits.

## 1. Assessment

The changes materially improve several important paths. New offline punches carry an owner, the agent no longer silently starts against demo data, ordinary request bodies are smaller, scheduling uses an atomic statement, return receipts are locked, replacement orders have a uniqueness constraint, and the deployment workflow now runs checks before deployment and builds before migration.

Verification also improved: **all 3,293 tests pass**, all typechecks pass, and the production build succeeds. The full API suite passed on a new empty database, which removes the historical fixture contamination that affected the previous audit.

The remaining concerns are specific failure cases that the added tests do not cover. Ownerless offline requests are still accepted by the server, uppercase credential routes bypass log redaction, replacement creation still spans two transactions, and sync allocations can be skipped permanently. Two new agent lint errors also prevent the new CI from passing.

The score reflects reduced risk, while retaining deductions for these incomplete fixes. It is an engineering assessment using the same weights as the first audit, not a certification or a measured percentage of product completion.

## 2. Scorecard

| Parameter | Weight | Previous | Current | Reason |
|---|---:|---:|---:|---|
| Product completeness | 10% | 5.0 | 5.0 | Tally now fails safely without explicit fixtures, but the production transport is still absent. |
| Architecture and modularity | 10% | 8.0 | 8.0 | Existing boundaries remain sound; the shared parser and precache helper reduce duplication. |
| Code quality and type safety | 8% | 8.0 | 7.5 | Build/typechecks pass; two new agent lint violations block CI. |
| Correctness and data integrity | 15% | 5.0 | 6.5 | Return locking, numeric report ordering, and pre-write checks improve correctness; transaction and cursor gaps remain. |
| Security and privacy | 15% | 5.5 | 6.5 | Ownership and reset-permission checks help; legacy-client, lifecycle, and redaction gaps prevent closure. |
| UX and responsive design | 8% | 7.5 | 7.5 | Existing responsive strengths remain; legacy-queue recovery and session errors need further work. |
| Accessibility | 5% | 5.0 | 5.0 | Zoom and accessible-name issues are unchanged. |
| Performance, scalability, and PWA | 8% | 5.5 | 6.0 | Smaller atomic precache; full install traffic and large initial chunks remain. |
| Testing and QA | 8% | 5.5 | 7.0 | All package tests pass in this run; new regressions are useful, but E2E, coverage, and failure-path gaps remain. |
| Deployment, rollback, and DR | 8% | 3.5 | 5.5 | Validation jobs and build-before-migrate added; commit pinning, action pinning, health checks, and tested recovery remain absent. |
| Observability and operations | 3% | 5.5 | 5.5 | Handled 5xx capture and durable audit/retry gaps remain. |
| Documentation and compliance | 2% | 3.5 | 4.5 | Forward-only migration documentation is corrected; other deployment/legal drift remains. |
| **Weighted total** | **100%** | **5.8** | **6.4** | Exact current weighted result: 6.435, rounded to one decimal. |

## 3. Verification performed

Build and test commands ran against the reviewed checkout. CPU-heavy suites were run separately to avoid the contention seen in the first audit.

| Check | Result | Details |
|---|---|---|
| Production monorepo build | **Pass** | API, web, shared, and agent compile. Frontend warnings remain. |
| All package typechecks | **Pass** | API, web, shared, and agent. |
| Shared, API, and web lint | **Pass** | API and web were also run independently after root lint stopped. |
| Agent lint / root lint | **Fail** | Two new agent errors; see R-01. |
| Clean database migrations | **Pass** | Applied to a newly created database, including migration 0091. |
| API tests | **2,284/2,284 pass** | 155 files; approximately 296 seconds; empty audit database. |
| Web tests | **921/921 pass** | 114 files; previous timeout tests passed this run. |
| Shared tests | **73/73 pass** | 9 files. |
| Agent tests | **15/15 pass** | 4 files; local HTTP test server enabled. |
| **Combined tests** | **3,293/3,293 pass** | **282 files; no failed or skipped tests reported.** |
| Change whitespace check | **Pass** | `git diff --check 497eda9a..HEAD`. |
| Live npm advisory refresh | **Blocked** | Automatic approval review rejected sending dependency metadata to npm. |
| Lockfile/package comparison | **Unchanged** | Dependency declarations and lockfile match the original audit baseline. |
| GitHub-hosted workflow execution | **Not verified** | Workflow was reviewed locally; a successful Actions run was not observed. |
| Browser/device E2E, load, restore drill | **Not performed** | No new browser E2E or coverage gate exists. |

The original API failures did not recur against the clean database. This establishes that the current suite passes with isolated input data; it does not establish that the persistent development-database harness has been fixed. The harness still shares a database and preserves historical rows.

The temporary database was removed after all its test connections closed. Test JSON and command logs remain in `/tmp/vyuha-reaudit-20260905.fUTnpz/` for this session; this temporary directory is not a permanent CI artifact.

### Dependency status

The last successful advisory query, on 4 September, reported four High and three Moderate advisories: `fast-uri@3.1.5`, `qs@6.15.3`, and `uuid@8.3.2`. Those dependency versions have not changed. A fresh advisory count is **not claimed**.

The earlier reachability qualification still applies: no direct vulnerable `fast-uri` use or attacker-controlled `uuid` buffer usage was established; `qs` is the more plausible server-side exposure. These are dependency findings, not proof of seven exploitable application vulnerabilities.

## 4. Original critical/high finding status

“Partial” means a meaningful part of the original finding was corrected but a relevant failure path remains. It does not mean the change was ineffective.

| ID | Current status | What changed | What remains |
|---|---|---|---|
| C-01 | **Partial** | New queue rows have owners; updated clients filter them; supplied mismatched owners are rejected. | Server owner is optional; old clients remain unsafe. Logout/in-flight snapshots are not identity-bound; legacy rows lack recovery. |
| C-02 | **Safely blocked; capability open** | Missing explicit fixture now exits instead of loading bundled demo data. | No real Tally transport exists. This is an integration release blocker, not a claim that the current default silently corrupts data. |
| H-01 | **Partial** | Lowercase credential paths and query strings are redacted in both logging paths. | Case-sensitive masking misses uppercase routes accepted by Express. |
| H-02 | **Partial** | Ordinary JSON is capped at 1 MB; only the sync prefix receives 15 MB; production and harness share the parser. | Any unauthenticated `/sync/*` request still reaches the large parser before route/auth checks; upstream resource controls are absent from the repository. |
| H-03 | **Partial** | PR checks, frozen installs, and a checks-before-deploy dependency exist. | Mutable action tags, moving branch-tip deployment, no immutable artifact/health gate; lint currently prevents checks from passing. |
| H-04 | **Partial** | Build precedes migration; docs now acknowledge forward-only migrations. | Pre-deploy backup/restore is not enforced or rehearsed; restore example is incomplete. |
| H-05 | **Partial** | Ordinary enqueue rejection releases the idempotency claim. | Crash or failed compensation can strand the claim; no durable outbox/retry record. |
| H-06 | **Named leave/purchase paths fixed; broader pattern remains** | Leave returns success after commit even when notification fails; purchase side effects moved out of the transaction. | Approval settlement can still throw after committing, and swallowed notification failures are not durably retried. |
| H-07 | **Partial** | Schedule advancement plus insertion is atomic; long jobs renew claims. | Completion/retry updates do not check lease ownership after takeover. |
| H-08 | **Partial** | Concurrent receipts are bounded; unique index prevents duplicate live replacement orders. | Replacement order and return counters still commit separately. |
| H-09 | **Partial** | Image metadata failure now attempts object deletion. | Document/upload paths lack the same compensation; failed deletion and feature rollback can still leave orphans. |
| H-10 | **Partial** | Misses are not cached; current upsert names are invalidated. | Old rename keys remain cached; missing bill allocations are skipped while the cursor advances. |
| H-11 | **Original request issue fixed** | API calls have a 30-second abort signal, responses use runtime schemas, remote HTTP is rejected. | Schema semantics and whole-tick shutdown bounds can be hardened; new lint defects are tracked separately. |
| H-12 | **Open** | No change. | Browser zoom remains disabled. |
| H-13 | **Partial** | Atomic critical set reduced to shell/Punch dependency closure. | Every optional route is still fetched and awaited during worker install. |
| H-14 | **Partial** | Direct transient `/auth/me` failures preserve the snapshot. | Expired-token → transient refresh failure still throws the original 401 and clears identity. |

## 5. Remaining findings, in priority order

### R-01 — New agent lint errors block the new CI

**Priority:** Fix before merge/deploy. **Evidence:** Reproduced by the actual lint command.

- [api-client.test.ts:21](apps/agent/src/api-client.test.ts#L21): `reject(init.signal?.reason)` violates `@typescript-eslint/prefer-promise-reject-errors`.
- [api-client.ts:79](apps/agent/src/api-client.ts#L79): the replacement timeout error omits its caught `cause`, violating `preserve-caught-error`.

The new [workflow:56](.github/workflows/ci.yml#L56) runs `pnpm lint` before tests/build and deployment depends on that job. The current revision therefore cannot pass its own configured release gate, even though compilation and tests pass.

**Completion condition:** Fix both errors while preserving the timeout behavior, then rerun agent and root lint.

### R-02 — Offline ownership is still optional at the server boundary

**Priority:** High; shared-device rollout blocker. **Original:** C-01. **Evidence:** Current code and backward-compatible test paths.

The schema declares [`ownerUserId` optional](packages/shared/src/attendance.ts#L209), and [the server checks it only when present](apps/api/src/modules/attendance/punch/punch.service.ts#L229). An already-loaded older client can still submit ownerless queued data. If that browser switches from A to B before draining, the new backend accepts the ownerless punch under B.

Updated clients are materially safer: new rows are stamped and a supplied stranger owner is refused. The remaining problem is the upgrade boundary, where old browser code remains executable.

Logout also leaves the module-global [outbox snapshot and drain promise](apps/web/src/lib/offline/outbox.ts#L69) intact. Queue refresh starts asynchronously on [Punch mount](apps/web/src/features/punch/use-punch-queue.ts#L43). Another account can briefly see stale queue metadata, while an in-flight A batch retried under B can be permanently marked refused. [Dismissal](apps/web/src/lib/offline/outbox.ts#L135) deletes by key without rechecking ownership.

Legacy `owner:null` rows are locked for every user by [partitionQueue](apps/web/src/lib/offline/punch-queue.ts#L184), but [the UI](apps/web/src/features/punch/queue-panel.tsx#L251) says they will send when that person signs in. There is no recovery action for those rows.

**Completion condition:** Require ownership on the server or explicitly reject the old sync protocol; capture and validate identity through each drain; reset snapshots/cancel pending work on identity change; recheck ownership on dismissal; provide a truthful legacy recovery path; test account switching, multiple tabs, and in-flight logout.

**Calibration:** User IDs are globally unique and active user/employee links are effectively immutable in the reviewed flows. Missing a separate org field alone is not established as a current bypass.

### R-03 — Uppercase routes bypass credential redaction

**Priority:** High. **Original:** H-01. **Evidence:** Reproduced with the installed Express router and actual redaction function.

[redact-url.ts:19](apps/api/src/platform/common/redact-url.ts#L19) uses case-sensitive regular expressions. Express routing is case-insensitive by default, and the application does not enable case-sensitive routing.

A synthetic, non-secret probe produced:

```text
Request:    /api/v1/PORTAL/prtl_TEST_ONLY
Matched:    true
Logged URL: /api/v1/PORTAL/prtl_TEST_ONLY
```

The lowercase case is correctly masked, but the accepted uppercase spelling preserves the key. Invitation and reset path names have the same issue. Query-signature removal works.

**Completion condition:** Mask case-insensitively or log canonical route templates; test accepted case variants through both request and exception logging.

### R-04 — Replacement creation can commit without updating its return

**Priority:** High data integrity. **Original:** H-08. **Evidence:** Static transaction boundaries; existing concurrency tests pass.

[orders.create](apps/api/src/modules/sales/returns/return.service.ts#L369) commits the replacement order before [a second transaction](apps/api/src/modules/sales/returns/return.service.ts#L396) writes `replacement_charge` and increments `replaced_qty`.

If the second stage fails, the order exists but the return counters remain stale. A retry is then rejected by the new unique replacement constraint. The uniqueness fix prevents two live replacements, but does not make the complete operation atomic.

**Completion condition:** Use one database transaction for order creation and return updates, or a durable resumable operation. Add failure injection after order creation and before counter updates.

### R-05 — Bill allocations can still be skipped permanently

**Priority:** High financial-data completeness. **Original:** H-10. **Evidence:** Explicit current code behavior.

[replaceBillAllocations](apps/api/src/platform/sync/sync-writer.service.ts#L921) skips rows whose voucher is not present, while [cursor advancement](apps/api/src/platform/sync/sync-writer.service.ts#L149) includes every input row.

If allocation AlterID N arrives before its voucher, cursor N is committed without that allocation. The unchanged voucher arriving later does not cause allocation N to be requested again; recovery depends on another alteration or a manual full pull.

Positive name caches also retain old names after rename: [party invalidation](apps/api/src/platform/sync/sync-writer.service.ts#L594) and [item invalidation](apps/api/src/platform/sync/sync-writer.service.ts#L656) delete the new key only. Negative-cache poisoning is fixed.

**Completion condition:** Persist unresolved allocations for reconciliation or avoid advancing past incomplete facts; invalidate all relevant names on rename; test allocation-before-voucher and rename/reused-name sequences.

### R-06 — Sales approval can still overwrite a concurrent cancellation

**Priority:** High business-state integrity. **Related change:** COM-2. **Evidence:** Static opposing transaction order.

Cancellation now uses a conditional update, protecting the case where approval commits first. But [approval handling](apps/api/src/modules/sales/orders/sales-order.service.ts#L342) reads `PENDING_APPROVAL` and later updates to `CONFIRMED` without a status predicate or a row lock.

The opposite ordering remains possible:

1. Approval reads PENDING.
2. Cancellation commits CANCELLED.
3. Approval's unconditional update writes CONFIRMED.

The added regression test covers approval-before-cancel, not this ordering. [Cancellation and approval-request withdrawal](apps/api/src/modules/sales/orders/sales-order.service.ts#L526) are also separate commits.

**Completion condition:** Use a consistent lock/transaction boundary or conditional status update for both directions, including approval-request state. Test both interleavings.

### R-07 — Notification delivery still has an unrecoverable crash window

**Priority:** Medium-to-high, depending on event importance. **Originals:** H-05, H-06. **Evidence:** Static cross-system failure paths.

The [dispatcher](apps/api/src/platform/notifications/notification.dispatcher.ts#L122) now removes the claim after an ordinary enqueue rejection. This is a real improvement. It still has no durable record of a pending event if the process dies between claim and enqueue, or if [claim deletion also fails](apps/api/src/platform/notifications/notification.dispatcher.ts#L162).

[`emitAfterCommit`](apps/api/src/platform/notifications/notification.dispatcher.ts#L190) prevents false failure responses for the updated leave/purchase paths, but logs and discards enqueue failures without a persistent retry. [Approval settlement](apps/api/src/platform/approvals/approval.service.ts#L374) retains throwable work after its decision transaction.

**Completion condition:** Persist a transactionally written outbox event and use retryable delivery states. Exercise crash/compensation failure and approval-settlement failure, not only successful compensation.

### R-08 — A stale job worker can overwrite its successor

**Priority:** Medium-to-high for multi-instance/long-running jobs. **Original:** H-07. **Evidence:** Static lease failure path.

The atomic schedule claim and renewal timer address the original normal-contention defects. However, [DONE, retry and FAILED updates](apps/api/src/platform/jobs/fallback-job-runner.service.ts#L269) only match job ID.

If A cannot renew for longer than the stale interval, B can reclaim the job. A can later complete and overwrite B's state, because terminal updates do not require the same lease owner or generation.

**Completion condition:** Fence state changes with a lease generation/claim token and require idempotent side effects. Add a takeover test where the original worker finishes late.

### R-09 — File cleanup covers images but not all stored objects

**Priority:** Medium, elevated for sensitive retained documents. **Original:** H-09. **Evidence:** Static lifecycle paths.

Image insert failure now attempts compensation and its test passes. [Document uploads](apps/api/src/platform/files/file.service.ts#L353) and [generated documents](apps/api/src/platform/files/file.service.ts#L413) still put object bytes before an unguarded metadata insert.

[`discardUnreferenced`](apps/api/src/platform/files/file.service.ts#L760) removes rows before best-effort object deletion; a delete outage leaves an object no scheduled row sweep can discover. File storage inside a larger feature transaction can also survive that transaction's rollback.

**Completion condition:** Apply recoverable finalization to every storage path, preserve a cleanup task until deletion succeeds, and reconcile object inventory against metadata.

### R-10 — Deployment does not use the exact validated revision

**Priority:** High release integrity. **Originals:** H-03, H-04. **Evidence:** Current workflow.

The workflow now has meaningful checks, frozen installs and correct build/migration ordering. The [deployment script](.github/workflows/ci.yml#L100) still runs `git pull --ff-only origin main`, not a checkout of the triggering `github.sha` or a verified artifact.

If main advances after a run's checks, that run may fetch a commit whose own checks have not passed. The workspace is rebuilt in place. [Action tags](.github/workflows/ci.yml#L24) remain mutable, including the SSH action receiving the production key.

No automatic pre-migration backup, readiness check, revision verification, rollback, or off-host restore evidence is part of this workflow.

**Completion condition:** Deploy the exact checked SHA/artifact; pin actions to verified commits; validate readiness/revision after activation; implement and rehearse the chosen recovery path.

### R-11 — Large unauthenticated requests still reach the sync parser

**Priority:** Medium availability risk; evaluate with the actual ingress limits. **Original:** H-02. **Evidence:** Current parser and deployment configuration.

[body-parsers.ts:31](apps/api/src/platform/common/body-parsers.ts#L31) grants 15 MB to any raw URL starting with `/api/v1/sync/`, including nonexistent paths. That parsing precedes authentication, HMAC verification, and route-level limits.

Moving ordinary routes to 1 MB reduces exposure. It does not prevent a network client from directing concurrent large requests at the sync prefix. Caddy and compose have no corresponding concurrency/resource controls in the repository.

**Completion condition:** Keep large payload support where required, but enforce request admission/concurrency and resource limits before expensive parsing. Validate the complete ingress path under representative load. This audit did not perform a denial-of-service load test.

### R-12 — Session recovery still loses identity after a transient refresh failure

**Priority:** Medium user-visible reliability. **Original:** H-14. **Evidence:** Reproduced with the actual API client and mocked HTTP responses.

The integrated sequence remains:

```text
GET  /auth/me      -> 401 (expired access token)
POST /auth/refresh -> 503 (temporary outage)
apiRequest throws -> 401 UNAUTHENTICATED
```

[apiRequest](apps/web/src/lib/api/client.ts#L425) falls through to the original response when refresh fails temporarily. [shouldForgetSession](apps/web/src/lib/session/use-session.ts#L160) then treats that 401 as a definitive logout.

Malformed successful refresh JSON also throws outside the direct `/auth/me` catch; a missing token is classified as unauthenticated. Direct 429/5xx `/auth/me` handling is fixed, but the helper-only tests do not cover these integrated sequences.

**Completion condition:** Propagate a temporary refresh failure as temporary, preserve the snapshot, and test the hook/session gate across expired-token and malformed-refresh paths.

### R-13 — Service-worker install still eagerly fetches all optional routes

**Priority:** Medium performance/reliability. **Originals:** H-13, M-14. **Evidence:** Current generated build and worker code.

The new [splitPrecache](apps/web/src/lib/offline/precache-split.ts#L25) correctly includes the entry, Punch and their recursive static imports. No static dependency was missing from the inspected critical set.

| Current build measurement | Result |
|---|---:|
| Critical assets | 14 |
| Critical payload | Approximately 2.21 MB raw / 618 KB gzip |
| Optional assets | 162 |
| Optional payload | Approximately 2.66 MB raw / 1.00 MB gzip |
| Initial HTML-linked preload | Approximately 596 KB gzip |
| Largest `ui` chunk | 883.06 KB minified |
| `app-lib` chunk | 615.17 KB minified |

The [worker install handler](apps/web/src/lib/offline/service-worker.js#L168) still fetches every optional asset concurrently and awaits all attempts. A failed optional file no longer aborts installation, but full-route download/cache cost remains.

**Completion condition:** Fetch nonessential routes on demand or after install in bounded background work. Test emitted assets and worker installation, not just a synthetic bundle graph.

### R-14 — Tally integration remains unavailable

**Priority:** Capability blocker for Tally rollout. **Original:** C-02. **Evidence:** Explicit entry-point behavior.

[main.ts:44](apps/agent/src/main.ts#L44) refuses to start without an explicit fixture. This removes the previous dangerous default. [The real transport](apps/agent/src/transport.ts#L20) still does not exist, and `tallyUrl` remains unused.

**Completion condition:** Implement and test the real Tally transport against representative exports; ensure production cannot be configured accidentally as a fixture demo. An attendance-only release can exclude this capability explicitly.

### R-15 — Browser zoom remains disabled

**Priority:** High accessibility. **Original:** H-12. **Evidence:** Unchanged source.

[Viewport restrictions](apps/web/index.html#L10), [gesture cancellation](apps/web/src/main.tsx#L15), and [CSS touch behavior](apps/web/src/index.css#L633) remain. The source acknowledges the WCAG 1.4.4 issue.

**Completion condition:** Restore browser/text zoom, then verify the camera and primary workflows at enlarged text and narrow viewport widths.

## 6. Other original findings

| ID | Status and current assessment | Evidence |
|---|---|---|
| M-01 | **Open:** commercial draft backups are document-type scoped and can outlive a change of user in the same tab. | [use-draft-backup.ts](apps/web/src/features/documents/use-draft-backup.ts#L27) |
| M-02 | **Open:** realtime retries a present but expired bearer rather than refreshing on 401. | [realtime-provider.tsx](apps/web/src/lib/realtime/realtime-provider.tsx#L81) |
| M-03 | **Open, conditional:** SMTP does not require STARTTLS. Relevant when external SMTP is enabled with `secure=false`. | [smtp-mailer.ts](apps/api/src/platform/mail/smtp-mailer.ts#L41) |
| M-04 | **Open, defense in depth:** Redis briefly stores a usable refresh token. Requires Redis read exposure; default replay window is short. | [session.service.ts](apps/api/src/platform/auth/session.service.ts#L334) |
| M-05 | **Open:** handled unexpected 5xx errors are consumed by the global filter without explicit Sentry capture. | [main.ts](apps/api/src/main.ts#L38), [filter](apps/api/src/platform/common/app-exception.filter.ts#L110) |
| M-06 | **Open:** PDF/Office uploads have content sniffing but no malware scan/quarantine. | [file.service.ts](apps/api/src/platform/files/file.service.ts#L319) |
| M-07 | **Open:** GRN listing fans out complex view queries; no new load evidence. | [purchase-order.service.ts](apps/api/src/modules/purchase/orders/purchase-order.service.ts#L565) |
| M-08 | **Open:** audit writes can fail after business mutations succeed. | [audit.interceptor.ts](apps/api/src/platform/audit/audit.interceptor.ts#L63) |
| M-09 | **Open risk:** inbound OpsTally money still traverses unrestricted JavaScript numbers. No new precision failure was reproduced. | [opstally.ts](packages/shared/src/opstally.ts#L14) |
| M-10 | **Open:** most creation endpoints lack request-level idempotency for ambiguous client retries. | [main.ts](apps/api/src/main.ts#L73) and creation-service review |
| M-11 | **Open:** some forms disable browser validation without providing equivalent schema/error feedback. | [Form](apps/web/src/components/shared/form.tsx#L22), [company sheet](apps/web/src/features/crm/company-sheet.tsx#L92) |
| M-12 | **Open:** password visibility and mobile Go To controls lack reliable accessible names. | [invite-dialog.tsx](apps/web/src/features/employees/invite-dialog.tsx#L318), [app-shell.tsx](apps/web/src/app/layout/app-shell.tsx#L557) |
| M-13 | **Corrected:** missing SelectGroup is withdrawn as a defect. The rendered link-button remains a **Low** semantic mismatch; disabled clicks are blocked. | [sales-order-sheet.tsx](apps/web/src/features/sales/sales-order-sheet.tsx#L439) |
| M-14 | **Open:** initial bundle remains large; Notifications/Updates still have ineffective dynamic imports. | [vite.config.ts](apps/web/vite.config.ts#L144), current build warnings |
| M-15 | **Not remediated:** lockfile unchanged; last verified advisory result is seven, with no fresh scan authorized. | `pnpm-lock.yaml`; dependency comparison |
| M-16 | **Environment isolated for audit, harness still open:** clean-database suite passes; ordinary test config still points to a shared persistent DB. | [vitest.config.mts](apps/api/vitest.config.mts#L7) |
| M-17 | **Open:** new CI runs unit/integration tests, but no browser E2E or coverage threshold exists. | [workflow](.github/workflows/ci.yml#L62), [test design](docs/02-technical-design.md#L524) |
| M-18 | **Open:** concurrent connection-initialization queries still emit the pg deprecation warning. | [db.provider.ts](apps/api/src/platform/db/db.provider.ts#L54) |
| M-19 | **Open:** large services and screens remain; new small helpers are well scoped. | `leave.service.ts`, `punch.service.ts`, `settings-page.tsx` |
| M-20 | **Open:** agent package version `0.0.0` differs from runtime `0.1.0`. | [package](apps/agent/package.json#L3), [agent.ts](apps/agent/src/agent.ts#L231) |
| M-21 | **Partial:** migration claims corrected; older attendance-only deployment/Sentry documentation remains. | [RELEASE.md](docs/RELEASE.md#L98), [DEPLOYMENT.md](docs/DEPLOYMENT.md#L123), [RUNBOOK.md](docs/RUNBOOK.md#L86) |
| M-22 | **Open:** legal copy still describes itself as an unreviewed working draft requiring operator-specific inputs. | [legal-content.ts](apps/web/src/features/legal/legal-content.ts#L6) |
| M-23 | **Accepted product limitations remain:** opening billwise balances and other external-data gaps remain documented. Treat these as limits on report completeness, not newly introduced bugs. | [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md#L532) |
| M-24 | **Open coverage gap:** cross-org sweep is mainly discoverable GET list/detail routes. No new direct backend IDOR was confirmed. | [cross-org-isolation.test.ts](apps/api/src/platform/rbac/cross-org-isolation.test.ts#L194) |

### Additional operational observations

- [The migration runner](apps/api/src/platform/db/migrate.ts#L30) terminates any session in the current database idle in transaction for more than ten seconds, without identifying an orphan or restricting the application/user. This pre-existing behavior can kill legitimate work during deployment.
- [The revised restore example](docs/RELEASE.md#L111) omits the mandatory target database argument required by [restore.sh](docker/restore.sh#L27), plus the live-restore opt-in and stop-API sequence. The script guards against accidental live overwrite, but the documented command is incomplete.
- CI validates Node 24, while the production API Dockerfile uses Node 22. Both may work, but this audit did not establish runtime parity on Node 22.
- An additive uniqueness migration can fail on existing duplicate rows. Migration 0091 passed on an empty database; production-data preflight/upgrade validation was not performed.

## 7. Improvements verified and worth retaining

| Change | Assessment | Evidence |
|---|---|---|
| Password/MFA reset privilege checks | Correctly prevents a caller from resetting an account holding permissions they lack. | [auth.service.ts](apps/api/src/platform/auth/auth.service.ts#L999), [mfa.service.ts](apps/api/src/platform/auth/mfa.service.ts#L275); auth tests pass. |
| Numeric financial ranking and full payable total | Uses numeric expressions for ordering and aggregates the full book rather than only the displayed 25 rows. | [purchases.service.ts](apps/api/src/modules/cfo/purchases.service.ts#L130), [credit-control.service.ts](apps/api/src/modules/cfo/credit-control.service.ts#L173); targeted CFO tests pass. |
| Sales edit policy before persistence | Rejects an invalid discount alteration before mutating the document. | [sales-order.service.ts](apps/api/src/modules/sales/orders/sales-order.service.ts#L388); COM-1 regression passes. |
| Concurrent return receipt locking | Locks and validates inside the write transaction; concurrency regression passes. | [return.service.ts](apps/api/src/modules/sales/returns/return.service.ts#L173) |
| One live replacement per return | Database unique index prevents concurrent duplicate live orders. | [migration 0091](apps/api/drizzle/0091_one_replacement_per_return.sql#L5) |
| Atomic scheduled occurrence claim | Due update and insertion share one statement; contention test passes. | [fallback-job-runner.service.ts](apps/api/src/platform/jobs/fallback-job-runner.service.ts#L189) |
| Agent request limits and validation | Timeout, HTTPS/loopback policy, and runtime response parsing all added. | [api-client.ts](apps/agent/src/api-client.ts#L65), [config.ts](apps/agent/src/config.ts#L16); all agent tests pass. |
| Shared production/test body-parser setup | Prevents the harness from silently testing a different body limit. | [body-parsers.ts](apps/api/src/platform/common/body-parsers.ts#L35) |
| Minimal required offline dependency closure | The built critical set includes Punch and its static dependencies. | [precache-split.ts](apps/web/src/lib/offline/precache-split.ts#L25) |
| Build-before-migration and required checks job | Corrects the previous ordering and introduces a real release gate. | [ci.yml](.github/workflows/ci.yml#L71) |

The original strengths remain: strict TypeScript, deny-by-default authorization, scoped repositories, signed file access, secure cookie settings, useful security headers, non-root API containers, responsive layouts, and broad domain/integration tests.

## 8. Corrections to the original report

The re-audit checked the installed Base UI 1.7 implementation rather than treating a composition convention as a defect:

- Direct SelectItem children are supported. SelectGroup is used when options need explicit grouping/labels. The original claim that 34 files were functionally invalid is withdrawn.
- The link-button missing `nativeButton={false}` is a Low semantic/accessibility mismatch. Its click handler still blocks disabled navigation; it is not a confirmed disabled-link bypass.
- The fixture-default danger is corrected. C-02 now means “Tally capability unavailable,” not “the default agent silently writes demo data.”
- Prior test failures are historical results. Every test in the current isolated verification passed.
- Scope-reducing fixes receive credit even where broader resilience work remains. Not every residual has the severity of the original headline finding.

## 9. Next remediation pass

| Order | Work | Acceptance evidence |
|---|---|---|
| 1 | Fix the two agent lint errors. | Root `pnpm lint` exits zero. |
| 2 | Close offline owner omission, account-switch, drain cancellation, and legacy recovery. | Old-client payload rejected; same-tab, multi-tab, and in-flight logout tests pass without disclosing/deleting another user's queue. |
| 3 | Make credential redaction match every accepted route case. | Real routing/logging tests mask uppercase and lowercase paths plus queries. |
| 4 | Make replacement/cancellation/approval operations atomic. | Failure injection and both concurrent orderings preserve all document/request invariants. |
| 5 | Add durable notification/cleanup/reconciliation work and fence job completion. | Crash/restart, double failure, and stale-worker takeover tests converge to the correct state. |
| 6 | Preserve skipped allocations and invalidate renamed keys. | Allocation-before-voucher and rename sequences recover automatically. |
| 7 | Deploy the checked artifact/SHA with pinned actions and a recovery/health gate. | Observed CI run and staging deployment verify the exact revision and successful restore/recovery. |
| 8 | Complete auth-outage UI, offline install behavior, zoom, labels, and form validation. | Integrated browser flows and accessibility checks pass. |
| 9 | Update dependencies, monitoring, SMTP controls, versions and remaining documentation. | Fresh advisory result, synthetic handled-500 capture, and reviewed operational instructions. |

## 10. Release recommendation and limits

**Current recommendation:** continue remediation before unrestricted external or shared-device production use.

An attendance-only pilot does not need a real Tally transport if the integration is explicitly excluded, but it still needs reliable offline ownership across upgrades/account changes, credential-safe logging, and a passing release gate. Commercial/Tally rollout additionally depends on transaction/cursor corrections and the real connector.

The audit reviewed the remediation range and relevant current implementations, then ran package verification against local services. It did not certify every unchanged line, exercise real production accounts, run a sustained load test, perform a complete device/browser accessibility study, or rehearse production backup restoration. Race/crash findings identified through source are labelled as such; the report does not claim they were all reproduced in production.

Automatic approval review blocked the fresh npm audit because it transmits dependency metadata to a public advisory service. The last successful result and unchanged lockfile are reported transparently instead.

**Final score: 6.4/10, up from 5.8/10. All tests pass; lint and the listed release issues remain.**
