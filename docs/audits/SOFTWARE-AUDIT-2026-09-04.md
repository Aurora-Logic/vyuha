# Vyuha Software Audit Report

**Audit date:** 4 September 2026\
**Repository:** Vyuha monorepo\
**Audit type:** Read-only source, configuration, dependency, build, and automated-test review\
**Overall score:** **5.8/10**\
**Release verdict:** **No-go for unrestricted production**

## 1. Executive summary

Vyuha has a strong engineering foundation: strict TypeScript, centralized validation, deny-by-default authorization, organization-scoped repositories, a broad integration-test corpus, responsive UI patterns, and sound container/network defaults.

It is not currently ready for unrestricted production because several issues affect employee privacy, business-data integrity, and recoverability:

1. Offline punch records are not bound to an account or organization and may cross users on a shared browser.
2. The production Tally transport is not implemented; the agent always uses fixture data.
3. Live credentials embedded in URLs are written to application logs.
4. Notification, scheduler, sales-return, file-storage, and sync paths have transaction or concurrency gaps.
5. The deployment workflow has no validation gates and applies forward-only migrations before verifying the build.

For an attendance-only pilot, the offline punch issue, credential logging, global request-body exposure, and deployment safeguards must be fixed first. For the complete ERP/Tally product, the real Tally connector and business-transaction gaps are additional blockers.

## 2. Scope and inventory

The audit covered:

- NestJS API, React/Vite web application, Tally sync agent, and shared schemas.
- Authentication, authorization, tenant isolation, request validation, file access, offline data, secrets, and logging.
- Attendance, leave, notification, scheduler, sales-return, purchase, sync, file, and reporting paths.
- Frontend UX, responsive behavior, accessibility, PWA/service worker, forms, state, and realtime handling.
- TypeScript, ESLint, builds, tests, dependency advisories, Docker, Caddy, CI/CD, migrations, backups, runbooks, and legal text.

Repository scale at audit time:

| Area | Production TS/TSX files | Approximate production lines | Test files |
|---|---:|---:|---:|
| API | 438 | 83,449 | 152 |
| Web | 577 | 114,465 | 111 |
| Agent | 6 | 805 | 2 |
| Shared | 43 | 11,041 | 9 |
| **Total** | **1,064** | **209,760** | **274** |

Additional scale indicators:

- 51 production API controllers and approximately 413 route handlers.
- Approximately 95 lazy frontend route imports.
- 89 production TypeScript/TSX files exceed 500 lines.
- SQL migrations contain approximately 4,273 lines.

## 3. Scorecard

Scores are weighted toward privacy, business correctness, and operational safety rather than code style alone.

| Parameter | Weight | Score | Assessment |
|---|---:|---:|---|
| Product completeness | 10% | 5.0 | Broad functional surface, but Tally integration is fixture-only and some facts remain intentionally unavailable. |
| Architecture and modularity | 10% | 8.0 | Good platform boundaries, shared contracts, guards, repositories, and feature organization. |
| Code quality and type safety | 8% | 8.0 | Strict compiler/lint rules and clean checks; reduced by very large services. |
| Correctness and data integrity | 15% | 5.0 | Multiple static transaction, concurrency, cursor, and idempotency risks. |
| Security and privacy | 15% | 5.5 | Strong backend controls, offset by offline identity leakage and credential logging. |
| UX and responsive design | 8% | 7.5 | Thoughtful desktop/mobile behavior and shared components. |
| Accessibility | 5% | 5.0 | Good motion/touch handling, but zoom is deliberately blocked and some controls lack labels. |
| Performance, scalability, and PWA | 8% | 5.5 | Useful lazy routing, but large initial bundles, fragile precaching, and query fan-out remain. |
| Testing and QA | 8% | 5.5 | Large test suite, but current gates are red, test state leaks, and browser E2E/coverage gates are absent. |
| Deployment, rollback, and DR | 8% | 3.5 | Direct mutable SSH deployment, no validation gates, and no implemented migration rollback. |
| Observability and operations | 3% | 5.5 | Structured logs and health checks exist; handled 5xx errors likely bypass Sentry. |
| Documentation and compliance | 2% | 3.5 | Material documentation drift and unreviewed legal text. |
| **Weighted total** | **100%** | **5.8/10** | **Good foundation; not currently production-ready.** |

## 4. Release decision

| Deployment scope | Verdict | Conditions |
|---|---|---|
| Local development/demo | Acceptable | Clearly label fixture integrations and known limitations. |
| Internal attendance pilot | No-go now | Fix C-01, H-01, H-02, H-03/H-04 and add a staging/restore gate. |
| External multi-tenant attendance | No-go | Pilot conditions plus legal/privacy review and tenant/offline regression tests. |
| Complete ERP/Tally product | No-go | All above plus C-02 and the data-integrity/concurrency fixes. |

## 5. Critical findings

### C-01 — Offline punches can cross users and organizations

**Status:** Confirmed design defect\
**Area:** Privacy, attendance integrity, multi-tenancy

The origin-wide IndexedDB queue stores photo, GPS, consent, timestamps, and punch type but no `userId`, `employeeId`, or `orgId`. Logout removes credentials and query state but does not clear or quarantine this queue. The next authenticated account automatically drains all pending records, and the server attributes them to the currently authenticated employee.

**Impact:** Employee A's photo/location may be disclosed and recorded as Employee B's attendance, including across organizations on a shared browser.

**Evidence:**

- `apps/web/src/lib/offline/punch-queue.ts:38-40,52-77,180-204`
- `apps/web/src/lib/session/use-session.ts:253-281`
- `apps/web/src/features/punch/use-punch-queue.ts:43-71`
- `apps/web/src/lib/offline/drain.ts:117-143`
- `apps/api/src/modules/attendance/punch/punch.service.ts:217-236,520-532`

**Required remediation:**

- Persist organization, user, and employee ownership with each queued row.
- Refuse or quarantine records whose ownership does not match the active session.
- Define a safe migration policy for existing ownerless records.
- Clear or lock sensitive offline state on logout/account change.
- Add same-org and cross-org account-switch tests.

### C-02 — The production Tally connector is not implemented

**Status:** Confirmed functional gap\
**Area:** Integration and product completeness

The agent executable always constructs `FixtureTransport` and defaults to `fixtures/demo.json`. The configured `tallyUrl` is not used. Source documentation confirms that the HTTP/XML implementation is deferred.

**Impact:** A deployed agent reads demo data and simulates Tally pushes rather than communicating with TallyPrime.

**Evidence:**

- `apps/agent/src/main.ts:20-22,46-50`
- `apps/agent/src/config.ts:21-22`
- `apps/agent/src/transport.ts:20-27,100-115`

**Required remediation:** Implement the real transport, remove the production fixture fallback, fail closed when transport configuration is incomplete, package/version the binary, and run end-to-end tests against representative Tally exports.

## 6. High findings

### H-01 — Live credentials are logged in request URLs

Pino serializes raw `req.url`, and the exception filter logs `originalUrl`. Portal keys, invitation/reset tokens, and local signed-file signatures are URL path/query credentials.

**Impact:** A log reader, support export, aggregator, or backup may expose replayable credentials.

**Evidence:**

- `apps/api/src/platform/common/logging.ts:60-66`
- `apps/api/src/platform/common/app-exception.filter.ts:232-260`
- `apps/api/src/platform/portal/portal.controller.ts:24-40`
- `apps/api/src/platform/auth/auth.controller.ts:225-232,271-280`
- `apps/api/src/platform/storage/object-store.ts:170-174`

**Remediation:** Log route templates, not raw paths; remove query strings; redact sensitive path parameters; and test log output using representative credentials.

### H-02 — Global unauthenticated 15 MB JSON parsing

The 15 MB parser limit applies globally before route guards. Caddy has no request-body/concurrency limit, and the API container has no explicit CPU/memory limit.

**Impact:** Concurrent unauthenticated large bodies can create buffering, decompression, JSON parsing, CPU, and memory pressure on the Node process.

**Evidence:**

- `apps/api/src/main.ts:42-50`
- `docker/Caddyfile:42-46`
- `docker/docker-compose.prod.yml:66-101`

**Remediation:** Keep ordinary routes near the framework default; grant the larger limit only to the integration endpoint; add proxy body/concurrency/rate controls and container resource limits.

### H-03 — Direct deployment without quality or supply-chain gates

Every push to `main` deploys through `appleboy/ssh-action@v1`, a mutable tag that receives the production SSH private key. The remote install is not frozen, and the workflow runs no lint, typecheck, tests, dependency scan, or artifact verification.

**Evidence:** `.github/workflows/ci.yml:3-7,19-25,37-55`

**Remediation:**

- Pin third-party actions to reviewed full commit SHAs.
- Add required PR checks for typecheck, lint, tests, build, SCA, and migration validation.
- Use `pnpm install --frozen-lockfile`.
- Build immutable artifacts before deployment.
- Use a least-privileged deploy identity and post-deploy health gate.

### H-04 — Migrations run before build and have no rollback implementation

CI applies migrations before verifying the production build. Release documentation claims all migrations have a reverse path, while the migration runner and repository documentation explicitly describe forward-only migrations.

**Impact:** A failed build can leave old application code running on a new schema with no defined down migration.

**Evidence:**

- `.github/workflows/ci.yml:43-55`
- `apps/api/src/platform/db/migrate.ts:9-16`
- `apps/api/drizzle/README.md:1-18`
- `docs/RELEASE.md:98-110`

**Remediation:** Build and validate first; adopt expand/contract migrations; implement and test the real recovery path; update the runbook; and perform a restore drill before release.

### H-05 — Notification idempotency can permanently lose messages

The dispatcher creates a permanent idempotency claim before enqueueing the notification. A failed or timed-out enqueue leaves a claimed key that causes all retries to skip the event.

**Evidence:**

- `apps/api/src/platform/notifications/notification.dispatcher.ts:122-141,171-178`
- `apps/api/drizzle/0060_notification_idempotency.sql:1-9`

**Remediation:** Use a transactional outbox or a state machine with pending/sent/failed states and retry ownership.

### H-06 — Notifications cross transaction boundaries inconsistently

Leave creation commits before awaiting a throwable notification emit, which may return an error after the leave exists. Purchase receipt allocation can call notification code from inside a transaction, allowing an already-enqueued event to outlive a later rollback.

**Evidence:**

- `apps/api/src/modules/attendance/leave/leave.service.ts:500-539,561-576`
- `apps/api/src/modules/purchase/orders/purchase-order.service.ts:670-709`

**Remediation:** Record domain events in the same database transaction and dispatch them asynchronously through a durable outbox.

### H-07 — Fallback scheduler is not multi-instance safe

Due-check, job insertion, and schedule advancement are separate statements without a transaction or row lock. Stale claims are requeued after five minutes, while running handlers do not renew leases.

**Impact:** Duplicate schedule occurrences and concurrent execution of legitimate long-running jobs.

**Evidence:** `apps/api/src/platform/jobs/fallback-job-runner.service.ts:188-207,220-275`

**Remediation:** Use a transaction with row-level/advisory locking, unique occurrence keys, renewable leases, and fenced completion tokens.

### H-08 — Sales-return quantity and replacement-order races

Returned quantity is checked outside the insert transaction, and no database constraint caps aggregate returns against dispatched quantity. Replacement-order creation commits separately from return-state updates, with no uniqueness constraint on the return relationship.

**Evidence:**

- `apps/api/src/modules/sales/returns/return.service.ts:171-174,322-440`
- `apps/api/src/modules/sales/schema/sales.schema.ts:53-56,86-94,426-457`

**Remediation:** Lock the dispatch/return aggregate during validation, enforce uniqueness/invariants in PostgreSQL where possible, and place return plus replacement creation in one transaction.

### H-09 — Object storage and database metadata are not recoverably coordinated

Object bytes are written before the metadata row. The cleanup path scans only existing file rows, so a rowless object cannot be discovered. Feature rollbacks can also leave unrelated global file rows/objects behind.

**Evidence:** `apps/api/src/platform/files/file.service.ts:231-265,656-669`

**Remediation:** Add compensating deletion on row failure, a durable pending/finalized upload state, an object inventory reconciler, and transaction-aware attachment finalization.

### H-10 — Sync caches and cursor advancement can preserve stale or missing data

Process-global name caches store both hits and misses indefinitely and are not invalidated after master upserts/renames. Missing voucher bill allocations are skipped, but the cursor advances and the job completes.

**Impact:** Stale/null party or item references until restart, and skipped facts that routine incremental pulls may never revisit.

**Evidence:**

- `apps/api/src/platform/sync/sync-writer.service.ts:149-188,551-670,825-855,909-957`
- `apps/api/src/platform/sync/sync-scheduler.service.ts:274-287`

**Remediation:** Scope/invalidate caches, persist resolvable failures, prevent cursor finalization for incomplete facts, and add automatic reconciliation/full-pull recovery.

### H-11 — Agent networking has no timeout or runtime response validation

The client uses `fetch` without an abort signal/timeout and casts `JSON.parse` directly to generic response types. Shutdown waits for the current tick, so a hung request can also hang shutdown. `serverUrl` accepts plaintext HTTP.

**Evidence:**

- `apps/agent/src/api-client.ts:52-74`
- `apps/agent/src/main.ts:60-76`
- `apps/agent/src/config.ts:16-24`
- `packages/shared/src/sync.ts:68-76,101-104,405-416`

**Remediation:** Require HTTPS except explicit loopback development, add bounded abortable requests and backoff, and parse every response with shared runtime schemas.

### H-12 — Browser zoom is deliberately disabled

The viewport, gesture handling, and punch-screen CSS prevent or interfere with zoom. The source itself notes that this fails WCAG 1.4.4.

**Evidence:**

- `apps/web/index.html:8-20`
- `apps/web/src/main.tsx:15-17`
- `apps/web/src/index.css:633-640`

**Remediation:** Restore user scaling and redesign the camera/punch layout to remain stable under browser zoom and large text.

### H-13 — Service-worker installation is oversized and atomic

Every emitted JS/CSS file, including lazy route chunks, is classified as critical. One `cache.addAll` downloads them atomically during install; any failed asset aborts the worker installation.

The audited build generated approximately 4.57 MB raw / 1.32 MB gzip of critical JS/CSS.

**Evidence:**

- `apps/web/vite.config.ts:60-74`
- `apps/web/src/lib/offline/service-worker.js:63,168-173`

**Remediation:** Precache only the minimal offline shell and punch dependencies; cache optional routes lazily or independently; version and clean caches safely.

### H-14 — Session-service failures are presented as logout

The `/auth/me` query preserves the snapshot only for a specific network-error code. Other failures, including 429, 500, or malformed responses, call `forgetMe()` and return anonymous, after which the session gate renders sign-in.

**Evidence:**

- `apps/web/src/lib/session/use-session.ts:165-173`
- `apps/web/src/app/session-gate.tsx:118-130`

**Remediation:** Distinguish unauthorized/expired sessions from temporary server failures, preserve the last known identity appropriately, and render an outage/retry state.

## 7. Medium findings and technical debt

| ID | Area | Finding | Evidence |
|---|---|---|---|
| M-01 | Privacy | Commercial drafts in `sessionStorage` are keyed only by document type and survive account changes. | `apps/web/src/features/documents/use-draft-backup.ts:25-65` |
| M-02 | Realtime | SSE reconnect retries a present-but-expired bearer indefinitely instead of refreshing after 401. | `apps/web/src/lib/realtime/realtime-provider.tsx:81-95,139-147` |
| M-03 | Email security | SMTP port 587 may opportunistically use STARTTLS but does not require it. | `apps/api/src/platform/mail/smtp-mailer.ts:41-59`; `.env.production.example:89-100` |
| M-04 | Credential handling | Redis replay coordination stores a usable replacement refresh token for up to 60 seconds. | `apps/api/src/platform/auth/session.service.ts:88-97,334-379` |
| M-05 | Observability | Sentry is initialized, but the global exception filter consumes handled 5xx errors without explicit capture. | `apps/api/src/main.ts:37-40`; `apps/api/src/platform/common/app-exception.filter.ts:109-140` |
| M-06 | File security | PDF/Office uploads lack malware scanning or content-disarm quarantine. | `apps/api/src/platform/files/file.service.ts:298-366`; `magic-bytes.ts:167-200` |
| M-07 | Performance | A GRN list may launch 200 simultaneous complex view queries against a 20-connection pool. | `apps/api/src/modules/purchase/orders/purchase-order.service.ts:565-571,1012-1040` |
| M-08 | Auditability | Audit writes are fire-and-forget and failures are suppressed after logging. | `apps/api/src/platform/audit/audit.interceptor.ts:63-72`; `audit.service.ts:120-156` |
| M-09 | Financial precision | OpsTally monetary inputs pass through unrestricted JavaScript numbers before becoming text. | `packages/shared/src/opstally.ts:14-16,44-45`; `opstally-webhook.service.ts:97-100` |
| M-10 | API resilience | `Idempotency-Key` is advertised globally, but most create mutations do not implement it. | `apps/api/src/main.ts:73-80` |
| M-11 | Form quality | Shared forms disable native validation, while many forms do not provide equivalent schema validation and accessible errors. | `apps/web/src/components/shared/form.tsx:22-37`; `features/crm/company-sheet.tsx:92-103,149-203` |
| M-12 | Accessibility | Password visibility and mobile Go To controls lack reliable accessible names. | `apps/web/src/features/employees/invite-dialog.tsx:318-337`; `apps/web/src/app/layout/app-shell.tsx:557-568` |
| M-13 | UI composition | One Base UI link-button lacks `nativeButton={false}`; 34 files place `SelectItem` directly under `SelectContent`. | `apps/web/src/features/sales/sales-order-sheet.tsx:439-441`; `components/shared/record-table.tsx:224-250` |
| M-14 | Bundle performance | Initial preload is approximately 600 KB gzip; `ui` and `app-lib` are 883 KB and 614 KB minified. Two dynamic imports are neutralized by static imports. | `apps/web/vite.config.ts:158-170` |
| M-15 | Dependencies | Production audit reports four High and three Moderate advisories in `fast-uri`, `qs`, and `uuid`. Reachability was not established for every advisory. | `pnpm-lock.yaml:3687,4855,5571` |
| M-16 | Test isolation | API tests share a persistent development database and have accumulated historical state; two current failures are isolation/timeout symptoms. | `apps/api/vitest.config.mts:7-34`; `apps/api/src/test-support/api-harness.ts:413-416,482` |
| M-17 | QA coverage | No Playwright/Cypress gate or coverage threshold exists despite the technical design requiring browser flows and coverage. | `docs/02-technical-design.md:524-533` |
| M-18 | Database compatibility | Pool-connect initialization fires concurrent `client.query()` calls; every application boot warns this will be unsupported in pg 9. | `apps/api/src/platform/db/db.provider.ts:54-63` |
| M-19 | Maintainability | Core services reach 1,000-1,700 lines, increasing review and regression cost. | `leave.service.ts`, `punch.service.ts`, `auth.service.ts`, `sync-writer.service.ts` |
| M-20 | Versioning | Agent package and runtime versions disagree (`0.0.0` versus `0.1.0`). | `apps/agent/package.json:2-3`; `apps/agent/src/agent.ts:231` |
| M-21 | Documentation | Deployment/runbook content describes an older attendance-only state and contradicts the current Sentry/CRM/ERP/CFO implementation. | `docs/DEPLOYMENT.md:15-35,123-139`; `docs/RUNBOOK.md:86-90` |
| M-22 | Legal/compliance | Terms and privacy content is explicitly an unreviewed working draft lacking operator-specific inputs. | `apps/web/src/features/legal/legal-content.ts:6-11`; `docs/OPEN-QUESTIONS.md:398-406` |
| M-23 | Data limitations | Opening billwise receivables may be omitted, and several CFO/compliance facts remain unavailable or intentionally deferred. | `docs/OPEN-QUESTIONS.md:532-547,710-719` |
| M-24 | Tenant test depth | No direct backend IDOR was found, but the automated cross-org sweep covers only discoverable GET-list/detail shapes and not every route. | `apps/api/src/platform/rbac/cross-org-isolation.test.ts:202-265` |

## 8. Verification results

### Static checks and build

| Check | Result |
|---|---|
| API typecheck | Pass |
| Web typecheck | Pass |
| Agent typecheck | Pass |
| Shared typecheck | Pass |
| API lint | Pass |
| Web lint and guide/precache checks | Pass |
| Agent lint | Pass |
| Shared lint | Pass |
| Production monorepo build | Pass with frontend warnings |

Build warnings:

- `ui` chunk: approximately 883 KB minified / 270 KB gzip.
- `app-lib` chunk: approximately 614 KB minified / 169 KB gzip.
- `notifications` and `updates` are dynamically and statically imported, so their dynamic imports do not create separate chunks.

### Automated tests

| Package | Passed | Total | Result |
|---|---:|---:|---|
| API | 2,257 | 2,259 | Fail: two leave-suite failures |
| Web | 909 | 911 | Fail: two 5-second timeouts |
| Shared | 73 | 73 | Pass |
| Agent | 10 | 10 | Pass |
| **Combined** | **3,249** | **3,253** | **99.88% passed; overall gate remains red** |

API details:

- 152 of 153 test files passed.
- One leave preview test exceeded its five-second timeout.
- One reconciliation assertion found a historical row with closing `1.00` versus ledger sum `3.00`.
- The persistent test database contained approximately 113,100 leave-balance rows.
- All seven balances produced by the isolated diagnostic run reconciled with their ledgers.
- Evidence therefore points to fixture isolation/retained-state defects rather than a newly reproduced leave-calculation defect.

Web details:

- 109 of 111 test files passed.
- Timeouts occurred at `apps/web/src/app/goto-palette.test.tsx:161` and `apps/web/src/features/settings/settings-page.test.tsx:96`.
- The palette test also emitted an unwrapped React `act(...)` warning.

### Dependency audit

`pnpm audit --prod` reported:

| Dependency | Severity/count | Current | Patched | Exposure assessment |
|---|---|---:|---:|---|
| `fast-uri` | 4 High | 3.1.5 | 3.1.6 | Transitive client/resolver chain; direct vulnerable use not established. |
| `qs` | 2 Moderate | 6.15.3 | 6.16.0 | Most plausible server exposure, depending on parser/configuration path. |
| `uuid` | 1 Moderate | 8.3.2 | 11.1.1 | Transitive through ExcelJS; attacker-controlled buffer use not found. |

This is a release-hygiene failure, not evidence that every advisory is directly exploitable in Vyuha.

## 9. Strong controls and positive findings

- Deny-by-default global authorization guard.
- Boot-time audit that rejects routes with missing policy declarations.
- Organization and soft-delete predicates centralized in scoped repositories.
- No confirmed direct backend IDOR in reviewed entity, export, attachment, portal-media, punch-photo, or raw-file paths.
- Strict TypeScript options including unchecked-index and optional-property safeguards.
- Custom lint rules for module boundaries and organization-scoped repository access.
- Central Zod parsing and consistent safe client error envelopes.
- JWT algorithm/claim/length checks and secure refresh-cookie attributes.
- Exact-origin credentialed CORS, Helmet, HSTS, CSP, frame denial, no-sniff, and restrictive permissions policy.
- Constant-time webhook/file-signature comparisons and AES-GCM secret storage.
- Sync chunks atomically write projection data, journal, cursor, and completion state.
- API image uploads are decoded/re-encoded rather than stored blindly.
- API container runs as a non-root user.
- PostgreSQL, Redis, and MinIO are not published directly to the host; Redis requires authentication.
- Separate liveness and dependency-aware readiness probes.
- Structured request logging and request IDs.
- Responsive desktop/mobile architecture, coarse-pointer target sizing, global error boundaries, and reduced-motion support.
- Dialog/sheet title usage and avatar fallbacks passed the component sweep.
- No tracked live environment files, private keys, or obvious production credentials were found.

## 10. Remediation roadmap

### Priority 0 — release blockers

1. Bind offline punch data to organization/user/employee and handle legacy rows safely.
2. Redact all credential-bearing URL segments and query strings from logs.
3. Disable the fixture agent in production; implement the real Tally transport before advertising the integration.
4. Restrict the large request-body limit to the required endpoint and add edge/container controls.
5. Replace direct-to-production deployment with required validation gates and a pinned action SHA.
6. Define and test a real migration recovery strategy before the next schema-changing deployment.

### Priority 1 — business-data integrity

1. Introduce a transactional outbox for notifications and other external side effects.
2. Make the fallback scheduler lock- and lease-safe across multiple instances.
3. Make sales return/replacement processing atomic and database-constrained.
4. Add recoverable object-upload finalization and orphan reconciliation.
5. Invalidate or scope sync caches and prevent completion over skipped required facts.
6. Add timeouts, HTTPS enforcement, and runtime schemas to the agent protocol.

### Priority 2 — release confidence

1. Give integration tests isolated schemas/databases or transaction-based cleanup.
2. Fix the four currently failing tests.
3. Add the three promised Playwright flows to CI.
4. Add meaningful coverage thresholds for critical business engines.
5. Add dependency/SCA, secret, and static security checks.
6. Test backup restoration and post-deploy rollback in staging.

### Priority 3 — frontend and operational hardening

1. Restore browser zoom and fix accessible labels/forms.
2. Reduce the initial bundle and make service-worker precaching incremental.
3. Separate authentication failure, outage, and rate-limit UI states.
4. Refresh expired realtime tokens on 401.
5. Capture handled unexpected errors in Sentry with PII/URL scrubbing.
6. Require production SMTP TLS and add document malware scanning.
7. Update dependencies, versions, runbooks, release documents, and legal copy.

## 11. Suggested production exit criteria

A release candidate should not be approved until all of the following are true:

- C-01 is fixed with same-account, account-switch, and cross-organization regression tests.
- Fixture transport cannot run accidentally in a production agent.
- Sensitive credentials do not appear in request, error, proxy, or Sentry logs.
- Typecheck, lint, build, unit, integration, and browser E2E gates are green in CI.
- Notification/scheduler/return transaction fixes have concurrency and failure-injection tests.
- Migrations follow a documented, tested expand/contract or restore strategy.
- A staging deployment, health check, rollback, backup, and restore drill succeeds.
- Production dependency audit has no unaccepted High/Critical issues.
- Browser zoom and core accessibility checks pass.
- Legal/privacy text and configured retention periods have owner/counsel approval for the intended deployment.

## 12. Audit limitations

This review was performed against the repository and local development services. It was not:

- A live production penetration test.
- A full browser/device/manual usability study.
- A sustained load, soak, or chaos test.
- An independent legal or regulatory opinion.
- A production backup-restore exercise.
- A verification of external Tally, SMTP, S3, DNS, TLS, monitoring, or infrastructure accounts.

Automated license inventory could not be completed because the local pnpm package index lacked the metadata required by the license command. Third-party license compliance therefore remains unverified.

## 13. Final assessment

Vyuha is not a weak codebase; it is a broad, carefully structured product whose release engineering and cross-boundary correctness have not yet caught up with its feature surface. The fastest safe path is to fix identity isolation and credential exposure first, then close the transactional and deployment gaps before expanding external usage.

**Final score: 5.8/10**\
**Recommendation: remediate Priority 0 and Priority 1, rerun the full audit gates, then conduct a controlled staging pilot.**
