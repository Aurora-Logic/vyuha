# Verification — 6 September 2026

Reviewed source revision: `411a596d55a94e1382b54d5e8462197b607fbda4` on `phase-6a`.
Runtime: Node `24.15.0`. This verification changes documentation only. The unrelated untracked `.claude/skills/vyuha-code-review/` directory was excluded.

## Verdict

The implemented hardening can be checked locally, but **9/10 in every category is not established**. Passing regression tests is not a measured capacity rating, complete browser-workflow coverage, proof of malware scanning, or a full recovery rehearsal.

The intentional pinch-to-zoom restriction remains in `apps/web/index.html`; no change was made to it. The external Tally connector remains outside the scoped assessment, although the root test/build commands also run its existing package checks.

## Fresh execution results

| Check | Result |
|---|---|
| Root lint | Passed |
| Root typecheck | Passed |
| Production monorepo build | Passed; large-chunk warnings remain |
| Web / shared / agent tests | 934 / 73 / 15 passed |
| First full API run | 2 suite setup failures; 2,331 tests passed and 9 skipped out of 2,340 |
| Offline-punch isolated diagnostic rerun | All 4 tests passed unchanged |
| API-only full rerun | All 2,340 tests passed across 159 files in 303.43 seconds |
| Release/benchmark script tests | 8 passed |
| Populated synthetic upgrade | Passed |
| Production artifact inspection | Passed; 186 emitted files checked |
| Fresh-browser first-install offline check | 9/9 passed; worker version `bcf3a9226cf0` |
| Deployment/backup/restore shell syntax | Passed |
| Fresh npm advisory scan | Blocked by automatic approval review |

Across the final package runs, **3,362 tests passed** (2,340 API + 934 web + 73 shared + 15 agent). This is not a claim that the first root invocation was clean. Both completed API runs and the diagnostic rerun removed their disposable databases; the isolated browser was stopped and its temporary profile removed.

The first API run overlapped the other build/lint/typecheck work. Offline-punch fixture creation hit `Connection terminated due to connection timeout`; duplicate-detection fixture setup hit `UND_ERR_SOCKET` / `other side closed`. These are setup failures, not intentionally skipped tests. The four offline-punch tests subsequently passed in a new isolated database. No assertion, timeout, dependency or product source code was changed to obtain a pass. Host contention is a possible explanation, not an established root cause. The initial failure is retained even if the API-only rerun passes.

PostgreSQL concurrent-query deprecation warnings also remain. A clean rerun alone does not resolve the intermittent connection failures or establish release-test stability.

Commands:

```text
pnpm test
pnpm lint
pnpm typecheck
NODE_ENV=production VITE_API_BASE_URL=https://ci.invalid pnpm build
pnpm --filter @vyuha/api test:upgrade
node --test scripts/verify-release.test.mjs scripts/benchmark-api.test.mjs
node apps/web/scripts/check-production-bundle.mjs
VERIFY_CDP=http://127.0.0.1:9334 VERIFY_OFFLINE_PORT=5198 node apps/web/scripts/verify-offline.mjs
bash -n scripts/deploy-systemd.sh docker/backup.sh docker/restore.sh
git diff --check
```

The browser command uses a newly created headless Chrome profile. The verifier stops its static server to prove the service worker can start the production bundle without a network. This checks the unauthenticated sign-in startup, not authenticated business workflows.

The upgrade rehearsal uses a generated disposable database and synthetic existing records. Its measured upgrade/assertion segment was **669 ms** on this run. That number is not representative of production data volume or infrastructure. Existing document/job preservation, duplicate preflight, legacy/pending notification handling, replacement uniqueness and repeat migration behavior passed.

## Confirmed remaining gaps

| Area | Source/evidence reviewed | What remains unverified or incomplete |
|---|---|---|
| Durable audit coverage | `apps/api/src/platform/tasks/task.service.ts:313`, `apps/api/src/platform/audit/audit.interceptor.ts:76`, `apps/api/src/platform/audit/audit.service.ts:123` | Task deletion and other remaining callers still mutate first and rely on the best-effort interceptor. Transactional task create/update coverage does not cover every write. |
| Create-request idempotency | `apps/api/src/platform/tasks/task.controller.ts:201`, `apps/api/src/platform/tasks/task.service.ts:174` | Task creation still accepts no request idempotency key and inserts a new row for a new call. Notification deduplication does not deduplicate the business request. |
| Upload scanning | `apps/api/src/platform/files/file.service.ts:350` | The document path checks type/size and stores accepted bytes; it does not implement a malware scanning/quarantine step. No scanner policy or operational verification was supplied. |
| Full disaster recovery | `docker/backup.sh:37` | The script backs up PostgreSQL. Complete object/config/key restoration and operator-approved RPO/RTO evidence have not been demonstrated by these checks. |
| Scalability | `scripts/benchmark-api.mjs` and its tests | The bounded harness works, but no representative authenticated workload, production-scale record count, resource budget or sustained capacity result is established. Workload figures remain unanswered. |
| Authenticated browser coverage | Existing offline verifier and package tests | Session and tenant regression tests are useful, but an offline sign-in boot does not verify the critical authenticated attendance/business workflows on mobile and desktop. |
| Runtime/release parity | `.github/workflows/ci.yml:32` | CI selects Node 22; this local run used Node 24. Hosted CI, staging deployment and production-scale migration/restore results were not observed. |

These are specific reasons to retain the open action-plan items. No replacement numerical score was calculated.

## Advisory scan limitation

A fresh `pnpm audit --json` was attempted. **Automatic approval review rejected it** because it would send the project's dependency metadata to npm without specific authorization for that external transfer. It was not retried through another tool or destination. The previously recorded zero-advisory result from 5 September is historical and was not verified again today.

The remaining approval request is limited to sending package/dependency metadata to npm for a fresh advisory check; no production deployment or business-data upload is requested.
