# Vyuha improvement action plan

Date: 5 September 2026. Baseline: `7097a125` and the [re-audit](SOFTWARE-AUDIT-REPORT.md).

## Scope and scoring

Target: independently verifiable software quality above 9/10. A target is not a result: completed code, regression tests and operational evidence determine the final assessment.

Per the owner's instruction, **leave the intentional zoom restriction unchanged** and **exclude the separately developed Tally connector** from this implementation and scoped score. These exclusions do not constitute WCAG certification or verification of the external connector. The application's own sync ingestion/data integrity remains in scope.

Status: Planned / In progress / Verified / Needs external evidence / Needs approval.

## Prioritized work

| Priority | Action | Audit references | Acceptance evidence | Status |
|---|---|---|---|---|
| P0 | Restore a green lint/release gate without suppressing rules. | R-01 | Root lint, typecheck and build pass. | Verified |
| P0 | Require offline owner identity and isolate queue/drains across login, logout and tabs; safely explain legacy rows. | R-02 | Missing/mismatched owner rejected; identity-switch and in-flight tests; no silent deletion. | In progress |
| P0 | Redact credentials for every accepted route spelling. | R-03 | Uppercase/mixed-case request and exception logging regressions. | In progress |
| P0 | Make replacement creation and return counters atomic. | R-04 | Rollback/failure injection and concurrent replacement tests. | In progress |
| P0 | Protect approval/cancellation in both transaction orderings. | R-06 | Both interleavings preserve document and approval-request state. | In progress |
| P0 | Prevent missing voucher allocations from being permanently skipped; invalidate renamed masters. | R-05 | Out-of-order ingestion and rename/reuse regression tests. | In progress |
| P1 | Persist notification work and recover failed dispatch; avoid false errors after committed approvals. | R-07 | Enqueue failure, restart/retry and post-commit failure tests. | In progress |
| P1 | Fence job completion/retry by lease ownership. | R-08 | Old worker cannot overwrite a reclaimed job. | In progress |
| P1 | Recover object-storage failures across image/upload/document paths. | R-09 | Metadata/storage failure injection; durable/retryable cleanup. | In progress |
| P1 | Deploy the validated revision; pin actions; enforce backup/readiness and document safe recovery. | R-10, H-04 | Script tests/static validation locally; staging deployment and restore evidence separately. | In progress |
| P1 | Restrict large JSON handling to real sync endpoints and bound concurrent parsing. | R-11 | Unknown route size cap; saturation/release regression tests. | In progress |
| P1 | Preserve identity through temporary refresh outages; refresh realtime bearer tokens. | R-12, M-02 | Integrated expired-token/503 recovery and realtime tests. | In progress |
| P1 | Stop downloading every optional route at worker installation. | R-13, M-14 | Worker install and emitted critical-dependency checks; bundle measurements. | In progress |
| P1 | Scope draft backups by identity; fix accessible names, link semantics and form feedback. | M-01, M-11–13 | Account-switch, labelled-control and invalid-form tests. | In progress |
| P1 | Require TLS for remote SMTP; capture unexpected handled server errors safely. | M-03, M-05 | Transport policy tests and redacted monitoring capture tests. | In progress |
| P1 | Use an isolated test database; remove unsafe migration session killing and pg initialization races. | M-16, M-18 | Clean migrations/full suite; migration timeout/connection configuration checks. | In progress |
| P2 | Refresh vulnerability advisories and update existing vulnerable dependencies. | M-15 | Approved npm scan, reviewed lockfile, full regression verification. | Verified |
| P2 | Expand browser E2E, performance and recovery evidence. | M-07, M-17 | Critical browser workflows; representative load; staging backup restoration. | Planned |
| P2 | Review durable audit writes, idempotent creates, financial precision and malware quarantine design. | M-06, M-08–10 | Explicit bounded contracts, adversarial tests and operational policy; no blanket claims. | In progress |
| P2 | Reconcile versions, deployment docs, legal/operator inputs and remaining maintainability findings. | M-19–24 | Accurate docs/version reporting; operator/legal decisions remain external evidence. | Planned |

## Execution and guardrails

1. Implement independent, reviewable fixes with targeted regressions.
2. Apply only additive migrations; test against disposable databases, never production data.
3. Run targeted checks before the complete build/lint/typecheck/test sequence.
4. Review the combined diff for interactions and repeat any affected verification.
5. Record actual results and remaining gaps here and in the audit report. Do not assign 9+ merely because work was attempted.

No production deployment, live restore, new dependency, or change to attendance/financial business policy is implied by this plan. Source changes and local verification are authorized; any new authority or operator decision is called out explicitly.

## Verification record

Implementation is in progress. The baseline had 3,293 passing tests, two agent lint errors and a 6.4/10 whole-product score. That score is historical and included the now-excluded items; the scoped post-change score will be assessed after verification.

## Follow-up review — 5 September 2026

**Additional work is needed.** The broad priorities above remain appropriate, but several acceptance contracts need expanding. This review inspected the current uncommitted remediation, not just baseline `7097a125`. Source findings below are not claims of production reproduction. The baseline report and its 3,293-test result must not be presented as verification of this working tree.

| ID / Priority | Additional or expanded work | Evidence and acceptance criteria | Status |
|---|---|---|---|
| F-01 / P1 | Close the business-commit-to-notification-outbox gap for notifications that must survive crashes. Expands R-07. | `NotificationDispatcher.stage()` uses its own transaction; `emitAfterCommit()` logs and swallows database staging failure. For example, leave application commits before emitting `LEAVE_APPLIED`. Persist required notification intent in the business transaction, or provide durable reconciliation from the committed record. Inject a crash before staging and a staging DB failure; recovery must create the intended notice. Explicitly document any events accepted as best effort. | In progress |
| F-02 / P1 | Track delivery outcomes and retry failed recipients/channels without repeating successful deliveries. Expands R-07 and M-08. | `notification.dispatcher.ts:deliver()` catches channel failures and returns a report; `send-notification.handler.ts` returns that report as a successful job. The outbox stops at ENQUEUED. An audit failure after sending can conversely fail the job and replay successful sends. Define delivery deduplication and ambiguous-send behavior; test partial channel failure, post-send audit failure, exhausted jobs and recovery after queue data loss. Queue acceptance alone is not verified delivery. | In progress |
| F-03 / P1 | Prevent poison cleanup tasks from starving later objects. Expands R-09. | `file.service.ts:cleanupPendingObjects()` selects the oldest 500 due tasks. `cleanupOne()` increments attempts on failure without advancing `runAfter`. If those 500 keep failing, newer tasks never enter the batch. Add bounded backoff, fair progress, and an alerted/manual recovery path for persistent failures. Test at least 500 persistently failing tasks followed by a removable object and prove the latter is processed. | Verified |
| F-04 / P1 | Verify upgrades from a populated previous schema, not only clean migrations. Expands R-10 / H-04. | Migration 0091 creates a unique index on live replacement returns; existing duplicates can prevent installation. Rehearse 0091–0093 against a sanitized representative previous-version database, including duplicates, existing jobs, and interrupted deployment. Provide a read-only duplicate preflight and a reviewed resolution procedure; do not silently delete business records. Record migration duration and old/new client compatibility. | In progress |
| F-05 / P1 | Rehearse complete application recovery, including object storage and required configuration/keys. Expands H-04. | `docker/backup.sh` backs up PostgreSQL. A restored file metadata row does not restore its MinIO/S3 object. Document the object-store backup/versioning and off-host policy plus secure configuration/key recovery; restore a representative document and image and verify authorized download. Set operator-approved RPO/RTO and record actual recovery time. Existing DB-only rehearsal is useful but insufficient for this criterion. | Needs external evidence |
| F-06 / P1 | Give cross-org write authorization its own security action rather than grouping it under documentation. Expands M-24. | `cross-org-isolation.test.ts` primarily discovers GET list/detail pairs. Add a route/permission matrix and adversarial POST/PATCH/DELETE, bulk action, approval, file attachment/download and nested foreign-ID tests, including lower-privilege callers. Assert no state change or emitted side effect on refusal. This is a coverage gap, not a newly confirmed IDOR. | In progress |
| F-07 / P2 | Restore explicit tracking of M-04 and define its upgrade verification. | M-04 is absent from the original action rows. The working tree now encrypts refresh replay entries and rejects legacy plaintext in `session.service.ts`. Verify round-trip, tampering, swapped entries and legacy-cache behavior, including concurrent refresh across rollout. Mark it verified only with current test evidence; Redis ciphertext changes alone do not close the finding. | In progress |
| F-08 / P1 | Make completion evidence and release gates traceable to the final revision. | Add an owner, dependency, release scope and durable evidence link per action; record commit/diff identity, commands, test counts, browser/load budgets and staging results. Split grouped findings where they can finish independently. Preserve baseline history and reconcile the audit's current-status language after final verification. No updated numerical score is established by this follow-up. | In progress |

F-01 through F-03 are residual source-level failure paths in the remediation. F-04 through F-08 expand verification and tracking; they are not five newly demonstrated application defects. Keep the intentional zoom restriction and external Tally connector exclusions above. App-owned sync validation and data integrity remain included.

### Checks performed during this follow-up

- Root `pnpm lint`: passed, including agent lint and the web guide/precache source checks. The baseline R-01 lint failure no longer reproduces in the inspected working tree.
- Root `pnpm typecheck`: passed across shared, API, web and agent packages.
- No application source was changed by this review. The full test suite, production build, browser E2E, populated upgrade rehearsal and staging recovery were not rerun; existing remediation must still complete those checks before closure.

### Subsequent pre-push verification — 5 September 2026

Before the owner's requested `phase-6a` push, package verification found two integration gaps: the org-scoping lint registry omitted the four new tenant-owned tables, and the query-key source scanner classified `resetQueries()` as a registration instead of a cache filter. Both were corrected without changing product behavior or weakening query-registration collision checks.

- Root lint: passed again after those corrections. Root typecheck passed earlier in this session.
- Production build: passed using `NODE_ENV=production VITE_API_BASE_URL=https://ci.invalid`; large-chunk and ineffective dynamic-import warnings remain.
- Package suites: shared **73**, agent **15**, web **933**, API **2,317** — **3,338 passing tests** across **287 files**. Web and API were rerun separately after the initial failures; API used and removed a unique disposable database.
- Release-script tests: **6 passed**.
- PostgreSQL concurrent-query deprecation warnings still occur during the API suite; M-18 is not fully closed.
- Local execution used Node **24.15.0**. Node 22 CI/runtime verification, staging recovery, browser E2E and representative load remain unverified.
- Pinch-to-zoom remains intentionally disabled. No external connector implementation is included.

Provisional source-review ratings requested by the owner: code quality **8/10**, security **7/10**, user/session handling **7.5/10**, scalability **6.5/10**. These are category judgments informed by the reviewed changes and remaining gaps, not a new weighted whole-product score or measured capacity claim. The F-01–F-08 work remains open.

## Implementation follow-through — 5 September 2026

See [the recovery hardening record](docs/audits/RECOVERY-HARDENING-2026-09-05.md) for code changes, delivery semantics, migration compatibility, operational recovery and remaining gates.

Implemented local work includes transactional leave notification intent, durable per-channel delivery progress, queue-loss recovery, fair cleanup retries, disk bucket traversal rejection, expanded tenant write/session tests, a read-only migration preflight, version reconciliation, corrected route splitting, critical font caching, and production/offline checks in CI. The real-browser offline check passes **9/9**; that is a test result, not a software quality score.

The fresh advisory scan was authorized by automatic review during this implementation pass. It found four High and four Moderate advisories. Existing-dependency overrides now select `fast-uri@3.1.6`, `qs@6.16.0`, `exceljs > uuid@11.1.1`, and `@esbuild-kit/core-utils > esbuild@0.25.12`. The subsequent npm advisory scan reports **zero known vulnerabilities**. This supersedes the historical scan block and counts, without claiming absence of undiscovered vulnerabilities. ExcelJS uses `uuid.v4()` on the affected path; the remaining compatibility evidence comes from the regression suite/build.

F-01 remains partial: other post-commit callers need conversion or an owner-approved best-effort contract. F-02 now persists outcomes, but interrupted external delivery requires operator reconciliation and transport rejections retain at-least-once ambiguity. F-04 and F-05 need populated upgrade/complete restore evidence. F-06 expands coverage without claiming a complete endpoint matrix. General durable business audit writes, request idempotency, upload quarantine policy, representative load and authenticated browser workflows remain open. Expected production load was requested from the owner; no capacity rating is inferred from the localhost benchmark harness.

No production deployment or restore is implied. Keep the intentional zoom restriction unchanged. Category ratings are not raised to 9 on the strength of this implementation alone.

### Final local verification for this implementation pass

- **3,354 package tests passed:** API 2,332 (159 files), web 934 (117 files), shared 73 (9 files), agent 15 (4 files). The API was rerun as a complete suite after setting its integration deadline to 15 seconds; all assertions passed. Earlier five-second timeout results are retained in the hardening record.
- Root **lint**, **typecheck**, and the **production build** passed with the patched dependency graph. Large-chunk and PostgreSQL deprecation warnings remain.
- **8 script tests passed** (release verification and bounded benchmark runner).
- **9/9 real-browser first-install offline checks passed**. The patched production build has the same verified worker version, `bcf3a9226cf0`.
- Production artifact verification passed: no development Patterns sample page, no build-machine paths, and the startup dependencies are present in the worker cache.
- Live `pnpm audit --json`: **0 known vulnerabilities** after patching the four affected packages. `drizzle-kit export` also passed with the updated loader dependency.
- Local verification used Node 24.15.0; hosted Node 22 CI, staging activation, populated upgrade, representative business load, and full application restore remain external/unperformed checks. Every disposable API test database from the completed runs was removed by its wrapper, and the isolated test browser was stopped.

These results establish the listed local fixes; they do not close the remaining business atomicity, quarantine, broader security/E2E and operational-evidence work or establish 9/10 in every category.


## Further transaction hardening — 5 September 2026

[Transaction hardening evidence](docs/audits/TRANSACTION-HARDENING-2026-09-05.md) records the follow-through after `292ff5b5`:

- All former best-effort post-commit notification callers now stage intent with their business transaction; the helper was removed. This covers task assignment, help, leave outcomes/cancellation and receipt allocations, plus period locks.
- Task writes and period lock/unlock now commit their business audit entry atomically, retaining request attribution without duplicate interceptor entries. Other audit writers remain open.
- Leave cancellation and approval withdrawal now roll back together. Period operations serialize by organization/month. Tests cover outbox/audit failure rollback and concurrent duplicate locks.
- Cross-tenant individual/bulk approval and nested attachment probes assert no mutation in either organization.
- A disposable, synthetic populated 0090→0094 migration rehearsal passed and is now part of CI. Production-scale upgrade and complete restore evidence remain open.
- Credential field redaction handles casing and separator aliases. The test runner now applies requested file filters correctly.

F-01, F-04 and F-06 have further implementation/evidence but retain their broader outstanding acceptance criteria. The record above lists remaining local engineering separately from workload/operator/staging dependencies. No new 9/10 score is asserted.


Final verification for this pass: **3,362 package tests passed** (API 2,340 across 159 files; web 934 across 117; shared 73 across 9; agent 15 across 4). Eight release/benchmark script tests passed. Root lint, typecheck, production build and production bundle inspection passed. After final connection/audit wiring corrections, affected task (21), help (7) and isolation (7) tests passed again; the API typecheck/lint/build were also checked. The synthetic populated upgrade rehearsal passed. No new frontend changes were made, and the previous 9/9 offline-browser evidence was not rerun or relabelled as a new browser result. Large bundle and PostgreSQL concurrent-query warnings remain; Node 22 hosted CI, representative load, full restoration and the other outstanding engineering items remain open.
