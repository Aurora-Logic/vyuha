# Transaction and authorization hardening — 5 September 2026

Parent revision: `292ff5b5`, branch `phase-6a`. Scope: app-owned code, retaining the owner's intentional pinch-to-zoom restriction and excluding the external Tally connector. This is an implementation evidence record, not a new numerical audit score.

## Changes

- Task creation/update now commits the task, item changes, assignment notification intent and business audit entry in one transaction. Queue availability does not determine whether saving succeeds; failure to persist required intent or audit rolls the write back.
- Period lock/unlock now commits the lock record, attendance-day projection, notification intent and audit together. An organization/month advisory lock serializes overlapping location and organization scope changes. Concurrent duplicate lock requests receive one success and conflicts for the others.
- Help questions commit their record, audit and notification intent together. A refused request leaves neither a question nor a misleading successful audit entry.
- Leave approval, rejection, cancellation and low-balance warnings stage notification intent inside their business transaction. Cancellation also withdraws the approval in that same transaction, with approval-before-subject lock ordering.
- Automatic and explicit purchase receipt allocation stage stock-arrival intent inside the existing allocation transaction. No financial calculation or allocation policy changes were made.
- All former `emitAfterCommit` callers were converted and that helper was removed. Scheduled/reconcilable `emit` callers still exist; removing the helper is not proof that every application event has been independently verified under crashes.
- `AuditContext.recordInTransaction` preserves HTTP request metadata and prevents the interceptor from writing a second copy. Existing best-effort audit callers remain to be migrated. Credential redaction now normalizes casing, underscores and hyphens, including API keys and recovery-code fields.
- Task detail reads on a transaction use sequential queries on its single PostgreSQL connection.
- Cross-organization tests cover individual and bulk approval refusals and attachment URL/deletion probes, including a foreign attachment ID under a caller-owned task. Both organizations' business records, approvals, files, attachments and notification intent remain unchanged on refusal.
- The isolated test wrapper now consumes the optional `--` separator correctly. Previously, a nominally filtered invocation ran the full API suite.

## Upgrade rehearsal

Run `pnpm --filter @vyuha/api test:upgrade`. The script refuses production mode and nonlocal database hosts, uses a generated disposable database on port 55432, and removes only its own database and temporary migration directory. It does not read or restore business data from the developer's database.

The rehearsal migrates through 0090, inserts synthetic existing document and running-job records, proves a real duplicate replacement is rejected by preflight without alteration, and upgrades through 0094. It verifies document/job preservation, new claim defaults, preservation of pending notification intent, holding legacy enqueued notifications, enforcement of replacement uniqueness, and a second migration invocation doing nothing. A simulated 0093 installation provides the existing outbox rows tested by 0094.

Local result: passed; the measured upgrade/assertion segment was 85 ms on this tiny fixture. This is **not** a capacity measurement or a representative migration duration. CI now invokes the rehearsal, but a hosted CI result has not been observed in this session.

## Verification

- Targeted transaction, leave, receipt, notification and tenant-boundary checks: 192 tests passed across eight files.
- Targeted durable audit/interceptor/task/period checks: 60 tests passed across three files.
- The initial full API run exposed two test assumptions: notification wiring bypassed the new durable drain, and a reused spy retained old reminder calls. Both were corrected; production assertions were not weakened.
- Final complete run: **3,362 package tests passed** (API 2,340; web 934; shared 73; agent 15), across 289 test files. Eight release/benchmark script tests passed.
- Root lint, typecheck and production build passed; production bundle inspection passed for 186 emitted files. Large chunks and remaining PostgreSQL concurrent-query deprecation warnings are still present.
- Final affected task (21), help (7) and isolation (7) tests passed after the last connection/audit wiring and exact tenant-refusal assertion corrections. API typecheck/lint/build also passed. The task actor lookup now shares the transaction connection instead of borrowing a second connection while holding the first.
- Local runtime: Node 24.15.0. No new dependency changes, production migration, deployment or restore occurred. The earlier offline-browser and dependency-advisory evidence is historical; neither was rerun for this backend-focused pass.

Notification delivery through the periodic drain can take up to its one-minute scheduling interval, plus processing/retry time. Queue outages retain intent. Interrupted external sends still need the reconciliation described in the earlier recovery record; this does not claim exactly-once email.

## Remaining requirements for a defensible 9/10 assessment

| Area | Remaining engineering or evidence | Completion condition |
|---|---|---|
| Code and correctness | Convert remaining critical best-effort audit writes; implement broader request creation idempotency; review concurrent edit behavior. | Named mutation inventory, rollback/concurrent retry tests, no duplicate business records or missing required audit entries under injected failures. |
| Security | Complete endpoint/permission write matrix and establish upload quarantine/scanning policy. | Adversarial coverage for every critical bulk/nested/file/approval path; selected scanner and fail-closed operational behavior verified. Current tests are an expansion, not an exhaustive matrix. |
| User/session handling | Authenticated browser workflows across login/logout, temporary outages, account switches, expired sessions and recovery. | Repeatable browser evidence for critical attendance and business flows, including mobile width and keyboard use. Keep zoom restriction as instructed. |
| Scalability | Representative authenticated workload with agreed user/concurrency/record-volume targets; large bundle and remaining PostgreSQL warning review. | Measured latency/error/resource budgets, sustained load and recovery results on representative infrastructure. A localhost harness or tiny upgrade fixture cannot establish this score. |
| Recovery and release | Sanitized production-scale upgrade and full DB/object/config/key restore rehearsal; Node 22 hosted CI/staging run. | Operator-approved RPO/RTO and retained recovery evidence, authorized file download after restore, validated release identity and rollback compatibility. |

Workload figures have been requested. Production deployment, destructive data resolution, new scanner dependencies and changes to business/retention policy have not been performed. Existing source work is independently useful; the overall 9/10 objective remains open.
