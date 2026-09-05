# Recovery and verification hardening — 5 September 2026

Scope: follow-up to `41e6f02e`. Pinch-to-zoom remains intentionally disabled. The external Tally transport is excluded; app-owned data handling remains included. This is an implementation/evidence record, not a certification or a new weighted score.

## Changes

- Leave application stores its `LEAVE_APPLIED` notification intent in the same transaction as the request and approval. Rollback removes the intent too. The recurring drain performs queue hand-off, so a process can stop after commit without losing that event. Other `emitAfterCommit` call sites still require individual conversion or an explicit best-effort contract; F-01 is partially closed.
- Outbox-backed notifications persist recipient/channel progress, fence concurrent consumers with claim tokens, and skip acknowledged sends on retry. Bell records have a unique delivery key; later channel success updates their delivery receipt without creating another bell item. A failed audit write leaves the event recoverable without replaying acknowledged sends. Queue IDs use the globally unique outbox ID, avoiding collisions between tenants using the same idempotency text.
- The drain revisits overdue ENQUEUED records, allowing recovery when queue work disappears. A fresh retry job ID avoids an exhausted/completed queue job blocking the database retry. DELIVERED events stay suppressed even after queue retention removes the job.
- A worker interrupted during an external send leaves SENDING progress. Recovery marks that channel UNCERTAIN and eventually puts the envelope in ATTENTION for reconciliation, rather than assuming the recipient received nothing. The idempotent bell channel can recover automatically.
- Cleanup failures receive exponential backoff capped at one hour. A regression with 500 failing objects proves a newer removable object is processed on the next batch.
- Disk storage rejects traversal into another bucket or a directory sharing the storage root's name prefix.
- Tenant-write tests cover foreign company/task PATCH and DELETE, contact/order creation with foreign nested IDs, and same-tenant accounts without permissions. They compare both tenants' data and notification intents before/after refusal. Existing GET coverage remains. This is not yet the complete approval/bulk/upload permission matrix.
- Refresh-cache tests cover swapped ciphertext and legacy plaintext, in addition to existing corruption, rotation, replay and multi-tab cases.
- Migration startup performs a read-only preflight for conflicting live replacement orders. Unit coverage exercises empty-schema acceptance and conflict refusal. This does not substitute for a populated previous-release upgrade rehearsal.
- Approval detail reads execute sequentially on their transaction client. Other PostgreSQL concurrent-query warnings remain under the full suite and require further tracing.
- Agent package/runtime versions now agree at 1.0.0.
- Notifications and Updates page imports no longer share the shell's static barrel imports. The Patterns sample page's import is development-gated, so its sample data is absent from production artifacts.
- CSS-referenced local fonts/assets are included in the first-install critical cache. Service-worker versions include source and critical-cache contents, so cache-policy edits change the version too.
- CI now checks production artifacts and starts an isolated headless browser to verify first-install offline startup. The localhost-only GET load harness in `scripts/benchmark-api.mjs` provides bounded concurrency, full-response timings, error counts and p50/p95/p99 results.

## Delivery contract and upgrade behavior

The database ledger provides selective retries, not universal exactly-once email delivery. A transport can accept a message and then lose its acknowledgement; a rejected send is retried and can therefore duplicate an external delivery. An interrupted SENDING attempt is held for review. Resolving that ambiguity requires transport evidence or a decision to accept the duplicate risk. Do not label ATTENTION as delivered.

Migration 0094 marks existing ENQUEUED rows LEGACY_ENQUEUED. Earlier jobs lack an outbox identity/progress ledger; automatically replaying those rows could resend historical notifications. Existing queued jobs retain their compatibility path. Inventory failed/lost historical jobs and reconcile them separately. Stop old workers during migration and activation; rolling mixed-version worker deployment is not verified.

Direct legacy `deliver()` calls without an outbox ID retain best-effort behavior. Business mutation-to-audit atomicity outside the converted paths and general request idempotency remain open. The implementation does not resolve every R-07/M-08/M-10 finding.

## Operator recovery

Monitor the age/count of PENDING and ENQUEUED notifications, ATTENTION records, and cleanup tasks with repeated attempts. Logs identify outbox IDs/channel keys and cleanup storage keys. Configure alerts and an accountable operator; log output alone does not establish that an alert reaches someone.

For an ATTENTION event: inspect the exact tenant/event under a row lock; confirm no active worker claim; compare the channel outcome with the transport's records. Mark the specific outcome SENT only with delivery evidence, or FAILED only after approving a retry and its duplicate risk. Return that envelope to PENDING with a due `run_after`. Preserve an audit of the operator decision. Do not clear all progress or replay an entire tenant's history. This pass does not add a recovery UI or a privileged replay endpoint.

For cleanup failures: verify object-store credentials and object policy, then let scheduled backoff retry. Investigate persistent errors rather than deleting the recovery rows. The recorded task is the evidence needed to remove an orphan safely.

## Migration preflight and complete restoration

Before upgrading a populated installation, run the following read-only investigation if preflight refuses migration 0091:

```sql
SELECT org_id, return_id, count(*) AS live_orders,
       array_agg(id ORDER BY created_at) AS order_ids
FROM sales_documents
WHERE return_id IS NOT NULL AND deleted_at IS NULL
GROUP BY org_id, return_id
HAVING count(*) > 1;
```

Review each business record and its linked dispatch/invoice history before choosing a resolution. Do not automatically delete duplicates to make an index build succeed. Rehearse the selected correction and migrations 0091–0094 on a sanitized previous-release database. Record counts, constraints, timings, interrupted-upgrade behavior and old-client compatibility.

Full restoration must recover PostgreSQL, both object buckets (or disk storage), and the protected runtime configuration/key material needed to read encrypted secrets. A database row pointing to a missing object is not a successful restoration. Use an isolated target, stop its writers, restore matching backup generations, compare counts/checksums, and download a representative authorized image/document through the application. Verify unauthorized downloads still fail. Keep secrets in the approved secret/backup system, never in this report or CI artifacts.

Off-host retention, encryption, RPO, RTO, alert recipients and actual restore evidence require operator inputs. No production restore or deployment was performed in this pass.

## Performance evidence still required

The load harness accepts `BENCH_ORIGIN`, JSON `BENCH_PATHS`, `BENCH_TOKEN`, `BENCH_CONCURRENCY`, `BENCH_REQUESTS` and `BENCH_BUDGET_MS`. It accepts only loopback targets and explicit non-credential API paths; it never logs tokens or response bodies. Supply representative authenticated report/list paths and an isolated populated database. An empty dataset or a health-only probe cannot establish business capacity.

Record user/data volume, workload mix, concurrency, resource limits, revision, duration and response budgets alongside the JSON result. The 1,500 ms default derives from the existing report requirement; it is not a measured guarantee for every operation. Browser end-to-end responsiveness and sustained queue recovery require separate measurements. Expected production scale was requested from the owner and is not assumed here.

## Remaining gates to a 9/10 assessment

Complete the remaining business outbox/audit/idempotency paths; expand the write/approval/bulk/file permission matrix; retain fresh advisory verification (this pass reports zero after targeted dependency patches); decide and implement upload quarantine policy; rehearse a populated upgrade and complete restoration; measure representative load and authenticated browser workflows; verify CI on Node 22; resolve or explain remaining pg and large-bundle warnings. No score is raised solely because this pass added tests.


## Dependency remediation

A fresh npm scan found eight advisories (four High/four Moderate). The root manifest now pins patched transitive versions with targeted overrides: fast-uri 3.1.6, qs 6.16.0, ExcelJS's uuid 11.1.1, and esbuild-kit core-utils' esbuild 0.25.12. A second live scan reports zero known vulnerabilities. No new direct dependency was added. Deprecated transitive packages remain; an advisory-free result does not mean every dependency is maintained indefinitely.


## Test deadline calibration

After dependency updates, two separate full runs hit Vitest's default 5-second deadline: the month-recomputation test and a cross-instance Redis rate-limit burst test. The roster suite passed all 76 checks in isolation. The API integration suite now has an explicit 15-second default; its correctness/security assertions and explicitly declared timing checks are unchanged. This is a test-harness allowance, not evidence of improved application latency. The final complete-suite result is recorded in the action plan.


## Final local results

With the patched dependency graph: API 2,332/2,332; web 934/934; shared 73/73; agent 15/15 — 3,354 passing package tests across 289 files. The final complete API run passed in 308 seconds after the explicit integration deadline was set. Eight script tests, root lint/typecheck, the production build, production-artifact inspection, and all nine first-install offline browser checks passed. The verified worker version is `bcf3a9226cf0`. A fresh npm scan reports zero known advisories, and Drizzle schema export succeeds. Local Node was 24.15.0; Node 22 hosted CI and staging evidence are not claimed.
