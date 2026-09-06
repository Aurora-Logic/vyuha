# Production readiness — 6 September 2026

Scope: application-owned code on `phase-6a`, following `6dc7e97a`. The external Tally connector is excluded. Pinch-to-zoom remains intentionally disabled. This record supersedes the task-specific open findings in the earlier verification, without erasing its historical results.

## Implemented in this pass

- `POST /tasks` accepts an optional `Idempotency-Key`. A receipt scoped by organization, actor and operation commits with the task, assignment notification intent and creation audit. Concurrent identical requests return the same task; changed input under the same key returns 409. Invalid keys return 400. An audit failure rolls back the receipt and business data, allowing a genuine retry.
- The task editor retains the key for retries of the same payload after a failed response. Authentication refresh preserves it. Successful saves and edited payloads start a new intent. The key is held in the mounted editor, **not persisted across reloads**. Older clients omitting the key retain their previous behavior. Replays return the current authorized task view; deleted or newly inaccessible tasks return 404. Replays may produce a generic HTTP audit/realtime refresh, but do not duplicate the task creation audit or assignment intent.
- Task deletion, attachment addition/removal, and column creation/update/reorder/deletion now persist their required audit entry in the business transaction. Column completion changes and affected tasks' closure timestamps commit together. File object finalization remains the existing durable staged-storage workflow; this change does not add malware scanning.
- Column configuration writes take an organization-specific exclusive transaction lock. Task creation and updates hold its shared counterpart while resolving columns and committing, preventing application task writes from racing column deletion/completion changes while allowing independent task writes to overlap. Task update/deletion also lock the task row before reading the transaction's current state. These controls apply to application paths, not arbitrary direct SQL.
- Default-column insertion uses database conflict handling instead of swallowing all insert errors, so a concurrent initialization cannot leave its caller's transaction aborted.

## Migration and rollback compatibility

Migration `0095_request_receipts.sql` is additive. Deploy the migration before the new API, then deploy the web build. The synthetic populated upgrade script now exercises 0090 through 0095, preserving existing document/job/notification data and verifying repeat application is a no-op. Its measured upgrade/assertion segment was 110 ms on a tiny local fixture, not a production-duration estimate.

Receipts store IDs and request hashes, not response bodies. They have no automatic expiry and remain until the owning user or organization is deleted; storage growth must be included in capacity planning. Do not prune receipts while clients may retry old requests. An application rollback can leave this additive table in place, but an old API ignores retry keys and therefore loses the new deduplication guarantee. Pause creation traffic during such a rollback and reconcile ambiguous requests before resuming. No production migration or rollback was executed.

## Verification

| Check | Result |
|---|---|
| Full API regression | 2,344 passed across 159 files, 362.30 seconds; scratch database removed |
| Final affected task/attachment checks | 36 passed across two files after the final audit/connection changes, including the additional attachment rollback test; scratch database removed |
| Full web / shared / agent suites | 936 / 73 / 15 passed |
| Root lint / typecheck / production build | Passed; affected API lint/build also checked after final edits |
| Migration rehearsal | Passed through 0095, repeat migration a no-op |
| Release/benchmark script tests | 8 passed |
| Production bundle inspection | 186 emitted files passed; large-chunk warnings remain |
| Fresh-profile offline startup | 9/9 passed; worker e1166f45a074; temporary browser profile removed |
| Diff whitespace validation | Passed |

The complete API run preceded the last attachment audit and task-row/connection refinements. Those affected paths were then checked with the final 36-test run; there is no claim that a second complete API run occurred. The agent's first invocation was denied its loopback socket by the sandbox (`listen EPERM`), producing eight passes and seven setup skips. With that permission available, all 15 unchanged tests passed; no timeout or assertion was weakened. PostgreSQL concurrent-query deprecation warnings persist outside the revised task path. Offline startup proves unauthenticated sign-in boot, not authenticated workflows.

Commands: `pnpm --filter @vyuha/api test`; targeted API tests for `task.endpoints.test.ts` and `task-attachments.endpoints.test.ts`; package test commands for web/shared/agent; `pnpm lint`; `pnpm typecheck`; `NODE_ENV=production VITE_API_BASE_URL=https://ci.invalid pnpm build`; `pnpm --filter @vyuha/api lint`; `pnpm --filter @vyuha/api build`; `pnpm --filter @vyuha/api test:upgrade`; `node --test scripts/verify-release.test.mjs scripts/benchmark-api.test.mjs`; `node apps/web/scripts/check-production-bundle.mjs`; `VERIFY_CDP=http://127.0.0.1:9347 VERIFY_OFFLINE_PORT=5198 node apps/web/scripts/verify-offline.mjs`; `git diff --check`.

Local runtime is Node 24.15.0; Node 22 hosted CI has not been observed. No dependency was added or changed. The owner-approved npm scan earlier on 6 September reported zero known vulnerabilities across 1,121 dependencies; that is dated dependency evidence, not proof of application security.

## Concluded release gaps

Owners below are required roles, not assignments to named people. None of these rows is closed by raising a numerical score.

| Priority / owner | Remaining work | Evidence needed to close |
|---|---|---|
| P1 / backend engineering | Inventory and convert remaining critical audit callers outside tasks; extend request idempotency to other create workflows and decide reload/recovery semantics. | Mutation-by-mutation coverage with audit rollback, concurrent retries, changed-input and tenant isolation assertions. Source search still finds best-effort `auditContext.record` callers outside tasks; this pass does not certify them. |
| P1 / security + operator | Select the upload scanner/quarantine service and implement rejection, unavailable-scanner behavior and recovery. | Clean, malicious, unavailable and retry probes; quarantined objects cannot receive download URLs. Type/size checks and image re-encoding alone do not close this gap. Scanner details/permission to add ClamAV were requested and remain unanswered. |
| P1 / QA + backend engineering | Complete the critical write/permission matrix and authenticated desktop/mobile browser flows. | Adversarial bulk/nested/file/approval tests plus login/logout, expiry, account switching, temporary outage and attendance/business workflow evidence. Existing API and hook tests are useful but not equivalent to these browser journeys. |
| P1 / operator + performance engineering | Supply expected peak concurrency, tenant/record volumes and acceptable latency/error/resource budgets; run sustained authenticated load. | Representative measured throughput, p95/p99, error rates, database/queue/resource behavior and recovery after disruption. Local test counts establish no production capacity. |
| P1 / operator | Rehearse a populated representative upgrade and complete DB, object storage, configuration and key restore. | Approved RPO/RTO, timed restore, restored document/image authorized download, preserved tenant boundaries, release/rollback identity. Staging target and recovery objectives were requested and remain unanswered. |
| P1 / release engineering | Run final revision on Node 22 hosted CI and staging; investigate intermittent prior setup failures and remaining PostgreSQL concurrent-query warnings. | Retained clean CI/staging results and diagnosed failures. The local GitHub CLI is unavailable; no hosted result is claimed. |

## Repository security-gate probes

`VERIFIED` here means the stated local source/test property only, not production configuration. The repository security skill references an unavailable built-in security-review command; that command was not run. Its older TOTP/rate-limit descriptions were checked against current source rather than copied as facts.

| Probe | Status and evidence |
|---|---|
| Route policy presence | VERIFIED locally: `RoutePolicyAudit` inspects registered handlers at startup and refuses missing policy; `AccessGuard` denies undeclared policy. This does not prove every chosen permission is correct; the complete adversarial matrix remains open. |
| Append-only writes | VERIFIED source probe: no production source update/delete calls targeting punches or audit logs were found by the direct SQL/Drizzle search. Existing append-only migrations remain in place. This is a bounded source search, not a full independent security review. |
| Photo path | VERIFIED for existing local checks: task changes do not alter attendance photo access; photo tests remain in the API suite. Camera source uses getUserMedia, signed URL TTL is bounded by configuration, and server stamp failure aborts the punch. Physical-device browser behavior remains NOT VERIFIED. |
| Authentication | VERIFIED locally by the existing API regression coverage; rotating sessions, token validation and timing behavior remain exercised. Current source implements a TOTP challenge for enrolled users; organization-wide enrollment/enforcement is NOT VERIFIED. |
| Rate limits / proxy | NOT VERIFIED in production: current source falls back from Redis to PostgreSQL, but deliberately allows attempts if that fallback lock is unavailable; per-account lockout remains. `TRUST_PROXY_HOPS` defaults to zero and must match the actual proxy topology. The existing availability policy was not silently inverted. |
| Cookies / response headers | VERIFIED source: production refresh cookies are secure, httpOnly, sameSite=strict and scoped to auth; API startup installs Helmet. Deployed TLS, CSP and proxy responses are NOT VERIFIED. |
| Secrets / environment | NOT VERIFIED as a complete historical secret scan or deployed configuration audit. Source validates environment values at startup; tracked environment files are example files. No real secret values were printed or committed in this pass. |
| Dependencies | VERIFIED against the owner-approved 6 September npm scan: zero known vulnerabilities; dependency graph unchanged in this pass. |

**Verdict: DO NOT DEPLOY as a certified production-ready release yet.** Blocking items are the remaining critical mutation/security coverage, upload scanning, authenticated browser evidence, representative capacity, full recovery and Node 22/staging verification listed above. The completed code changes are reviewable, but a defensible 9/10 rating in every category is not established.
