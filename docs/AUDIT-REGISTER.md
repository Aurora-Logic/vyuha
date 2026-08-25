# Audit register — 22 Aug 2026

A whole-product audit: 69 agents across every module, 71 defects raised, the
29 serious ones each attacked by two independent refuters. 27 survived, and
several were reproduced against the live database rather than only read.
P3 is **as-claimed and unverified** — leads, not findings.

Status values: Fixed (commit) · Open · Lead.

## P0 — before anyone trusts a number or a document

| # | Where | What is wrong | Status |
|---|---|---|---|
| 1 | `api:platform/jobs/job-runner.service.ts` | Frozen clock: `requestedAt` baked into the BullMQ scheduler template at boot, so three leave jobs treat deploy day as today for ever | Fixed `ff03a7b` |
| 2 | `web:features/documents/paper.tsx` | HSN/SAC summary printed the gross subtotal as "Taxable Value" on the GST invoice | Fixed `71727c7` |
| 3 | `web:features/documents/paper.tsx` | Tally invoice subtracted the discount twice — the Amount cell is already net | Fixed `71727c7` |
| 7, 26 | `api:platform/jobs/*` | `GET /jobs` returned the whole deployment's queue state and every org's failure payloads | Fixed `729a3e7` |
| 13 | `api:modules/purchase/orders/purchase-order.service.ts` | `putItemSettings` conflict target was not org-scoped: one org could overwrite another's item settings | Fixed `c00e33d` |
| 6 | `api:platform/documents/document-settings.controller.ts` | Logo endpoint minted a signed URL for any file id in the org | Fixed `9c759d1` |
| 29 | `web:lib/session/use-session.ts` | Sign-out did not sign out when `/auth/logout` failed: cache, localStorage and refresh cookie all survived | Fixed `3df0a5a` |
| P-36 | `api:platform/auth/*-rate-limit.service.ts` | Both limiters diverted to the fail-open Postgres path whenever Redis was merely connecting | Fixed `109421a` |

## P1 — reports and documents that state a wrong figure

| # | Where | What is wrong | Status |
|---|---|---|---|
| 14 | `api:…/analytics-report.source.ts` | Ledger extract balance recomputed from opening on every page, and page one returned a row too many | Fixed `7e07252` |
| 15 | `api:…/tally-report.source.ts` | Sales analysis "By item group" crashed twice over, and shipped in the dropdown | Fixed `4d05419` |
| 16 | `api:…/analytics-report.source.ts` | Credit breaches "Releases (90d)" was uncorrelated — the same number on every row | Fixed `12d2ee5` |
| 18, 56 | `web:…/dashboard-v2.tsx` | Headline money tiles summed 200 rows while the hint quoted the full count | Fixed `7fe4552` |
| 28 | `web:…/dashboard-v2.series.ts` | "Revenue at risk" counted healthy `ON_RHYTHM` customers | Fixed `7fe4552` |
| 17 | `shared:reports.ts` | Exports omitted party and ledger — a customer statement said nowhere whose it was | Fixed `20e1efa` |
| 4 | `api:…/estimate.repository.ts` | In-flight invoice quantity all attributed to the first line matching the item | Fixed `5c77c22` |
| 34 | `api:platform/masters/lifecycle.service.ts` | Lifecycle and analytics counted cancelled orders and draft/cancelled invoices, across 36 sites | Fixed `8e00690` |

**P1 is closed.** Every fix was run against the pre-fix source first and the
failure recorded in its commit message.

## P2 — correctness, with a workaround

| # | Where | What is wrong | Status |
|---|---|---|---|
| 19 | `api:…/estimate.repository.ts` | Alter is dead once picking starts: hard delete hits a RESTRICT FK and returns a bare 500 | Fixed `39adb4f` |
| 20 | `api:…/invoice.service.ts` | Two drafts can invoice the same packed balance, and both push | Fixed `7c45fd9` |
| 21 | `api:…/dispatch.service.ts` | Free-of-charge lines have no database ceiling on `dispatched_qty` | Fixed `78277da` |
| 8 | `api:…/return.service.ts` | The same line named twice in one receipt bypasses the dispatched ceiling | Fixed `efa0d7f` |
| 27 | `web:features/sales/types.ts` | Web schema drops `freeOfCharge`, so a free replacement can never be dispatched from the UI | Fixed `3faa213` |
| 49 | `api:…/estimate.repository.ts` | Editing a replacement's lines clears the free-of-charge mark | Fixed `3faa213` |
| 9 | `api:…/collections.service.ts` | Promise state filtered after `LIMIT/OFFSET` — wrong rows and wrong total | Fixed `764c109` |
| 10 | `api:…/collections.service.ts` | `kept` is absorbing: a receipt later cancelled in Tally leaves it wrong | Fixed `764c109` |
| 23 | `api:…/sales-order.service.ts` | `push()` always sends `remoteGuid: null`, risking a duplicate voucher after a rejected alter | Fixed `aab4d86` |
| 24 | `api:platform/sync/sync-agent.service.ts` | A FAILED push never tells the document, which stays `QUEUED` for ever | Fixed `4c051cc` |
| 25 | `api:platform/sync/push-queue.service.ts` | Picks the oldest agent connection rather than the document's | Fixed `703fdc0` |
| 11, 12 | `api:…/purchase-order.service.ts` | Allocation races on a stale snapshot and is never capped by outstanding | Fixed `ebe0063` |
| 22 | `api:…/invoice.service.ts` | `sourceDocumentId` filtered in JavaScript after paging | Fixed `701a50f` |
| 5 | `api:platform/files/file.service.ts` | Retention purges at most 500 a week; an org creating more never catches up | Fixed `b935b16` |
| 35 | `api:…/analytics-report.source.ts` | Rounding and tax-split details: CGST/SGST halving, `formatAmount` truncating | Lead (with P3) |

**P2 is closed.** Every fix was run against the pre-fix source first and the
failure recorded in its commit message. Fixing them turned up four defects the
audit had not named: an alter that returned 200 with nothing sent to Tally, a
failed enqueue that erased the fact a document was already in Tally, the
`last_order_at` figures that carried no status condition at all, and the
item-group label that failed even once its table was joined.

## P3 — 42 leads, unverified

**Closed 25 Aug 2026.** The 35 deduped leads all survived adversarial
verification and are all fixed, each proven by a test failing against its
pre-fix source. The last three: draft POs double-taking a requirement (the
confirm now re-reads open quantities under lock and refuses, D-18), GRN and
dispatch voids arriving from Tally without an audit row (one row, on the
pull that learned of it), and the duplicate-cluster signature exceeding the
btree index ceiling (~2.7KB; proved live with an incompressible 8KB probe,
now deduped by md5).

Rounding and tax-split details, stale query keys, drill-throughs dropping the
period, short-close callable twice, requirements not released on a Tally
cancel, a NULL-passing CHECK in migration 0011, and similar. Each is
catalogued with file and line in the session transcript.
