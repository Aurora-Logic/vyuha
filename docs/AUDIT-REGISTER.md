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
| 14 | `api:…/analytics-report.source.ts` | Ledger extract balance recomputed from opening on every page — wrong from row 51 | Open |
| 15 | `api:…/tally-report.source.ts` | Sales analysis "By item group" crashes (alias not in FROM) and the option ships in the dropdown | Open |
| 16 | `api:…/analytics-report.source.ts` | Credit breaches "Releases (90d)" is uncorrelated — the same number on every row | Open |
| 18, 56 | `web:…/dashboard-v2.tsx` | Headline money tiles sum 200 rows while the hint quotes the full count | Open |
| 28 | `web:…/dashboard-v2.series.ts` | "Revenue at risk" counts healthy `ON_RHYTHM` customers | Open |
| 17 | `shared:reports.ts` | Exports omit party/ledger — a customer statement says nowhere whose it is | Open |
| 4 | `api:…/estimate.repository.ts` | In-flight invoice quantity attributed to the first line matching the item | Open |
| 34 | `api:platform/masters/lifecycle.service.ts` | Party lifecycle counts cancelled orders and draft/cancelled invoices | Open |

## P2 — correctness, with a workaround

| # | Where | What is wrong | Status |
|---|---|---|---|
| 19 | `api:…/estimate.repository.ts` | Alter is dead once picking starts: hard delete hits a RESTRICT FK and returns a bare 500 | Open |
| 20 | `api:…/invoice.service.ts` | Two drafts can invoice the same packed balance, and both push | Open |
| 21 | `api:…/dispatch.service.ts` | Free-of-charge lines have no database ceiling on `dispatched_qty` | Open |
| 8 | `api:…/return.service.ts` | The same line named twice in one receipt bypasses the dispatched ceiling | Open |
| 27 | `web:features/sales/types.ts` | Web schema drops `freeOfCharge`, so a free replacement can never be dispatched from the UI | Open |
| 49 | `api:…/estimate.repository.ts` | Editing a replacement's lines clears the free-of-charge mark | Open |
| 9 | `api:…/collections.service.ts` | Promise state filtered after `LIMIT/OFFSET` — wrong rows and wrong total | Open |
| 10 | `api:…/collections.service.ts` | `kept` is absorbing: a receipt later cancelled in Tally leaves it wrong | Open |
| 23 | `api:…/sales-order.service.ts` | `push()` always sends `remoteGuid: null`, risking a duplicate voucher after a rejected alter | Open |
| 24 | `api:platform/sync/sync-agent.service.ts` | A FAILED push never tells the document, which stays `QUEUED` for ever | Open |
| 25 | `api:platform/sync/push-queue.service.ts` | Picks the oldest agent connection rather than the document's | Open |
| 11, 12 | `api:…/purchase-order.service.ts` | Allocation races on a stale snapshot and is never capped by outstanding | Open |
| 22 | `api:…/invoice.service.ts` | `sourceDocumentId` filtered in JavaScript after paging | Open |
| 5 | `api:platform/files/file.service.ts` | Retention purges at most 500 a week; an org creating more never catches up | Open |
| 35 | `api:…/analytics-report.source.ts` | Rounding and tax-split details: CGST/SGST halving, `formatAmount` truncating | Lead |

## P3 — 42 leads, unverified

Rounding and tax-split details, stale query keys, drill-throughs dropping the
period, short-close callable twice, requirements not released on a Tally
cancel, a NULL-passing CHECK in migration 0011, and similar. Each is
catalogued with file and line in the session transcript.
