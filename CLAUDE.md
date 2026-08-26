# CLAUDE.md — Project Constitution

Working name: **Setu**. One find-replace changes it if you pick something else.
Read this file at the start of every session. It overrides your defaults.

Companion documents in `/docs`:

| File | Read when |
|---|---|
| `01-product-requirements.md` | Before implementing any feature. It has the REQ IDs. |
| `02-technical-design.md` | Before writing code, migrations, or APIs. |
| `03-scope-and-delivery-plan.md` | Before starting or closing a phase. |
| `08-product-requirements-phase-6-8.md` | Tally, CRM and sales/purchase. REQ IDs O–Z. |
| `09-technical-design-phase-6-8.md` | The sync engine, projection tables, navigation shell. |
| `10-scope-and-delivery-plan-phase-6-8.md` | Phases 6a–8b and their exit gates. |
| `11-decisions-phase-6-8.md` | **Authority for Phase 6–8.** Overrides 08–10 wherever they disagree. |
| `16-virtual-cfo-brief.md` | **The Virtual CFO master brief, Parts 0–R.** Read before any cfo module work; its Part 0 governs execution. |
| `17-virtual-cfo-part-s.md` | Part S: the CFO custom report builder and lifecycle models. |
| `18-virtual-cfo-report-list.md` | Every report the CFO module should produce, numbered. |

`01`–`03` are not superseded — they remain in force for attendance. `08`–`11`
extend them for everything after it.

---

## 1. What this product is

A **workforce attendance web application** — punch in/out with photo capture, shift rules, leave, holidays, approvals, reports, and Excel export. Payroll is **not** run here; the product produces the inputs and hands them off.

## 2. What this product will become

The same codebase will later carry a **CRM module** and an **ERP module**, where ERP masters and financial data are pulled from **TallyPrime**. You are not building those now. You **are** building the foundations they will sit on: module boundaries, RBAC, master data, audit, jobs, and an integration layer.

**Rule:** never write attendance-specific logic into a shared/platform module, and never put platform concerns inside the attendance module. If you are unsure which side a thing belongs on, ask.

## 3. Non-negotiables

These are permanent. They do not expire, and they are not up for re-litigation in a later session.

1. **Every UI component comes from shadcn/ui, installed through the shadcn MCP server. This is exclusive and absolute.**
   - Install components by calling the shadcn MCP. Never paste component source from memory, never copy from a blog, never write your own version of something shadcn provides.
   - No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<dialog>`, `<form>` controls in feature code.
   - **This includes every small thing, not just the obvious ones.** Date picker, time picker, date-range picker, month picker, dropdown, combobox, multi-select, checkbox, radio, switch, slider, file input, search field, tabs, accordion, tooltip, popover, badge, avatar, breadcrumb, pagination, toast, alert, skeleton, progress, separator, scroll area, sheet, drawer, command palette, calendar, chart. If it renders, it comes from shadcn.
   - **Date and time inputs specifically:** use shadcn Calendar / Popover / Command compositions. Never `<input type="date">`, never `<input type="time">`, never `react-datepicker` or any other picker library. The native date input renders differently on every browser and is unusable on mobile — it is the single most common place this rule gets broken.
   - Every one of these must be **fully usable on a phone**: touch targets at least 44px, pickers open as a bottom Sheet or Drawer on small screens rather than a desktop popover, no hover-only interactions, no control that needs a mouse.
   - No other component library, ever: not MUI, not Ant, not Mantine, not Headless UI directly, not a "quick" custom modal.
   - If a primitive is missing, compose it from existing shadcn primitives and put the composition in `components/shared/` so it is reused, not re-invented.
   - Before building any screen, check what shadcn already offers for it via the MCP. Reach for the MCP first, code second.
   - The only styling layer is Tailwind plus the shadcn theme tokens. No inline style objects, no CSS modules, no styled-components.
2. **No emojis anywhere** — not in UI, not in code comments, not in commit messages, not in seed data. Icons only (`lucide-react`).
3. **No "box in box."** One card should not contain another card. Use spacing, dividers, and typographic hierarchy to separate things. A page is: header → toolbar → content surface. That's it.
4. **One hierarchy across the whole app.** Same page header pattern, same table pattern, same form pattern, same empty state, same toast. A screen built in week 6 must be indistinguishable in structure from one built in week 1.
5. **Fully responsive.** Every screen works at 360px and 1920px. Tables collapse to a defined mobile pattern (see PRD §6.5), they do not horizontally scroll into oblivion.
6. **Keyboard-first, TallyPrime key parity.** A Tally user must be able to work without touching the mouse. Wherever a shortcut exists, its key is shown as a hint chip on the control. See PRD §6.4 for the authoritative key table.
7. **No payroll calculation.** No salary, no rates, no deductions, no tax. If a task seems to require money math, stop and ask.

## 4. Definition of Done

A task is done when **all** of these are true:

- [ ] Types check (`tsc --noEmit`) and lint pass with zero warnings.
- [ ] Zod schema validates every request body and every env var. No `any`. No non-null assertions on API data.
- [ ] Unit tests for domain logic; integration test for every new endpoint.
- [ ] RBAC enforced **server-side** on the endpoint, and reflected in the UI (hidden or disabled with a reason).
- [ ] Audit log written for every state-changing action.
- [ ] Empty state, loading state, and error state all implemented — not just the happy path.
- [ ] Keyboard path works; shortcut registered and hint chip rendered if applicable.
- [ ] Responsive at 360px verified.
- [ ] Migration written and reversible. No destructive migration without an explicit instruction.
- [ ] The REQ ID from the PRD is referenced in the commit message.

## 5. Working method

- Use `/loop` for multi-file feature work.
- Use `/ultrareview` before closing any phase.
- Use `/security-review` before closing Phase 1 (punch) and before any deployment.
- Use the **apple-design** skill for screen layout and interaction polish.
- Use the **shadcn MCP** to install components — do not copy component source from memory.

Work in vertical slices: migration → domain service → API → UI → test. Do not build twelve endpoints and then start on UI.

## 6. Hard "do not" list

- Do not add a dependency without asking. Especially: no UI kit other than shadcn, no state library beyond TanStack Query + React Hook Form + Zustand, no ORM other than the one chosen.
- Do not invent features that aren't in the PRD. If you think something is missing, add it to `docs/OPEN-QUESTIONS.md` and ask.
- Do not put business logic in controllers or React components. Controllers validate and delegate; components render.
- Do not query the database outside a repository/service layer.
- Do not leave mock or hardcoded data in a code path that runs in production. Seed data lives only in `seed/`.
- Do not silently swallow an error. Every catch either handles or rethrows with context.
- Do not weaken an RBAC check, rate limit, or validation to make a test pass.
- Do not commit secrets, tokens, or real employee data.

## 7. When you are blocked

Stop and ask. Append the question to `docs/OPEN-QUESTIONS.md` with the REQ ID and your recommended default. Do not guess on: punch policy edge cases, leave accrual rules, statutory requirements, or anything involving money.
